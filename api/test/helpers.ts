import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { deps, type Env } from "../src/env";
import { hmacSha256Hex } from "../src/lib/crypto";

type Reply = Response | object | string | null;
export type Handler = Reply | ((req: Request) => Reply | Promise<Reply>);

/**
 * Stands in for GitHub, GitLab, PyPI and image registries. Routes are "METHOD url-prefix"; the
 * longest matching prefix wins. A handler returning an object is sent as JSON, null as 404.
 */
export function fakeHosts(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: string }[] = [];
  deps.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "GET" ? "" : await req.clone().text();
    calls.push({ method: req.method, url: req.url, body });
    const key = Object.keys(routes)
      .filter((k) => {
        const [m, prefix] = k.split(" ");
        return m === req.method && req.url.startsWith(prefix!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(`no fake for ${req.method} ${req.url}`, { status: 599 });
    const h = routes[key]!;
    const out = typeof h === "function" ? await h(req) : h;
    if (out instanceof Response) return out.clone();
    if (out === null) return new Response("not found", { status: 404 });
    if (typeof out === "string") return new Response(out);
    return Response.json(out);
  };
  return calls;
}

let keyPem: string | undefined;
async function appPrivateKey(): Promise<string> {
  if (keyPem) return keyPem;
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  keyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return keyPem;
}

export const sent: unknown[] = [];

/** The Worker's env with a generated GitHub App key and a queue that records messages. */
export async function testEnv(): Promise<Env> {
  return {
    ...(env as unknown as Env),
    GITHUB_APP_PRIVATE_KEY: await appPrivateKey(),
    PUBLISH_QUEUE: { send: async (m: unknown) => void sent.push(m), sendBatch: async () => {} } as unknown as Queue<any>,
  };
}

export async function call(path: string, init: RequestInit = {}, e?: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.otinstaller.com/v1${path}`, init), e ?? (await testEnv()), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function webhook(event: string, payload: unknown, delivery = crypto.randomUUID(), secret = "test-webhook-secret") {
  const body = JSON.stringify(payload);
  return call("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, body)}`,
    },
  });
}

/** Cookie header value from a response's Set-Cookie headers. */
export function cookiesFrom(res: Response): string {
  // Cleared cookies come back with an empty value; a browser drops them, so do the same.
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("=")).join("; ");
}
