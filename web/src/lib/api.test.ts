import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

const unavailable = (retryAfterS: number) =>
  Response.json({ error: { code: "database_unavailable", message: "the registry's database didn't answer", request_id: "abc-LHR", retry_after_s: retryAfterS } }, { status: 503 });

/** Answers each call with the next response in turn, and records what was asked. */
function fakeFetch(...responses: Response[]) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    return responses.shift() ?? new Response("no more answers", { status: 599 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("api", () => {
  it("tries a read once more after a brief database outage", async () => {
    vi.useFakeTimers();
    const calls = fakeFetch(unavailable(1), Response.json({ results: [] }));
    const result = api<{ results: unknown[] }>("/tools");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ results: [] });
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second try with the request ID", async () => {
    fakeFetch(unavailable(0), unavailable(0));
    const err = (await api("/tools").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: "database_unavailable" });
    expect(err.message).toContain("request ID abc-LHR");
  });

  it("doesn't retry writes, long waits or other errors", async () => {
    let calls = fakeFetch(unavailable(0));
    await expect(api("/feedback", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(calls).toHaveLength(1);

    calls = fakeFetch(unavailable(3600));
    await expect(api("/tools")).rejects.toThrow();
    expect(calls).toHaveLength(1);

    calls = fakeFetch(Response.json({ error: { code: "internal_error", message: "Something went wrong on our side." } }, { status: 500 }));
    await expect(api("/tools")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
