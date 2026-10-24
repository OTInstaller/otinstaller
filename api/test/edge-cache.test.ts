import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, testEnv } from "./helpers";

let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;

async function person() {
  const id = ulid();
  const token = `ot_test_${id}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)`).bind(id, `u${uniq()}`, Date.now()),
    env.DB.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { auth: { authorization: `Bearer ${token}` } };
}

// The severity-1 outage of October 2026: crawlers walking the site's filter links used up D1's daily reads.
describe("edge cache", () => {
  const cachedEnv = async () => ({ ...(await testEnv()), EDGE_CACHE: undefined });

  it("answers repeated anonymous reads from the cache, keyed by query and CORS origin", async () => {
    const e = await cachedEnv();
    const path = `/tools?q=edgecache${uniq()}&kind=tool`;
    const first = await call(path, {}, e);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-edge-cache")).toBeNull();
    const second = await call(path, {}, e);
    expect(second.headers.get("x-edge-cache")).toBe("hit");
    expect(second.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
    expect(second.headers.get("x-ot-cache-control")).toBeNull();
    expect(await second.json()).toEqual(await first.json());
    // The same filters in another order are the same page.
    const [base, query] = path.split("?");
    const reordered = await call(`${base}?${query!.split("&").reverse().join("&")}`, {}, e);
    expect(reordered.headers.get("x-edge-cache")).toBe("hit");
    // The site gets its own credentialed CORS answer, cached separately.
    const fromSite = await call(path, { headers: { origin: "https://otinstaller.com" } }, e);
    expect(fromSite.headers.get("x-edge-cache")).toBeNull();
    expect(fromSite.headers.get("access-control-allow-credentials")).toBe("true");
    expect(second.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("stops serving everything cached before a takedown or yank", async () => {
    const { bumpCacheEpoch, resetCacheEpoch } = await import("../src/edge-cache");
    const e = await cachedEnv();
    const path = `/tools?q=epoch${uniq()}`;
    resetCacheEpoch();
    await call(path, {}, e);
    expect((await call(path, {}, e)).headers.get("x-edge-cache")).toBe("hit");
    await bumpCacheEpoch(env.DB).run();
    // Within the 30 seconds an isolate trusts the epoch it read, then never again.
    resetCacheEpoch();
    expect((await call(path, {}, e)).headers.get("x-edge-cache")).toBeNull();
    expect((await call(path, {}, e)).headers.get("x-edge-cache")).toBe("hit");
  });

  it("never caches signed-in reads, writes or errors", async () => {
    const e = await cachedEnv();
    const me = await person();
    const path = `/tools?q=signedin${uniq()}`;
    await call(path, {}, e);
    expect((await call(path, { headers: me.auth }, e)).headers.get("x-edge-cache")).toBeNull();
    await call("/tools/nobody/nothing", {}, e);
    expect((await call("/tools/nobody/nothing", {}, e)).headers.get("x-edge-cache")).toBeNull();
    await call("/me", {}, e);
    expect((await call("/me", {}, e)).headers.get("x-edge-cache")).toBeNull();
  });
});

describe("ETags", () => {
  it("answers a repeated read with 304 when the body is unchanged, cached or not", async () => {
    for (const e of [await testEnv(), { ...(await testEnv()), EDGE_CACHE: undefined }]) {
      const path = `/tools?q=etag${uniq()}`;
      const first = await call(path, {}, e);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^W\/"[0-9a-f]{24}"$/);
      const again = await call(path, { headers: { "if-none-match": etag! } }, e);
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(await again.text()).toBe("");
      expect((await call(path, { headers: { "if-none-match": 'W/"other"' } }, e)).status).toBe(200);
    }
    // Signed-in reads get one too.
    const me = await person();
    const r = await call("/me", { headers: me.auth });
    expect((await call("/me", { headers: { ...me.auth, "if-none-match": r.headers.get("etag")! } })).status).toBe(304);
  });
});
