import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { d1RetryAfter } from "../src/lib/errors";
import { recomputeLatest } from "../src/trust";
import { alertStuckJobs, businessDays, dailyDigest } from "../src/ops";
import { call, fakeHosts, testEnv } from "./helpers";

const DB = () => env.DB;
let n = 0;
// A fixed-width counter keeps IDs from colliding ("12" + "34" vs "123" + "4").
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;
const emails: { to: string[]; subject: string; text: string }[] = [];
const githubAdmins = new Set<string>();
const claimFiles: Record<string, string> = {};

beforeEach(() => {
  emails.length = 0;
  fakeHosts({
    "POST https://api.resend.com/emails": async (req) => (emails.push(await req.json() as any), { id: "e" }),
    "GET https://api.github.com/repos/": (req) => {
      const repo = new URL(req.url).pathname.replace("/repos/", "");
      return { id: 1, full_name: repo, private: false, permissions: { admin: githubAdmins.has(repo) } };
    },
    "GET https://raw.githubusercontent.com/": (req) => {
      const repo = new URL(req.url).pathname.split("/").slice(1, 3).join("/");
      return claimFiles[repo] ?? null;
    },
  });
});

// ---------- fixtures ----------

async function person(flags: { reviewer?: boolean; admin?: boolean; github?: boolean } = {}) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, is_reviewer, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, login, `${login}@example.com`, flags.reviewer ? 1 : 0, flags.admin ? 1 : 0, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  if (flags.github) {
    const { encrypt } = await import("../src/lib/crypto");
    await DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?)`)
      .bind(ulid(), id, uniq(), login, await encrypt(env.TOKEN_ENC_KEY, `gho_${login}`), Date.now()).run();
  }
  return { id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function namespace(owner: { id: string }, status = "active") {
  const id = ulid();
  const name = `ns${uniq()}`;
  await DB().batch([
    DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, created_at) VALUES (?, 'github', ?, ?, 'user', ?, ?)`)
      .bind(id, uniq(), name, status, Date.now()),
    DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(id, owner.id),
  ]);
  return { id, name };
}

const manifest = (ns: string, name: string, version: string, over: Record<string, unknown> = {}) => ({
  schema: 1, kind: "tool", name, namespace: ns, version, summary: "Looks things up for the week 10 tests", readme: "README.md", license: "MIT",
  categories: ["utilities"], inputs: [{ name: "domain", type: "domain", required: true }], outputs: [{ type: "organization" }],
  runtime: { kind: "docker", image: `ghcr.io/${ns}/${name}@sha256:${"a".repeat(64)}`, platforms: ["linux/amd64"], command: [name, "{domain}"], output_format: "json" },
  ethics: { touches_target: false, auth_required: false, collects_personal_data: false }, test: { input: { domain: "example.com" } }, ...over,
});

/** A published package with the given versions (all published unless marked). */
async function pkg(ns: { id: string; name: string }, versions: string[], opts: { community?: boolean; over?: Record<string, unknown> } = {}) {
  const toolId = ulid();
  const name = `tool${uniq()}`;
  const now = Date.now();
  await DB().prepare(
    `INSERT INTO tools (id, namespace_id, kind, name, summary, community_packaged, repo_url, created_at, updated_at) VALUES (?, ?, 'tool', ?, 'x', ?, ?, ?, ?)`,
  ).bind(toolId, ns.id, name, opts.community ? 1 : 0, `https://github.com/${ns.name}/${name}`, now, now).run();
  for (const v of versions) {
    const [maj, min, pat] = v.split(".").map(Number);
    await DB().prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, status, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'docker', 'published', ?, ?)`,
    ).bind(ulid(), toolId, v, maj, min, pat, JSON.stringify(manifest(ns.name, name, v, opts.over)), now, now).run();
  }
  await recomputeLatest(await testEnv(), toolId);
  return { id: toolId, name, ref: `${ns.name}/${name}` };
}

const post = (path: string, headers: Record<string, string>, body: unknown = {}) => call(path, { method: "POST", headers, body: JSON.stringify(body) });

// ---------- owners ----------

describe("yank and deprecate", () => {
  it("lets owners yank a version out of @latest while it stays installable by exact version", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns, ["1.0.0", "1.1.0"]);
    expect(((await (await call(`/tools/${p.ref}/latest/manifest`)).json()) as any).version).toBe("1.1.0");

    const stranger = await person();
    expect((await post(`/tools/${p.ref}/1.1.0/yank`, stranger.auth)).status).toBe(403);
    expect(await (await post(`/tools/${p.ref}/1.1.0/yank`, owner.auth)).json()).toEqual({ ref: p.ref, version: "1.1.0", status: "yanked" });
    expect(((await (await call(`/tools/${p.ref}/latest/manifest`)).json()) as any).version).toBe("1.0.0");
    expect(((await (await call(`/tools/${p.ref}/1.1.0/manifest`)).json()) as any).status).toBe("yanked");
    expect((await post(`/tools/${p.ref}/1.1.0/yank`, owner.auth)).status).toBe(409);

    await post(`/tools/${p.ref}/1.1.0/unyank`, owner.auth);
    expect(((await (await call(`/tools/${p.ref}/latest/manifest`)).json()) as any).version).toBe("1.1.0");
  });

  it("deprecates with a message and a replacement, and undoes it", async () => {
    const owner = await person();
    const ns = await namespace(owner);
    const [old, next] = [await pkg(ns, ["1.0.0"]), await pkg(ns, ["2.0.0"])];
    expect((await post(`/tools/${old.ref}/deprecate`, owner.auth, { message: "Use the new one", replacement: "nobody/nothing" })).status).toBe(400);
    await post(`/tools/${old.ref}/deprecate`, owner.auth, { message: "Use the new one", replacement: next.ref });
    expect(await (await call(`/tools/${old.ref}`)).json()).toMatchObject({ status: "deprecated", deprecated_message: "Use the new one", deprecated_replacement: next.ref });
    // ot install reads it from the manifest response, to warn.
    expect(await (await call(`/tools/${old.ref}/latest/manifest`)).json()).toMatchObject({ deprecated: true, deprecated_message: "Use the new one", deprecated_replacement: next.ref });
    await call(`/tools/${old.ref}/deprecate`, { method: "DELETE", headers: owner.auth });
    expect(((await (await call(`/tools/${old.ref}`)).json()) as any).status).toBe("active");
    expect(((await (await call(`/tools/${old.ref}/latest/manifest`)).json()) as any).deprecated).toBeUndefined();
  });
});

// ---------- reviewers ----------

describe("removal", () => {
  it("removes a version: it stops resolving, owners are told, and it is listed publicly", async () => {
    const owner = await person();
    const reviewer = await person({ reviewer: true });
    const ns = await namespace(owner);
    const p = await pkg(ns, ["1.0.0", "1.1.0"]);
    expect((await post(`/admin/tools/${p.ref}/1.1.0/remove`, owner.auth, { category: "malware", reason: "x" })).status).toBe(403);
    expect((await post(`/admin/tools/${p.ref}/1.1.0/remove`, reviewer.auth, { category: "spam", reason: "x" })).status).toBe(400);
    const res = await post(`/admin/tools/${p.ref}/1.1.0/remove`, reviewer.auth, { category: "malware", reason: "Exfiltrates environment variables" });
    expect(await res.json()).toMatchObject({ status: "removed", version: "1.1.0" });

    const m = (await (await call(`/tools/${p.ref}/1.1.0/manifest`)).json()) as any;
    expect(m).toMatchObject({ status: "removed", removed_reason: "Exfiltrates environment variables", manifest: null });
    expect(((await (await call(`/tools/${p.ref}/latest/manifest`)).json()) as any).version).toBe("1.0.0");
    expect(emails.at(-1)).toMatchObject({ to: [`${owner.login}@example.com`], subject: `${p.ref} 1.1.0 was removed from the registry` });

    const t = (await (await call("/removed")).json()) as any;
    expect(t.removed).toContainEqual({ ref: p.ref, version: "1.1.0", category: "malware", removed_at: expect.any(Number) });
    expect(t.quarters[0]).toMatchObject({ removals: expect.any(Number) });
    const log = (await (await call("/admin/audit-log", { headers: reviewer.auth })).json()) as any;
    expect(log.entries.find((e: any) => e.action === "version.remove")).toMatchObject({ actor: reviewer.login, metadata: { category: "malware" } });
  });

  it("removes a whole tool and can suspend its namespace; the tool then answers 410", async () => {
    const owner = await person();
    const reviewer = await person({ reviewer: true });
    const ns = await namespace(owner);
    const p = await pkg(ns, ["1.0.0"]);
    const epoch = async () => (await DB().prepare(`SELECT value FROM settings WHERE key = 'cache_epoch'`).first<{ value: string }>())!.value;
    const before = await epoch();
    await post(`/admin/tools/${p.ref}/remove`, reviewer.auth, { category: "policy", reason: "Stalkerware", suspend_namespace: true });
    // Nothing cached at the edge before the takedown is served again.
    expect(await epoch()).not.toBe(before);
    const res = await call(`/tools/${p.ref}`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as any).error.code).toBe("tool_removed");
    expect((await call(`/tools/${p.ref}/latest/manifest`)).status).toBe(410);
    expect((await DB().prepare(`SELECT status FROM namespaces WHERE id = ?`).bind(ns.id).first<any>()).status).toBe("suspended");
    expect(((await (await call("/removed")).json()) as any).removed).toContainEqual(expect.objectContaining({ ref: p.ref, version: null, category: "policy" }));
  });
});

describe("reports", () => {
  it("takes anonymous reports with a per-address limit and alerts reviewers to malware at once", async () => {
    const owner = await person();
    const reviewer = await person({ reviewer: true });
    const ns = await namespace(owner);
    const p = await pkg(ns, ["1.0.0"]);
    const anon = (body: unknown, ip = "203.0.113.7") => call(`/tools/${p.ref}/reports`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) });

    expect((await anon({ reason: "nonsense", details: "x" })).status).toBe(400);
    const first = await anon({ reason: "malware", details: "It uploads ~/.ssh", version: "1.0.0" });
    expect(first.status).toBe(201);
    expect(emails.at(-1)).toMatchObject({ to: expect.arrayContaining([`${reviewer.login}@example.com`]), subject: `[URGENT malware] ${p.ref}@1.0.0` });
    for (let i = 0; i < 4; i++) expect((await anon({ reason: "broken" })).status).toBe(201);
    expect((await anon({ reason: "broken" })).status).toBe(429);
    expect((await anon({ reason: "broken" }, "198.51.100.1")).status).toBe(201);
    // Only a hash of the address is kept, never the address.
    expect(JSON.stringify((await DB().prepare(`SELECT * FROM rate_limits`).all()).results)).not.toContain("203.0.113.7");

    const queue = (await (await call("/admin/reports", { headers: reviewer.auth })).json()) as any;
    const mine = queue.reports.filter((r: any) => r.ref === p.ref);
    expect(mine[0]).toMatchObject({ reason: "malware", version: "1.0.0", status: "open" });
    const id = mine[0].id;
    expect((await post(`/admin/reports/${id}/resolve`, reviewer.auth, { status: "actioned", action: "removed version", note: "confirmed" })).status).toBe(200);
    const after = (await (await call("/admin/reports?status=actioned", { headers: reviewer.auth })).json()) as any;
    expect(after.reports.find((r: any) => r.id === id)).toMatchObject({ action: "removed version", resolved_by: reviewer.login });
    // Resolved once only: a second decision is refused, and the first stands.
    const again = await post(`/admin/reports/${id}/resolve`, reviewer.auth, { status: "dismissed", note: "late" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.code).toBe("already_resolved");
    expect(await DB().prepare(`SELECT status, action FROM reports WHERE id = ?`).bind(id).first()).toEqual({ status: "actioned", action: "removed version" });
  });
});

describe("bans", () => {
  it("lets admins ban a user, which ends their sessions and tokens", async () => {
    const admin = await person({ admin: true });
    const reviewer = await person({ reviewer: true });
    const bad = await person();
    expect((await call("/me", { headers: bad.auth })).status).toBe(200);
    expect((await post(`/admin/users/${bad.login}/ban`, reviewer.auth, { reason: "x" })).status).toBe(403);
    expect((await post(`/admin/users/${bad.login}/ban`, admin.auth, { reason: "Credential stuffing tools" })).status).toBe(200);
    expect((await call("/me", { headers: bad.auth })).status).toBe(401);
  });
});

describe("audit log", () => {
  const entry = (action: string, kind: string, id: string, at = Date.now(), actor: { id: string } | null = null) =>
    DB().prepare(`INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(ulid(), actor?.id ?? null, actor ? "user" : "system", action, kind, id, at);
  const read = async (query: string, auth: Record<string, string>) => {
    const res = await call(`/admin/audit-log?${query}`, { headers: auth });
    return { status: res.status, body: (await res.json()) as any };
  };
  const row = (sql: string, ...values: unknown[]) => DB().prepare(sql).bind(...values);

  it("says what each entry is about: its package, person or link, and null once the row is gone", async () => {
    const reviewer = await person({ reviewer: true });
    const owner = await person();
    const [upper, named] = [await person(), await person()];
    const ns = await namespace(owner);
    const p = await pkg(ns, ["1.0.0"]);
    const version = (await DB().prepare(`SELECT id FROM versions WHERE tool_id = ?`).bind(p.id).first<{ id: string }>())!.id;
    const token = (await DB().prepare(`SELECT id FROM api_tokens WHERE user_id = ?`).bind(owner.id).first<{ id: string }>())!.id;
    const [handle, wanted, account, installation, now] = [`h${uniq()}`, `https://github.com/someone/wanted-${uniq()}`, `acct${uniq()}`, uniq(), Date.now()];
    const rows = [
      row(`UPDATE users SET login = upper(login), handle = login WHERE id = ?`, upper.id),
      row(`UPDATE users SET handle = ? WHERE id = ?`, handle, named.id),
      row(`INSERT INTO installations (id, github_installation_id, account_login) VALUES (?, ?, ?)`, ulid(), Number(installation), account),
    ];
    // Adds a row with a new id, and returns the id.
    const add =(sql: string, ...values: unknown[]) => {
      const id = ulid();
      rows.push(row(sql, id, ...values));
      return id;
    };
    const report = add(`INSERT INTO reports (id, tool_id, version_id, reason, created_at) VALUES (?, ?, ?, 'broken', ?)`, p.id, version, now);
    const issue = add(`INSERT INTO issues (id, tool_id, number, kind, title, created_at, last_activity_at) VALUES (?, ?, 7, 'broken', 'x', ?, ?)`, p.id, now, now);
    const comment = add(`INSERT INTO issue_comments (id, issue_id, body_md, created_at) VALUES (?, ?, 'x', ?)`, issue, now);
    const transfer = add(`INSERT INTO transfers (id, tool_id, from_namespace_id, requested_by, kind, created_at) VALUES (?, ?, ?, ?, 'transfer', ?)`, p.id, ns.id, owner.id, now);
    const submission = `INSERT INTO wrapper_submissions (id, number, provider, upstream_path, upstream_key, upstream_url, name, runtime, manifest_json, tool_id, created_at, updated_at)
      VALUES (?, ?, 'github', 'someone/thing', 'github:someone/thing', 'https://github.com/someone/thing', 'thing', 'docker', '{}', ?, ?, ?)`;
    const [released, submitted] = [add(submission, Number(uniq()), p.id, now, now), add(submission, Number(uniq()), null, now, now)];
    const job = add(`INSERT INTO publish_jobs (id, delivery_id, provider, repo, tag, status, tool_id, version_id, created_at) VALUES (?, ?, 'github', ?, 'v1.0.0', 'published', ?, ?, ?)`,
      `d${uniq()}`, p.ref, p.id, version, now);
    const upload = add(`INSERT INTO publish_jobs (id, delivery_id, provider, repo, tag, status, created_at) VALUES (?, ?, 'direct', 'someone/thing', 'v2.0.0', 'rejected', ?)`, `d${uniq()}`, now);
    const source = add(`INSERT INTO sources (id, tool_id, provider, project_id, url) VALUES (?, ?, 'github', ?, ?)`, p.id, uniq(), `https://github.com/${p.ref}`);
    const request = add(`INSERT INTO tool_requests (id, number, provider, repo_path, repo_key, url, created_at, updated_at) VALUES (?, ?, 'github', 'x', ?, ?, ?, ?)`,
      Number(uniq()), `github:${wanted}`, wanted, now, now);
    const reply = add(`INSERT INTO request_comments (id, request_id, body_md, created_at) VALUES (?, ?, 'x', ?)`, request, now);
    const imported = add(`INSERT INTO imports (id, user_id, provider, path, created_at, updated_at) VALUES (?, ?, 'github', 'someone/imported', ?, ?)`, owner.id, now, now);
    const feedback = add(`INSERT INTO feedback (id, kind, message, source, created_at) VALUES (?, 'idea', 'x', 'web', ?)`, now);
    await DB().batch(rows);
    const cases: [kind: string, id: string, target: string | null][] = [
      ["namespace", ns.id, ns.name],
      ["tool", p.id, p.ref],
      ["version", version, `${p.ref} 1.0.0`],
      // The handle only when it says more than the login.
      ["user", owner.id, owner.login],
      ["user", upper.id, upper.login.toUpperCase()],
      ["user", named.id, `${named.login} (@${handle})`],
      ["report", report, `${p.ref} 1.0.0`],
      ["issue", issue, `${p.ref}#7`],
      ["comment", comment, `${p.ref}#7`],
      ["transfer", transfer, p.ref],
      ["submission", released, p.ref],
      ["submission", submitted, "https://github.com/someone/thing"],
      // A share's row is deleted by the takedown that audits it; its link is its id.
      ["share", "Sh4redRuns", "https://otinstaller.com/r/Sh4redRuns"],
      ["publish_job", job, `${p.ref} 1.0.0`],
      ["publish_job", upload, "someone/thing v2.0.0"],
      ["source", source, p.ref],
      ["request", request, wanted],
      ["request_comment", reply, wanted],
      ["token", token, `test (${owner.login})`],
      ["import", imported, "github:someone/imported"],
      ["installation", installation, account],
      ["feedback", feedback, null],
      ["tool", ulid(), null],
      ["user", ulid(), null],
    ];
    await DB().batch(cases.map(([kind, id]) => entry("check.target", kind, id)));
    const log = await read("action=check.target&limit=500", reviewer.auth);
    expect(log.status).toBe(200);
    const got = log.body.entries.map((e: any) => [e.target_kind, e.target_id, e.target]);
    expect(got).toEqual(expect.arrayContaining(cases));
    expect(got).toHaveLength(cases.length);
  });

  it("filters by action, actor and target in SQL, and pages through the matches only", async () => {
    const reviewer = await person({ reviewer: true });
    const actor = await person();
    const a = await namespace(await person());
    const b = await namespace(await person());
    const [one, two, other] = [await pkg(a, ["1.0.0"]), await pkg(a, ["1.0.0"]), await pkg(b, ["1.0.0"])];
    const version = (await DB().prepare(`SELECT id FROM versions WHERE tool_id = ?`).bind(one.id).first<{ id: string }>())!.id;
    const [issue, comment, report, job, t0] = [ulid(), ulid(), ulid(), ulid(), Date.now() - 60_000];
    const moved = `old${uniq()}/gone${uniq()}`;
    await DB().batch([
      row(`INSERT INTO issues (id, tool_id, number, kind, title, created_at, last_activity_at) VALUES (?, ?, 1, 'broken', 'x', ?, ?)`, issue, one.id, t0, t0),
      row(`INSERT INTO issue_comments (id, issue_id, body_md, created_at) VALUES (?, ?, 'x', ?)`, comment, issue, t0),
      row(`INSERT INTO reports (id, tool_id, reason, created_at) VALUES (?, ?, 'other', ?)`, report, two.id, t0),
      row(`INSERT INTO publish_jobs (id, delivery_id, provider, repo, tag, status, tool_id, created_at) VALUES (?, ?, 'github', ?, 'v1.0.0', 'published', ?, ?)`, job, `d${job}`, two.ref, two.id, t0),
      row(`INSERT INTO aliases (old_namespace, old_name, tool_id, created_at) VALUES (?, ?, ?, ?)`, ...moved.split("/"), one.id, t0),
      entry("namespace.approve", "namespace", a.id, t0 + 1, reviewer),
      entry("trusted_publisher.add", "namespace", a.id, t0 + 2, actor),
      // Under LIKE, the _ in trusted_publisher. would match this one too.
      entry("trustedxpublisher.add", "namespace", a.id, t0 + 3),
      entry("tool.deprecate", "tool", one.id, t0 + 4, actor),
      entry("version.yank", "version", version, t0 + 5, actor),
      entry("issue.status", "issue", issue, t0 + 6),
      entry("comment.hide", "comment", comment, t0 + 7, reviewer),
      entry("report.dismissed", "report", report, t0 + 8, reviewer),
      entry("publish.published", "publish_job", job, t0 + 9),
      entry("tool.deprecate", "tool", other.id, t0 + 10, actor),
      entry("namespace.approve", "namespace", b.id, t0 + 11, reviewer),
    ]);
    const lines = async (query: string) => {
      const log = await read(query, reviewer.auth);
      expect(log.status).toBe(200);
      return log.body.entries.map((e: any) => `${e.action} ${e.target}`);
    };

    // A namespace: itself, its packages, their versions and what belongs to them, newest first.
    const inA = [
      `publish.published ${two.ref}`, `report.dismissed ${two.ref}`, `comment.hide ${one.ref}#1`, `issue.status ${one.ref}#1`, `version.yank ${one.ref} 1.0.0`,
      `tool.deprecate ${one.ref}`, `trustedxpublisher.add ${a.name}`, `trusted_publisher.add ${a.name}`, `namespace.approve ${a.name}`,
    ];
    expect(await lines(`target=${a.name}`)).toEqual(inA);
    // One package, also at an address it moved from.
    expect(await lines(`target=${one.ref}`)).toEqual(inA.slice(2, 6));
    expect(await lines(`target=${moved.toUpperCase()}`)).toEqual(inA.slice(2, 6));
    // An action, or every action under a prefix ending in "." (where _ is only an underscore).
    expect(await lines(`target=${a.name}&action=trusted_publisher.`)).toEqual([`trusted_publisher.add ${a.name}`]);
    expect(await lines(`target=${a.name}&action=namespace.approve`)).toEqual([`namespace.approve ${a.name}`]);
    expect(await lines(`target=${a.name}&action=namespace`)).toEqual([]);
    // The person who acted, by login in any case, on its own or with the others.
    expect(await lines(`actor=${actor.login.toUpperCase()}`)).toEqual([`tool.deprecate ${other.ref}`, `version.yank ${one.ref} 1.0.0`, `tool.deprecate ${one.ref}`, `trusted_publisher.add ${a.name}`]);
    expect(await lines(`actor=${actor.login}&target=${a.name}&action=tool.`)).toEqual([`tool.deprecate ${one.ref}`]);

    // Paging keeps the filters: next_before leads to the next matching entries, and the last page has none.
    const pages: string[][] = [];
    let before: number | undefined;
    do {
      const log = await read(`target=${a.name}&limit=4${before ? `&before=${before}` : ""}`, reviewer.auth);
      pages.push(log.body.entries.map((e: any) => `${e.action} ${e.target}`));
      before = log.body.next_before;
    } while (before);
    expect(pages).toEqual([inA.slice(0, 4), inA.slice(4, 8), inA.slice(8)]);

    // Names that don't exist are 404s rather than empty pages, a malformed target is a 400, and it is for staff only.
    const code = async (query: string, auth = reviewer.auth) => {
      const log = await read(query, auth);
      return `${log.status} ${log.body.error?.code}`;
    };
    expect(await code(`target=nobody-${uniq()}`)).toBe("404 namespace_not_found");
    expect(await code(`target=${a.name}/nothing`)).toBe("404 tool_not_found");
    expect(await code(`actor=nobody${uniq()}`)).toBe("404 user_not_found");
    expect(await code("target=a/b/c")).toBe("400 invalid_parameter");
    expect(await code(`target=${a.name}`, actor.auth)).toBe("403 forbidden");
  });
});

// ---------- claims and transfers ----------

describe("claims", () => {
  async function wrapper(upstream: string) {
    const curator = await person();
    const community = await namespace(curator);
    await DB().prepare(`UPDATE namespaces SET name = ? WHERE id = ?`).bind(`osintverse-community-${uniq()}`, community.id).run();
    const ns = await DB().prepare(`SELECT id, name FROM namespaces WHERE id = ?`).bind(community.id).first<{ id: string; name: string }>();
    return pkg(ns!, ["1.0.0"], { community: true, over: { homepage: upstream } });
  }

  it("moves a wrapper to the upstream owner after a linked-account check and an admin's confirmation", async () => {
    const upstream = `upstream${uniq()}/tool`;
    const w = await wrapper(`https://github.com/${upstream}`);
    const maintainer = await person({ github: true });
    const theirs = await namespace(maintainer);
    const admin = await person({ admin: true });

    githubAdmins.add(upstream);
    const res = await post(`/tools/${w.ref}/claim`, maintainer.auth, { to: theirs.name });
    const claim = (await res.json()) as any;
    expect(res.status).toBe(201);
    expect(claim).toMatchObject({ kind: "claim", status: "verified", verification: "linked_account", to: theirs.name, upstream_url: `https://github.com/${upstream}` });
    expect(emails.at(-1)?.subject).toBe(`Claim of ${w.ref} by ${theirs.name} is verified`);

    expect((await post(`/admin/transfers/${claim.id}/complete`, maintainer.auth)).status).toBe(403);
    const done = (await (await post(`/admin/transfers/${claim.id}/complete`, admin.auth)).json()) as any;
    const newRef = `${theirs.name}/${w.name}`;
    expect(done).toMatchObject({ status: "completed", ref: newRef, alias: w.ref });
    const moved = (await (await call(`/tools/${w.ref}`)).json()) as any;
    expect(moved).toMatchObject({ namespace: theirs.name, moved_to: newRef, community_packaged: false });
    expect(((await (await call(`/tools/${w.ref}/latest/manifest`)).json()) as any).moved_to).toBe(newRef);
    expect(emails.at(-1)?.subject).toBe(`${w.ref} is now ${newRef}`);
  });

  it("verifies with a claim file when the account is not an upstream admin", async () => {
    const upstream = `upstream${uniq()}/tool`;
    const w = await wrapper(`https://github.com/${upstream}`);
    const maintainer = await person({ github: true });
    const theirs = await namespace(maintainer);
    const claim = (await (await post(`/tools/${w.ref}/claim`, maintainer.auth, { to: theirs.name })).json()) as any;
    expect(claim).toMatchObject({ status: "pending", claim_file: ".otinstaller-claim" });
    expect(claim.verification_error).toContain("not an admin");
    expect(claim.claim_token).toMatch(/^otclaim_/);

    claimFiles[upstream] = `${claim.claim_token}\n`;
    const v = (await (await post(`/transfers/${claim.id}/verify`, maintainer.auth)).json()) as any;
    expect(v).toMatchObject({ status: "verified", verification: "claim_file" });
    // Someone not involved cannot see it.
    expect((await call(`/transfers/${claim.id}`, { headers: (await person()).auth })).status).toBe(404);
  });

  it("refuses claims on packages that are not community wrappers", async () => {
    const owner = await person();
    const p = await pkg(await namespace(owner), ["1.0.0"]);
    const other = await person();
    await namespace(other);
    expect(((await (await post(`/tools/${p.ref}/claim`, other.auth)).json()) as any).error.code).toBe("not_community_packaged");
  });
});

describe("transfers", () => {
  it("moves a package once the receiving owner accepts, and keeps the old address working", async () => {
    const a = await person();
    const b = await person();
    const nsA = await namespace(a);
    const nsB = await namespace(b);
    const p = await pkg(nsA, ["1.0.0"]);
    expect((await post(`/tools/${p.ref}/transfer`, b.auth, { to: nsB.name })).status).toBe(403);
    const offer = (await (await post(`/tools/${p.ref}/transfer`, a.auth, { to: nsB.name })).json()) as any;
    expect(offer).toMatchObject({ kind: "transfer", status: "pending", from: nsA.name, to: nsB.name });
    expect(emails.at(-1)).toMatchObject({ to: [`${b.login}@example.com`], subject: `${nsA.name} offers ${p.ref} to ${nsB.name}` });
    expect(((await (await call("/me/transfers", { headers: b.auth })).json()) as any).transfers.map((t: any) => t.id)).toContain(offer.id);

    expect((await post(`/transfers/${offer.id}/accept`, a.auth)).status).toBe(403);
    const done = (await (await post(`/transfers/${offer.id}/accept`, b.auth)).json()) as any;
    expect(done).toMatchObject({ status: "completed", ref: `${nsB.name}/${p.name}` });
    expect(((await (await call(`/tools/${p.ref}`)).json()) as any).moved_to).toBe(`${nsB.name}/${p.name}`);
  });

  it("refuses to overwrite a package of the same name", async () => {
    const a = await person();
    const b = await person();
    const nsA = await namespace(a);
    const nsB = await namespace(b);
    const p = await pkg(nsA, ["1.0.0"]);
    await DB().prepare(`INSERT INTO tools (id, namespace_id, name, summary, created_at, updated_at) VALUES (?, ?, ?, 'x', 0, 0)`).bind(ulid(), nsB.id, p.name).run();
    const offer = (await (await post(`/tools/${p.ref}/transfer`, a.auth, { to: nsB.name })).json()) as any;
    expect(((await (await post(`/transfers/${offer.id}/accept`, b.auth)).json()) as any).error.code).toBe("name_taken");
  });
});

// ---------- operations ----------

describe("monitoring", () => {
  it("alerts admins to stuck publish jobs once, and sends the reviewers' digest", async () => {
    const admin = await person({ admin: true });
    const now = Date.now();
    const jobId = ulid();
    await DB().prepare(`INSERT INTO publish_jobs (id, delivery_id, provider, repo, tag, status, created_at) VALUES (?, ?, 'github', 'a/b', 'v1.0.0', 'validating', ?)`)
      .bind(jobId, `d-${jobId}`, now - 45 * 60_000).run();
    expect(await alertStuckJobs(await testEnv(), now)).toBeGreaterThan(0);
    const alert = emails.find((m) => m.subject.includes("stuck"))!;
    expect(alert.to).toContain(`${admin.login}@example.com`);
    expect(alert.text).toContain(`a/b v1.0.0: validating for 45 min (job ${jobId})`);
    await alertStuckJobs(await testEnv(), now);
    expect(emails.filter((m) => m.subject.includes("stuck"))).toHaveLength(1);
    await DB().prepare(`UPDATE publish_jobs SET status = 'error' WHERE id = ?`).bind(jobId).run();

    expect(businessDays(Date.UTC(2026, 9, 16), Date.UTC(2026, 9, 20))).toBe(2); // Fri -> Tue
    await person({ reviewer: true });
    const owner = await person();
    const ns = await namespace(owner);
    const p = await pkg(ns, ["1.0.0"]);
    await DB().prepare(`INSERT INTO reports (id, tool_id, reason, details, created_at) VALUES (?, ?, 'policy', 'x', ?)`).bind(ulid(), p.id, now - 50 * 3_600_000).run();
    expect(await dailyDigest(await testEnv(), now)).toMatchObject({ reports: expect.any(Number) });
    expect(emails.at(-1)?.text).toContain(`${p.ref}: policy (50 h)`);
  });

  it("reports server errors to Sentry with the request ID and no request data", async () => {
    let sent = "";
    fakeHosts({ "POST https://sentry.example/api/42/envelope/": async (req) => ((sent = await req.text()), { id: "x" }) });
    const e = { ...(await testEnv()), CONTENT: undefined as unknown as R2Bucket, SENTRY_DSN: "https://pubkey@sentry.example/42" };
    const res = await call("/tools/dheeraj/whois-lite/readme", { headers: { "cf-ray": "abc-LHR", cookie: "ot_session=secret" } }, e);
    expect(res.status).toBe(500);
    const [header, , event] = sent.trim().split("\n").map((l) => JSON.parse(l));
    expect(header.dsn).toBe("https://pubkey@sentry.example/42");
    expect(event).toMatchObject({ level: "error", tags: { request_id: "abc-LHR" }, transaction: "GET /v1/tools/dheeraj/whois-lite/readme" });
    expect(sent).not.toContain("secret");
  });

  // A database whose every query fails the way production's D1 did (OTINSTALLER-A and -B in Sentry).
  const failingDb = (message: string) => {
    const fail = () => Promise.reject(new Error(message));
    const stmt: Record<string, unknown> = { first: fail, all: fail, run: fail, raw: fail };
    stmt.bind = () => stmt;
    return { prepare: () => stmt, batch: fail } as unknown as D1Database;
  };

  it("answers a D1 failure on Cloudflare's side with a 503 that says when to retry, reported as a warning", async () => {
    const events: any[] = [];
    fakeHosts({ "POST https://sentry.example/api/42/envelope/": async (req) => (events.push(JSON.parse((await req.text()).trim().split("\n")[2]!)), { id: "x" }) });
    const e = (message: string) => ({ ...env, DB: failingDb(message), SENTRY_DSN: "https://pubkey@sentry.example/42" }) as any;

    const res = await call("/tools", { headers: { "cf-ray": "def-LHR" } }, e("D1_ERROR: internal error; reference = a0cj7t444s94ckbg836c09pk"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toMatchObject({
      error: { code: "database_unavailable", hint: "try again in a few seconds", request_id: "def-LHR", retry_after_s: 1 },
    });
    // Every stack lands in one warning issue instead of a new error issue each.
    expect(events.at(-1)).toMatchObject({ level: "warning", fingerprint: ["d1-unavailable", "transient"], tags: { request_id: "def-LHR" } });

    const limited = await call("/tools/dheeraj/whois-lite", {}, e("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."));
    expect(limited.status).toBe(503);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await limited.json()) as any).error.hint).toBe("try again after midnight UTC");
    expect(events.at(-1).fingerprint).toEqual(["d1-unavailable", "daily-limit"]);

    // A query of ours that D1 had to stop is still our bug.
    const ours = await call("/tools", {}, e("D1_ERROR: D1 DB exceeded its CPU time limit and was reset."));
    expect(ours.status).toBe(500);
    expect(((await ours.json()) as any).error.code).toBe("internal_error");
    expect(events.at(-1)).toMatchObject({ level: "error" });
    expect(events.at(-1).fingerprint).toBeUndefined();
  });

  it("knows which D1 errors pass on their own", () => {
    const midnight = Date.UTC(2026, 9, 24);
    expect(d1RetryAfter(new Error("D1_ERROR: Network connection lost."))).toBe(1);
    expect(d1RetryAfter(new Error("D1_ERROR: Internal error in D1 DB storage caused object to be reset."))).toBe(1);
    expect(d1RetryAfter(new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued."))).toBe(1);
    expect(d1RetryAfter(new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit."), midnight - 90_000)).toBe(90);
    expect(d1RetryAfter(new Error("D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset."))).toBeNull();
    expect(d1RetryAfter(new Error("D1_ERROR: no such table: toolz: SQLITE_ERROR"))).toBeNull();
    expect(d1RetryAfter(new Error("internal error"))).toBeNull();
  });
});

describe("removing the last version", () => {
  it("answers 410 with the reason, not 404, once nothing published is left", async () => {
    const owner = await person();
    const reviewer = await person({ reviewer: true });
    const p = await pkg(await namespace(owner), ["1.0.0"]);
    await post(`/admin/tools/${p.ref}/1.0.0/remove`, reviewer.auth, { category: "malware", reason: "Bundles a miner" });
    const res = await call(`/tools/${p.ref}/latest/manifest`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as any).error.message).toContain("(malware)");
  });
});

describe("write limits", () => {
  it("limits signed-in users to 30 changes a minute, but not reviewers", async () => {
    const owner = await person();
    const p = await pkg(await namespace(owner), ["1.0.0", "1.1.0"]);
    // The limit counts in fixed one-minute windows (rate_limits, keyed like trust.ts:overLimit). Rather than sending 31
    // requests, which under a busy parallel run can straddle a window boundary and never meet the limit, count three
    // real ones, then move the window's count to 29 so the 30th passes and the 31st is refused.
    const windowOf = async (userId: string) => ({
      key: (await sha256Hex(`${env.TOKEN_ENC_KEY}|write|${userId}`)).slice(0, 32),
      start: Math.floor(Date.now() / 60_000) * 60_000,
    });
    if (Date.now() % 60_000 > 50_000) await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 50));
    const change = (i: number) => post(`/tools/${p.ref}/1.1.0/${i % 2 ? "unyank" : "yank"}`, owner.auth);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await change(i)).status);
    const w = await windowOf(owner.id);
    expect((await DB().prepare(`SELECT count FROM rate_limits WHERE key = ? AND window_start = ?`).bind(w.key, w.start).first<{ count: number }>())?.count).toBe(3);
    await DB().prepare(`UPDATE rate_limits SET count = 29 WHERE key = ? AND window_start = ?`).bind(w.key, w.start).run();
    codes.push((await change(3)).status, (await change(4)).status);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
    // Reviewers are never limited, however many changes their window holds.
    const reviewer = await person({ reviewer: true });
    const r = await windowOf(reviewer.id);
    await DB().prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 100)`).bind(r.key, r.start).run();
    expect((await post(`/admin/reports/none/resolve`, reviewer.auth, { status: "dismissed" })).status).toBe(404);
  }, 30_000);

  it("counts token and sign-in routes too", async () => {
    const owner = await person();
    const key = (await sha256Hex(`${env.TOKEN_ENC_KEY}|write|${owner.id}`)).slice(0, 32);
    if (Date.now() % 60_000 > 55_000) await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 50));
    await DB().prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 30) ON CONFLICT DO UPDATE SET count = 30`).bind(key, Math.floor(Date.now() / 60_000) * 60_000).run();
    const res = await post("/me/tokens", owner.auth, { name: "ci", scopes: ["read"] });
    expect(res.status).toBe(429);
  });
});
