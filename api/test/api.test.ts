import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ftsQuery } from "../src/index";
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

  it("filters by runtime and category", async () => {
    expect(refs((await get("/tools?runtime=pipx")).body)).toEqual(["osintverse/phone-parse"]);
    expect(refs((await get("/tools?category=domain-dns")).body)).toEqual(["dheeraj/whois-lite"]);
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
    expect((await get("/namespaces/newbie")).status).toBe(404);
  });

  it("suggests pivots for entity types that other tools accept", async () => {
    const { body } = await get("/pivots?from=email,account");
    expect(Object.keys(body.pivots)).toEqual(["email"]);
    expect(body.pivots.email.map((t: any) => t.name)).toContain("holehe-lite");
  });

  it("serves the vocabulary from the schema", async () => {
    const { body } = await get("/types");
    expect(body.inputs).toContain("crypto_address");
    expect(body.categories).toContain("domain-dns");
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
});
