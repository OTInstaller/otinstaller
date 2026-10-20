import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { failJob, processJob } from "../src/publish";
import { findPersonalData, renderPage, resolvePath, type RenderContext } from "../src/content";
import { queueNightlyLinkChecks, recheckLinks, runContentChecks } from "../src/guides";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { deps } from "../src/env";
import { call, sent, testEnv, webhook, type Handler } from "./helpers";
import { README, fakeRelease, installation, manifestFor, statuses, tagEvent } from "./fixtures";

const DB = () => env.DB;
let n = 0;
// A fixed-width counter keeps IDs from colliding ("12" + "34" vs "123" + "4").
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;

beforeEach(() => void (sent.length = 0));

// ---------- rendering ----------

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  file: "docs/02-passive.md",
  root: "docs/",
  pages: new Set(["index.md", "02-passive.md", "sub/03-pivot.md"]),
  pageUrl: (p) => `https://otinstaller.com/guides/alice/g/1.0.0/${p.replace(/\.md$/, "")}`,
  fileUrl: (p) => `https://raw.githubusercontent.com/alice/g/abc/${p}`,
  ...over,
});

describe("rendering", () => {
  it("renders GFM with heading anchors, a table of contents and admonitions", () => {
    const r = renderPage("# Passive checks\n\n## Step one\n\n> [!WARNING]\n> Only lawful targets.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Step one\n", ctx());
    expect(r.title).toBe("Passive checks");
    expect(r.toc).toEqual([
      { depth: 1, id: "passive-checks", text: "Passive checks" },
      { depth: 2, id: "step-one", text: "Step one" },
      { depth: 2, id: "step-one-1", text: "Step one" },
    ]);
    expect(r.html).toContain('<div class="admonition admonition-warning"><p class="admonition-title">Warning</p>');
    expect(r.html).toContain("<table>");
    expect(r.problems).toEqual([]);
  });

  it("never renders raw HTML or unsafe links, and flags active content", () => {
    const r = renderPage('Hi <b>there</b><br>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>\n', ctx());
    expect(r.html).not.toMatch(/<script|<b>|href="javascript|<img src=x/);
    expect(r.html).toContain("&lt;b&gt;there");
    expect(r.html).toContain("<br>");
    expect(r.problems.map((p) => p.code)).toEqual(["content_raw_html", "content_raw_html"]);
  });

  it("points page links at the site, repository files at the tagged commit, and records the rest", () => {
    const md = "[next](sub/03-pivot.md#scope) [home](./index.md) [gone](04-missing.md) [script](../scripts/run.py)\n\n" +
      "See https://osint.dev/tools and [mail](mailto:a@example.com).\n\n![map](img/map.png) ![badge](https://img.shields.io/x.svg) ![doc](spec.pdf)\n";
    const r = renderPage(md, ctx());
    expect(r.html).toContain('href="https://otinstaller.com/guides/alice/g/1.0.0/sub/03-pivot#scope"');
    expect(r.html).toContain('href="https://otinstaller.com/guides/alice/g/1.0.0/index"');
    expect(r.html).toContain('href="https://raw.githubusercontent.com/alice/g/abc/scripts/run.py"');
    expect(r.html).toContain('<img src="https://raw.githubusercontent.com/alice/g/abc/docs/img/map.png" alt="map" loading="lazy">');
    expect(r.html).toContain('<a href="https://img.shields.io/x.svg" rel="nofollow noopener noreferrer">badge</a>');
    expect(r.html).toContain('rel="nofollow noopener noreferrer">https://osint.dev/tools</a>');
    expect(r.links).toEqual([
      { url: "04-missing.md", line: 1, missing: true },
      { url: "https://osint.dev/tools", line: 3 },
      { url: "https://img.shields.io/x.svg", line: 5 },
    ]);
    expect(r.problems.map((p) => p.code)).toEqual(["content_image_type"]);
  });

  it("treats other Markdown files as repository files in a README", () => {
    const r = renderPage("[contributing](CONTRIBUTING.md) [usage](docs/usage.md)", ctx({ file: "README.md", root: "docs/", pages: new Set(["usage.md"]), strict: false }));
    expect(r.html).toContain("https://raw.githubusercontent.com/alice/g/abc/CONTRIBUTING.md");
    expect(r.html).toContain("https://otinstaller.com/guides/alice/g/1.0.0/usage");
    expect(r.links).toEqual([]);
  });

  it("resolves paths without leaving the repository", () => {
    expect(resolvePath("docs/sub/", "../img/a.png")).toBe("docs/img/a.png");
    expect(resolvePath("docs/", "../../etc/passwd")).toBeNull();
    expect(resolvePath("docs/", "/README.md")).toBe("README.md");
  });
});

describe("personal data", () => {
  it("finds real-looking emails, phone numbers and names next to addresses, not fictional ones", () => {
    const md = [
      "Search for target@example.com or jane@test, or git@github.com:alice/x.git.", // 1: fictional
      "The suspect wrote from maria.lopez@gmail.com last week.", // 2: email
      "Call +44 20 7946 0958 or (415) 555-0199.", // 3: one real-looking phone; 555-01xx is fictional
      "Build 1792400000000 from 192.168.100.200 on 2026-10-19.", // 4: IDs, IPs, dates
      "Maria Lopez lives at 42 Elm Street, Springfield.", // 5: name + address
      "John Doe lives at 1 Main Street.", // 6: fictional name
    ].join("\n");
    const hits = findPersonalData(md, "02-passive.md");
    expect(hits.map((h) => [h.line, h.kind, h.match])).toEqual([
      [2, "email", "maria.lopez@gmail.com"],
      [3, "phone", "+44 20 7946 0958"],
      [5, "name_address", "Maria Lopez / 42 Elm Street"],
    ]);
    expect(hits[0]!.excerpt).toBe("The suspect wrote from «maria.lopez@gmail.com» last week.");
  });
});

// ---------- the publishing pipeline ----------

/** A signed-in user with an email, owner of a namespace created by installing the app. */
async function publisher(active = true) {
  const login = `gd${uniq()}`;
  const ghId = Number(uniq());
  const userId = ulid();
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(userId, login, `${login}@example.com`, Date.now()),
    DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, created_at) VALUES (?, ?, 'github', ?, ?, ?)`).bind(ulid(), userId, String(ghId), login, Date.now()),
  ]);
  const instId = Number(uniq());
  const repoId = Number(uniq());
  await webhook("installation", installation(instId, { id: ghId, login }, [repoId], ghId));
  if (active) await DB().prepare(`UPDATE namespaces SET status = 'active' WHERE name = ?`).bind(login).run();
  return { login, instId, repoId };
}

const PAGES = 20;
const nav = Array.from({ length: PAGES }, (_, i) => (i === 0 ? "index.md" : `${String(i).padStart(2, "0")}-step.md`));

const guideManifest = (ns: string, version = "1.0.0", over: { related?: string[]; nav?: string[] } = {}) => `schema: 1
kind: guide
name: email-playbook
namespace: ${ns}
version: ${version}
title: Email investigation playbook
summary: A repeatable workflow from one email address to linked accounts and breaches
license: CC-BY-4.0
categories: [email]
level: intermediate
format: guide
content:
  root: docs/
  nav:
${(over.nav ?? nav).map((p) => `    - ${p}`).join("\n")}
related_tools:
${(over.related ?? ["osintverse/email-header-parser", "dheeraj/whois-lite"]).map((r) => `  - ${r}`).join("\n")}
topics: [email]
`;

/** A 20-page guide: one live link, one dead link, one example link and one link to a missing page. */
function guidePages(extra: Record<number, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  nav.forEach((p, i) => {
    files[`docs/${p}`] = extra[i] ?? (i === 0
      ? `# Email investigation playbook\n\nStart with [the first step](01-step.md). Uses holehe heuristics.\n\nSee https://osint.dev/handbook and https://gone.osint.dev/page.\n`
      : i === 3
        ? `# Step ${i}\n\nTry it on target@example.com, see https://example.com/demo and [later](99-missing.md).\n`
        : `# Step ${i}\n\nRun \`ot run osintverse/email-header-parser\` and read https://osint.dev/handbook.\n`);
  });
  return files;
}

const links: Record<string, Handler> = {
  "HEAD https://osint.dev/": new Response(null, { status: 200 }),
  "HEAD https://gone.osint.dev/": new Response(null, { status: 404 }),
};

async function tagGuide(p: Awaited<ReturnType<typeof publisher>>, files: Record<string, string | null>, version = "1.0.0", extra: Record<string, Handler> = links) {
  const repo = `${p.login}/email-playbook`;
  const res = await webhook("create", tagEvent(p.instId, repo, p.repoId, `v${version}`));
  const jobId = ((await res.json()) as any).jobId as string;
  const calls = fakeRelease(repo, files, { extra });
  sent.length = 0; // the webhook queued the job itself
  const out = await processJob(await testEnv(), jobId);
  return { jobId, calls, out, repo };
}

describe("publishing a guide", () => {
  it("renders a 20-page guide, checks its links instead of scanning it, and publishes it", async () => {
    const p = await publisher();
    const { out, calls } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages() });
    expect(out?.status).toBe("scanning");
    // Guides are never sent to the security scanner.
    expect(calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
    expect(statuses(calls).at(-1)).toMatchObject({ state: "pending", description: "Valid; content checks running" });
    expect(sent).toEqual([{ checkVersionId: out!.versionId }]);

    const checked = await runContentChecks(await testEnv(), out!.versionId!);
    expect(checked?.status).toBe("published");
    expect(checked?.summary.links).toMatchObject({ checked: 20, dead: 1, missing: 1, malicious: 0, skipped: 1 });
    // Each distinct URL is fetched once, however many pages link to it.
    expect(calls.filter((c) => c.method === "HEAD" && c.url === "https://osint.dev/handbook")).toHaveLength(1);
    expect(statuses(calls).at(-1)).toMatchObject({ state: "success" });

    const g = (await (await call(`/guides/${p.login}/email-playbook`)).json()) as any;
    expect(g).toMatchObject({
      ref: `${p.login}/email-playbook`, version: "1.0.0", kind: "guide", title: "Email investigation playbook", level: "intermediate",
      license: "CC-BY-4.0", inputs: ["email"], needs_update: false,
      checks: { needs_update: false, links: { dead: 1, missing: 1 } },
    });
    expect(g.nav).toHaveLength(PAGES);
    expect(g.nav[0]).toEqual({ path: "index.md", title: "Email investigation playbook", words: expect.any(Number), dead_links: 1 });
    expect(g.nav[3].dead_links).toBe(1);
    expect(g.related_tools.map((t: any) => [t.ref, t.available, t.install])).toEqual([
      ["osintverse/email-header-parser", true, "ot install osintverse/email-header-parser"],
      ["dheeraj/whois-lite", true, "ot install dheeraj/whois-lite"],
    ]);
    expect(g.checks.links.dead_links).toContainEqual({ page: "index.md", line: 5, url: "https://gone.osint.dev/page", status: "dead", http_status: 404 });

    // Pages come back as HTML for the site and Markdown for the CLI, by path, short path or position.
    const html = (await (await call(`/guides/${p.login}/email-playbook/1.0.0/pages/index.md`)).json()) as any;
    expect(html).toMatchObject({ path: "index.md", position: 1, pages: PAGES, format: "html", prev: null, next: { path: "01-step.md", title: "Step 1" } });
    expect(html.body).toContain(`href="https://otinstaller.com/guides/${p.login}/email-playbook/1.0.0/01-step"`);
    const md = (await (await call(`/guides/${p.login}/email-playbook/latest/pages/01-step?format=md`)).json()) as any;
    expect(md).toMatchObject({ path: "01-step.md", format: "md", prev: { path: "index.md" } });
    expect(md.body).toContain("`ot run osintverse/email-header-parser`");
    expect(((await (await call(`/guides/${p.login}/email-playbook/latest/pages/20`)).json()) as any).path).toBe("19-step.md");
    expect((await call(`/guides/${p.login}/email-playbook/latest/pages/nope.md`)).status).toBe(404);

    // Guides are searchable by their page text, filterable, and listed on the tools they use.
    const found = (await (await call(`/guides?q=holehe heuristics`)).json()) as any;
    expect(found.results.map((r: any) => `${r.namespace}/${r.name}`)).toContain(`${p.login}/email-playbook`);
    const lvl = (await (await call(`/guides?level=intermediate&lang=en&input=email`)).json()) as any;
    expect(lvl.results.map((r: any) => r.name)).toContain("email-playbook");
    expect(((await (await call(`/guides?level=advanced`)).json()) as any).results.map((r: any) => r.namespace)).not.toContain(p.login);
    expect((await call(`/guides?lang=english`)).status).toBe(400);
    const using = (await (await call(`/tools/osintverse/email-header-parser/guides`)).json()) as any;
    expect(using.guides.map((r: any) => `${r.namespace}/${r.name}`)).toContain(`${p.login}/email-playbook`);
    expect((await call(`/tools/${p.login}/email-playbook/docs`)).status).toBe(404);
  });

  it("re-checks links nightly and marks a guide with more than 20% dead links as needing an update", async () => {
    const p = await publisher();
    const { out } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages() });
    await runContentChecks(await testEnv(), out!.versionId!);
    const toolId = (await DB().prepare(`SELECT tool_id FROM versions WHERE id = ?`).bind(out!.versionId).first<{ tool_id: string }>())!.tool_id;

    expect(await queueNightlyLinkChecks({ ...(await testEnv()), PUBLISH_QUEUE: { sendBatch: async (b: any[]) => void sent.push(...b.map((m) => m.body)) } as any })).toBeGreaterThan(0);
    expect(sent).toContainEqual({ linkCheckToolId: toolId });

    // The handbook site went away, and every page links to it.
    fakeRelease(`${p.login}/email-playbook`, {}, { extra: { "HEAD https://osint.dev/": new Response(null, { status: 410 }), "HEAD https://gone.osint.dev/": new Response(null, { status: 404 }) } });
    await recheckLinks(await testEnv(), toolId);
    const g = (await (await call(`/guides/${p.login}/email-playbook`)).json()) as any;
    expect(g.checks).toMatchObject({ needs_update: true });
    expect(g.checks.dead_link_ratio).toBe(1);
    expect(g.nav[1].dead_links).toBe(1);
  });

  it.each([
    ["an unknown related tool", (ns: string) => ({ "otinstaller.yaml": guideManifest(ns, "1.0.0", { related: ["nobody/no-such-tool"] }), ...guidePages() }), "guide_related_tool_unknown"],
    ["a script in a page", (ns: string) => ({ "otinstaller.yaml": guideManifest(ns), ...guidePages({ 2: "# Step\n\n<script>steal()</script>\n" }) }), "content_raw_html"],
    ["a page over 200 KB", (ns: string) => ({ "otinstaller.yaml": guideManifest(ns), ...guidePages({ 4: `# Big\n\n${"word ".repeat(42_000)}` }) }), "content_page_too_large"],
    ["a missing page", (ns: string) => ({ "otinstaller.yaml": guideManifest(ns), ...guidePages(), "docs/05-step.md": null }), "manifest_file_missing"],
  ] as const)("rejects %s", async (_l, files, code) => {
    const p = await publisher();
    const { out, calls } = await tagGuide(p, files(p.login));
    expect(out).toMatchObject({ status: "rejected", problems: [expect.objectContaining({ code })] });
    expect(statuses(calls).at(-1)).toMatchObject({ state: "failure" });
    expect(sent).toEqual([]);
  });

  it("holds a guide with possible personal data for a reviewer, who can publish it", async () => {
    const p = await publisher();
    const files = { "otinstaller.yaml": guideManifest(p.login), ...guidePages({ 6: "# Step 6\n\nWe traced maria.lopez@gmail.com to Maria Lopez at 42 Elm Street.\n" }) };
    const { out, calls } = await tagGuide(p, files);
    const checked = await runContentChecks(await testEnv(), out!.versionId!);
    expect(checked?.status).toBe("awaiting_review");
    expect(statuses(calls).at(-1)).toMatchObject({ state: "pending", description: "Checks done; possible personal data awaits review" });
    expect(calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(c.body).text).at(-1)).toContain("2 line(s) look like they contain personal data");

    const reviewer = await reviewerToken();
    const queue = (await (await call("/admin/review-queue", { headers: reviewer })).json()) as any;
    const item = queue.content_review.find((i: any) => i.version_id === out!.versionId);
    expect(item.scans.find((s: any) => s.kind === "pii")).toMatchObject({ result: "warn", summary: { hits: [expect.objectContaining({ page: "06-step.md", line: 3, kind: "email" }), expect.anything()] } });

    const res = await call(`/admin/versions/${out!.versionId}/approve`, { method: "POST", headers: reviewer });
    expect(await res.json()).toEqual({ status: "published" });
    expect((await call(`/guides/${p.login}/email-playbook`)).status).toBe(200);
    expect((await call(`/admin/versions/${out!.versionId}/approve`, { method: "POST", headers: reviewer })).status).toBe(409);
  });

  it("rejects a guide that links to a site URL Scanner calls malicious", async () => {
    const p = await publisher();
    const scanned: Record<string, Handler> = {
      ...links,
      "POST https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/scan": async (req) => ({ uuid: `scan-${new URL(((await req.json()) as any).url).hostname}` }),
      "GET https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/result/scan-osint.dev": { verdicts: { overall: { malicious: false } } },
      "GET https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/result/scan-gone.osint.dev": null, // still running
    };
    const { out, calls } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages() }, "1.0.0", scanned);
    const e = { ...(await testEnv()), CF_ACCOUNT_ID: "cf-acct", CF_URLSCAN_TOKEN: "cf-token" };
    sent.length = 0;
    expect(await runContentChecks(e, out!.versionId!)).toBeNull();
    expect(sent).toEqual([{ checkVersionId: out!.versionId, attempt: 1 }]);
    expect(calls.filter((c) => c.url.endsWith("/urlscanner/v2/scan"))).toHaveLength(2);

    fakeRelease(`${p.login}/email-playbook`, {}, { extra: { ...scanned, "GET https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/result/scan-gone.osint.dev": { verdicts: { overall: { malicious: true } } } } });
    const second = await runContentChecks(e, out!.versionId!, 1);
    expect(second?.status).toBe("rejected");
    const job = await DB().prepare(`SELECT status, error_code, error_detail FROM publish_jobs WHERE version_id = ?`).bind(out!.versionId).first<any>();
    expect(job).toMatchObject({ status: "rejected", error_code: "content_link_malicious" });
    expect(job.error_detail).toContain("https://gone.osint.dev/page");
  });
});

async function reviewerToken() {
  const id = ulid();
  const token = `ot_reviewer_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, is_reviewer, created_at) VALUES (?, ?, 1, ?)`).bind(id, `rev${id.slice(-6)}`, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { authorization: `Bearer ${token}` };
}

// ---------- tool docs and READMEs ----------

describe("tool docs", () => {
  it("renders a tool's README and docs at release and serves them once it is published", async () => {
    const p = await publisher();
    const repo = `${p.login}/whois-plus`;
    const res = await webhook("create", tagEvent(p.instId, repo, p.repoId, "v1.0.0"));
    const jobId = ((await res.json()) as any).jobId;
    const calls = fakeRelease(repo, {
      "otinstaller.yaml": manifestFor(p.login, "1.0.0", "docs:\n  root: docs/\n  nav: [usage.md, output-fields.md]\n"),
      "README.md": `${README}\nSee the [usage guide](docs/usage.md) and [contributing](CONTRIBUTING.md).\n`,
      "docs/usage.md": "# Usage\n\nRun `ot run whois-plus --domain example.org`. Fields are in [output fields](output-fields.md).\n",
      "docs/output-fields.md": "# Output fields\n\n| field | meaning |\n|---|---|\n| registrar | who registered it |\n",
    });
    const out = await processJob(await testEnv(), jobId);
    expect(out?.status).toBe("scanning");
    // Tools still go to the security scanner.
    const scan = JSON.parse(calls.find((c) => c.url.endsWith("/dispatches"))!.body).client_payload.scan;
    const report = await call("/internal/scans", {
      method: "POST", headers: { authorization: `Bearer ${scan.callback_token}`, "content-type": "application/json" },
      body: JSON.stringify({ signature: { status: "absent" }, vulnerabilities: null, secrets: { count: 0 }, malware: { count: 0 }, smoke: { status: "skipped" } }),
    });
    expect(((await report.json()) as any).status).toBe("published");

    const docs = (await (await call(`/tools/${repo}/docs`)).json()) as any;
    expect(docs).toMatchObject({ ref: repo, version: "1.0.0", nav: [{ path: "usage.md", title: "Usage" }, { path: "output-fields.md", title: "Output fields" }] });
    const page = (await (await call(`/tools/${repo}/docs/usage`)).json()) as any;
    expect(page.body).toContain(`href="https://otinstaller.com/tools/${repo}/docs/output-fields"`);
    expect(page.next).toEqual({ path: "output-fields.md", title: "Output fields" });
    const md = (await (await call(`/tools/${repo}/docs/output-fields.md?format=md`)).json()) as any;
    expect(md.body).toContain("| registrar | who registered it |");
    const readme = (await (await call(`/tools/${repo}/readme`)).json()) as any;
    expect(readme.html).toContain(`href="https://otinstaller.com/tools/${repo}/docs/usage"`);
    expect(readme.html).toContain(`https://raw.githubusercontent.com/${repo}/abc123/CONTRIBUTING.md`);
    expect((await call(`/tools/osintverse/email-header-parser/docs`)).status).toBe(404);
  });
});

// ---------- follow-ups from the week 4 real-service test ----------

describe("stuck releases", () => {
  it("moves the commit status on before dispatch, and closes a release whose scan never got dispatched", async () => {
    const p = await publisher();
    const repo = `${p.login}/whois-plus`;
    const res = await webhook("create", tagEvent(p.instId, repo, p.repoId, "v1.0.0"));
    const jobId = ((await res.json()) as any).jobId;
    const calls = fakeRelease(repo, { "otinstaller.yaml": manifestFor(p.login), "README.md": README }, {
      extra: { "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": new Response("down", { status: 502 }) },
    });
    await expect(processJob(await testEnv(), jobId)).rejects.toThrow(/dispatch failed/);
    expect(statuses(calls).at(-1)).toMatchObject({ state: "pending", description: "Valid; security scans running" });

    await failJob(await testEnv(), jobId, "scan dispatch failed: 502 down");
    const row = await DB().prepare(`SELECT j.status, v.status AS version_status FROM publish_jobs j JOIN versions v ON v.id = j.version_id WHERE j.id = ?`).bind(jobId).first<any>();
    expect(row).toEqual({ status: "error", version_status: "rejected" });
    expect(statuses(calls).at(-1)).toMatchObject({ state: "error", description: "The registry could not start the checks; push the tag again" });

    // Pushing the tag again is not refused as an existing version.
    const again = await webhook("create", tagEvent(p.instId, repo, p.repoId, "v1.0.0"));
    fakeRelease(repo, { "otinstaller.yaml": manifestFor(p.login), "README.md": README });
    expect((await processJob(await testEnv(), ((await again.json()) as any).jobId))?.status).toBe("scanning");
  });

  it("gives 500 errors a request ID to quote", async () => {
    const broken = { ...(await testEnv()), CONTENT: undefined as unknown as R2Bucket };
    const res = await call("/tools/dheeraj/whois-lite/readme", { headers: { "cf-ray": "8f0a1b2c3d4e5f60-LHR" } }, broken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Something went wrong on our side.", request_id: "8f0a1b2c3d4e5f60-LHR" } });
    deps.fetch = fetch;
  });
});
