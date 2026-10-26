import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ftsQuery } from "../src/index";
import { compatManifest } from "../src/lib/manifest";
import { rank } from "../src/ranking";

const get = async (path: string) => {
  const res = await SELF.fetch(`https://api.otinstaller.com/v1${path}`);
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
};
const refs = (body: any) => body.results.map((r: any) => `${r.namespace}/${r.name}`);

describe("search", () => {
  it("lists visible packages and hides namespaces awaiting review", async () => {
    const { status, body } = await get("/tools?limit=100");
    expect(status).toBe(200);
    expect(refs(body)).toContain("dheeraj/holehe-lite");
    expect(refs(body)).not.toContain("newbie/secret-tool");
  });

  it("finds tools by text, with prefix matching", async () => {
    const { body } = await get("/tools?q=hole");
    expect(refs(body)[0]).toBe("dheeraj/holehe-lite");
  });

  it("follows a renamed namespace", async () => {
    const before = await get("/tools?q=zebrafinch");
    expect(before.body.results).toEqual([]);
    await env.DB.prepare(`UPDATE namespaces SET name = 'zebrafinch' WHERE id = 'ns_sigstore'`).run();
    try {
      expect(refs((await get("/tools?q=zebrafinch")).body)).toContain("zebrafinch/cosign");
    } finally {
      await env.DB.prepare(`UPDATE namespaces SET name = 'sigstore' WHERE id = 'ns_sigstore'`).run();
    }
    expect((await get("/tools?q=zebrafinch")).body.results).toEqual([]);
  });

  it("puts an exact name match first", async () => {
    const { body } = await get("/tools?q=sherlock");
    expect(refs(body)[0]).toBe("osintverse-community/sherlock");
  });

  it("filters by input type", async () => {
    const { body } = await get("/tools?input=username");
    expect(refs(body).sort()).toEqual(["dheeraj/old-username-scraper", "osintverse-community/sherlock"]);
  });

  it("ranks broken tools below healthy ones", async () => {
    const { body } = await get("/tools?input=username");
    expect(refs(body)[0]).toBe("osintverse-community/sherlock");
  });

  it("ranks a registry-held manifest below an otherwise identical tool", async () => {
    // Same installs, stars and health; email-header-parser is verified (+0.2), whois-lite is registry-held (-0.15).
    const { body } = await get("/tools?limit=100");
    const order = refs(body);
    expect(order.indexOf("osintverse/email-header-parser")).toBeLessThan(order.indexOf("dheeraj/whois-lite"));
    const whois = body.results.find((r: any) => r.name === "whois-lite");
    expect(whois.manifest_held_by_registry).toBe(true);
  });

  it("filters out tools that need API keys", async () => {
    const { body } = await get("/tools?no_keys=1&input=username");
    expect(refs(body)).toEqual(["osintverse-community/sherlock"]);
  });

  it("filters by kind, and /guides is an alias", async () => {
    const a = await get("/tools?kind=guide");
    const b = await get("/guides");
    expect(refs(a.body)).toEqual(["dheeraj/email-investigation-playbook"]);
    expect(refs(b.body)).toEqual(refs(a.body));
  });

  it("says when each package's latest version was published", async () => {
    for (const path of ["/tools?limit=100", "/guides"]) {
      const { body } = await get(path);
      expect(body.results.length).toBeGreaterThan(0);
      for (const t of body.results) expect(t.published_at === null || typeof t.published_at === "number").toBe(true);
    }
    const latest = await env.DB.prepare(
      `SELECT v.published_at FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
       WHERE n.name = 'osintverse-community' AND t.name = 'sherlock'`,
    ).first<{ published_at: number }>();
    const sherlock = (await get("/tools?q=sherlock")).body.results[0];
    expect(sherlock.published_at).toBe(latest!.published_at);
    expect(sherlock.published_at).toEqual(expect.any(Number));
  });

  it("filters by runtime and category", async () => {
    expect(refs((await get("/tools?runtime=pipx")).body).sort()).toEqual(["osintverse-community/tldextract", "osintverse/phone-parse"]);
    expect(refs((await get("/tools?category=domain-dns")).body).sort()).toEqual(["dheeraj/whois-lite", "osintverse-community/tldextract"]);
  });

  it("paginates with a cursor", async () => {
    const first = await get("/tools?limit=2");
    expect(first.body.results).toHaveLength(2);
    const second = await get(`/tools?limit=2&cursor=${first.body.next_cursor}`);
    expect(refs(second.body)).not.toContain(refs(first.body)[0]);
  });

  it("rejects unknown filter values with a documented error", async () => {
    const { status, body } = await get("/tools?input=shoe-size");
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_parameter");
    expect(body.error.docs).toMatch(/otinstaller\.com\/docs\/errors#invalid_parameter/);
  });

  it("survives FTS syntax in queries", async () => {
    const { status } = await get(`/tools?q=${encodeURIComponent('"OR (* NEAR')}`);
    expect(status).toBe(200);
  });
});

describe("tool detail and manifests", () => {
  it("returns tool detail with trust flags", async () => {
    const { status, body } = await get("/tools/dheeraj/holehe-lite");
    expect(status).toBe(200);
    expect(body).toMatchObject({ latest_version: "1.2.0", signed: true, verified: false, inputs: ["email"] });
    expect(body.manifest.runtime.kind).toBe("docker");
  });

  it("serves the latest manifest with signer identity for the CLI", async () => {
    const { body, headers } = await get("/tools/dheeraj/holehe-lite/latest/manifest");
    expect(body.version).toBe("1.2.0");
    expect(body.signer_identity).toContain("refs/tags/v1.2.0");
    expect(headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("caches pinned versions longer", async () => {
    const { headers } = await get("/tools/dheeraj/holehe-lite/1.1.0/manifest");
    expect(headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("explains removed versions without serving their manifest", async () => {
    const { body } = await get("/tools/dheeraj/holehe-lite/1.0.0/manifest");
    expect(body.status).toBe("removed");
    expect(body.removed_reason).toMatch(/Malicious/);
    expect(body.manifest).toBeNull();
  });

  it("lists versions newest first", async () => {
    const { body } = await get("/tools/dheeraj/holehe-lite/versions");
    expect(body.versions.map((v: any) => v.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  it("records the real signer for keyless-signed images", async () => {
    const { body } = await get("/tools/sigstore/cosign/latest/manifest");
    expect(body.signer_identity).toBe("keyless@projectsigstore.iam.gserviceaccount.com");
    expect(body.signer_issuer).toBe("https://accounts.google.com");
  });

  it("follows aliases after a transfer", async () => {
    const { status, body } = await get("/tools/osintverse-community/holehe/latest/manifest");
    expect(status).toBe(200);
    expect(body.ref).toBe("dheeraj/holehe-lite");
    expect(body.moved_to).toBe("dheeraj/holehe-lite");
  });

  it("returns 404 for unknown and unreviewed packages", async () => {
    expect((await get("/tools/nobody/nothing")).status).toBe(404);
    expect((await get("/tools/newbie/secret-tool")).status).toBe(404);
    expect((await get("/tools/dheeraj/holehe-lite/9.9.9/manifest")).status).toBe(404);
  });
});

describe("namespaces, pivots, types, installs", () => {
  it("shows a namespace with its tools", async () => {
    const { body } = await get("/namespaces/osintverse");
    expect(body.verified).toBe(true);
    expect(body.tools.map((t: any) => t.name).sort()).toEqual(["email-header-parser", "phone-parse"]);
    // A namespace waiting for review has a page, but no packages and nothing its owner wrote (profiles.test.ts).
    const pending = await get("/namespaces/newbie");
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: "pending_review", tools: [] });
  });

  it("suggests pivots for entity types that other tools accept, through the pivot map", async () => {
    const { body } = await get("/pivots?from=email,account,breach");
    expect(body.pivots.email.map((t: any) => t.name)).toContain("holehe-lite");
    // An account feeds username and url inputs; a breach feeds nothing.
    expect(body.inputs.account).toEqual(["username", "url"]);
    expect(body.unmapped).toEqual(["breach"]);
    expect(body.pivots.breach).toBeUndefined();
  });

  it("shows ethics and network access in search, and filters to passive tools", async () => {
    const { body } = await get("/tools?q=holehe");
    const t = body.results.find((r: any) => r.name === "holehe-lite");
    expect(t.ethics).toEqual({ touches_target: false, auth_required: false, collects_personal_data: true, notifies_target: false });
    expect(t.egress).toBe(true);
    const passive = await get("/tools?passive_only=1&limit=100");
    expect(passive.body.results.map((r: any) => r.name)).not.toContain("holehe-lite");
    for (const r of passive.body.results) expect(r.ethics.collects_personal_data || r.ethics.touches_target || r.egress).toBe(false);
  });

  it("serves the vocabulary from the schema", async () => {
    const { body } = await get("/types");
    expect(body.inputs).toContain("crypto_address");
    expect(body.categories).toContain("domain-dns");
    expect(body.pivots.subdomain).toEqual([{ input: "domain" }]);
    // Every value has a plain description.
    for (const [list, key] of [["inputs", "inputs"], ["outputs", "outputs"], ["categories", "categories"]] as const) {
      for (const v of body[list]) expect(body.descriptions[key][v], `${key} ${v}`).toBeTruthy();
    }
  });

  it("counts installs anonymously and ignores unknown packages", async () => {
    const send = (tool: string, version: string) =>
      SELF.fetch("https://api.otinstaller.com/v1/installs", { method: "POST", body: JSON.stringify({ tool, version }) });
    expect((await send("dheeraj/holehe-lite", "1.2.0")).status).toBe(204);
    expect((await send("dheeraj/holehe-lite", "1.2.0")).status).toBe(204);
    expect((await send("nobody/nothing", "1.0.0")).status).toBe(204);
    const { env } = await import("cloudflare:test");
    const row = await env.DB.prepare("SELECT SUM(count) AS n FROM install_counts").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it("counts an address once per version and day, and records the kind of client", async () => {
    const { env } = await import("cloudflare:test");
    const before = (await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM install_counts").first<{ n: number }>())!.n;
    const send = (ip: string, client: string) =>
      SELF.fetch("https://api.otinstaller.com/v1/installs", {
        method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ tool: "dheeraj/holehe-lite", version: "1.2.0", client }),
      });
    await send("203.0.113.7", "mcp");
    await send("203.0.113.7", "mcp");
    await send("203.0.113.8", "agent-of-chaos");
    const after = (await env.DB.prepare("SELECT SUM(count) AS n FROM install_counts").first<{ n: number }>())!.n;
    expect(after - before).toBe(2);
    const clients = await env.DB.prepare("SELECT client, SUM(count) AS n FROM install_clients GROUP BY client ORDER BY client").all();
    expect(clients.results).toContainEqual({ client: "mcp", n: 1 });
    expect(clients.results).toContainEqual({ client: "other", n: expect.any(Number) });
  });
});

describe("facets and health", () => {
  it("counts facet values over the visible catalogue", async () => {
    const { status, body } = await get("/facets");
    expect(status).toBe(200);
    expect(body.kind).toBe("tool");
    expect(body.inputs.email).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.categories).length).toBeGreaterThan(0);
    expect(typeof body.no_keys).toBe("number");
    expect(body.runtimes.docker).toBeGreaterThanOrEqual(1);
    const guides = (await get("/facets?kind=guide")).body;
    expect(guides.kind).toBe("guide");
    expect((await get("/facets?kind=nope")).status).toBe(400);
  });

  it("sorts by the last passing health check and exposes when it ran", async () => {
    const { status, body } = await get("/tools?kind=tool&sort=health&limit=100");
    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    for (const t of body.results) expect("health_checked_at" in t).toBe(true);
    const order = body.results.map((t: any) => (t.health === "healthy" ? 2 : t.health === "broken" ? 0 : 1));
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    const detail = (await get("/tools/osintverse/phone-parse")).body;
    expect("health_checked_at" in detail).toBe(true);
  });
});

describe("latest versions", () => {
  it("lists every visible package's latest version and lifecycle, and where moved ones went", async () => {
    const { env } = await import("cloudflare:test");
    const src = await env.DB.prepare(
      `SELECT s.tool_id, n.name || '/' || t.name AS ref FROM sources s JOIN tools t ON t.id = s.tool_id JOIN namespaces n ON n.id = t.namespace_id LIMIT 1`,
    ).first<{ tool_id: string; ref: string }>();
    await env.DB.batch([
      env.DB.prepare(`UPDATE tools SET status = 'deprecated', deprecated_replacement = 'osintverse-community/sherlock' WHERE id = 'tool_dheeraj_old-username-scraper'`),
      env.DB.prepare(`UPDATE sources SET sync_status = 'unavailable' WHERE tool_id = ?`).bind(src!.tool_id),
    ]);
    try {
      const { status, body, headers } = await get("/latest");
      expect(status).toBe(200);
      expect(headers.get("cache-control")).toBe("public, max-age=3600");
      const byRef = Object.fromEntries(body.packages.map((p: any) => [p.ref, p]));
      // Each latest version is what the package's own page says.
      for (const ref of ["dheeraj/holehe-lite", "osintverse-community/sherlock", "osintverse/phone-parse"]) {
        expect(byRef[ref].latest).toBe((await get(`/tools/${ref}`)).body.latest_version);
      }
      expect(byRef["newbie/secret-tool"]).toBeUndefined();
      expect(byRef["dheeraj/old-username-scraper"]).toMatchObject({ status: "deprecated", health: "broken", replacement: "osintverse-community/sherlock" });
      expect(byRef["dheeraj/holehe-lite"].replacement).toBeUndefined();
      // A package whose source is gone leaves search but not this list.
      expect(byRef[src!.ref].source_unavailable).toBe(true);
      expect(body.moved).toContainEqual({ from: "osintverse-community/holehe", to: "dheeraj/holehe-lite" });
    } finally {
      await env.DB.batch([
        env.DB.prepare(`UPDATE tools SET status = 'active', deprecated_replacement = NULL WHERE id = 'tool_dheeraj_old-username-scraper'`),
        env.DB.prepare(`UPDATE sources SET sync_status = 'ok' WHERE tool_id = ?`).bind(src!.tool_id),
      ]);
    }
  });
});

describe("helpers", () => {
  it("builds safe FTS queries", () => {
    expect(ftsQuery("holehe lite")).toBe('"holehe"* "lite"*');
    expect(ftsQuery('"OR (*')).toBe('"or"*');
    expect(ftsQuery("   ")).toBeNull();
  });

  it("applies the plan's ranking weights", () => {
    const baseline = { installs30d: 0, stars: 0, healthy: false, broken: false, verified: false, manifestHeld: false };
    expect(rank({ ...baseline, healthy: true })).toBeCloseTo(0.4);
    expect(rank({ ...baseline, broken: true })).toBeCloseTo(-0.8);
    expect(rank({ ...baseline, manifestHeld: true })).toBeCloseTo(-0.15);
    expect(rank({ ...baseline, installs30d: Math.E - 1 })).toBeCloseTo(0.35);
  });

  it("keeps the seed's copy of the search fields the same as the API's", async () => {
    const { SEARCH_FIELDS } = await import("../src/catalog");
    expect((env as unknown as { TEST_SEED_SEARCH_FIELDS: string }).TEST_SEED_SEARCH_FIELDS).toBe(SEARCH_FIELDS);
  });

  it("filters on the latest version's manifest fields copied onto tools", async () => {
    // Every listed tool's copied fields match its latest manifest, as latestMetadata and the seed write them.
    const rows = (await env.DB.prepare(
      `SELECT t.touches_target, t.collects_personal_data, t.egress, t.language, t.level, v.manifest_json FROM tools t JOIN versions v ON v.id = t.latest_version_id`,
    ).all<{ touches_target: number | null; collects_personal_data: number | null; egress: number | null; language: string | null; level: string | null; manifest_json: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const m = JSON.parse(r.manifest_json);
      const flag = (b: unknown) => (b === undefined ? null : b ? 1 : 0);
      expect([r.touches_target, r.collects_personal_data, r.egress, r.language, r.level])
        .toEqual([flag(m.ethics?.touches_target), flag(m.ethics?.collects_personal_data), flag(m.network?.egress), m.language ?? null, m.level ?? null]);
    }
  });
});

describe("OpenAPI", () => {
  it("lists exactly the public, account, publishing and owner routes", async () => {
    const { app } = await import("../src/index");
    const spec = (await (await SELF.fetch("https://api.otinstaller.com/v1/openapi.json")).json()) as any;
    expect(spec.openapi).toBe("3.1.0");
    // Staff, scanner callbacks, webhooks and the OSINTverse device pages (HTML for a browser) are left out.
    const hidden = /^\/(admin|internal|webhooks)\/|^\/auth\/osintverse\/device/;
    const routes = new Set(
      app.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/^\/v1/, "").replace(/:(\w+)(\{[^}]*\})?/g, "{$1}")}`)
        .filter((r) => !hidden.test(r.split(" ")[1]!)),
    );
    const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]: [string, any]) => Object.keys(ops).map((m) => `${m} ${p}`)));
    expect([...routes].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((r) => !routes.has(r)).sort()).toEqual([]);
    for (const ops of Object.values(spec.paths) as any[]) for (const op of Object.values(ops) as any[]) expect(op.operationId).toMatch(/^[a-z_]+$/);
  });
});

describe("install manifests for older ot", () => {
  it("serves a manifest without the newer optional fields, and the full one beside it", async () => {
    const { body } = await get("/tools/dheeraj/holehe-lite/1.2.0/manifest");
    expect(body.manifest_full.runtime.typical_seconds).toBe(40);
    expect(body.manifest_full.ethics.notifies_target).toBe(false);
    expect(body.manifest.runtime.typical_seconds).toBeUndefined();
    expect(body.manifest.ethics).toEqual({ touches_target: false, auth_required: false, collects_personal_data: true });
    expect(body.manifest.inputs.some((i: any) => "example" in i)).toBe(false);
    expect(body.manifest.outputs).toEqual([{ type: "account" }]);
    expect(body.manifest.secrets[0].pricing).toBeUndefined();
  });

  it("leaves finding_prefixes out of the manifest older ot reads", () => {
    const m = { runtime: { kind: "docker", output_format: "text", finding_prefixes: ["[+]"] } };
    expect(compatManifest(m)).toEqual({ runtime: { kind: "docker", output_format: "text" } });
    expect(m.runtime.finding_prefixes).toEqual(["[+]"]);
  });

  it("serves only `manifest` when nothing had to be left out", async () => {
    const { body } = await get("/tools/dheeraj/whois-lite/latest/manifest");
    expect(body.manifest.name).toBe("whois-lite");
    expect(body.manifest_full).toBeUndefined();
  });

  it("carries notifies_target in search results only when the publisher says", async () => {
    const { body } = await get("/tools?limit=100");
    const by = (n: string) => body.results.find((r: any) => r.name === n);
    expect(by("holehe-lite").ethics.notifies_target).toBe(false);
    expect("notifies_target" in by("whois-lite").ethics).toBe(false);
  });
});

describe("remote MCP server", () => {
  const rpc = async (body: unknown, init: RequestInit = {}) => {
    const res = await SELF.fetch("https://api.otinstaller.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      ...init,
    });
    return { status: res.status, headers: res.headers, body: res.status === 202 ? null : ((await res.json()) as any) };
  };
  const callTool = async (name: string, args: unknown) => (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body.result;

  it("initializes without a session and lists read-only tools", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.instructions).toContain("ot mcp");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const unknown = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");

    const { body } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["search_tools", "get_tool", "list_types", "suggest_pivots", "search_guides", "read_guide"]);
    for (const t of body.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
    expect(names).not.toContain("run_tool");
  });

  it("searches, describes a tool with its consent class, and suggests pivots", async () => {
    const search = await callTool("search_tools", { query: "hole" });
    expect(search.isError).toBeUndefined();
    expect(search.structuredContent.results[0].name).toBe("holehe-lite");
    expect(JSON.parse(search.content[0].text).results[0].name).toBe("holehe-lite");

    const tool = await callTool("get_tool", { tool: "dheeraj/holehe-lite" });
    expect(tool.structuredContent).toMatchObject({ ref: "dheeraj/holehe-lite", consent_class: "personal", typical_seconds: 40, install: "ot install dheeraj/holehe-lite" });
    expect(tool.structuredContent.effects).toContain("collects personal data");
    expect(tool.structuredContent.outputs[0].attrs.map((a: any) => a.name)).toEqual(["site", "url", "recovery_hint"]);
    const pinned = await callTool("get_tool", { tool: "dheeraj/holehe-lite@1.2.0" });
    expect(pinned.structuredContent.version).toBe("1.2.0");
    expect(pinned.structuredContent.ethics.notifies_target).toBe(false);

    const pivots = await callTool("suggest_pivots", { entity_types: ["email"] });
    expect(pivots.structuredContent.pivots.email.map((t: any) => t.name)).toContain("holehe-lite");
    expect((await callTool("list_types", {})).structuredContent.inputs).toContain("email");
  });

  it("reports bad arguments and missing tools as tool errors", async () => {
    const bad = await callTool("get_tool", { tool: "not a ref" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe("invalid_params");
    const missing = await callTool("get_tool", { tool: "dheeraj/no-such-tool" });
    expect(missing.isError).toBe(true);
    const guide = await callTool("get_tool", { tool: "dheeraj/email-investigation-playbook" });
    expect(guide.structuredContent.error.code).toBe("usage");
    const unknown = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run_tool", arguments: {} } });
    expect(unknown.body.error.code).toBe(-32602);
  });

  it("reads guides", async () => {
    const found = await callTool("search_guides", { query: "email" });
    expect(found.structuredContent.results.map((r: any) => r.name)).toContain("email-investigation-playbook");
    const page = await callTool("read_guide", { guide: "dheeraj/email-investigation-playbook" });
    // The local seed doesn't render pages to R2, so either the page or the registry's own error comes back.
    if (page.isError) expect(page.structuredContent.error.code).toMatch(/^page_/);
    else expect(page.structuredContent.ref).toBe("dheeraj/email-investigation-playbook");
  });

  it("answers batches, refuses GET, allows CORS and never caches", async () => {
    const batch = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "nope" }]);
    expect(batch.body).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "method nope is not supported" } }]);
    expect(batch.headers.get("cache-control")).toBe("no-store");
    expect(batch.headers.get("access-control-allow-origin")).toBe("*");
    const get = await SELF.fetch("https://api.otinstaller.com/mcp");
    expect(get.status).toBe(405);
    const parse = await SELF.fetch("https://api.otinstaller.com/mcp", { method: "POST", body: "{" });
    expect(((await parse.json()) as any).error.code).toBe(-32700);
    const pre = await SELF.fetch("https://api.otinstaller.com/mcp", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
  });
});
