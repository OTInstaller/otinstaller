import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, toHex, ulid } from "../src/lib/crypto";
import { presignSigV4 } from "../src/lib/presign";
import { deleteImage, hideImage, mirrorFetch, purgeUploads, releaseImage, sweepRepo, type MirrorEnv } from "../src/mirror/registry";
import {
  backfillBackups, completeRun, expireDrills, KEEP_WEEKLY, osiApproved, purgeBackups, releasePlan, startDrill, TAKEDOWN_GRACE, weeklyBackups, type BackupPlan,
} from "../src/backups";
import { publishVersion } from "../src/scans";
import { handleBatch } from "../src/publish";
import { call, fakeHosts, sent, testEnv } from "./helpers";
import worker from "../src/index";

const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;
const emails: { to: string[]; subject: string; text: string }[] = [];
const dispatches: { event_type: string; client_payload: any }[] = [];
let gitlabHooks: string[] = [];

beforeEach(() => {
  emails.length = 0;
  dispatches.length = 0;
  gitlabHooks = [];
  fakeHosts({
    "POST https://api.resend.com/emails": async (req) => (emails.push(await req.json() as any), { id: "e" }),
    "POST https://api.github.com/app/installations/": { token: "ghs_inst", expires_at: new Date(Date.now() + 3600e3).toISOString() },
    "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": async (req) => (dispatches.push(await req.json() as any), new Response(null, { status: 204 })),
    "GET https://gitlab.com/api/v4/projects/": (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/repository/tags")) return [{ name: "v1.0.0" }, { name: "v1.1.0" }];
      return {
        id: 4242, path_with_namespace: "restored/whois-plus", web_url: "https://gitlab.com/restored/whois-plus", default_branch: "main",
        visibility: "public", archived: false, namespace: { id: 77, path: "restored", full_path: "restored", kind: "group" },
        permissions: { project_access: { access_level: 50 } },
      };
    },
    "POST https://gitlab.com/api/v4/projects/": async (req) => (gitlabHooks.push(req.url), { id: 999 }),
  });
});

// ---------- fixtures ----------

async function person(flags: { admin?: boolean; gitlab?: boolean } = {}) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, is_admin, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, login, `${login}@example.com`, flags.admin ? 1 : 0, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  if (flags.gitlab) {
    const { encrypt } = await import("../src/lib/crypto");
    await DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, created_at) VALUES (?, ?, 'gitlab', ?, ?, ?, ?)`)
      .bind(ulid(), id, uniq(), login, await encrypt(env.TOKEN_ENC_KEY, `glpat_${login}`), Date.now()).run();
  }
  return { id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function namespace(owner: { id: string }, extra: { id: string; role: string }[] = []) {
  const id = ulid();
  const name = `ns${uniq()}`;
  await DB().batch([
    DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, created_at) VALUES (?, 'github', ?, ?, 'user', 'active', ?)`).bind(id, uniq(), name, Date.now()),
    DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(id, owner.id),
    ...extra.map((m) => DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, ?)`).bind(id, m.id, m.role)),
  ]);
  return { id, name };
}

const DIGEST = `sha256:${"b".repeat(64)}`;
const WHEEL_SHA = "c".repeat(64);

function manifest(ns: string, name: string, version: string, opts: { license?: string; pipx?: boolean } = {}) {
  return {
    schema: 1, kind: "tool", name, namespace: ns, version, summary: "Looks things up for the week 11 tests", readme: "README.md", license: opts.license ?? "MIT",
    categories: ["utilities"], inputs: [{ name: "domain", type: "domain", required: true }], outputs: [{ type: "organization" }],
    runtime: opts.pipx
      ? { kind: "pipx", package: name, package_version: version, wheel_sha256: WHEEL_SHA, command: [name, "{domain}"], output_format: "json" }
      : { kind: "docker", image: `ghcr.io/${ns}/${name}@${DIGEST}`, platforms: ["linux/amd64"], command: [name, "{domain}"], output_format: "json" },
    ethics: { touches_target: false, auth_required: false, collects_personal_data: false },
  };
}

/** A package with one version (published unless a status is given) and a GitHub source. */
async function pkg(ns: { id: string; name: string }, opts: { status?: string; license?: string; pipx?: boolean; visibility?: string; syncStatus?: string } = {}) {
  const toolId = ulid();
  const versionId = ulid();
  const name = `tool${uniq()}`;
  const now = Date.now();
  const m = manifest(ns.name, name, "1.0.0", opts);
  await DB().batch([
    DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, repo_url, created_at, updated_at) VALUES (?, ?, 'tool', ?, 'x', ?, ?, ?)`)
      .bind(toolId, ns.id, name, `https://github.com/${ns.name}/${name}`, now, now),
    DB().prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, status, signer_identity, signer_issuer, published_at, created_at)
       VALUES (?, ?, '1.0.0', 1, 0, 0, ?, ?, ?, 'https://github.com/x/y/.github/workflows/r.yml@refs/tags/v1.0.0', 'https://token.actions.githubusercontent.com', ?, ?)`,
    ).bind(versionId, toolId, JSON.stringify(m), opts.pipx ? "pipx" : "docker", opts.status ?? "published", now, now),
    DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(opts.status && opts.status !== "published" ? null : versionId, toolId),
    DB().prepare(
      `INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url, installation_id, visibility, sync_status, created_at)
       VALUES (?, ?, ?, 'github', ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(ulid(), toolId, ns.id, uniq(), `${ns.name}/${name}`, `https://github.com/${ns.name}/${name}`, opts.visibility ?? "public", opts.syncStatus ?? "ok", now),
  ]);
  return { toolId, versionId, name, ref: `${ns.name}/${name}` };
}

const mirrorEnv = (): MirrorEnv => ({ MIRROR: env.MIRROR, MIRROR_PUSH_TOKEN: "push-secret" });
const basic = `Basic ${btoa("scanner:push-secret")}`;
const M = "https://mirror.otinstaller.com";
const mirror = (path: string, init: RequestInit = {}) => mirrorFetch(new Request(`${M}${path}`, init), mirrorEnv());
const digestOf = async (bytes: Uint8Array | string) => `sha256:${toHex(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes))}`;

/** Pushes a one-layer image to the mirror and returns its manifest digest. */
async function pushImage(name: string, layer = `layer ${uniq()}`) {
  const config = JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } });
  for (const blob of [layer, config]) {
    const d = await digestOf(blob);
    const r = await mirror(`/v2/${name}/blobs/uploads/?digest=${d}`, { method: "POST", headers: { authorization: basic, "content-length": String(blob.length) }, body: blob });
    expect(r.status).toBe(201);
  }
  const doc = JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: await digestOf(config), size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: await digestOf(layer), size: layer.length }],
  });
  const d = await digestOf(doc);
  const put = await mirror(`/v2/${name}/manifests/${d}`, { method: "PUT", headers: { authorization: basic, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc });
  expect(put.status).toBe(201);
  return { digest: d, layer: await digestOf(layer) };
}

// ---------- rules ----------

describe("license rules", () => {
  it.each([
    ["MIT", true], ["Apache-2.0", true], ["GPL-3.0-or-later", true], ["MIT OR Apache-2.0", true], ["(MIT AND BSD-3-Clause)", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", true], ["Unlicense", true], ["LicenseRef-Proprietary", false], ["CC-BY-4.0", false],
    ["MIT AND LicenseRef-Proprietary", false], ["LicenseRef-x OR MIT", true], ["", false],
  ])("%s → public mirror: %s", (expr, want) => {
    expect(osiApproved(expr)).toBe(want);
  });
});

describe("presigned URLs", () => {
  it("match AWS's published SigV4 example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await presignSigV4({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400, now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});

// ---------- the mirror ----------

describe("image mirror", () => {
  it("asks for a token the standard way and hands out pull tokens to anyone, push tokens only for the credential", async () => {
    const ping = await mirror("/v2/");
    expect(ping.status).toBe(401);
    expect(ping.headers.get("www-authenticate")).toBe(`Bearer realm="${M}/token",service="mirror.otinstaller.com"`);
    const anon = (await (await mirror("/token?scope=repository:a/b:pull")).json()) as { token: string };
    expect((await mirror("/v2/", { headers: { authorization: `Bearer ${anon.token}` } })).status).toBe(200);
    const write = await mirror("/v2/a/b/blobs/uploads/", { method: "POST", headers: { authorization: `Bearer ${anon.token}` } });
    expect(write.status).toBe(401);
    expect(write.headers.get("www-authenticate")).toContain(`scope="repository:a/b:pull,push"`);
    expect((await mirror("/token", { headers: { authorization: `Basic ${btoa("x:wrong")}` } })).status).toBe(401);
    const push = (await (await mirror("/token", { headers: { authorization: basic } })).json()) as { token: string };
    expect((await mirror("/v2/a/b/blobs/uploads/", { method: "POST", headers: { authorization: `Bearer ${push.token}` } })).status).toBe(202);
    // Without a configured credential nobody can push.
    const open = await mirrorFetch(new Request(`${M}/v2/a/b/blobs/uploads/`, { method: "POST", headers: { authorization: basic } }), { MIRROR: env.MIRROR });
    expect(open.status).toBe(401);
  });

  it("joins chunked uploads, checks the digest, and serves the image to the public by digest", async () => {
    const name = `ns${uniq()}/chunked`;
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const d = await digestOf(big);
    const start = await mirror(`/v2/${name}/blobs/uploads/`, { method: "POST", headers: { authorization: basic } });
    let loc = start.headers.get("location")!;
    for (let off = 0; off < big.length; off += 100_000) {
      const chunk = big.slice(off, off + 100_000);
      const r = await mirror(loc, { method: "PATCH", headers: { authorization: basic, "content-range": `${off}-${off + chunk.length - 1}`, "content-length": String(chunk.length) }, body: chunk });
      expect(r.status).toBe(202);
      expect(r.headers.get("range")).toBe(`0-${off + chunk.length - 1}`);
      loc = r.headers.get("location")!;
    }
    // A chunk at the wrong offset is refused.
    expect((await mirror(loc, { method: "PATCH", headers: { authorization: basic, "content-range": "5-9", "content-length": "5" }, body: "xxxxx" })).status).toBe(416);
    const done = await mirror(`${loc}?digest=${d}`, { method: "PUT", headers: { authorization: basic, "content-length": "0" } });
    expect(done.status).toBe(201);
    const blob = await mirror(`/v2/${name}/blobs/${d}`);
    expect(blob.status).toBe(200);
    expect(await digestOf(new Uint8Array(await blob.arrayBuffer()))).toBe(d);

    // Content that does not hash to the digest is thrown away.
    const wrong = await mirror(`/v2/${name}/blobs/uploads/?digest=sha256:${"0".repeat(64)}`, { method: "POST", headers: { authorization: basic, "content-length": "3" }, body: "abc" });
    expect(wrong.status).toBe(400);
    expect((await mirror(`/v2/${name}/blobs/sha256:${"0".repeat(64)}`)).status).toBe(404);
  });

  it("refuses manifests whose blobs are missing, and keeps tags", async () => {
    const name = `ns${uniq()}/tool`;
    const missing = JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${"1".repeat(64)}` }, layers: [] });
    const r = await mirror(`/v2/${name}/manifests/v1`, { method: "PUT", headers: { authorization: basic, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: missing });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");

    const { digest } = await pushImage(name);
    const sigTag = `sha256-${digest.slice(7)}.sig`;
    const doc = await (await mirror(`/v2/${name}/manifests/${digest}`)).text();
    expect((await mirror(`/v2/${name}/manifests/${sigTag}`, { method: "PUT", headers: { authorization: basic, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc })).status).toBe(201);
    const got = await mirror(`/v2/${name}/manifests/${sigTag}`, { method: "HEAD" });
    expect(got.headers.get("docker-content-digest")).toBe(digest);
    expect(((await (await mirror(`/v2/${name}/tags/list`)).json()) as any).tags).toEqual([sigTag]);
    // The referrers API is not offered, so cosign falls back to the tag schema.
    expect((await mirror(`/v2/${name}/referrers/${digest}`)).status).toBe(404);
  });

  it("keeps private repositories and hidden images away from the public", async () => {
    const ns = `ns${uniq()}`;
    const priv = await pushImage(`private/${ns}/tool`);
    expect((await mirror(`/v2/private/${ns}/tool/manifests/${priv.digest}`)).status).toBe(401);
    expect((await mirror(`/v2/private/${ns}/tool/manifests/${priv.digest}`, { headers: { authorization: basic } })).status).toBe(200);

    const pub = await pushImage(`${ns}/tool`);
    // Another image in the same repository, sharing nothing with the first, and tags for both (one a signature).
    const other = await pushImage(`${ns}/tool`);
    const tag = async (t: string, digest: string) => {
      const doc = await (await mirror(`/v2/${ns}/tool/manifests/${digest}`)).text();
      expect((await mirror(`/v2/${ns}/tool/manifests/${t}`, { method: "PUT", headers: { authorization: basic, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc })).status).toBe(201);
    };
    await tag("1.0.0", pub.digest);
    await tag(`sha256-${pub.digest.slice(7)}.sig`, pub.digest);
    await tag("2.0.0", other.digest);
    await hideImage(env.MIRROR, `${ns}/tool`, pub.digest);
    expect((await mirror(`/v2/${ns}/tool/manifests/${pub.digest}`)).status).toBe(404);
    expect((await mirror(`/v2/${ns}/tool/manifests/${pub.digest}`, { headers: { authorization: basic } })).status).toBe(200);
    // A single hidden image's layers and tags aren't served either; the rest of the repository is.
    expect((await mirror(`/v2/${ns}/tool/blobs/${pub.layer}`)).status).toBe(404);
    expect((await mirror(`/v2/${ns}/tool/blobs/${pub.layer}`, { headers: { authorization: basic } })).status).toBe(200);
    expect((await mirror(`/v2/${ns}/tool/blobs/${other.layer}`)).status).toBe(200);
    expect(((await (await mirror(`/v2/${ns}/tool/tags/list`)).json()) as any).tags).toEqual(["2.0.0"]);
    expect(((await (await mirror(`/v2/${ns}/tool/tags/list`, { headers: { authorization: basic } })).json()) as any).tags).toHaveLength(3);
    await hideImage(env.MIRROR, `${ns}/tool`, null);
    expect((await mirror(`/v2/${ns}/tool/blobs/${other.layer}`)).status).toBe(404);
    expect((await mirror(`/v2/${ns}/tool/tags/list`)).status).toBe(404);
  });

  it("deletes an image with its signatures and the blobs nothing else uses", async () => {
    const name = `ns${uniq()}/gc`;
    const a = await pushImage(name, "shared-and-a");
    const b = await pushImage(name, "only-b");
    const doc = await (await mirror(`/v2/${name}/manifests/${b.digest}`)).text();
    await mirror(`/v2/${name}/manifests/sha256-${b.digest.slice(7)}.sig`, { method: "PUT", headers: { authorization: basic, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc });
    expect((await mirror(`/v2/${name}/manifests/${b.digest}`, { method: "DELETE" })).status).toBe(401);
    const out = await deleteImage(env.MIRROR, name, b.digest);
    expect(out.manifests).toBe(1);
    expect((await mirror(`/v2/${name}/manifests/${b.digest}`)).status).toBe(404);
    expect((await mirror(`/v2/${name}/blobs/${b.layer}`)).status).toBe(404);
    expect((await mirror(`/v2/${name}/manifests/${a.digest}`)).status).toBe(200);
    expect((await mirror(`/v2/${name}/blobs/${a.layer}`)).status).toBe(200);
    expect(((await (await mirror(`/v2/${name}/tags/list`)).json()) as any).tags).toEqual([]);
  });
});

// ---------- images publishers push ----------

const tokenOf = (p: { auth: { authorization: string } }) => p.auth.authorization.slice("Bearer ".length);
const mirrorWithDb = (): MirrorEnv => ({ ...mirrorEnv(), DB: env.DB });
const pmirror = (path: string, init: RequestInit = {}) => mirrorFetch(new Request(`${M}${path}`, init), mirrorWithDb());

/** A push token for a publisher's `ot_` token, for the repositories it asks for. */
async function publisherToken(otToken: string, repo: string) {
  const res = await pmirror(`/token?service=mirror.otinstaller.com&scope=repository:${repo}:pull,push`, { headers: { authorization: `Basic ${btoa(`ot:${otToken}`)}` } });
  expect(res.status).toBe(200);
  return `Bearer ${((await res.json()) as { token: string }).token}`;
}

/** Pushes a one-layer image as a publisher (blobs, then the manifest by tag) and returns its digest. */
async function publisherPush(auth: string, name: string, tag = "1.0.0", layer = `layer ${uniq()}`) {
  const config = JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } });
  for (const blob of [layer, config]) {
    const r = await pmirror(`/v2/${name}/blobs/uploads/?digest=${await digestOf(blob)}`, { method: "POST", headers: { authorization: auth, "content-length": String(blob.length) }, body: blob });
    expect(r.status, await r.clone().text()).toBe(201);
  }
  const doc = JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: await digestOf(config), size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: await digestOf(layer), size: layer.length }],
  });
  const put = await pmirror(`/v2/${name}/manifests/${tag}`, { method: "PUT", headers: { authorization: auth, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc });
  return { status: put.status, digest: put.headers.get("docker-content-digest")!, doc, body: put.status === 201 ? "" : await put.text() };
}

/** A signature-like manifest for an image: its own bytes (so its own digest), pointing at blobs the image pushed. */
const signatureDoc = (imageDoc: string) => JSON.stringify({ ...JSON.parse(imageDoc), layers: [], annotations: { "dev.cosignproject.cosign/signature": "x" } });

describe("images publishers push to the mirror", () => {
  it("lets a namespace's members push to its repositories with their ot_ token, and nobody else", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const auth = await publisherToken(tokenOf(owner), repo);
    const pushed = await publisherPush(auth, repo);
    expect(pushed.status).toBe(201);
    const row = await DB().prepare(`SELECT tag, user_id FROM mirror_pushes WHERE repo = ? AND digest = ?`).bind(repo, pushed.digest).first<any>();
    expect(row).toEqual({ tag: "1.0.0", user_id: owner.id });

    // Someone outside the namespace gets a token without push rights, then 403 DENIED, as with Basic auth.
    const stranger = await person();
    const theirs = await publisherToken(tokenOf(stranger), repo);
    expect((await pmirror(`/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: theirs } })).status).toBe(403);
    const denied = await pmirror(`/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: `Basic ${btoa(`ot:${tokenOf(stranger)}`)}` } });
    expect(((await denied.json()) as any).errors[0].code).toBe("DENIED");
    // Only <namespace>/<name>: not the namespace's private copies, and not deeper paths.
    expect((await pmirror(`/v2/private/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: `Basic ${btoa(`ot:${tokenOf(owner)}`)}` } })).status).toBe(403);
    // Deleting stays the scanner's.
    expect((await pmirror(`/v2/${repo}/manifests/${pushed.digest}`, { method: "DELETE", headers: { authorization: auth } })).status).toBe(403);
    // Anonymous writes still get the challenge.
    expect((await pmirror(`/v2/${repo}/blobs/uploads/`, { method: "POST" })).status).toBe(401);
  });

  it("needs the publish scope, a namespace in good standing and a mirror secret", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const readOnly = `ot_test_ro_${ulid()}`;
    await DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES (?, ?, 'ro', ?, 'read', 1, ?)`)
      .bind(ulid(), owner.id, await sha256Hex(readOnly), Date.now()).run();
    expect((await pmirror(`/token?scope=repository:${repo}:push`, { headers: { authorization: `Basic ${btoa(`ot:${readOnly}`)}` } })).status).toBe(401);

    await DB().prepare(`UPDATE namespaces SET status = 'suspended' WHERE id = ?`).bind(ns.id).run();
    const suspended = await publisherToken(tokenOf(owner), repo);
    expect((await pmirror(`/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: suspended } })).status).toBe(403);

    // Without the secret the mirror can't sign push grants, so publishers can't push at all.
    await DB().prepare(`UPDATE namespaces SET status = 'active' WHERE id = ?`).bind(ns.id).run();
    const noSecret = await mirrorFetch(new Request(`${M}/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: `Basic ${btoa(`ot:${tokenOf(owner)}`)}` } }), { MIRROR: env.MIRROR, DB: env.DB });
    expect(noSecret.status).toBe(401);
  });

  it("answers containerd's OAuth2 password grant, and sends other grants back to GET", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const form = (body: Record<string, string>) => pmirror("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    const ok = await form({ grant_type: "password", username: "ot", password: tokenOf(owner), service: "mirror.otinstaller.com", scope: `repository:${repo}:pull,push` });
    expect(ok.status).toBe(200);
    const auth = `Bearer ${((await ok.json()) as any).access_token}`;
    expect((await pmirror(`/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: auth } })).status).toBe(202);
    expect((await form({ grant_type: "refresh_token", refresh_token: "x" })).status).toBe(400);
  });

  it("keeps a pushed image from the public until a published version uses it", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const auth = await publisherToken(tokenOf(owner), repo);
    const { digest } = await publisherPush(auth, repo);
    expect((await pmirror(`/v2/${repo}/manifests/${digest}`)).status).toBe(404);
    expect((await pmirror(`/v2/${repo}/manifests/1.0.0`)).status).toBe(404);
    // Its publishers (cosign has to read it to sign it) and the scanner can.
    expect((await pmirror(`/v2/${repo}/manifests/${digest}`, { headers: { authorization: auth } })).status).toBe(200);
    expect((await pmirror(`/v2/${repo}/manifests/${digest}`, { headers: { authorization: basic } })).status).toBe(200);
    await releaseImage(env.MIRROR, repo, digest);
    expect((await pmirror(`/v2/${repo}/manifests/1.0.0`)).status).toBe(200);
  });

  it("lets publishers sign their own images, but not replace a backup copy's signatures", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const auth = await publisherToken(tokenOf(owner), repo);
    const mine = await publisherPush(auth, repo);
    const sig = await pmirror(`/v2/${repo}/manifests/sha256-${mine.digest.slice(7)}.sig`, { method: "PUT", headers: { authorization: auth, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: signatureDoc(mine.doc) });
    expect(sig.status).toBe(201);
    // Before the image is published its signature is as private as the image: its publishers and the scanner read it,
    // anyone else learns nothing (not even the digest from the tag list), and neither layer nor config can be fetched.
    const sigPath = `/v2/${repo}/manifests/sha256-${mine.digest.slice(7)}.sig`;
    expect((await pmirror(sigPath)).status).toBe(404);
    expect((await pmirror(sigPath, { headers: { authorization: auth } })).status).toBe(200);
    expect((await pmirror(sigPath, { headers: { authorization: basic } })).status).toBe(200);
    expect(((await (await pmirror(`/v2/${repo}/tags/list`)).json()) as any).tags).toEqual([]);
    const layer = JSON.parse(mine.doc).layers[0].digest;
    expect((await pmirror(`/v2/${repo}/blobs/${layer}`)).status).toBe(404);
    expect((await pmirror(`/v2/${repo}/blobs/${layer}`, { headers: { authorization: auth } })).status).toBe(200);
    await releaseImage(env.MIRROR, repo, mine.digest);
    expect((await pmirror(sigPath)).status).toBe(200);
    expect((await pmirror(`/v2/${repo}/blobs/${layer}`)).status).toBe(200);

    const backup = await pushImage(repo);
    const forged = await pmirror(`/v2/${repo}/manifests/sha256-${backup.digest.slice(7)}.sig`, { method: "PUT", headers: { authorization: auth, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: signatureDoc(mine.doc) });
    expect(forged.status).toBe(403);
  });

  it("limits what a namespace can push", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const auth = await publisherToken(tokenOf(owner), repo);
    // At most 30 version tags an hour.
    await DB().batch(Array.from({ length: 30 }, (_, i) => DB().prepare(
      `INSERT INTO mirror_pushes (id, repo, digest, tag, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(ulid(), `${ns.name}/other`, `sha256:${String(i).padStart(64, "0")}`, `0.0.${i}`, Date.now())));
    const many = await publisherPush(auth, repo);
    expect(many.status).toBe(429);
    // At most 10 GiB of blobs a day.
    const ns2 = await namespace(owner);
    await DB().prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)`)
      .bind(`mirror_bytes|${ns2.name}`, Math.floor(Date.now() / 86_400_000) * 86_400_000, 10 * 1024 ** 3).run();
    const auth2 = await publisherToken(tokenOf(owner), `${ns2.name}/tool`);
    const blob = "one more byte";
    const over = await pmirror(`/v2/${ns2.name}/tool/blobs/uploads/?digest=${await digestOf(blob)}`, { method: "POST", headers: { authorization: auth2, "content-length": String(blob.length) }, body: blob });
    expect(over.status).toBe(429);
    // An image of at most 2 GiB: its blobs' sizes come from their pointers.
    const ns3 = await namespace(owner);
    const big = `sha256:${"9".repeat(64)}`;
    await env.MIRROR.put(`repos/${ns3.name}/tool/blobs/${big}`, JSON.stringify({ size: 3 * 1024 ** 3, parts: [] }));
    const doc = JSON.stringify({ schemaVersion: 2, config: { digest: big }, layers: [] });
    const auth3 = await publisherToken(tokenOf(owner), `${ns3.name}/tool`);
    expect((await pmirror(`/v2/${ns3.name}/tool/manifests/1.0.0`, { method: "PUT", headers: { authorization: auth3, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: doc })).status).toBe(413);
  });

  it("stores a body without a Content-Length in parts instead of buffering it", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const auth = await publisherToken(tokenOf(owner), repo);
    const data = new TextEncoder().encode("streamed layer ".repeat(1000));
    const start = await pmirror(`/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: auth } });
    const body = new ReadableStream({ start(c) { c.enqueue(data.slice(0, 5000)); c.enqueue(data.slice(5000)); c.close(); } });
    const patch = await mirrorFetch(new Request(`${M}${start.headers.get("location")}`, { method: "PATCH", headers: { authorization: auth }, body, duplex: "half" } as RequestInit), mirrorWithDb());
    expect(patch.status).toBe(202);
    expect(patch.headers.get("range")).toBe(`0-${data.length - 1}`);
    const done = await pmirror(`${patch.headers.get("location")}?digest=${await digestOf(data)}`, { method: "PUT", headers: { authorization: auth, "content-length": "0" } });
    expect(done.status).toBe(201);
  });

  it("sweeps images no version uses, keeping published ones, their signatures and what backups hold", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const repo = `${ns.name}/tool`;
    const auth = await publisherToken(tokenOf(owner), repo);
    const kept = await publisherPush(auth, repo, "1.0.0", "kept layer");
    await pmirror(`/v2/${repo}/manifests/sha256-${kept.digest.slice(7)}.sig`, { method: "PUT", headers: { authorization: auth, "content-type": "application/vnd.oci.image.manifest.v1+json" }, body: signatureDoc(kept.doc) });
    const unused = await publisherPush(auth, repo, "1.1.0", "unused layer");
    const backup = await pushImage(repo, "backup layer");
    const later = Date.now() + 8 * 86_400_000;
    const out = await sweepRepo(env.MIRROR, repo, new Set([kept.digest, backup.digest]), { now: later });
    expect(out.manifests).toBe(1);
    const admin = { headers: { authorization: basic } };
    expect((await pmirror(`/v2/${repo}/manifests/${unused.digest}`, admin)).status).toBe(404);
    expect((await pmirror(`/v2/${repo}/manifests/${kept.digest}`, admin)).status).toBe(200);
    expect((await pmirror(`/v2/${repo}/manifests/sha256-${kept.digest.slice(7)}.sig`, admin)).status).toBe(200);
    expect((await pmirror(`/v2/${repo}/manifests/${backup.digest}`, admin)).status).toBe(200);
    expect(((await (await pmirror(`/v2/${repo}/tags/list`, admin)).json()) as any).tags).not.toContain("1.1.0");
    // Nothing is swept while it is young.
    const fresh = await publisherPush(auth, repo, "1.2.0");
    await sweepRepo(env.MIRROR, repo, new Set([kept.digest]));
    expect((await pmirror(`/v2/${repo}/manifests/${fresh.digest}`, admin)).status).toBe(200);
  });

  it("clears blob uploads nobody finished", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const auth = await publisherToken(tokenOf(owner), `${ns.name}/tool`);
    const start = await pmirror(`/v2/${ns.name}/tool/blobs/uploads/`, { method: "POST", headers: { authorization: auth } });
    const id = start.headers.get("docker-upload-uuid")!;
    expect(await env.MIRROR.head(`uploads/${id}.json`)).not.toBeNull();
    await purgeUploads(env.MIRROR, { now: Date.now() + 2 * 86_400_000 });
    expect(await env.MIRROR.head(`uploads/${id}.json`)).toBeNull();
  });
});

// ---------- release backups ----------

async function scanning(p: Awaited<ReturnType<typeof pkg>>) {
  const token = `scan-${uniq()}`;
  await DB().prepare(`UPDATE versions SET status = 'scanning', scan_token_hash = ?, scan_token_expires_at = ? WHERE id = ?`)
    .bind(await sha256Hex(token), Date.now() + 3600e3, p.versionId).run();
  return token;
}

const clean = {
  signature: { status: "pass", identity: "https://github.com/x/y/.github/workflows/r.yml@refs/tags/v1.0.0", issuer: "https://token.actions.githubusercontent.com" },
  vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0, fixable_critical: 0, fixable_high: 0 },
  secrets: { count: 0 }, malware: { count: 0 }, smoke: { status: "pass", exit_code: 0 },
};

async function scanCallback(token: string) {
  const res = await call("/internal/scans", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(clean) });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; backup?: BackupPlan };
}

/** Does what the scanner does with a plan: uploads through the signed URLs (and pushes images), then reports. */
async function runPlan(plan: BackupPlan, override: Record<string, Partial<{ status: string; size_bytes: number; sha256: string; body: string }>> = {}) {
  const items = [];
  for (const it of plan.items) {
    const o = override[it.kind] ?? {};
    const body = o.body ?? `${it.kind} bytes ${uniq()}`;
    if (it.kind !== "image" && (o.status ?? "stored") === "stored") {
      const url = new URL(it.upload_url as string);
      const put = await call(url.pathname.replace(/^\/v1/, "") + url.search, { method: "PUT", headers: { "content-length": String(body.length) }, body });
      expect(put.status).toBe(200);
    }
    items.push({ id: it.id, status: o.status ?? "stored", size_bytes: o.size_bytes ?? body.length, sha256: o.sha256 ?? (it.kind === "wheel" ? WHEEL_SHA : await digestOf(body)), filename: it.kind === "wheel" ? "tool-1.0.0-py3-none-any.whl" : undefined, refs_count: 3 });
  }
  return call(`/internal/backups/${plan.run_id}`, { method: "POST", headers: { authorization: `Bearer ${plan.token}`, "content-type": "application/json" }, body: JSON.stringify({ items }) });
}

describe("backups after a passing scan", () => {
  it("answers the scan callback with signed upload URLs for the image, the wheel or the bundle", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns, { status: "scanning" });
    const out = await scanCallback(await scanning(p));
    expect(out.status).toBe("published");
    const plan = out.backup!;
    expect(plan.complete_url).toBe(`https://api.otinstaller.com/v1/internal/backups/${plan.run_id}`);
    const image = plan.items.find((i) => i.kind === "image")!;
    expect(image).toMatchObject({ source: `ghcr.io/${ns.name}/${p.name}@${DIGEST}`, target: `mirror.otinstaller.com/${ns.name}/${p.name}`, digest: DIGEST, max_bytes: 2 * 1024 ** 3, visibility: "public" });
    const git = plan.items.find((i) => i.kind === "git")!;
    expect(git).toMatchObject({ clone_url: `https://github.com/${p.ref}.git`, max_bytes: 500 * 1024 ** 2 });
    expect(git.key as string).toMatch(new RegExp(`^git/github/\\d+/\\d{4}-\\d\\d-\\d\\d-v1\\.0\\.0\\.bundle$`));
    expect(git.upload_url as string).toMatch(/^https:\/\/api\.otinstaller\.com\/v1\/internal\/backups\/objects\/git\/.+\?method=PUT&expires=\d+&sig=[0-9a-f]{64}$/);
    // The scanner backs it up itself, so publishing queued no separate backup job.
    expect(sent.some((m: any) => m.backupVersionId === p.versionId)).toBe(false);
  });

  it("keeps non-OSI images private, skips git for private or unavailable sources and for owners who opted out", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const prop = await pkg(ns, { license: "LicenseRef-Proprietary" });
    const plan = (await releasePlan(env as any, prop.versionId))!;
    expect(plan.items.find((i) => i.kind === "image")).toMatchObject({ target: `mirror.otinstaller.com/private/${ns.name}/${prop.name}`, visibility: "private" });

    const gone = await pkg(ns, { syncStatus: "unavailable" });
    expect((await releasePlan(env as any, gone.versionId))!.items.map((i) => i.kind)).toEqual(["image"]);
    const optOut = await pkg(ns);
    await DB().prepare(`UPDATE tools SET git_backups = 0 WHERE id = ?`).bind(optOut.toolId).run();
    expect((await releasePlan(env as any, optOut.versionId))!.items.map((i) => i.kind)).toEqual(["image"]);
    const unpublished = await pkg(ns, { status: "awaiting_review" });
    expect(await releasePlan(env as any, unpublished.versionId)).toBeNull();
  });

  it("records what arrived, checks sizes and hashes, and the token works once", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns, { pipx: true });
    const plan = (await releasePlan(env as any, p.versionId))!;
    expect(plan.items.map((i) => i.kind).sort()).toEqual(["git", "wheel"]);
    const res = await runPlan(plan);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).items).toEqual({ wheel: "stored", git: "stored" });
    expect((await runPlan(plan)).status).toBe(401);

    // The registry's copy of the wheel is offered to ot, and served with the same bytes.
    const m = (await (await call(`/tools/${p.ref}/1.0.0/manifest`)).json()) as any;
    expect(m.wheel_url).toBe(`https://api.otinstaller.com/v1/tools/${p.ref}/1.0.0/wheel/tool-1.0.0-py3-none-any.whl`);
    const wheel = await call(new URL(m.wheel_url).pathname.replace(/^\/v1/, ""));
    expect(wheel.status).toBe(200);
    expect(wheel.headers.get("x-checksum-sha256")).toBe(WHEEL_SHA);
    expect(await wheel.text()).toMatch(/^wheel bytes/);

    // A wheel whose hash does not match the manifest is not kept.
    const p2 = await pkg(ns, { pipx: true });
    const plan2 = (await releasePlan(env as any, p2.versionId))!;
    await runPlan(plan2, { wheel: { sha256: "d".repeat(64) } });
    const row = await DB().prepare(`SELECT status, detail FROM backups WHERE version_id = ? AND kind = 'wheel'`).bind(p2.versionId).first<any>();
    expect(row).toMatchObject({ status: "failed" });
    expect(await env.BACKUPS.head(plan2.items.find((i) => i.kind === "wheel")!.key as string)).toBeNull();
  });

  it("tells the owner when a bundle or image is over the limit and keeps the rest", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const plan = (await releasePlan(env as any, p.versionId))!;
    const image = plan.items.find((i) => i.kind === "image")!;
    // Push the image the plan names, as crane copy would.
    const name = (image.target as string).replace("mirror.otinstaller.com/", "");
    const pushed = await pushImage(name);
    await DB().prepare(`UPDATE backups SET location = ? WHERE id = ?`).bind(`${name}@${pushed.digest}`, image.id).run();
    const res = await runPlan(plan, { git: { status: "too_large", size_bytes: 600 * 1024 ** 2 } });
    expect(((await res.json()) as any).items).toEqual({ image: "stored", git: "too_large" });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toEqual([`${owner.login}@example.com`]);
    expect(emails[0]!.text).toContain("git repository bundle (limit 500 MB): 600 MB");
    const m = (await (await call(`/tools/${p.ref}/1.0.0/manifest`)).json()) as any;
    expect(m.mirror_image).toBe(`mirror.otinstaller.com/${name}@${pushed.digest}`);
  });

  it("an image the scanner says it copied must be in the mirror", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const plan = (await releasePlan(env as any, p.versionId))!;
    await runPlan(plan);
    const row = await DB().prepare(`SELECT status, detail FROM backups WHERE version_id = ? AND kind = 'image'`).bind(p.versionId).first<any>();
    expect(row).toEqual({ status: "failed", detail: "the image is not in the mirror" });
    expect(((await (await call(`/tools/${p.ref}/1.0.0/manifest`)).json()) as any).mirror_image).toBeUndefined();
  });

  it("signed object URLs refuse tampering and expiry", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const plan = (await releasePlan(env as any, p.versionId))!;
    const url = new URL(plan.items.find((i) => i.kind === "git")!.upload_url as string);
    const path = url.pathname.replace(/^\/v1/, "");
    const tampered = await call(path.replace("git/", "git/x") + url.search, { method: "PUT", headers: { "content-length": "1" }, body: "x" });
    expect(tampered.status).toBe(403);
    const asGet = await call(path + url.search.replace("method=PUT", "method=GET"));
    expect(asGet.status).toBe(403);
    const old = url.search.replace(/expires=\d+/, "expires=1");
    expect((await call(path + old, { method: "PUT", headers: { "content-length": "1" }, body: "x" })).status).toBe(403);
  });

  it("versions published without a scanner run (approved releases) get their own backup job", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns, { status: "awaiting_review" });
    const e = await testEnv();
    await publishVersion(e, p.versionId);
    expect(sent).toContainEqual({ backupVersionId: p.versionId });
    const acks: string[] = [];
    await handleBatch({ messages: [{ body: { backupVersionId: p.versionId }, attempts: 1, ack: () => acks.push("ack"), retry: () => acks.push("retry") }] } as any, e);
    expect(acks).toEqual(["ack"]);
    const d = dispatches.find((x) => x.event_type === "otinstaller-backup")!;
    expect(d.client_payload.backup.jobs[0]).toMatchObject({ ref: p.ref, items: expect.arrayContaining([expect.objectContaining({ kind: "image" })]) });
    expect((await DB().prepare(`SELECT status FROM backup_runs WHERE version_id = ?`).bind(p.versionId).first<any>()).status).toBe("dispatched");
  });
});

// ---------- weekly ----------

describe("backfill", () => {
  it("backs up published versions that have no image or wheel backup, once a day each", async () => {
    // Clear what other tests left so this run only sees its own packages.
    await DB().prepare(`UPDATE versions SET status = 'yanked' WHERE status = 'published' AND id NOT IN (SELECT version_id FROM backups WHERE version_id IS NOT NULL)`).run();
    await DB().prepare(`UPDATE versions SET status = 'removed' WHERE status = 'yanked' AND id NOT IN (SELECT version_id FROM backups WHERE version_id IS NOT NULL)`).run();
    const owner = await person();
    const ns = await namespace(owner);
    const old = await pkg(ns);
    const wheel = await pkg(ns, { pipx: true });
    const done = await pkg(ns);
    await runPlan((await releasePlan(env as any, done.versionId))!, { image: { status: "too_large", size_bytes: 3 * 1024 ** 3 } });
    dispatches.length = 0;

    expect(await backfillBackups(await testEnv(), Date.now(), 10)).toBe(2);
    const jobs = dispatches.flatMap((d) => d.client_payload.backup.jobs) as BackupPlan[];
    expect(jobs.map((j) => j.ref).sort()).toEqual([old.ref, wheel.ref].sort());
    expect(jobs.find((j) => j.ref === wheel.ref)!.items.map((i) => i.kind).sort()).toEqual(["git", "wheel"]);
    // Jobs in flight (or failed in the last day) are not sent again.
    expect(await backfillBackups(await testEnv(), Date.now(), 10)).toBe(0);
    await DB().prepare(`UPDATE backups SET status = 'failed' WHERE version_id = ?`).bind(old.versionId).run();
    // A day later a failed backup is retried; one still in progress is not.
    dispatches.length = 0;
    await backfillBackups(await testEnv(), Date.now() + 2 * 86_400_000, 50);
    const retried = dispatches.flatMap((d) => d.client_payload.backup.jobs.map((j: BackupPlan) => j.ref));
    expect(retried).toContain(old.ref);
    expect(retried).not.toContain(wheel.ref);
    expect(retried).not.toContain(done.ref);
  });
});

describe("weekly git backups", () => {
  it("dispatches a bundle job for every active public source and keeps the last 4 weekly bundles", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const active = await pkg(ns);
    const priv = await pkg(ns, { visibility: "private" });
    const gone = await pkg(ns, { syncStatus: "unavailable" });
    const out = await pkg(ns);
    await DB().prepare(`UPDATE tools SET git_backups = 0 WHERE id = ?`).bind(out.toolId).run();
    await weeklyBackups(await testEnv());
    const jobs = dispatches.filter((d) => d.event_type === "otinstaller-backup").flatMap((d) => d.client_payload.backup.jobs) as BackupPlan[];
    const refs = jobs.map((j) => j.ref);
    expect(refs).toContain(active.ref);
    for (const skipped of [priv, gone, out]) expect(refs).not.toContain(skipped.ref);
    const job = jobs.find((j) => j.ref === active.ref)!;
    expect(job.items).toHaveLength(1);
    expect(job.items[0]!.key as string).toMatch(/-weekly\.bundle$/);

    // Six weekly bundles later, only the newest four are left.
    const keys: string[] = [];
    for (let w = 0; w < 6; w++) {
      const id = ulid();
      const key = `git/github/test/${uniq()}-weekly.bundle`;
      keys.push(key);
      await env.BACKUPS.put(key, "bundle");
      await DB().prepare(`INSERT INTO backups (id, tool_id, kind, location, weekly, status, created_at, stored_at) VALUES (?, ?, 'git', ?, 1, 'stored', ?, ?)`)
        .bind(id, active.toolId, key, 1000 + w, 1000 + w).run();
    }
    await runPlan(job);
    const left = (await DB().prepare(`SELECT location FROM backups WHERE tool_id = ? AND kind = 'git' AND weekly = 1 AND status = 'stored'`).bind(active.toolId).all<any>()).results;
    expect(left).toHaveLength(KEEP_WEEKLY);
    expect(await env.BACKUPS.head(keys[0]!)).toBeNull();
    expect(await env.BACKUPS.head(keys[5]!)).not.toBeNull();
  });

  it("runs from the Monday cron", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    await worker.scheduled({ cron: "41 4 * * 1", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, await testEnv());
    expect(dispatches.filter((d) => d.event_type === "otinstaller-backup").flatMap((d) => d.client_payload.backup.jobs.map((j: any) => j.ref))).toContain(p.ref);
  });
});

// ---------- restores ----------

async function storedBundle(p: Awaited<ReturnType<typeof pkg>>, body = "# v2 git bundle\nrefs\n") {
  const plan = (await releasePlan(env as any, p.versionId))!;
  await runPlan(plan, { git: { body }, image: { status: "failed" } });
  return plan;
}

describe("restore from backup", () => {
  it("gives owners a download link for the latest bundle and the steps to move hosts", async () => {
    const owner = await person();
    const publisherUser = await person();
    const ns = await namespace(owner, [{ id: publisherUser.id, role: "publisher" }]);
    const p = await pkg(ns);
    expect(((await (await call(`/packages/${p.ref}/backups/restore`, { method: "POST", headers: owner.auth })).json()) as any).error.code).toBe("no_backup");
    await storedBundle(p, "the bundle bytes");

    expect((await call(`/packages/${p.ref}/backups/restore`, { method: "POST", headers: publisherUser.auth })).status).toBe(403);
    const res = await call(`/packages/${p.ref}/backups/restore`, { method: "POST", headers: owner.auth });
    expect(res.status).toBe(200);
    const link = (await res.json()) as any;
    expect(link).toMatchObject({ filename: expect.stringMatching(new RegExp(`^${p.name}-\\d{4}-\\d\\d-\\d\\d\\.bundle$`)), refs: 3, size_bytes: 16 });
    expect(link.steps.join("\n")).toContain("git push --mirror");
    const url = new URL(link.url);
    const dl = await call(url.pathname.replace(/^\/v1/, "") + url.search);
    expect(await dl.text()).toBe("the bundle bytes");

    const summary = (await (await call(`/packages/${p.ref}/backups`, { headers: owner.auth })).json()) as any;
    expect(summary).toMatchObject({ git_backups: true, latest_bundle: { refs: 3 } });
    const mine = (await (await call(`/me/backups`, { headers: owner.auth })).json()) as any;
    expect(mine.packages.find((x: any) => x.ref === p.ref)).toMatchObject({ git_backups: true, latest_bundle: { refs: 3 }, source: { provider: "github" } });
  });

  it("goes straight to R2 with presigned URLs when R2 credentials are set", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    await storedBundle(p);
    const e = { ...(await testEnv()), R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "secret" };
    const link = (await (await call(`/packages/${p.ref}/backups/restore`, { method: "POST", headers: owner.auth }, e)).json()) as any;
    expect(link.url).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/otinstaller-backups\/git\/github\/.+\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=3600.*&X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it("owners can opt out of git backups; existing bundles are deleted by the nightly purge", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const plan = await storedBundle(p);
    const key = plan.items.find((i) => i.kind === "git")!.key as string;
    const res = await call(`/packages/${p.ref}/backups`, { method: "PATCH", headers: owner.auth, body: JSON.stringify({ git_backups: false }) });
    expect(res.status).toBe(200);
    expect(await releasePlan(env as any, p.versionId)).toMatchObject({ items: [expect.objectContaining({ kind: "image" })] });
    await purgeBackups(env as any, Date.now() + 1000);
    expect(await env.BACKUPS.head(key)).toBeNull();
    expect(((await (await call(`/packages/${p.ref}/backups/restore`, { method: "POST", headers: owner.auth })).json()) as any).error.code).toBe("no_backup");
  });

  it("switches the package's source to the restored repository on the other host", async () => {
    const owner = await person({ gitlab: true });
    const ns = await namespace(owner);
    const p = await pkg(ns, { syncStatus: "unavailable" });
    const res = await call(`/packages/${p.ref}/source`, { method: "POST", headers: owner.auth, body: JSON.stringify({ repo: "https://gitlab.com/restored/whois-plus" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).source).toEqual({ provider: "gitlab", path: "restored/whois-plus", url: "https://gitlab.com/restored/whois-plus" });
    expect(gitlabHooks.some((u) => u.endsWith("/projects/4242/hooks"))).toBe(true);
    const s = await DB().prepare(`SELECT provider, project_id, sync_status, baseline_tags, connected_by FROM sources WHERE tool_id = ?`).bind(p.toolId).first<any>();
    expect(s).toEqual({ provider: "gitlab", project_id: "4242", sync_status: "ok", baseline_tags: JSON.stringify(["v1.0.0", "v1.1.0"]), connected_by: owner.id });
    expect((await DB().prepare(`SELECT repo_url FROM tools WHERE id = ?`).bind(p.toolId).first<any>()).repo_url).toBe("https://gitlab.com/restored/whois-plus");
    // The package is listed again, and backups now come from the new repository.
    expect((await releasePlan(env as any, p.versionId))!.items.find((i) => i.kind === "git")).toMatchObject({ clone_url: "https://gitlab.com/restored/whois-plus.git" });
    const other = await person({ gitlab: true });
    expect((await call(`/packages/${p.ref}/source`, { method: "POST", headers: other.auth, body: JSON.stringify({ repo: "https://gitlab.com/restored/whois-plus" }) })).status).toBe(403);
  });
});

// ---------- takedowns ----------

describe("takedowns apply to backups", () => {
  async function mirrored(p: Awaited<ReturnType<typeof pkg>>) {
    const plan = (await releasePlan(env as any, p.versionId))!;
    const image = plan.items.find((i) => i.kind === "image")!;
    const name = (image.target as string).replace("mirror.otinstaller.com/", "");
    const pushed = await pushImage(name);
    await DB().prepare(`UPDATE backups SET location = ? WHERE id = ?`).bind(`${name}@${pushed.digest}`, image.id).run();
    await runPlan(plan);
    return { name, digest: pushed.digest, bundleKey: plan.items.find((i) => i.kind === "git")!.key as string };
  }

  it("stops serving at once and deletes within 30 days, unless a legal hold applies", async () => {
    const admin = await person({ admin: true });
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const m = await mirrored(p);
    expect((await mirror(`/v2/${m.name}/manifests/${m.digest}`)).status).toBe(200);

    const res = await call(`/admin/tools/${p.ref}/1.0.0/remove`, { method: "POST", headers: admin.auth, body: JSON.stringify({ category: "legal", reason: "DMCA notice 123" }) });
    expect(res.status).toBe(200);
    expect((await mirror(`/v2/${m.name}/manifests/${m.digest}`)).status).toBe(404);
    const rows = (await DB().prepare(`SELECT delete_after FROM backups WHERE version_id = ? AND status = 'stored'`).bind(p.versionId).all<any>()).results;
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.delete_after).toBeLessThanOrEqual(Date.now() + TAKEDOWN_GRACE);

    // Nothing is deleted before the grace period; after it, the bundle and the mirrored image are gone.
    expect(await purgeBackups(env as any)).toBe(0);
    await purgeBackups(env as any, Date.now() + TAKEDOWN_GRACE + 1000);
    expect(await env.BACKUPS.head(m.bundleKey)).toBeNull();
    expect((await mirror(`/v2/${m.name}/manifests/${m.digest}`, { headers: { authorization: basic } })).status).toBe(404);
  });

  it("a legal hold keeps the backups until it is released", async () => {
    const admin = await person({ admin: true });
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const m = await mirrored(p);
    expect((await call(`/admin/tools/${p.ref}/legal-hold`, { method: "POST", headers: owner.auth, body: JSON.stringify({ hold: true, reason: "x" }) })).status).toBe(403);
    expect((await call(`/admin/tools/${p.ref}/legal-hold`, { method: "POST", headers: admin.auth, body: JSON.stringify({ hold: true, reason: "litigation hold, case 42" }) })).status).toBe(200);
    await call(`/admin/tools/${p.ref}/remove`, { method: "POST", headers: admin.auth, body: JSON.stringify({ category: "legal", reason: "court order" }) });
    expect((await mirror(`/v2/${m.name}/manifests/${m.digest}`)).status).toBe(404);
    await purgeBackups(env as any, Date.now() + 40 * 86_400_000);
    expect(await env.BACKUPS.head(m.bundleKey)).not.toBeNull();

    await call(`/admin/tools/${p.ref}/legal-hold`, { method: "POST", headers: admin.auth, body: JSON.stringify({ hold: false }) });
    await purgeBackups(env as any, Date.now() + TAKEDOWN_GRACE + 1000);
    expect(await env.BACKUPS.head(m.bundleKey)).toBeNull();
    // Removed packages are not restorable.
    expect(((await (await call(`/packages/${p.ref}/backups/restore`, { method: "POST", headers: owner.auth })).json()) as any).error.code).toBe("tool_removed");
  });
});

// ---------- restore drill ----------

describe("monthly restore drill", () => {
  it("sends a random bundle and mirrored image to the drill and alerts on failure", async () => {
    const admin = await person({ admin: true });
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const plan = (await releasePlan(env as any, p.versionId))!;
    const image = plan.items.find((i) => i.kind === "image")!;
    const name = (image.target as string).replace("mirror.otinstaller.com/", "");
    const pushed = await pushImage(name);
    await DB().prepare(`UPDATE backups SET location = ? WHERE id = ?`).bind(`${name}@${pushed.digest}`, image.id).run();
    await runPlan(plan);

    const out = (await startDrill(await testEnv()))!;
    expect(out.status).toBe("dispatched");
    const d = dispatches.find((x) => x.event_type === "otinstaller-drill")!.client_payload.drill;
    expect(d.bundle.url).toMatch(/\/v1\/internal\/backups\/objects\/git\//);
    expect(d.image).toMatchObject({ ref: expect.stringMatching(/^mirror\.otinstaller\.com\/.+@sha256:[0-9a-f]{64}$/), signer_issuer: expect.any(String) });

    const fail = await call(`/internal/drills/${d.id}`, { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: JSON.stringify({ result: "fail", detail: "git fsck found problems" }) });
    expect(fail.status).toBe(200);
    expect(emails.find((e) => e.subject === "Restore drill failed")!.to).toContain(`${admin.login}@example.com`);
    expect((await call(`/internal/drills/${d.id}`, { method: "POST", headers: { authorization: `Bearer ${d.token}` }, body: "{}" })).status).toBe(401);
  });

  it("admins can run a drill now and read the results", async () => {
    const admin = await person({ admin: true });
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    await runPlan((await releasePlan(env as any, p.versionId))!, { image: { status: "failed" } });
    expect((await call("/admin/backups/drill", { method: "POST", headers: owner.auth })).status).toBe(403);
    const res = await call("/admin/backups/drill", { method: "POST", headers: admin.auth });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const d = dispatches.find((x) => x.event_type === "otinstaller-drill")!.client_payload.drill;
    expect(d.id).toBe(id);
    await call(`/internal/drills/${id}`, { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: JSON.stringify({ result: "pass", detail: "bundle: pass" }) });
    const list = (await (await call("/admin/backups/drills", { headers: admin.auth })).json()) as { drills: { id: string; status: string; detail: string }[] };
    expect(list.drills.find((x) => x.id === id)).toMatchObject({ status: "pass", detail: "bundle: pass" });
    expect((await call("/admin/backups/drills", { headers: owner.auth })).status).toBe(403);
  });

  it("alerts when a drill never reports back", async () => {
    await person({ admin: true });
    const id = ulid();
    await DB().prepare(`INSERT INTO restore_drills (id, token_hash, expires_at, status, created_at) VALUES (?, 'x', ?, 'dispatched', ?)`).bind(id, Date.now() - 1, Date.now() - 7 * 3600e3).run();
    await expireDrills(env as any);
    expect((await DB().prepare(`SELECT status FROM restore_drills WHERE id = ?`).bind(id).first<any>()).status).toBe("expired");
    expect(emails.some((e) => e.subject === "Restore drill did not report back")).toBe(true);
  });
});

describe("admin backups", () => {
  it("returns a job to run by hand instead of dispatching it", async () => {
    const admin = await person({ admin: true });
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns);
    const res = await call(`/admin/tools/${p.ref}/1.0.0/backup`, { method: "POST", headers: admin.auth, body: JSON.stringify({ dispatch: false }) });
    const body = (await res.json()) as any;
    expect(body.status).toBe("created");
    expect(body.job.backup.jobs[0].items.map((i: any) => i.kind).sort()).toEqual(["git", "image"]);
    expect(dispatches).toHaveLength(0);
    // A completed run is the only way to fill the backup rows: completeRun with a wrong token is refused.
    await expect(completeRun(env as any, body.job.backup.jobs[0].run_id, "nope", [])).rejects.toThrow(/backup token/);
  });
});
