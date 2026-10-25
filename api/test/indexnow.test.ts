import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ulid } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { flushIndexNow, indexNowEnabled, queueIndexNow, releasePaths } from "../src/indexnow";
import { publishVersion } from "../src/scans";
import { removeVersion, setDeprecated, setYanked, toolByRef } from "../src/trust";
import { fakeHosts, testEnv } from "./helpers";

const KEY = "e504c354f3a7f3b558b3d362b4b70767";
const DB = () => env.DB;
let submitted: any[] = [];
let answer = 200;

const on = async (over: Partial<Env> = {}): Promise<Env> => ({ ...(await testEnv()), INDEXNOW_KEY: KEY, ...over });
const queued = async () => (await DB().prepare(`SELECT path FROM indexnow_queue ORDER BY path`).all<{ path: string }>()).results.map((r) => r.path);

beforeEach(async () => {
  submitted = [];
  answer = 200;
  await DB().prepare(`DELETE FROM indexnow_queue`).run();
  fakeHosts({
    "POST https://api.indexnow.org/indexnow": async (req) => (submitted.push(await req.json()), new Response(null, { status: answer })),
  });
});

describe("IndexNow", () => {
  it("is off without a key or on a local site", async () => {
    expect(indexNowEnabled(await testEnv())).toBe(false);
    expect(indexNowEnabled(await on())).toBe(true);
    expect(indexNowEnabled(await on({ SITE_URL: "http://127.0.0.1:4321" }))).toBe(false);
    await queueIndexNow(await testEnv(), ["/dheeraj/whois-lite"]);
    expect(await queued()).toEqual([]);
    expect(await flushIndexNow(await testEnv())).toEqual({ sent: 0 });
    expect(submitted).toEqual([]);
  });

  it("names a release's pages, and the landing pages that start listing a new package", () => {
    expect(releasePaths({ kind: "tool", namespace: "dheeraj", name: "whois-lite", first: false, inputs: ["domain"], categories: ["domain-dns"] }))
      .toEqual(["/dheeraj/whois-lite", "/dheeraj/whois-lite/versions", "/dheeraj", "/new"]);
    expect(releasePaths({ kind: "tool", namespace: "dheeraj", name: "x", first: true, inputs: ["domain", "string"], categories: ["domain-dns"] }))
      .toEqual(["/dheeraj/x", "/dheeraj/x/versions", "/dheeraj", "/new", "/input/domain", "/category/domain-dns"]);
    expect(releasePaths({ kind: "guide", namespace: "dheeraj", name: "g", first: true, inputs: ["email"], categories: ["email"] }))
      .toEqual(["/guides/dheeraj/g", "/dheeraj", "/new", "/input/email", "/category/email", "/guides"]);
  });

  it("sends what is queued in one request and clears it", async () => {
    const e = await on();
    await queueIndexNow(e, ["/dheeraj/whois-lite", "/dheeraj", "/dheeraj/whois-lite"], 1000);
    expect(await flushIndexNow(e, 2000)).toEqual({ sent: 2, status: 200 });
    expect(submitted).toEqual([{
      host: "otinstaller.com", key: KEY, keyLocation: `https://otinstaller.com/${KEY}.txt`,
      urlList: ["https://otinstaller.com/dheeraj", "https://otinstaller.com/dheeraj/whois-lite"],
    }]);
    expect(await queued()).toEqual([]);
    // Nothing queued: no request.
    expect(await flushIndexNow(e, 3000)).toEqual({ sent: 0 });
    expect(submitted).toHaveLength(1);
  });

  it("keeps a page changed again after it was read for the next run", async () => {
    const e = await on();
    await queueIndexNow(e, ["/dheeraj"], 1000);
    // Queued after the run started: not read, not deleted.
    await queueIndexNow(e, ["/new"], 5000);
    expect(await flushIndexNow(e, 2000)).toEqual({ sent: 1, status: 200 });
    expect(submitted[0].urlList).toEqual(["https://otinstaller.com/dheeraj"]);
    expect(await queued()).toEqual(["/new"]);
  });

  it("tries again after a refusal that can pass, drops what can't be sent, and gives up after a week", async () => {
    const e = await on();
    await queueIndexNow(e, ["/dheeraj"], 1000);
    for (const status of [403, 429, 503]) {
      answer = status;
      expect(await flushIndexNow(e, 2000)).toEqual({ sent: 0, status });
      expect(await queued()).toEqual(["/dheeraj"]);
    }
    answer = 422;
    expect(await flushIndexNow(e, 2000)).toEqual({ sent: 0, status: 422 });
    expect(await queued()).toEqual([]);
    answer = 503;
    await queueIndexNow(e, ["/new"], 1000);
    submitted = [];
    expect(await flushIndexNow(e, 1000 + 8 * 24 * 60 * 60 * 1000)).toEqual({ sent: 0 });
    expect(submitted).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("queues a new latest version's pages, and the landing pages for a package's first", async () => {
    const e = await on();
    const latest = await DB().prepare(`SELECT v.manifest_json FROM tools t JOIN versions v ON v.id = t.latest_version_id WHERE t.id = 'tool_dheeraj_whois-lite'`)
      .first<{ manifest_json: string }>();
    const m = JSON.parse(latest!.manifest_json);
    const insertVersion = async (toolId: string, version: string, manifest: object) => {
      const id = ulid();
      const [major, minor, patch] = version.split(".").map(Number);
      await DB().prepare(
        `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, semver_pre, manifest_json, runtime_kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, 'docker', 'awaiting_review', ?)`,
      ).bind(id, toolId, version, major, minor, patch, JSON.stringify(manifest), Date.now()).run();
      return id;
    };
    await publishVersion(e, await insertVersion("tool_dheeraj_whois-lite", "2.1.0", { ...m, version: "2.1.0" }));
    expect(await queued()).toEqual(["/dheeraj", "/dheeraj/whois-lite", "/dheeraj/whois-lite/versions", "/new"]);
    // Publishing it again (a retried message) is not a new announcement.
    await DB().prepare(`DELETE FROM indexnow_queue`).run();
    await publishVersion(e, (await DB().prepare(`SELECT id FROM versions WHERE tool_id = 'tool_dheeraj_whois-lite' AND version = '2.1.0'`).first<{ id: string }>())!.id);
    expect(await queued()).toEqual([]);

    const toolId = `tool_${ulid()}`;
    await DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, categories, tags, created_at, updated_at)
                        SELECT ?, namespace_id, 'tool', 'whois-new', 'A new whois lookup for testing', '["domain-dns"]', '[]', 0, 0 FROM tools WHERE id = 'tool_dheeraj_whois-lite'`).bind(toolId).run();
    await publishVersion(e, await insertVersion(toolId, "1.0.0", { ...m, name: "whois-new", version: "1.0.0" }));
    expect(await queued()).toEqual(expect.arrayContaining(["/dheeraj/whois-new", "/input/domain", "/category/domain-dns"]));
  });

  it("queues a package's pages when it is yanked, deprecated, or taken down", async () => {
    const e = await on();
    await DB().prepare(`INSERT OR IGNORE INTO users (id, login, email, is_reviewer, is_admin, created_at) VALUES ('usr_staff', 'staff', 'staff@example.com', 1, 1, 0)`).run();
    const t = (await toolByRef(e, "dheeraj", "old-username-scraper"))!;
    expect((await setYanked(e, "usr_staff", t, "0.9.0", true)).ok).toBe(true);
    expect(await queued()).toEqual(["/dheeraj/old-username-scraper", "/dheeraj/old-username-scraper/versions"]);
    await DB().prepare(`DELETE FROM indexnow_queue`).run();
    await setDeprecated(e, "usr_staff", t, "Use something else", null);
    expect(await queued()).toEqual(["/dheeraj/old-username-scraper", "/dheeraj/old-username-scraper/versions"]);
    await DB().prepare(`DELETE FROM indexnow_queue`).run();
    expect((await removeVersion(e, "usr_staff", (await toolByRef(e, "dheeraj", "old-username-scraper"))!, null, "policy", "test takedown", false)).ok).toBe(true);
    expect(await queued()).toEqual(["/dheeraj", "/dheeraj/old-username-scraper", "/dheeraj/old-username-scraper/versions"]);
  });
});
