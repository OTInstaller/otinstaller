// pipx sandbox images and dependency locks: the scanner pins a pipx release's dependencies, builds and scans the image,
// pushes it to the mirror under sandbox-<version> (withheld until the version is published) and signs it; the manifest
// response hands ot the lock and, once published, the image (scans.ts, backups.ts, mirror/registry.ts).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processJob } from "../src/publish";
import { backfillBackups, sweepMirrorRepo } from "../src/backups";
import { mirrorFetch, type MirrorEnv } from "../src/mirror/registry";
import type { ScanResults } from "../src/scans";
import { ulid } from "../src/lib/crypto";
import { call, testEnv, webhook } from "./helpers";
import { README, fakeRelease, installation, tagEvent } from "./fixtures";

const DB = () => env.DB;
const WHEEL = "c".repeat(64);
const H = (c: string) => c.repeat(64);
const LOCK = `phonenumbers==8.13.40 --hash=sha256:${H("a")} --hash=sha256:${H("b")}\nrequests==2.32.3 --hash=sha256:${H("d")}\n`;
const SIGNER = "https://github.com/osintverse/registry-ops/.github/workflows/scan.yml@refs/heads/main";

const pipxManifest = (ns: string, license = "MIT", version = "1.0.0") => `schema: 1
name: phone-plus
namespace: ${ns}
version: ${version}
summary: Parses phone numbers into country, carrier type and E.164 format
readme: README.md
license: ${license}
categories: [phone]
inputs:
  - name: phone
    type: phone
    required: true
outputs:
  - type: phone
runtime:
  kind: pipx
  package: phone-plus
  package_version: "${version}"
  wheel_sha256: ${WHEEL}
  entrypoint: phone-plus
  command: ["phone-plus", "{phone}"]
  output_format: json
ethics:
  touches_target: false
  auth_required: false
  collects_personal_data: false
`;

let seq = 0;
async function publisher() {
  const n = ++seq;
  const login = `pipx${n}x${Date.now() % 100000}`;
  const ghId = 40000 + n * 1000 + (Date.now() % 1000);
  const userId = ulid();
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(userId, login, `${login}@example.com`, Date.now()),
    DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, created_at) VALUES (?, ?, 'github', ?, ?, ?)`).bind(ulid(), userId, String(ghId), login, Date.now()),
  ]);
  const instId = 7000000 + n * 1000 + (Date.now() % 1000);
  const repoId = 90000 + n;
  await webhook("installation", installation(instId, { id: ghId, login }, [repoId], ghId));
  await DB().prepare(`UPDATE namespaces SET status = 'active' WHERE name = ?`).bind(login).run();
  return { login, instId, repoId, repo: `${login}/phone-plus` };
}

async function tagAndValidate(p: Awaited<ReturnType<typeof publisher>>, manifest = pipxManifest(p.login)) {
  const res = await webhook("create", tagEvent(p.instId, p.repo, p.repoId, "v1.0.0"));
  const jobId = ((await res.json()) as any).jobId as string;
  const calls = fakeRelease(p.repo, { "otinstaller.yaml": manifest, "README.md": README }, {
    extra: { "GET https://pypi.org/pypi/": { urls: [{ packagetype: "bdist_wheel", digests: { sha256: WHEEL } }] } },
  });
  const out = await processJob(await testEnv(), jobId);
  expect(out?.status, JSON.stringify(out)).toBe("scanning");
  const scan = JSON.parse(calls.find((c) => c.url.endsWith("/registry-ops/dispatches"))!.body).client_payload.scan;
  return { scan, versionId: out!.versionId! };
}

const clean: ScanResults = {
  signature: { status: "absent" },
  vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0, fixable_critical: 0, fixable_high: 0 },
  secrets: { count: 0 },
  malware: { count: 0 },
  smoke: { status: "pass", exit_code: 0 },
};

const report = (token: string, results: unknown) =>
  call("/internal/scans", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(results) });

// ---------- the mirror, as the scanner pushes to it ----------

const M = "https://mirror.otinstaller.com";
const mirrorEnv = (): MirrorEnv => ({ MIRROR: env.MIRROR, MIRROR_PUSH_TOKEN: "push-secret", DB: env.DB });
const scanner = `Basic ${btoa("scanner:push-secret")}`;
const mirror = (path: string, init: RequestInit = {}) => mirrorFetch(new Request(`${M}${path}`, init), mirrorEnv());
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const digestOf = async (s: string) => `sha256:${toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))}`;

/** Pushes a one-layer image with the scanner's credential under a tag, as `docker push` does, and returns its digest. */
async function scannerPush(repo: string, tag: string) {
  const layer = `layer ${crypto.randomUUID()}`;
  const config = JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } });
  for (const blob of [layer, config]) {
    const r = await mirror(`/v2/${repo}/blobs/uploads/?digest=${await digestOf(blob)}`, { method: "POST", headers: { authorization: scanner, "content-length": String(blob.length) }, body: blob });
    expect(r.status).toBe(201);
  }
  const doc = JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: await digestOf(config), size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: await digestOf(layer), size: layer.length }],
  });
  const put = await mirror(`/v2/${repo}/manifests/${tag}`, { method: "PUT", headers: { authorization: scanner, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc });
  expect(put.status).toBe(201);
  return digestOf(doc);
}

/** An anonymous pull of a manifest, as ot does. */
async function anonymousPull(repo: string, digest: string) {
  const { token } = (await (await mirror(`/token?scope=repository:${repo}:pull`)).json()) as { token: string };
  return mirror(`/v2/${repo}/manifests/${digest}`, { headers: { authorization: `Bearer ${token}` } });
}

const manifestOf = async (ns: string) => (await (await call(`/tools/${ns}/phone-plus/latest/manifest`)).json()) as any;

// ---------- flows ----------

describe("pipx scan dispatch", () => {
  it("names where the scanner pushes the sandbox image", async () => {
    const p = await publisher();
    const { scan } = await tagAndValidate(p);
    expect(scan.sandbox).toEqual({ repository: `mirror.otinstaller.com/${p.login}/phone-plus`, tag: "sandbox-1.0.0" });
  });

  it("asks for no image when the license doesn't let the registry share it", async () => {
    const p = await publisher();
    const { scan } = await tagAndValidate(p, pipxManifest(p.login, "LicenseRef-Proprietary"));
    expect(scan.sandbox).toBeUndefined();
  });
});

describe("pipx sandbox images", () => {
  it("withholds the image until the version is published, then hands ot the image and the lock", async () => {
    const p = await publisher();
    const { scan, versionId } = await tagAndValidate(p);
    const repo = `${p.login}/phone-plus`;
    const digest = await scannerPush(repo, scan.sandbox.tag);
    expect((await anonymousPull(repo, digest)).status).toBe(404);

    const image = `mirror.otinstaller.com/${repo}@${digest}`;
    const res = await report(scan.callback_token, { ...clean, python_lock: LOCK, sandbox: { image, signed: true } });
    expect(await res.json()).toMatchObject({ status: "published" });
    expect((await anonymousPull(repo, digest)).status).toBe(200);

    const m = await manifestOf(p.login);
    expect(m).toMatchObject({
      python_lock: LOCK, sandbox_image: image,
      sandbox_signer_identity: SIGNER, sandbox_signer_issuer: "https://token.actions.githubusercontent.com",
    });
    // Recorded as a hosted image backup, so takedowns hide it and purges delete it.
    expect(await DB().prepare(`SELECT kind, location, hosted, visibility FROM backups WHERE version_id = ? AND kind = 'image'`).bind(versionId).first())
      .toEqual({ kind: "image", location: `${repo}@${digest}`, hosted: 1, visibility: "public" });
  });

  it("hands ot the lock but no image when the image isn't signed, isn't there, or is another package's", async () => {
    for (const sandbox of [
      (repo: string, d: string) => ({ image: `mirror.otinstaller.com/${repo}@${d}`, signed: false }),
      (repo: string) => ({ image: `mirror.otinstaller.com/${repo}@sha256:${H("9")}`, signed: true }),
      (_repo: string, d: string) => ({ image: `mirror.otinstaller.com/someone-else/phone-plus@${d}`, signed: true }),
      (_repo: string, d: string) => ({ image: `ghcr.io/x/y@${d}`, signed: true }),
    ]) {
      const p = await publisher();
      const { scan } = await tagAndValidate(p);
      const repo = `${p.login}/phone-plus`;
      const digest = await scannerPush(repo, scan.sandbox.tag);
      expect((await report(scan.callback_token, { ...clean, python_lock: LOCK, sandbox: sandbox(repo, digest) })).status).toBe(200);
      const m = await manifestOf(p.login);
      expect(m.python_lock).toBe(LOCK);
      expect(m.sandbox_image).toBeUndefined();
    }
  });

  it("drops a lock that isn't pinned, hashed packages, and a malformed sandbox entry, without failing the scan", async () => {
    for (const lock of ["requests==2.32.3\n", `--index-url https://evil.example/simple\n${LOCK}`, 42]) {
      const p = await publisher();
      const { scan } = await tagAndValidate(p);
      const res = await report(scan.callback_token, { ...clean, python_lock: lock, sandbox: { image: 7 } });
      expect(await res.json()).toMatchObject({ status: "published" });
      const m = await manifestOf(p.login);
      expect(m.python_lock).toBeUndefined();
      expect(m.sandbox_image).toBeUndefined();
    }
  });

  it("stops offering the image once it is waiting for deletion", async () => {
    const p = await publisher();
    const { scan, versionId } = await tagAndValidate(p);
    const repo = `${p.login}/phone-plus`;
    const digest = await scannerPush(repo, scan.sandbox.tag);
    await report(scan.callback_token, { ...clean, sandbox: { image: `mirror.otinstaller.com/${repo}@${digest}`, signed: true } });
    await DB().prepare(`UPDATE backups SET delete_after = ? WHERE version_id = ?`).bind(Date.now() + 1000, versionId).run();
    // The manifest response is edge-cached by URL; ask for the exact version to get a fresh one.
    const m = (await (await call(`/tools/${p.login}/phone-plus/1.0.0/manifest`)).json()) as any;
    expect(m.sandbox_image).toBeUndefined();
  });

  it("still backs up the wheel of a version whose sandbox image is stored", async () => {
    const p = await publisher();
    const { scan, versionId } = await tagAndValidate(p);
    const repo = `${p.login}/phone-plus`;
    const digest = await scannerPush(repo, scan.sandbox.tag);
    await report(scan.callback_token, { ...clean, sandbox: { image: `mirror.otinstaller.com/${repo}@${digest}`, signed: true } });
    // The callback planned the wheel backup inline; forget that run, as if it had expired a day ago.
    await DB().prepare(`DELETE FROM backups WHERE version_id = ? AND kind != 'image'`).bind(versionId).run();
    await DB().prepare(`DELETE FROM backup_runs WHERE version_id = ?`).bind(versionId).run();
    fakeRelease(p.repo, {});
    await backfillBackups(await testEnv(), Date.now(), 100);
    expect(await DB().prepare(`SELECT kind FROM backups WHERE version_id = ? AND kind = 'wheel'`).bind(versionId).first()).toEqual({ kind: "wheel" });
  });

  it("keeps the image of a release waiting for review when the nightly sweep runs, and removes a rejected one's", async () => {
    const p = await publisher();
    await DB().prepare(`UPDATE namespaces SET status = 'pending_review' WHERE name = ?`).bind(p.login).run();
    const { scan, versionId } = await tagAndValidate(p);
    const repo = `${p.login}/phone-plus`;
    const kept = await scannerPush(repo, scan.sandbox.tag);
    const res = await report(scan.callback_token, { ...clean, sandbox: { image: `mirror.otinstaller.com/${repo}@${kept}`, signed: true } });
    expect(await res.json()).toMatchObject({ status: "awaiting_review" });
    // An image from a release that was rejected before it reported back.
    const dropped = await scannerPush(repo, "sandbox-0.9.0");
    const later = Date.now() + 8 * 86_400_000;
    await sweepMirrorRepo(await testEnv(), repo, later);
    expect(await env.MIRROR.head(`repos/${repo}/manifests/${kept}`)).not.toBeNull();
    expect(await env.MIRROR.head(`repos/${repo}/manifests/${dropped}`)).toBeNull();
    expect(await DB().prepare(`SELECT sandbox_image FROM versions WHERE id = ?`).bind(versionId).first()).toEqual({ sandbox_image: `mirror.otinstaller.com/${repo}@${kept}` });
  });
});
