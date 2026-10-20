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

async function tagGuide(p: Awaited<ReturnType<typeof publisher>>, files: Record<string, string | Uint8Array | null>, version = "1.0.0", extra: Record<string, Handler> = links) {
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
    expect(html.body).toContain(`href="https://otinstaller.com/guides/${p.login}/email-playbook/01-step?v=1.0.0"`);
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
    const e = { ...(await testEnv()), CF_URLSCAN_ACCOUNT_ID: "cf-acct", CF_URLSCAN_TOKEN: "cf-token" };
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
    expect(page.body).toContain(`href="https://otinstaller.com/${repo}/docs/output-fields"`);
    expect(page.next).toEqual({ path: "output-fields.md", title: "Output fields" });
    const md = (await (await call(`/tools/${repo}/docs/output-fields.md?format=md`)).json()) as any;
    expect(md.body).toContain("| registrar | who registered it |");
    const readme = (await (await call(`/tools/${repo}/readme`)).json()) as any;
    expect(readme.html).toContain(`href="https://otinstaller.com/${repo}/docs/usage"`);
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

// ---------- images, README HTML, CORS ----------

const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const chunks = parts.map((p) => (typeof p === "string" ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const pngChunk = (type: string, data: string) => bytes(u32be(data.length), type, data, [0, 0, 0, 0]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk("IHDR", "x".repeat(13)), pngChunk("eXIf", "GPS 51.5N"),
  pngChunk("tEXt", "Author\0Maria Lopez"), pngChunk("IDAT", "pixels"), pngChunk("IEND", ""));
const JPEG = bytes([0xff, 0xd8], [0xff, 0xe0, 0, 7], "JFIF\0", [0xff, 0xe1, 0, 15], "Exif\0\0GPS 51N", [0xff, 0xfe, 0, 7], "Maria",
  [0xff, 0xdb, 0, 4, 1, 2], [0xff, 0xda, 0, 4, 9, 9], "scan data", [0xff, 0xd9]);
const webpChunk = (fourcc: string, data: number[] | string) => {
  const b = bytes(data);
  return bytes(fourcc, u32le(b.length), b, b.length % 2 ? [0] : []);
};
const webpBody = bytes("WEBP", webpChunk("VP8X", [0x0c, 0, 0, 0, 1, 0, 0, 1, 0, 0]), webpChunk("VP8L", "pixel"), webpChunk("EXIF", "GPS"), webpChunk("XMP ", "<x:xmpmeta/>"));
const WEBP = bytes("RIFF", u32le(webpBody.length), webpBody);
const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("images", () => {
  it("strips location and author metadata from PNG, JPEG and WebP, and sanitizes SVG", async () => {
    const { cleanImage, sniff } = await import("../src/lib/images");
    expect([sniff(PNG), sniff(JPEG), sniff(WEBP), sniff(bytes("<?xml version='1.0'?>\n<svg xmlns='x'/>")), sniff(bytes("GIF89a"))]).toEqual(["png", "jpeg", "webp", "svg", null]);
    const png = text(cleanImage("png", PNG));
    expect(png).toContain("IHDR");
    expect(png).toContain("pixels");
    expect(png).not.toMatch(/GPS|Maria|eXIf|tEXt/);
    const jpeg = cleanImage("jpeg", JPEG);
    expect(text(jpeg)).not.toMatch(/Exif|GPS|Maria/);
    expect(text(jpeg)).toContain("JFIF");
    expect([...jpeg.slice(-2)]).toEqual([0xff, 0xd9]);
    const webp = cleanImage("webp", WEBP);
    expect(text(webp)).not.toMatch(/EXIF|XMP|xmpmeta|GPS/);
    expect(new DataView(webp.buffer).getUint32(4, true)).toBe(webp.length - 8);
    expect(webp[20]! & 0x0c).toBe(0); // VP8X no longer claims EXIF or XMP
    const svg = text(cleanImage("svg", bytes(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><iframe/></foreignObject>` +
      `<a href="https://evil.example/x"><use xlink:href="#ok"/></a><image href="https://tracker.example/p.png"/><rect style="fill:url(https://t.example/a)"/></svg>`)));
    expect(svg).not.toMatch(/onload|script|foreignObject|iframe|evil|tracker|t\.example/);
    expect(svg).toContain('xlink:href="#ok"');
  });

  it("copies a guide's images to the registry and serves them from there", async () => {
    const p = await publisher();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>`;
    const files = {
      "otinstaller.yaml": guideManifest(p.login), ...guidePages({ 2: "# Step 2\n\n![photo](img/street.jpg) ![logo](../logo.svg) ![again](img/street.jpg)\n" }),
      "docs/img/street.jpg": JPEG, "logo.svg": svg,
    };
    const { out } = await tagGuide(p, files);
    expect(out?.status).toBe("scanning");
    await runContentChecks(await testEnv(), out!.versionId!);
    const page = (await (await call(`/guides/${p.login}/email-playbook/1.0.0/pages/02-step.md`)).json()) as any;
    const srcs = [...page.body.matchAll(/<img src="([^"]+)"/g)].map((m: RegExpMatchArray) => m[1]!);
    expect(srcs).toHaveLength(3);
    expect(srcs[0]).toMatch(/^https:\/\/api\.otinstaller\.com\/v1\/assets\/[0-9a-f]{64}\.jpg$/);
    expect(srcs[2]).toBe(srcs[0]);
    const jpg = await call(new URL(srcs[0]!).pathname.replace("/v1", ""));
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
    expect(jpg.headers.get("cache-control")).toContain("immutable");
    expect(text(new Uint8Array(await jpg.arrayBuffer()))).not.toContain("GPS");
    const logo = await call(new URL(srcs[1]!).pathname.replace("/v1", ""));
    expect(logo.headers.get("content-security-policy")).toContain("sandbox");
    expect(await logo.text()).toBe(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`);
    expect((await call("/assets/../../secret")).status).toBe(404);
    expect((await call(`/assets/${"0".repeat(64)}.png`)).status).toBe(404);
  });

  it.each([
    ["an image over 2 MB", { "docs/img/big.png": bytes(PNG, new Uint8Array(2 * 1024 * 1024)) }, "img/big.png", "content_image_too_large"],
    ["a JPEG that is really a GIF", { "docs/img/fake.jpg": bytes("GIF89a...") }, "img/fake.jpg", "content_image_type"],
    ["a missing image", {}, "img/none.png", "manifest_file_missing"],
  ] as const)("rejects %s", async (_l, images, ref, code) => {
    const p = await publisher();
    const { out } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages({ 1: `# Step 1\n\n![x](${ref})\n` }), ...images });
    expect(out).toMatchObject({ status: "rejected", problems: [expect.objectContaining({ code, path: `docs/${ref}` })] });
  });
});

describe("README HTML", () => {
  it("keeps layout HTML and badges' links, and drops everything active", () => {
    const md = `<p align="center"><img src="docs/logo.png" width="120" onerror="alert(1)"></p>\n\n` +
      `<a href="https://ci.example.org/x"><img src="https://img.shields.io/badge/ci-passing-green" alt="CI status"></a>\n\n` +
      `<details open><summary>More</summary>\n\nHidden <b>bold</b> <span style="color:red">text</span>.\n\n</details>\n\n` +
      `<script>steal()</script><style>p{}</style><iframe src="https://x"></iframe><a href="javascript:alert(1)">x</a> <img src=x onerror=alert(1)\n\n<!-- note -->`;
    const r = renderPage(md, ctx({ file: "README.md", root: "docs/", pages: new Set(), strict: false, allowHtml: true }));
    expect(r.html).toContain('<p align="center"><img src="https://raw.githubusercontent.com/alice/g/abc/docs/logo.png" loading="lazy" width="120"></p>');
    expect(r.html).toContain('<a href="https://ci.example.org/x" rel="nofollow noopener noreferrer"><span class="external-image">CI status</span></a>');
    expect(r.html).toContain("<details open><summary>More</summary>");
    expect(r.html).toContain("<b>bold</b> <span>text</span>");
    // Only as escaped text: no tag carries an event handler.
    expect(r.html).not.toMatch(/<[^>]*onerror|steal|<style|<iframe|javascript:|note|shields\.io/);
    expect(r.html).toContain("&lt;img src=x");
    expect(r.images).toEqual(["docs/logo.png"]);
  });
});

describe("CORS", () => {
  it("sends credentials only to the website; anyone else gets public reads", async () => {
    const site = await call("/types", { headers: { origin: "https://otinstaller.com" } });
    expect(site.headers.get("access-control-allow-origin")).toBe("https://otinstaller.com");
    expect(site.headers.get("access-control-allow-credentials")).toBe("true");
    const other = await call("/types", { headers: { origin: "https://elsewhere.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBe("*");
    expect(other.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("sync", () => {
  it("does not replace a guide's page text in search with its README", async () => {
    const { refreshReadme } = await import("../src/sync");
    const p = await publisher();
    const { out } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages() });
    await runContentChecks(await testEnv(), out!.versionId!);
    const source = await DB().prepare(`SELECT s.* FROM sources s JOIN versions v ON v.tool_id = s.tool_id WHERE v.id = ?`).bind(out!.versionId).first<any>();
    const host = { fileAt: async () => "# Just a README" } as any;
    await refreshReadme(await testEnv(), source, host, "main");
    const found = (await (await call(`/guides?q=holehe heuristics`)).json()) as any;
    expect(found.results.map((r: any) => r.namespace)).toContain(p.login);
  });
});

describe("/guides", () => {
  it("answers signed-in requests as well as anonymous ones", async () => {
    const id = ulid();
    const token = `ot_signed_in_${id}`;
    await DB().batch([
      DB().prepare(`INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)`).bind(id, `si${id.slice(-6)}`, Date.now()),
      DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
    ]);
    const res = await call("/guides?level=intermediate", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });
});

describe("URL Scanner submissions", () => {
  it("prefers a working link per host, and keeps the reason when a scan is refused", async () => {
    const p = await publisher();
    const scanned: string[] = [];
    const fakes: Record<string, Handler> = {
      ...links,
      "POST https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/scan": async (req) => {
        const url = ((await req.json()) as any).url as string;
        scanned.push(url);
        if (url.startsWith("https://gone.osint.dev")) return Response.json({ success: false, errors: [{ code: 1, message: "Scan prevented: hostname blocked" }] }, { status: 400 });
        return { uuid: "scan-ok" };
      },
      "GET https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/result/scan-ok": { verdicts: { overall: { malicious: false } } },
      "HEAD https://osint.dev/a-gone-page": new Response(null, { status: 404 }),
    };
    // osint.dev has a dead link that sorts first and a working one; the working one is scanned.
    const { out } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages({ 5: "# Step 5\n\nOld: https://osint.dev/a-gone-page\n" }) }, "1.0.0", fakes);
    const e = { ...(await testEnv()), CF_URLSCAN_ACCOUNT_ID: "cf-acct", CF_URLSCAN_TOKEN: "cf-token" };
    // The result is ready at once here, so the check finishes in its first round.
    const done = await runContentChecks(e, out!.versionId!);
    expect(done?.status).toBe("published");
    expect(scanned.sort()).toEqual(["https://gone.osint.dev/page", "https://osint.dev/handbook"]);
    expect(done?.summary.url_scans).toEqual([
      { url: "https://gone.osint.dev/page", verdict: "unknown", error: "400: Scan prevented: hostname blocked" },
      { url: "https://osint.dev/handbook", verdict: "clean", error: null },
    ]);
  });
});

describe("URL Scanner rate limits", () => {
  it("retries rate-limited submissions in the next round instead of giving up on them", async () => {
    const p = await publisher();
    let calls = 0;
    const fakes: Record<string, Handler> = {
      ...links,
      // The first submission is rate limited; later ones go through.
      "POST https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/scan": () =>
        ++calls === 1 ? Response.json({ success: false, errors: [{ message: "rate limited" }] }, { status: 429 }) : { uuid: `scan-${calls}` },
      "GET https://api.cloudflare.com/client/v4/accounts/cf-acct/urlscanner/v2/result/": { verdicts: { overall: { malicious: false } } },
    };
    const { out } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages() }, "1.0.0", fakes);
    const e = { ...(await testEnv()), CF_URLSCAN_ACCOUNT_ID: "cf-acct", CF_URLSCAN_TOKEN: "cf-token" };
    sent.length = 0;
    expect(await runContentChecks(e, out!.versionId!)).toBeNull();
    expect(sent).toEqual([{ checkVersionId: out!.versionId, attempt: 1 }]);
    const done = await runContentChecks(e, out!.versionId!, 1);
    expect(done?.status).toBe("published");
    expect(done?.summary.url_scans.map((s) => [s.url, s.verdict, s.error])).toEqual([
      ["https://gone.osint.dev/page", "clean", null],
      ["https://osint.dev/handbook", "clean", null],
    ]);
  });
});

describe("security page data", () => {
  it("lists a version's checks without the personal-data lines", async () => {
    const p = await publisher();
    const { out } = await tagGuide(p, { "otinstaller.yaml": guideManifest(p.login), ...guidePages({ 6: "# Step 6\n\nmaria.lopez@gmail.com\n" }) });
    await runContentChecks(await testEnv(), out!.versionId!);
    await DB().prepare(`UPDATE versions SET status = 'published' WHERE id = ?`).bind(out!.versionId).run();
    await DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = (SELECT tool_id FROM versions WHERE id = ?)`).bind(out!.versionId, out!.versionId).run();
    const res = (await (await call(`/tools/${p.login}/email-playbook/1.0.0/scans`)).json()) as any;
    expect(res).toMatchObject({ ref: `${p.login}/email-playbook`, version: "1.0.0", scan_status: "warn", signed: false });
    expect(res.scans.find((s: any) => s.kind === "pii")).toMatchObject({ result: "warn", summary: { hits: 1 } });
    expect(JSON.stringify(res)).not.toContain("maria");
    expect(res.scans.find((s: any) => s.kind === "links").summary.dead).toBe(1);
  });
});
