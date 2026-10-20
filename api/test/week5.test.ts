import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processJob, publishApproved } from "../src/publish";
import { expireStaleScans, verdict, type ScanResults } from "../src/scans";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, testEnv, webhook } from "./helpers";
import { README, fakeRelease, installation, manifestFor, statuses, tagEvent } from "./fixtures";

const DB = () => env.DB;

const clean: ScanResults = {
  signature: { status: "pass", identity: "https://github.com/x/y/.github/workflows/otinstaller-release.yml@refs/tags/v1.0.0", issuer: "https://token.actions.githubusercontent.com" },
  vulnerabilities: { critical: 0, high: 0, medium: 2, low: 5, fixable_critical: 0, fixable_high: 0 },
  secrets: { count: 0 },
  malware: { count: 0 },
  smoke: { status: "pass", exit_code: 0, duration_ms: 900 },
  sbom: { packages: 42 },
};

describe("verdict rules", () => {
  it.each([
    ["clean results pass", clean, false, "pass"],
    ["fixable high CVEs publish with a warning", { ...clean, vulnerabilities: { ...clean.vulnerabilities!, high: 3, fixable_high: 2 } }, false, "warn"],
    ["unfixable CVEs alone do not warn", { ...clean, vulnerabilities: { ...clean.vulnerabilities!, critical: 1 } }, false, "pass"],
    ["an unsigned first release is allowed", { ...clean, signature: { status: "absent" } }, false, "pass"],
    ["a bad signature rejects", { ...clean, signature: { status: "fail", detail: "identity mismatch" } }, false, "signature_mismatch"],
    ["dropping signatures rejects", { ...clean, signature: { status: "absent" } }, true, "signature_dropped"],
    ["malware heuristics reject", { ...clean, malware: { count: 1 } }, false, "malware_suspected"],
    ["embedded secrets reject", { ...clean, secrets: { count: 2 } }, false, "secrets_found"],
    ["a failed smoke test rejects", { ...clean, smoke: { status: "fail", exit_code: 1, output_excerpt: "boom" } }, false, "smoke_test_failed"],
  ] as const)("%s", (_l, results, prevSigned, want) => {
    const v = verdict(results as ScanResults, prevSigned);
    expect(v.result === "fail" ? v.code : v.result).toBe(want);
  });
});

// ---------- helpers ----------

let seq = 0;
/** A signed-in user with an email, owner of a namespace created by installing the app. */
async function publisher(active: boolean) {
  const n = ++seq;
  const login = `pub${n}x${Date.now() % 100000}`;
  // Spaced by 1000 per publisher so the millisecond part can never make two of them collide.
  const ghId = 20000 + n * 1000 + (Date.now() % 1000);
  const userId = ulid();
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(userId, login, `${login}@example.com`, Date.now()),
    DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, created_at) VALUES (?, ?, 'github', ?, ?, ?)`).bind(ulid(), userId, String(ghId), login, Date.now()),
  ]);
  const instId = 5000000 + n * 1000 + (Date.now() % 1000);
  const repoId = 70000 + n;
  await webhook("installation", installation(instId, { id: ghId, login }, [repoId], ghId));
  if (active) await DB().prepare(`UPDATE namespaces SET status = 'active' WHERE name = ?`).bind(login).run();
  return { login, instId, repoId, repo: `${login}/whois-plus` };
}

async function reviewerToken() {
  const id = ulid();
  const token = `ot_reviewer_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, is_reviewer, created_at) VALUES (?, ?, 1, ?)`).bind(id, `rev${id.slice(-6)}`, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { authorization: `Bearer ${token}` };
}

/** Tags a release, runs validation, and returns the scan token the dispatch carried. */
async function tagAndValidate(p: Awaited<ReturnType<typeof publisher>>, version = "1.0.0") {
  const res = await webhook("create", tagEvent(p.instId, p.repo, p.repoId, `v${version}`));
  const jobId = ((await res.json()) as any).jobId as string;
  const calls = fakeRelease(p.repo, { "otinstaller.yaml": manifestFor(p.login, version), "README.md": README });
  const out = await processJob(await testEnv(), jobId);
  expect(out?.status).toBe("scanning");
  const dispatch = calls.find((c) => c.url.endsWith("/registry-ops/dispatches"))!;
  const scan = JSON.parse(dispatch.body).client_payload.scan;
  return { jobId, calls, scan, versionId: out!.versionId! };
}

async function report(token: string, results: unknown) {
  return call("/internal/scans", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(results) });
}

const emailsTo = (calls: { url: string; body: string }[]) =>
  calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(c.body) as { to: string[]; subject: string; text: string });

// ---------- flows ----------

describe("scan dispatch", () => {
  it("sends the scanner everything it needs, including who must have signed the release", async () => {
    const p = await publisher(true);
    const { scan } = await tagAndValidate(p);
    expect(scan).toMatchObject({
      ref: `${p.login}/whois-plus@1.0.0`,
      runtime: { kind: "docker" },
      callback_url: "https://api.otinstaller.com/v1/internal/scans",
      expected_signer: { issuer: "https://token.actions.githubusercontent.com" },
      expect_exit_code: 0,
    });
    expect(scan.upstream_repo).toBeUndefined();
    expect(new RegExp(scan.expected_signer.identityRegexp).test(`https://github.com/${p.repo}/.github/workflows/release.yml@refs/tags/v1.0.0`)).toBe(true);
    expect(new RegExp(scan.expected_signer.identityRegexp).test(`https://github.com/attacker/${p.repo}/.github/workflows/release.yml@refs/tags/v1.0.0`)).toBe(false);
  });

  it("dispatches with OPS_DISPATCH_TOKEN when set, so the App can stay read-only", async () => {
    const p = await publisher(true);
    const res = await webhook("create", tagEvent(p.instId, p.repo, p.repoId, "v1.0.0"));
    const jobId = ((await res.json()) as any).jobId;
    const auth: string[] = [];
    fakeRelease(p.repo, { "otinstaller.yaml": manifestFor(p.login), "README.md": README }, {
      extra: {
        "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": (req) => {
          auth.push(req.headers.get("authorization") ?? "");
          return new Response(null, { status: 204 });
        },
      },
    });
    // Pasted secrets often end in a newline.
    const out = await processJob({ ...(await testEnv()), OPS_DISPATCH_TOKEN: "github_pat_ops\n" }, jobId);
    expect(out?.status).toBe("scanning");
    expect(auth).toEqual(["Bearer github_pat_ops"]);
  });

  it("retries a failed dispatch without validating again", async () => {
    const p = await publisher(true);
    const res = await webhook("create", tagEvent(p.instId, p.repo, p.repoId, "v1.0.0"));
    const jobId = ((await res.json()) as any).jobId;
    const calls = fakeRelease(p.repo, { "otinstaller.yaml": manifestFor(p.login), "README.md": README });
    // Make only the first dispatch fail; it never reaches the recorded fake.
    const realFetch = (await import("../src/env")).deps.fetch;
    (await import("../src/env")).deps.fetch = async (input, init) => {
      const url = new Request(input, init).url;
      if (url.endsWith("/dispatches")) return new Response("down", { status: 502 });
      return realFetch(input, init);
    };
    await expect(processJob(await testEnv(), jobId)).rejects.toThrow(/dispatch failed/);
    (await import("../src/env")).deps.fetch = realFetch;
    await processJob(await testEnv(), jobId);
    expect(calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/contents/otinstaller.yaml"))).toHaveLength(1);
  });
});

describe("scan callback", () => {
  it("publishes a clean release from an approved publisher and makes it searchable", async () => {
    const p = await publisher(true);
    const { scan, calls } = await tagAndValidate(p);
    const res = await report(scan.callback_token, clean);
    expect(await res.json()).toMatchObject({ status: "published", verdict: { result: "pass" } });

    const tool = (await (await call(`/tools/${p.login}/whois-plus`)).json()) as any;
    expect(tool).toMatchObject({ latest_version: "1.0.0", inputs: ["domain"], outputs: ["organization"], signed: true });
    const manifest = (await (await call(`/tools/${p.login}/whois-plus/latest/manifest`)).json()) as any;
    expect(manifest.signer_identity).toBe(clean.signature.identity);
    expect(statuses(calls).at(-1)).toMatchObject({ state: "success" });
    expect(emailsTo(calls).at(-1)).toMatchObject({ to: [`${p.login}@example.com`], subject: `Published ${p.login}/whois-plus 1.0.0` });
  });

  it("accepts each scan token once, and refuses unknown ones", async () => {
    const p = await publisher(true);
    const { scan } = await tagAndValidate(p);
    expect((await report(scan.callback_token, clean)).status).toBe(200);
    expect((await report(scan.callback_token, clean)).status).toBe(401);
    expect((await report("forged", clean)).status).toBe(401);
  });

  it("rejects malformed results without changing anything", async () => {
    const p = await publisher(true);
    const { scan, versionId } = await tagAndValidate(p);
    expect((await report(scan.callback_token, { ...clean, malware: { count: -1 } })).status).toBe(400);
    expect(await DB().prepare(`SELECT status FROM versions WHERE id = ?`).bind(versionId).first()).toMatchObject({ status: "scanning" });
  });

  it("rejects a release with suspected malware, tells the author, and lets them re-tag", async () => {
    const p = await publisher(true);
    const first = await tagAndValidate(p);
    const res = await report(first.scan.callback_token, { ...clean, malware: { count: 1, findings: [{ rule: "exfiltrate-sensitive-data" }] } });
    expect(await res.json()).toMatchObject({ status: "rejected", verdict: { code: "malware_suspected" } });
    expect(statuses(first.calls).at(-1)).toMatchObject({ state: "failure", description: expect.stringMatching(/^malware_suspected/) });
    expect(emailsTo(first.calls).at(-1)!.subject).toBe(`${p.login}/whois-plus 1.0.0 was not published`);
    expect((await call(`/tools/${p.login}/whois-plus`)).status).toBe(404);

    // Same version, fixed and re-tagged: validated again and reuses the version row.
    const second = await tagAndValidate(p);
    expect(second.versionId).toBe(first.versionId);
  });

  it("publishes with a warning when vulnerabilities have fixes available", async () => {
    const p = await publisher(true);
    const { scan, calls } = await tagAndValidate(p);
    const res = await report(scan.callback_token, { ...clean, vulnerabilities: { ...clean.vulnerabilities!, high: 2, fixable_high: 2 } });
    expect(await res.json()).toMatchObject({ status: "published", verdict: { result: "warn" } });
    expect(emailsTo(calls).at(-1)!.text).toMatch(/vulnerabilities that have fixes available/);
  });

  it("rejects a release that drops the signature earlier versions had", async () => {
    const p = await publisher(true);
    const v1 = await tagAndValidate(p, "1.0.0");
    await report(v1.scan.callback_token, clean);
    const v2 = await tagAndValidate(p, "1.1.0");
    const res = await report(v2.scan.callback_token, { ...clean, signature: { status: "absent" } });
    expect(await res.json()).toMatchObject({ status: "rejected", verdict: { code: "signature_dropped" } });
  });

  it("keeps the highest stable version as latest", async () => {
    const p = await publisher(true);
    for (const v of ["1.1.0", "1.0.5", "2.0.0-beta.1"]) {
      const r = await tagAndValidate(p, v);
      await report(r.scan.callback_token, clean);
    }
    expect(((await (await call(`/tools/${p.login}/whois-plus`)).json()) as any).latest_version).toBe("1.1.0");
  });

  it("closes scans that never report back", async () => {
    const p = await publisher(true);
    const { jobId, versionId } = await tagAndValidate(p);
    expect(await expireStaleScans(await testEnv(), Date.now() + 2 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    expect(await DB().prepare(`SELECT status, rejected_reason FROM versions WHERE id = ?`).bind(versionId).first()).toMatchObject({ status: "rejected", rejected_reason: "scan_timeout" });
    expect(await DB().prepare(`SELECT status FROM publish_jobs WHERE id = ?`).bind(jobId).first()).toMatchObject({ status: "error" });
  });
});

describe("manual review of new publishers", () => {
  it("holds a new publisher's first release for review, then publishes it on approval", async () => {
    const p = await publisher(false);
    const { scan, calls } = await tagAndValidate(p);
    expect(await (await report(scan.callback_token, clean)).json()).toMatchObject({ status: "awaiting_review" });
    expect(statuses(calls).at(-1)).toMatchObject({ state: "pending", description: expect.stringMatching(/awaiting review/) });
    expect(emailsTo(calls).at(-1)!.subject).toMatch(/waiting for review/);

    const auth = await reviewerToken();
    const queue = (await (await call("/admin/review-queue", { headers: auth })).json()) as any;
    const entry = queue.queue.find((q: any) => q.namespace === p.login);
    expect(entry.versions[0]).toMatchObject({ ref: `${p.login}/whois-plus`, version: "1.0.0", signed: true });
    expect(entry.versions[0].scans.map((s: any) => s.kind)).toEqual(["signature", "vuln", "malware", "smoke", "sbom"]);

    // Approval queues the waiting releases; each queue message publishes one.
    const queued: { body: { publishVersionId: string } }[] = [];
    const e = { ...(await testEnv()), PUBLISH_QUEUE: { send: async () => {}, sendBatch: async (m: any[]) => void queued.push(...m) } as any };
    const approved = await call(`/admin/namespaces/${p.login}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ notes: "Looks good" }) }, e);
    expect(await approved.json()).toEqual({ status: "active", queued: 1 });
    expect(queued.map((m) => m.body.publishVersionId)).toHaveLength(1);
    for (const m of queued) await publishApproved(e, m.body.publishVersionId);
    expect(((await (await call(`/tools/${p.login}/whois-plus`)).json()) as any).latest_version).toBe("1.0.0");
    // A repeated message does nothing.
    await publishApproved(e, queued[0]!.body.publishVersionId);

    // After approval, later releases skip review.
    const next = await tagAndValidate(p, "1.1.0");
    expect(await (await report(next.scan.callback_token, clean)).json()).toMatchObject({ status: "published" });
  });

  it("lets reviewers request changes, which closes the waiting release and emails the notes", async () => {
    const p = await publisher(false);
    const { scan, calls } = await tagAndValidate(p);
    await report(scan.callback_token, clean);
    const auth = await reviewerToken();
    expect((await call(`/admin/namespaces/${p.login}/request-changes`, { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
    const res = await call(`/admin/namespaces/${p.login}/request-changes`, { method: "POST", headers: auth, body: JSON.stringify({ notes: "Add a scope and legal note to the README." }) });
    expect(res.status).toBe(200);
    expect(emailsTo(calls).at(-1)!.text).toMatch(/Add a scope and legal note/);
    expect(await DB().prepare(`SELECT status FROM namespaces WHERE name = ?`).bind(p.login).first()).toMatchObject({ status: "pending_review" });
  });

  it("rejecting a namespace stops it from publishing again", async () => {
    const p = await publisher(false);
    const { scan } = await tagAndValidate(p);
    await report(scan.callback_token, clean);
    const auth = await reviewerToken();
    await call(`/admin/namespaces/${p.login}/reject`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "Tool is built for account takeover." }) });
    const res = await webhook("create", tagEvent(p.instId, p.repo, p.repoId, "v1.0.1"));
    fakeRelease(p.repo, { "otinstaller.yaml": manifestFor(p.login, "1.0.1"), "README.md": README });
    const out = await processJob(await testEnv(), ((await res.json()) as any).jobId);
    expect(out!.problems[0]!.code).toBe("namespace_not_allowed");
  });

  it("is limited to reviewers, and verify/suspend to admins", async () => {
    const p = await publisher(false);
    expect((await call("/admin/review-queue")).status).toBe(401);
    const auth = await reviewerToken();
    expect((await call(`/admin/namespaces/${p.login}/verify`, { method: "POST", headers: auth })).status).toBe(403);
  });
});

describe("emails", () => {
  it("never sends the same message twice", async () => {
    const p = await publisher(true);
    const { scan, calls } = await tagAndValidate(p);
    await report(scan.callback_token, clean);
    const { sendEmail, templates } = await import("../src/notify");
    const v = await DB().prepare(`SELECT id FROM versions WHERE scan_token_hash IS NULL ORDER BY created_at DESC LIMIT 1`).first<{ id: string }>();
    const again = await sendEmail(await testEnv(), { to: ["x@example.com"], kind: "published", key: `published:${v!.id}`, ...templates.published(await testEnv(), "a/b", "1.0.0", false) });
    expect(["duplicate", "sent"]).toContain(again);
    expect(emailsTo(calls).filter((e) => e.subject.startsWith("Published"))).toHaveLength(1);
  });
});
