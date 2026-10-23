import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { processJob } from "../src/publish";
import { purgeIdleNamespaces, IDLE_NAMESPACE_MS } from "../src/direct";
import { readmeKey } from "../src/guides";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, testEnv, webhook, type Handler } from "./helpers";
import { README, fakeRelease, installation, manifestFor, tagEvent } from "./fixtures";

const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(3, "0")}`;

// ---------- fakes ----------

let githubUsers: Record<string, { id: number; type: string }> = {};
let gitlabUsers: Record<string, number> = {};

/** GitHub and GitLab name lookups, ghcr.io, the scanner dispatch and email. */
function hosts(extra: Record<string, Handler> = {}) {
  return fakeHosts({
    "POST https://api.github.com/app/installations/": { token: "ghs_ops" },
    "GET https://api.github.com/users/": (req) => githubUsers[decodeURIComponent(new URL(req.url).pathname.split("/")[2]!)] ?? null,
    "GET https://gitlab.com/api/v4/users": (req) => {
      const name = new URL(req.url).searchParams.get("username")!;
      return gitlabUsers[name] ? [{ id: gitlabUsers[name], username: name }] : [];
    },
    "GET https://gitlab.com/api/v4/groups/": null,
    "GET https://ghcr.io/v2/": (req) =>
      req.headers.get("authorization")
        ? new Response(JSON.stringify({ schemaVersion: 2 }))
        : new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"' } }),
    "GET https://ghcr.io/token": { token: "anon" },
    "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": new Response(null, { status: 204 }),
    "POST https://api.resend.com/emails": { id: "email" },
    ...extra,
  });
}

beforeEach(() => {
  githubUsers = {};
  gitlabUsers = {};
});

// ---------- helpers ----------

async function person(opts: { scopes?: string; github?: number } = {}) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(id, login, `${login}@example.com`, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES (?, ?, 'cli', ?, ?, ?, ?)`)
      .bind(ulid(), id, await sha256Hex(token), opts.scopes ?? "read", opts.scopes ? 1 : 0, Date.now()),
    ...(opts.github ? [DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, created_at) VALUES (?, ?, 'github', ?, ?, ?)`)
      .bind(ulid(), id, String(opts.github), login, Date.now())] : []),
  ]);
  return { id, login, auth: { authorization: `Bearer ${token}` } };
}

type Person = Awaited<ReturnType<typeof person>>;

const createNs = (p: Person, name: string, kind?: string) =>
  call("/namespaces", { method: "POST", headers: { ...p.auth, "content-type": "application/json" }, body: JSON.stringify({ name, kind }) });

/** A registry namespace owned by `p`, approved unless asked otherwise. */
async function namespace(p: Person, active = true) {
  const name = `ns${uniq()}`;
  hosts();
  expect((await createNs(p, name)).status).toBe(201);
  if (active) await DB().prepare(`UPDATE namespaces SET status = 'active' WHERE name = ?`).bind(name).run();
  return name;
}

const u32be = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const chunk = (type: string, data: string) => bytes(u32be(data.length), type, data, [0, 0, 0, 0]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [...chunk("IHDR", "x".repeat(13))], [...chunk("IDAT", "pixels")], [...chunk("IEND", "")]);

const READMED = "# Tool\n\nSee [the changelog](CHANGELOG.txt) and the screenshot:\n\n![screenshot](docs/shot.png)\n";

function files(ns: string, version = "1.0.0", over: Record<string, string | Uint8Array | null> = {}) {
  const all: Record<string, string | Uint8Array | null> = { "otinstaller.yaml": manifestFor(ns, version), "README.md": READMED, "docs/shot.png": PNG, ...over };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null)) as Record<string, string | Uint8Array>;
}

/** Uploads files as `ot publish` does: multipart with one `file` part per path, and a Content-Length. */
async function upload(p: Person, ns: string, version: string, fs: Record<string, string | Uint8Array>, query?: string) {
  const form = new FormData();
  for (const [path, content] of Object.entries(fs)) form.append("file", new Blob([content]), path);
  const req = new Response(form);
  const body = await req.arrayBuffer();
  return call(`/publish?${query ?? `namespace=${ns}&name=whois-plus&version=${version}`}`, {
    method: "POST",
    headers: { ...p.auth, "content-type": req.headers.get("content-type")!, "content-length": String(body.byteLength) },
    body,
  });
}

/** Uploads and validates a release, returning the job, the version and what the scanner was sent. */
async function publishDirect(p: Person, ns: string, version = "1.0.0", over: Record<string, string | Uint8Array | null> = {}) {
  const calls = hosts();
  const res = await upload(p, ns, version, files(ns, version, over));
  expect(res.status, await res.clone().text()).toBe(202);
  const { job_id } = (await res.json()) as { job_id: string };
  const out = await processJob(await testEnv(), job_id);
  const dispatch = calls.find((c) => c.url.endsWith("/registry-ops/dispatches"));
  return { jobId: job_id, out, calls, scan: dispatch ? JSON.parse(dispatch.body).client_payload.scan : null };
}

const signed = (...ids: { identity: string; issuer: string }[]) => ({
  signature: ids.length ? { status: "pass", identity: ids[0]!.identity, issuer: ids[0]!.issuer, identities: ids } : { status: "absent" },
  vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0, fixable_critical: 0, fixable_high: 0 },
  secrets: { count: 0 },
  malware: { count: 0 },
  smoke: { status: "pass", exit_code: 0 },
});

async function report(scan: { callback_token: string }, results: unknown) {
  const res = await call("/internal/scans", { method: "POST", headers: { authorization: `Bearer ${scan.callback_token}`, "content-type": "application/json" }, body: JSON.stringify(results) });
  return (await res.json()) as { status: string; verdict: { result: string; code?: string } };
}

const ALICE = { identity: "alice@example.com", issuer: "https://github.com/login/oauth" };
const CI = (ref: string) => ({ identity: `https://github.com/alice/tools/.github/workflows/release.yml@${ref}`, issuer: "https://token.actions.githubusercontent.com" });

// ---------- namespaces ----------

describe("registry namespaces", () => {
  it("are created by any signed-in user, owned by them and held for review", async () => {
    const p = await person();
    const name = `ns${uniq()}`;
    hosts();
    const res = await createNs(p, name);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name, kind: "user", status: "pending_review" });
    const row = await DB().prepare(`SELECT n.provider, n.status, n.created_by, m.role FROM namespaces n JOIN namespace_members m ON m.namespace_id = n.id WHERE n.name = ?`).bind(name).first<any>();
    expect(row).toEqual({ provider: "registry", status: "pending_review", created_by: p.id, role: "owner" });
    const me = (await (await call("/me", { headers: p.auth })).json()) as any;
    expect(me.namespaces).toEqual([{ name, status: "pending_review", verified: 0, role: "owner" }]);
  });

  it("refuse reserved, taken and malformed names", async () => {
    const p = await person();
    hosts();
    expect(((await (await createNs(p, "dashboard")).json()) as any).error.code).toBe("namespace_reserved");
    expect(((await (await createNs(p, "private")).json()) as any).error.code).toBe("namespace_reserved");
    expect(((await (await createNs(p, "osintverse-community")).json()) as any).error.code).toBe("namespace_taken");
    expect((await createNs(p, "No_Caps")).status).toBe(400);
    expect((await createNs(p, `ns${uniq()}`, "group")).status).toBe(400);
  });

  it("leave GitHub and GitLab names to their owners", async () => {
    const p = await person({ github: 4242 });
    const stranger = await person();
    const mine = `gh${uniq()}`, org = `org${uniq()}`, gl = `gl${uniq()}`;
    githubUsers = { [mine]: { id: 4242, type: "User" }, [org]: { id: 777, type: "Organization" } };
    gitlabUsers = { [gl]: 99 };
    hosts();
    const refused = async (who: Person, name: string) => ((await (await createNs(who, name)).json()) as any).error;
    expect(await refused(stranger, mine)).toMatchObject({ code: "namespace_account_required", message: `${mine} is a GitHub user's name` });
    expect((await refused(p, org)).code).toBe("namespace_account_required");
    expect((await refused(p, gl)).code).toBe("namespace_account_required");
    // Your own GitHub login is yours to take.
    expect((await createNs(p, mine)).status).toBe(201);
  });

  it("are limited to three per account", async () => {
    const p = await person();
    hosts();
    for (let i = 0; i < 3; i++) expect((await createNs(p, `ns${uniq()}`)).status).toBe(201);
    expect(((await (await createNs(p, `ns${uniq()}`)).json()) as any).error.code).toBe("namespace_limit");
  });

  it("need a token with the manage scope", async () => {
    const p = await person({ scopes: "read,publish" });
    hosts();
    expect(((await (await createNs(p, `ns${uniq()}`)).json()) as any).error.code).toBe("insufficient_scope");
  });

  it("are removed when nothing was published into them within 30 days", async () => {
    const p = await person();
    const idle = await namespace(p, false);
    const used = await namespace(p, false);
    await publishDirect(p, used);
    await DB().prepare(`UPDATE namespaces SET created_at = 1 WHERE name IN (?, ?)`).bind(idle, used).run();
    expect(await purgeIdleNamespaces(env as any, Date.now())).toBeGreaterThanOrEqual(1);
    expect(await DB().prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(idle).first()).toBeNull();
    expect(await DB().prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(used).first()).not.toBeNull();
    expect(IDLE_NAMESPACE_MS).toBe(30 * 86_400_000);
  });
});

// ---------- uploads ----------

describe("direct uploads", () => {
  it("publish a tool with no repository: no source, no repo URL, and the scanner told any signer will do", async () => {
    const p = await person();
    const ns = await namespace(p);
    const { jobId, out, scan } = await publishDirect(p, ns);
    expect(out?.status).toBe("scanning");
    expect(scan).toMatchObject({ ref: `${ns}/whois-plus@1.0.0`, source_repo: "", expected_signer: null });

    const tool = await DB().prepare(`SELECT t.id, t.repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ?`).bind(ns).first<any>();
    expect(tool.repo_url).toBeNull();
    expect(await DB().prepare(`SELECT 1 FROM sources WHERE tool_id = ?`).bind(tool.id).first()).toBeNull();
    const v = await DB().prepare(`SELECT git_sha, expected_signer_regexp FROM versions WHERE id = ?`).bind(out!.versionId).first<any>();
    expect(v).toEqual({ git_sha: null, expected_signer_regexp: null });

    // The README's image was copied to the registry; its link to a file with nowhere to point stays text.
    const html = await (await env.CONTENT.get(readmeKey(out!.versionId!)))!.text();
    expect(html).toMatch(/<img src="https:\/\/api\.otinstaller\.com\/v1\/assets\/[0-9a-f]{64}\.png" alt="screenshot"/);
    expect(html).toContain("the changelog");
    expect(html).not.toContain("raw.githubusercontent.com");
    // The upload is gone once the release is recorded.
    expect((await env.CONTENT.list({ prefix: `uploads/${jobId}/` })).objects).toEqual([]);

    const job = (await (await call(`/me/publish-jobs/${jobId}`, { headers: p.auth })).json()) as any;
    expect(job).toMatchObject({ id: jobId, method: "direct", status: "scanning", ref: `${ns}/whois-plus`, version: "1.0.0", url: `https://otinstaller.com/dashboard/publish/${jobId}` });
    expect((await call(`/me/publish-jobs/${jobId}`, { headers: (await person()).auth })).status).toBe(404);
  });

  it("are checked before the body is read: membership, namespace, conflicts and scope", async () => {
    const p = await person();
    const ns = await namespace(p);
    hosts();
    const code = async (res: Response) => ((await res.json()) as any).error.code;
    expect(await code(await upload(await person(), ns, "1.0.0", files(ns)))).toBe("forbidden");
    expect(await code(await upload(p, "no-such-ns", "1.0.0", files("no-such-ns")))).toBe("namespace_unknown");
    expect(await code(await upload(await person({ scopes: "read" }), ns, "1.0.0", files(ns)))).toBe("insufficient_scope");
    await DB().prepare(`UPDATE namespaces SET status = 'suspended' WHERE name = ?`).bind(ns).run();
    expect(await code(await upload(p, ns, "1.0.0", files(ns)))).toBe("namespace_not_allowed");
  });

  it("refuse malformed uploads", async () => {
    const p = await person();
    const ns = await namespace(p);
    hosts();
    const err = async (res: Response) => ((await res.json()) as any).error;
    expect((await err(await upload(p, ns, "1.0.0", { "README.md": README }))).code).toBe("bundle_invalid");
    expect((await err(await upload(p, ns, "1.0.0", { ...files(ns), "../escape.md": "x" }))).code).toBe("bundle_invalid");
    expect((await err(await upload(p, ns, "1.0.0", files(ns), `namespace=${ns}&name=whois-plus&version=2.0.0`))).code).toBe("bundle_invalid");
    const bad = await err(await upload(p, ns, "1.0.0", files(ns, "1.0.0", { "otinstaller.yaml": "schema: 1\nname: whois-plus\n" })));
    expect(bad.code).toBe("manifest_invalid");
    expect(bad.problems.length).toBeGreaterThan(0);
    const huge = await call(`/publish?namespace=${ns}&name=whois-plus&version=1.0.0`, {
      method: "POST", headers: { ...p.auth, "content-type": "multipart/form-data; boundary=x", "content-length": String(26 * 1024 * 1024) }, body: "--x--",
    });
    expect(huge.status).toBe(413);
  });

  it("refuse a version that is published or being published", async () => {
    const p = await person();
    const ns = await namespace(p);
    hosts();
    expect((await upload(p, ns, "1.0.0", files(ns))).status).toBe(202);
    expect(((await (await upload(p, ns, "1.0.0", files(ns))).json()) as any).error.code).toBe("publish_in_progress");
    const job = await DB().prepare(`SELECT id FROM publish_jobs WHERE repo = ? ORDER BY created_at DESC LIMIT 1`).bind(`${ns}/whois-plus`).first<{ id: string }>();
    await processJob(await testEnv(), job!.id);
    expect(((await (await upload(p, ns, "1.0.0", files(ns))).json()) as any).error.code).toBe("manifest_version_exists");
  });

  it("can't take over a package a repository publishes, and a repository's tag claims a direct package", async () => {
    // A GitHub user who installed the App owns their namespace, and uploads a package to it.
    const ghId = 900000 + (Date.now() % 100000);
    const p = await person({ github: ghId });
    const instId = 8000000 + (Date.now() % 100000);
    const repoId = 880000 + (Date.now() % 1000);
    await webhook("installation", installation(instId, { id: ghId, login: p.login }, [repoId], ghId));
    await DB().prepare(`UPDATE namespaces SET status = 'active' WHERE name = ?`).bind(p.login).run();
    const { out, calls } = await publishDirect(p, p.login);
    expect(out?.status).toBe("scanning");
    // Its owners hear about uploads into a GitHub namespace.
    expect(calls.some((c) => c.url === "https://api.resend.com/emails" && c.body.includes(`uploaded ${p.login}/whois-plus 1.0.0`))).toBe(true);

    // A tag in one of the namespace's repositories releases the same package and claims its name.
    const repo = `${p.login}/whois-plus`;
    const res = await webhook("create", tagEvent(instId, repo, repoId, "v1.1.0"));
    fakeRelease(repo, { "otinstaller.yaml": manifestFor(p.login, "1.1.0"), "README.md": README });
    expect((await processJob(await testEnv(), ((await res.json()) as any).jobId))?.status).toBe("scanning");
    const tool = await DB().prepare(`SELECT repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = 'whois-plus'`).bind(p.login).first<any>();
    expect(tool.repo_url).toBe(`https://github.com/${repo}`);
    // From then on uploads are refused.
    hosts();
    expect(((await (await upload(p, p.login, "1.2.0", files(p.login, "1.2.0"))).json()) as any).error.code).toBe("manifest_name_taken");
  });

  it("are rate limited per namespace", async () => {
    const p = await person();
    const ns = await namespace(p);
    hosts();
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) last = await upload(p, ns, `1.0.${i}`, files(ns, `1.0.${i}`));
    expect(last!.status).toBe(429);
    expect(((await last!.json()) as any).error.code).toBe("publish_rate_limited");
  });
});

// ---------- signatures ----------

describe("signing a direct package", () => {
  it("pins the first signer; later versions may change the ref but not the signer", async () => {
    const p = await person();
    const ns = await namespace(p);
    const first = await publishDirect(p, ns, "1.0.0");
    expect(await report(first.scan, signed(CI("refs/tags/v1.0.0")))).toMatchObject({ status: "published" });
    const v1 = await DB().prepare(`SELECT signer_identity FROM versions WHERE id = ?`).bind(first.out!.versionId).first<any>();
    expect(v1.signer_identity).toBe(CI("refs/tags/v1.0.0").identity);

    const second = await publishDirect(p, ns, "1.0.1");
    expect(await report(second.scan, signed(CI("refs/heads/main")))).toMatchObject({ status: "published" });

    const third = await publishDirect(p, ns, "1.0.2");
    expect(await report(third.scan, signed(ALICE))).toMatchObject({ status: "rejected", verdict: { code: "signature_mismatch" } });
    const job = await DB().prepare(`SELECT status, error_detail FROM publish_jobs WHERE id = ?`).bind(third.jobId).first<any>();
    expect(job.error_detail).toContain("which signed this package's earlier versions");

    // Of several signatures, the pinned signer's counts.
    const fourth = await publishDirect(p, ns, "1.0.3");
    expect(await report(fourth.scan, signed(ALICE, CI("refs/tags/v1.0.3")))).toMatchObject({ status: "published" });

    const fifth = await publishDirect(p, ns, "1.0.4");
    expect(await report(fifth.scan, signed())).toMatchObject({ status: "rejected", verdict: { code: "signature_dropped" } });
  });

  it("allows unsigned uploads, and refuses a first signed release with two signers", async () => {
    const p = await person();
    const ns = await namespace(p);
    const unsigned = await publishDirect(p, ns, "1.0.0");
    expect(await report(unsigned.scan, signed())).toMatchObject({ status: "published" });
    const two = await publishDirect(p, ns, "1.1.0");
    expect(await report(two.scan, signed(ALICE, CI("refs/tags/v1.1.0")))).toMatchObject({ status: "rejected", verdict: { code: "signature_ambiguous" } });
  });
});

// ---------- review ----------

describe("review of a new registry publisher", () => {
  it("holds the first upload, and closes its job when a reviewer asks for changes", async () => {
    const p = await person();
    const ns = await namespace(p, false);
    const { jobId, scan } = await publishDirect(p, ns);
    expect(await report(scan, signed())).toMatchObject({ status: "awaiting_review" });

    const rid = ulid();
    const reviewer = `ot_reviewer_${rid}`;
    await DB().batch([
      DB().prepare(`INSERT INTO users (id, login, is_reviewer, created_at) VALUES (?, ?, 1, ?)`).bind(rid, `rev${rid.slice(-6)}`, Date.now()),
      DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), rid, await sha256Hex(reviewer), Date.now()),
    ]);
    const queue = (await (await call("/admin/review-queue", { headers: { authorization: `Bearer ${reviewer}` } })).json()) as any;
    const item = queue.queue.find((q: any) => q.namespace === ns);
    expect(item).toMatchObject({ provider: "registry", profile_url: null, creator: { login: p.login, accounts: [] } });

    hosts();
    const res = await call(`/admin/namespaces/${ns}/request-changes`, {
      method: "POST", headers: { authorization: `Bearer ${reviewer}`, "content-type": "application/json" }, body: JSON.stringify({ notes: "add a test input" }),
    });
    expect(res.status).toBe(200);
    const job = (await (await call(`/me/publish-jobs/${jobId}`, { headers: p.auth })).json()) as any;
    expect(job).toMatchObject({ status: "rejected", error_code: "changes_requested" });
  });
});
