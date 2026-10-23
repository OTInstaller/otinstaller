// The image mirror (mirror.otinstaller.com): a small OCI registry (distribution spec v1.1) with everything in R2.
// Anyone can pull public repositories. Deleting and pulling `private/...` need the scanner credential
// (MIRROR_PUSH_TOKEN), which may also push anywhere. A publisher may push to <namespace>/<name> of a namespace they own
// or publish to, with their own `ot_` API token (the publish scope; `ot publish --image`), which makes the mirror that
// image's primary home. Clients authenticate the usual way: a 401 with a Bearer challenge, then /token (GET with the
// credential as HTTP Basic, any user name, or POST with the OAuth2 password grant), or no credential for a pull token.
//
// R2 layout (each repository keeps its own blobs, so deleting a repository never touches another):
//   repos/<name>/blobs/<digest>       a layer or config: JSON listing the chunks it was uploaded in, and its size
//   repos/<name>/data/<id>/<n>        those chunks, as uploaded (a blob is never copied once it is in R2)
//   repos/<name>/manifests/<digest>   manifests and indexes (content type in the object's metadata)
//   repos/<name>/tags/<tag>           the digest the tag points to
//   uploads/<id>.json                 a blob upload in progress
//   hidden/<name>, hidden/<name>@<digest> taken-down images: not served to the public while they wait for deletion
//   pending/<name>@<digest>           a publisher's image that no published version uses yet: only the scanner and
//                                     the repository's publishers may read it (releaseImage clears it on publishing)
//
// The referrers API is not implemented, so cosign and other clients use the tag schema (sha256-<hex>.sig,
// sha256-<hex>); the scanner copies those tags, so signatures keep verifying on the mirror.
import { findToken, hasScope, TOKEN_PREFIX } from "../lib/tokens";

export interface MirrorEnv {
  MIRROR: R2Bucket;
  MIRROR_PUSH_TOKEN?: string;
  // The registry's database (the same one the API binds): publishers' tokens and namespaces, and their pushes.
  // Without it only the scanner credential can push.
  DB?: D1Database;
}

const NAME = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
// A repository a publisher may push to: <namespace>/<name>, both manifest slugs.
const PUBLISHER_REPO = /^([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])$/;
// Tags cosign and other tools hang off an image: signatures, attestations, SBOMs.
const ATTACHED_TAG = /^sha256-([a-f0-9]{64})(\..+)?$/;
const MAX_MANIFEST = 4 * 1024 * 1024;
const TOKEN_TTL = 300;
const DAY = 86_400_000;
// Limits for publishers (the scanner has its own: backup.py and backups.ts).
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
export const MAX_HOSTED_IMAGE_BYTES = 2 * 1024 ** 3;
export const DAILY_PUSH_BYTES = 10 * 1024 ** 3;
export const TAG_PUSHES_PER_HOUR = 30;
// Bodies without a Content-Length are stored in parts of this size, so a Worker never holds more than one in memory.
const PART_SIZE = 16 * 1024 * 1024;
const enc = new TextEncoder();

export const keys = {
  blob: (n: string, d: string) => `repos/${n}/blobs/${d}`,
  manifest: (n: string, d: string) => `repos/${n}/manifests/${d}`,
  tag: (n: string, t: string) => `repos/${n}/tags/${t}`,
  upload: (id: string) => `uploads/${id}.json`,
  hiddenRepo: (n: string) => `hidden/${n}`,
  hiddenImage: (n: string, d: string) => `hidden/${n}@${d}`,
  pending: (n: string, d: string) => `pending/${n}@${d}`,
};

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64url = (s: string) => atob(s.replaceAll("-", "+").replaceAll("_", "/"));

function ociError(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return Response.json({ errors: [{ code, message }] }, { status, headers: { "Docker-Distribution-API-Version": "registry/2.0", ...headers } });
}

// ---------- credentials and tokens ----------

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Compares digests of the two strings, so the comparison takes the same time whatever they hold. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x!), v = new Uint8Array(y!);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i]! ^ v[i]!;
  return diff === 0;
}

/** The password of an HTTP Basic header (the user name is ignored), "" when unreadable, null without one. */
function basicPassword(header: string): string | null {
  if (!header.startsWith("Basic ")) return null;
  try {
    return atob(header.slice(6).trim()).split(":").slice(1).join(":");
  } catch {
    return "";
  }
}

async function isScanner(env: MirrorEnv, pass: string): Promise<boolean> {
  const secret = env.MIRROR_PUSH_TOKEN;
  return !!secret && !!pass && (await sameSecret(pass, secret));
}

type Publisher = { userId: string; tokenId: string };

/**
 * A publisher's `ot_` token, looked up as the API does (lib/tokens.ts): it needs the publish scope. Pushes by
 * publishers are only offered when the mirror can sign its tokens with a secret, or a push grant could be forged.
 */
async function publisherFor(env: MirrorEnv, pass: string): Promise<Publisher | null> {
  if (!env.DB || !env.MIRROR_PUSH_TOKEN || !pass.startsWith(TOKEN_PREFIX)) return null;
  const t = await findToken(env.DB, pass);
  return t && hasScope(t, "publish") ? { userId: t.user.id, tokenId: t.tokenId } : null;
}

/**
 * Whether a publisher may push to a repository: <namespace>/<name> in a namespace they own or publish to, which is not
 * rejected or suspended, and a repository that was not taken down.
 */
export async function canPush(env: MirrorEnv, p: Publisher, name: string): Promise<boolean> {
  const m = PUBLISHER_REPO.exec(name);
  if (!m || m[1] === "private" || !env.DB) return false;
  const ns = await env.DB.prepare(
    `SELECT n.status FROM namespaces n JOIN namespace_members m ON m.namespace_id = n.id WHERE n.name = ? AND m.user_id = ?`,
  ).bind(m[1], p.userId).first<{ status: string }>();
  if (!ns || ns.status === "rejected" || ns.status === "suspended") return false;
  return !(await env.MIRROR.head(keys.hiddenRepo(name)));
}

type Grant = { adm: boolean; push?: string[]; sub?: string; tid?: string };

async function issueToken(env: MirrorEnv, grant: Grant, now = Date.now()): Promise<string> {
  const body = b64url(JSON.stringify({ ...grant, exp: Math.floor(now / 1000) + TOKEN_TTL }));
  // Pull tokens are not secret; they are signed with a fixed key when no credential is configured (and then carry
  // nothing else: publisherFor needs the secret).
  return `${body}.${await hmac(env.MIRROR_PUSH_TOKEN || "anonymous-pull", body)}`;
}

async function verifyToken(env: MirrorEnv, token: string): Promise<Grant | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig || sig !== (await hmac(env.MIRROR_PUSH_TOKEN || "anonymous-pull", body))) return null;
  try {
    const p = JSON.parse(fromB64url(body)) as Grant & { exp: number };
    if (p.exp * 1000 <= Date.now()) return null;
    // A grant counts only from a token signed with the secret.
    if (!env.MIRROR_PUSH_TOKEN) return { adm: false };
    return { adm: p.adm === true, push: Array.isArray(p.push) ? p.push : [], sub: p.sub, tid: p.tid };
  } catch {
    return null;
  }
}

/** Who a request comes from: the scanner credential, a publisher (and the repositories they may push to), or the public. */
type Caller = { admin: boolean; authed: boolean; push: Set<string>; publisher?: Publisher };

async function caller(req: Request, env: MirrorEnv, repo?: string): Promise<Caller> {
  const h = req.headers.get("authorization") ?? "";
  const pass = basicPassword(h);
  if (pass !== null) {
    if (await isScanner(env, pass)) return { admin: true, authed: true, push: new Set() };
    const p = await publisherFor(env, pass);
    if (!p) return { admin: false, authed: false, push: new Set() };
    return { admin: false, authed: true, push: new Set(repo && (await canPush(env, p, repo)) ? [repo] : []), publisher: p };
  }
  if (h.startsWith("Bearer ")) {
    const t = await verifyToken(env, h.slice(7).trim());
    if (!t) return { admin: false, authed: false, push: new Set() };
    return { admin: t.adm, authed: true, push: new Set(t.push ?? []), publisher: t.sub && t.tid ? { userId: t.sub, tokenId: t.tid } : undefined };
  }
  return { admin: false, authed: false, push: new Set() };
}

/**
 * /token: a pull token for anyone; for the scanner credential an admin token; for a publisher's `ot_` token, push
 * rights to each repository it asks for (`scope=repository:<name>:pull,push`) that canPush allows. GET takes the
 * credential as HTTP Basic; POST the OAuth2 password grant, which containerd and buildx try first (other grants answer
 * 400, so they fall back to GET).
 */
async function tokenEndpoint(req: Request, env: MirrorEnv, url: URL): Promise<Response> {
  let pass = basicPassword(req.headers.get("authorization") ?? "");
  let scopes = url.searchParams.getAll("scope");
  if (req.method === "POST") {
    const form = new URLSearchParams(await req.text());
    if (form.get("grant_type") !== "password") return ociError(400, "UNSUPPORTED", "only the password grant is offered; use GET with Basic auth");
    pass = form.get("password") ?? "";
    scopes = form.getAll("scope");
  }
  scopes = scopes.flatMap((s) => s.split(" ")).filter(Boolean);
  const answer = async (grant: Grant) => {
    const token = await issueToken(env, grant);
    return Response.json({ token, access_token: token, expires_in: TOKEN_TTL, issued_at: new Date().toISOString() });
  };
  if (pass === null) return answer({ adm: false });
  if (await isScanner(env, pass)) return answer({ adm: true });
  const p = await publisherFor(env, pass);
  if (!p) return ociError(401, "UNAUTHORIZED", "wrong credential");
  const push: string[] = [];
  for (const s of scopes) {
    const m = /^repository:([^:]+):(.+)$/.exec(s);
    if (m && m[2]!.split(",").includes("push") && !push.includes(m[1]!) && (await canPush(env, p, m[1]!))) push.push(m[1]!);
  }
  return answer({ adm: false, push, sub: p.userId, tid: p.tokenId });
}

function challenge(req: Request, scope?: string) {
  const url = new URL(req.url);
  const parts = [`realm="${url.origin}/token"`, `service="${url.host}"`];
  if (scope) parts.push(`scope="${scope}"`);
  return ociError(401, "UNAUTHORIZED", "authentication required", { "WWW-Authenticate": `Bearer ${parts.join(",")}` });
}

// ---------- routing ----------

type Route =
  | { kind: "manifest"; name: string; ref: string }
  | { kind: "blob"; name: string; digest: string }
  | { kind: "uploads"; name: string }
  | { kind: "upload"; name: string; id: string }
  | { kind: "tags"; name: string }
  | { kind: "referrers"; name: string; digest: string };

function route(path: string): Route | null {
  const m = path.match(/^\/v2\/(.+?)\/(manifests|blobs|tags|referrers)\/(.*)$/);
  if (!m) return null;
  const [, name, what, rest] = m as unknown as [string, string, string, string];
  if (!NAME.test(name) || name.length > 255) return null;
  if (what === "manifests") return rest && (DIGEST.test(rest) || TAG.test(rest)) ? { kind: "manifest", name, ref: rest } : null;
  if (what === "tags") return rest === "list" ? { kind: "tags", name } : null;
  if (what === "referrers") return DIGEST.test(rest) ? { kind: "referrers", name, digest: rest } : null;
  if (rest === "uploads/" || rest === "uploads") return { kind: "uploads", name };
  const up = rest.match(/^uploads\/([A-Za-z0-9-]{1,64})$/);
  if (up) return { kind: "upload", name, id: up[1]! };
  return DIGEST.test(rest) ? { kind: "blob", name, digest: rest } : null;
}

const isPrivate = (name: string) => name === "private" || name.startsWith("private/");

async function hidden(env: MirrorEnv, name: string, digest?: string): Promise<boolean> {
  if (await env.MIRROR.head(keys.hiddenRepo(name))) return true;
  return !!digest && !!(await env.MIRROR.head(keys.hiddenImage(name, digest)));
}

/** A publisher's image no published version uses yet (see the pending/ marker above). */
async function pending(env: MirrorEnv, name: string, digest: string): Promise<boolean> {
  return !!(await env.MIRROR.head(keys.pending(name, digest)));
}

export async function mirrorFetch(req: Request, env: MirrorEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const base = { "Docker-Distribution-API-Version": "registry/2.0" };

  if (path === "/" && req.method === "GET") {
    return new Response("OTInstaller image mirror. Pull with the digest from the registry, e.g. docker pull mirror.otinstaller.com/<namespace>/<name>@sha256:...\n");
  }
  if (path === "/token") return tokenEndpoint(req, env, url);
  if (path === "/v2/" || path === "/v2") {
    const who = await caller(req, env);
    return who.authed ? new Response("{}", { headers: { ...base, "Content-Type": "application/json" } }) : challenge(req);
  }
  const r = route(path);
  if (!r) return ociError(404, "NAME_UNKNOWN", "no such repository or endpoint");

  const who = await caller(req, env, r.name);
  const write = !["GET", "HEAD"].includes(req.method);
  // Publishers push blobs and manifests to their own repositories; deletes and private repositories are the scanner's.
  const publisherWrite = write && req.method !== "DELETE" && (r.kind === "manifest" || r.kind === "uploads" || r.kind === "upload") && who.push.has(r.name);
  if ((write && !who.admin && !publisherWrite) || (isPrivate(r.name) && !who.admin)) {
    if (who.publisher && write) {
      return ociError(403, "DENIED", `you can't push to ${r.name}: push to <namespace>/<name> of a namespace you own or publish to`);
    }
    return challenge(req, `repository:${r.name}:${write ? "pull,push" : "pull"}`);
  }

  switch (r.kind) {
    case "referrers":
      // Not supported: clients fall back to the referrers tag schema.
      return ociError(404, "UNSUPPORTED", "the referrers API is not supported; use the tag schema");
    case "tags":
      return listTags(env, r.name, url);
    case "blob":
      if (req.method === "DELETE") return ociError(405, "UNSUPPORTED", "blobs are deleted with their manifests");
      if (!who.admin && (await hidden(env, r.name))) return ociError(404, "BLOB_UNKNOWN", "blob unknown");
      return getBlob(env, r.name, r.digest, req.method === "HEAD");
    case "manifest":
      if (req.method === "PUT") return putManifest(req, env, r.name, r.ref, who);
      if (req.method === "DELETE") {
        if (!DIGEST.test(r.ref)) return ociError(400, "UNSUPPORTED", "delete manifests by digest");
        const out = await deleteImage(env.MIRROR, r.name, r.ref);
        return out.manifests ? new Response(null, { status: 202, headers: base }) : ociError(404, "MANIFEST_UNKNOWN", "manifest unknown");
      }
      return getManifest(env, r.name, r.ref, req.method === "HEAD", who);
    case "uploads":
      if (req.method !== "POST") return ociError(405, "UNSUPPORTED", "start uploads with POST");
      return startUpload(req, env, r.name, url, who);
    case "upload":
      return continueUpload(req, env, r.name, r.id, url, who);
  }
}

// ---------- reads ----------

async function resolve(env: MirrorEnv, name: string, ref: string): Promise<string | null> {
  if (DIGEST.test(ref)) return ref;
  const t = await env.MIRROR.get(keys.tag(name, ref));
  return t ? (await t.text()).trim() : null;
}

async function getManifest(env: MirrorEnv, name: string, ref: string, head: boolean, who: Caller) {
  const digest = await resolve(env, name, ref);
  const unknown = () => ociError(404, "MANIFEST_UNKNOWN", "manifest unknown");
  if (!digest) return unknown();
  if (!who.admin) {
    if (await hidden(env, name, digest)) return unknown();
    // Before it is published, only its publishers see an image (cosign has to read it to sign it).
    if (!who.push.has(name) && (await pending(env, name, digest))) return unknown();
  }
  const obj = await env.MIRROR.get(keys.manifest(name, digest));
  if (!obj) return ociError(404, "MANIFEST_UNKNOWN", "manifest unknown");
  const headers = {
    "Docker-Distribution-API-Version": "registry/2.0",
    "Content-Type": obj.httpMetadata?.contentType ?? "application/vnd.oci.image.manifest.v1+json",
    "Content-Length": String(obj.size),
    "Docker-Content-Digest": digest,
    ETag: `"${digest}"`,
  };
  return new Response(head ? null : obj.body, { headers });
}

type BlobPointer = { size: number; parts: string[] };

async function readPointer(bucket: R2Bucket, name: string, digest: string): Promise<BlobPointer | null> {
  const obj = await bucket.get(keys.blob(name, digest));
  return obj ? ((await obj.json()) as BlobPointer) : null;
}

/** The chunks of a blob one after another, pulled only as fast as the reader takes them. */
function concat(bucket: R2Bucket, partKeys: string[]): ReadableStream<Uint8Array> {
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        if (!reader) {
          const key = partKeys[next++];
          if (key === undefined) return ctrl.close();
          const obj = await bucket.get(key);
          if (!obj) return ctrl.error(new Error(`blob chunk ${key} is missing`));
          reader = obj.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        return ctrl.enqueue(value);
      }
    },
  });
}

async function getBlob(env: MirrorEnv, name: string, digest: string, head: boolean) {
  const ptr = await readPointer(env.MIRROR, name, digest);
  if (!ptr) return ociError(404, "BLOB_UNKNOWN", "blob unknown");
  const headers = {
    "Docker-Distribution-API-Version": "registry/2.0",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(ptr.size),
    "Docker-Content-Digest": digest,
    ETag: `"${digest}"`,
  };
  if (head) return new Response(null, { headers });
  if (ptr.parts.length === 1) {
    const obj = await env.MIRROR.get(ptr.parts[0]!);
    if (!obj) return ociError(404, "BLOB_UNKNOWN", "blob unknown");
    return new Response(obj.body, { headers });
  }
  const { readable, writable } = new FixedLengthStream(ptr.size);
  concat(env.MIRROR, ptr.parts).pipeTo(writable).catch((e) => console.error("streaming a blob failed", e));
  return new Response(readable, { headers });
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function listTags(env: MirrorEnv, name: string, url: URL) {
  const prefix = keys.tag(name, "");
  let tags = (await listAll(env.MIRROR, prefix)).map((o) => o.key.slice(prefix.length)).sort();
  const last = url.searchParams.get("last");
  if (last) tags = tags.filter((t) => t > last);
  const n = Number(url.searchParams.get("n") ?? 0);
  if (n > 0) tags = tags.slice(0, n);
  return Response.json({ name, tags }, { headers: { "Docker-Distribution-API-Version": "registry/2.0" } });
}

// ---------- blob uploads ----------

type UploadState = { name: string; parts: { key: string; size: number }[]; offset: number; created: number };

const chunkKey = (name: string, id: string, n: number) => `repos/${name}/data/${id}/${n}`;

const uploadUrl = (name: string, id: string) => `/v2/${name}/blobs/uploads/${id}`;

function accepted(name: string, id: string, offset: number) {
  return new Response(null, {
    status: 202,
    headers: {
      "Docker-Distribution-API-Version": "registry/2.0",
      Location: uploadUrl(name, id),
      "Docker-Upload-UUID": id,
      Range: `0-${Math.max(offset - 1, 0)}`,
      "Content-Length": "0",
    },
  });
}

function created(name: string, digest: string) {
  return new Response(null, {
    status: 201,
    headers: { "Docker-Distribution-API-Version": "registry/2.0", Location: `/v2/${name}/blobs/${digest}`, "Docker-Content-Digest": digest, "Content-Length": "0" },
  });
}

/**
 * Stores a request body as chunk objects, numbered from `first`. A body with a Content-Length streams straight to R2
 * (which needs the length); one without, as `docker push` sends, is cut into parts of PART_SIZE, so the Worker holds
 * one part at a time. Null when the body is over `budget` bytes (nothing is kept then).
 */
async function putBody(bucket: R2Bucket, name: string, id: string, first: number, req: Request, budget: number): Promise<{ key: string; size: number }[] | null> {
  const len = req.headers.get("content-length");
  if (!req.body || len === "0") return [];
  if (len !== null) {
    if (Number(len) > budget) return null;
    const key = chunkKey(name, id, first);
    const obj = await bucket.put(key, req.body);
    return [{ key, size: obj?.size ?? 0 }];
  }
  const parts: { key: string; size: number }[] = [];
  const buf = new Uint8Array(PART_SIZE);
  let fill = 0;
  let total = 0;
  const flush = async () => {
    if (fill === 0) return;
    const key = chunkKey(name, id, first + parts.length);
    await bucket.put(key, buf.slice(0, fill));
    parts.push({ key, size: fill });
    fill = 0;
  };
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > budget) {
      await reader.cancel();
      if (parts.length) await bucket.delete(parts.map((p) => p.key));
      return null;
    }
    for (let off = 0; off < value.length;) {
      const n = Math.min(PART_SIZE - fill, value.length - off);
      buf.set(value.subarray(off, off + n), fill);
      fill += n;
      off += n;
      if (fill === PART_SIZE) await flush();
    }
  }
  await flush();
  return parts;
}

const tooLarge = () => ociError(413, "SIZE_INVALID", `a blob can be at most ${MAX_UPLOAD_BYTES / 1024 ** 3} GiB`);

async function startUpload(req: Request, env: MirrorEnv, name: string, url: URL, who: Caller) {
  // Cross-repository mounts are not offered (each repository keeps its own blobs); the client then uploads, as the
  // spec allows. A blob this repository already has needs no upload.
  const mount = url.searchParams.get("mount");
  if (mount && DIGEST.test(mount) && (await env.MIRROR.head(keys.blob(name, mount)))) return created(name, mount);
  const id = crypto.randomUUID();
  const state: UploadState = { name, parts: [], offset: 0, created: Date.now() };
  const digest = url.searchParams.get("digest");
  if (digest) {
    // Monolithic upload: the whole blob in this request.
    if (!DIGEST.test(digest)) return ociError(400, "DIGEST_INVALID", "unsupported digest");
    const parts = await putBody(env.MIRROR, name, id, 0, req, MAX_UPLOAD_BYTES);
    if (!parts) return tooLarge();
    state.parts.push(...parts);
    return finishUpload(env, name, id, state, digest, who);
  }
  await env.MIRROR.put(keys.upload(id), JSON.stringify(state));
  return accepted(name, id, 0);
}

async function loadUpload(env: MirrorEnv, name: string, id: string): Promise<UploadState | null> {
  const obj = await env.MIRROR.get(keys.upload(id));
  if (!obj) return null;
  const s = (await obj.json()) as UploadState;
  return s.name === name ? s : null;
}

async function continueUpload(req: Request, env: MirrorEnv, name: string, id: string, url: URL, who: Caller) {
  const state = await loadUpload(env, name, id);
  if (!state) return ociError(404, "BLOB_UPLOAD_UNKNOWN", "upload unknown");
  if (req.method === "GET") return new Response(null, { status: 204, headers: { Location: uploadUrl(name, id), Range: `0-${Math.max(state.offset - 1, 0)}`, "Docker-Upload-UUID": id } });
  if (req.method === "DELETE") {
    await env.MIRROR.delete([keys.upload(id), ...state.parts.map((p) => p.key)]);
    return new Response(null, { status: 204 });
  }
  if (req.method === "PATCH" || req.method === "PUT") {
    const range = req.headers.get("content-range");
    if (range) {
      const start = Number(range.replace(/^bytes[ =]/, "").split("-")[0]);
      if (start !== state.offset) return ociError(416, "BLOB_UPLOAD_INVALID", `expected the chunk at offset ${state.offset}`, { Range: `0-${Math.max(state.offset - 1, 0)}` });
    }
    const parts = await putBody(env.MIRROR, name, id, state.parts.length, req, MAX_UPLOAD_BYTES - state.offset);
    if (!parts) {
      await env.MIRROR.delete([keys.upload(id), ...state.parts.map((p) => p.key)]);
      return tooLarge();
    }
    for (const p of parts.filter((p) => p.size > 0)) {
      state.parts.push(p);
      state.offset += p.size;
    }
    if (req.method === "PATCH") {
      await env.MIRROR.put(keys.upload(id), JSON.stringify(state));
      return accepted(name, id, state.offset);
    }
    const digest = url.searchParams.get("digest");
    if (!digest || !DIGEST.test(digest)) return ociError(400, "DIGEST_INVALID", "finish the upload with ?digest=sha256:...");
    return finishUpload(env, name, id, state, digest, who);
  }
  return ociError(405, "UNSUPPORTED", "unsupported method");
}

/**
 * Adds a publisher's uploaded bytes to their namespace's count for the day (in `rate_limits`, which purgeRateLimits
 * clears) and returns the day's total.
 */
async function addPushedBytes(db: D1Database, namespace: string, bytes: number, now = Date.now()): Promise<number> {
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + excluded.count RETURNING count`,
  ).bind(`mirror_bytes|${namespace}`, Math.floor(now / DAY) * DAY, bytes).first<{ count: number }>();
  return row?.count ?? bytes;
}

/**
 * Checks the uploaded chunks against the digest by reading them once, then records the blob as those chunks.
 * Nothing is copied, so a blob of any size finishes in one pass; a blob whose content does not match is deleted.
 */
async function finishUpload(env: MirrorEnv, name: string, id: string, state: UploadState, digest: string, who: Caller) {
  const bucket = env.MIRROR;
  const discard = () => bucket.delete([keys.upload(id), ...state.parts.map((p) => p.key)]);
  if (await bucket.head(keys.blob(name, digest))) {
    await discard();
    return created(name, digest);
  }
  const hasher = new crypto.DigestStream("SHA-256");
  await concat(bucket, state.parts.map((p) => p.key)).pipeTo(hasher);
  const got = `sha256:${toHex(await hasher.digest)}`;
  if (got !== digest) {
    await discard();
    return ociError(400, "DIGEST_INVALID", `content hashes to ${got}, not ${digest}`);
  }
  const ptr: BlobPointer = { size: state.parts.reduce((n, p) => n + p.size, 0), parts: state.parts.map((p) => p.key) };
  // Publishers share a daily allowance per namespace, so the mirror can't be filled faster than unused uploads are cleared.
  if (who.publisher && !who.admin && env.DB) {
    const total = await addPushedBytes(env.DB, name.split("/")[0]!, ptr.size);
    if (total > DAILY_PUSH_BYTES) {
      await discard();
      return ociError(429, "TOOMANYREQUESTS", `this namespace has pushed more than ${DAILY_PUSH_BYTES / 1024 ** 3} GiB today; try again tomorrow`);
    }
  }
  await bucket.put(keys.blob(name, digest), JSON.stringify(ptr), { httpMetadata: { contentType: "application/json" } });
  await bucket.delete(keys.upload(id));
  return created(name, digest);
}

// ---------- manifests ----------

type ManifestDoc = {
  mediaType?: string;
  config?: { digest: string };
  layers?: { digest: string }[];
  manifests?: { digest: string }[];
  subject?: { digest: string };
};

function references(doc: ManifestDoc): { blobs: string[]; manifests: string[] } {
  return {
    blobs: [doc.config?.digest, ...(doc.layers ?? []).map((l) => l.digest)].filter((d): d is string => !!d && DIGEST.test(d)),
    manifests: (doc.manifests ?? []).map((m) => m.digest).filter((d) => DIGEST.test(d)),
  };
}

/** The bytes an image's manifest (or an index's platform manifests) point to, from the blob pointers. */
async function imageBytes(bucket: R2Bucket, name: string, doc: ManifestDoc, depth = 0): Promise<number> {
  const refs = references(doc);
  let total = 0;
  for (const b of refs.blobs) total += (await readPointer(bucket, name, b))?.size ?? 0;
  if (depth === 0) for (const m of refs.manifests) total += await imageBytes(bucket, name, (await readManifest(bucket, name, m)) ?? {}, 1);
  return total;
}

/**
 * The checks a publisher's manifest push passes on top of everyone's: a tag that hangs off an image (a signature,
 * an attestation) only for an image a publisher pushed here, so a backup copy's signatures can't be replaced; at most
 * TAG_PUSHES_PER_HOUR version tags per namespace an hour; and an image of at most MAX_HOSTED_IMAGE_BYTES.
 */
async function publisherManifestProblem(env: MirrorEnv, name: string, ref: string, doc: ManifestDoc): Promise<Response | null> {
  const db = env.DB!;
  const attached = ATTACHED_TAG.exec(ref);
  if (attached) {
    const subject = `sha256:${attached[1]}`;
    const ours = await db.prepare(
      `SELECT 1 FROM mirror_pushes WHERE repo = ? AND digest = ? UNION SELECT 1 FROM backups WHERE location = ? AND hosted = 1 LIMIT 1`,
    ).bind(name, subject, `${name}@${subject}`).first();
    if (!ours) return ociError(403, "DENIED", `${ref} belongs to an image that was not pushed by a publisher`);
    return null;
  }
  if (!DIGEST.test(ref)) {
    const recent = await db.prepare(
      `SELECT COUNT(*) AS n FROM mirror_pushes WHERE repo LIKE ? AND tag IS NOT NULL AND tag NOT LIKE 'sha256-%' AND created_at > ?`,
    ).bind(`${name.split("/")[0]}/%`, Date.now() - 3_600_000).first<{ n: number }>();
    if ((recent?.n ?? 0) >= TAG_PUSHES_PER_HOUR) return ociError(429, "TOOMANYREQUESTS", `at most ${TAG_PUSHES_PER_HOUR} image pushes an hour per namespace`);
  }
  if ((await imageBytes(env.MIRROR, name, doc)) > MAX_HOSTED_IMAGE_BYTES) {
    return ociError(413, "SIZE_INVALID", `an image can be at most ${MAX_HOSTED_IMAGE_BYTES / 1024 ** 3} GiB`);
  }
  return null;
}

async function putManifest(req: Request, env: MirrorEnv, name: string, ref: string, who: Caller) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_MANIFEST) return ociError(413, "SIZE_INVALID", "manifest is too large");
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_MANIFEST) return ociError(413, "SIZE_INVALID", "manifest is too large");
  const digest = `sha256:${toHex(await crypto.subtle.digest("SHA-256", bytes))}`;
  if (DIGEST.test(ref) && ref !== digest) return ociError(400, "DIGEST_INVALID", `manifest hashes to ${digest}, not ${ref}`);
  let doc: ManifestDoc;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes)) as ManifestDoc;
  } catch {
    return ociError(400, "MANIFEST_INVALID", "manifest is not JSON");
  }
  const contentType = req.headers.get("content-type")?.split(";")[0] || doc.mediaType || "application/vnd.oci.image.manifest.v1+json";
  // Everything a manifest points to must already be here, so a mirrored image is always complete.
  const refs = references(doc);
  for (const b of refs.blobs) {
    if (!(await env.MIRROR.head(keys.blob(name, b)))) return ociError(400, "MANIFEST_BLOB_UNKNOWN", `blob ${b} has not been pushed`);
  }
  for (const m of refs.manifests) {
    if (!(await env.MIRROR.head(keys.manifest(name, m)))) return ociError(400, "MANIFEST_UNKNOWN", `manifest ${m} has not been pushed`);
  }
  const publisher = !who.admin && who.publisher && env.DB ? who.publisher : null;
  if (publisher) {
    const problem = await publisherManifestProblem(env, name, ref, doc);
    if (problem) return problem;
  }
  await env.MIRROR.put(keys.manifest(name, digest), bytes, { httpMetadata: { contentType } });
  if (!DIGEST.test(ref)) await env.MIRROR.put(keys.tag(name, ref), digest);
  if (publisher) {
    // Not served to the public until a published version uses it (releaseImage). Signatures and attestations are
    // metadata about an image, so they stay readable.
    if (!ATTACHED_TAG.test(ref)) await env.MIRROR.put(keys.pending(name, digest), String(Date.now()));
    await env.DB!.prepare(`INSERT INTO mirror_pushes (id, repo, digest, tag, user_id, token_id, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), name, digest, DIGEST.test(ref) ? null : ref, publisher.userId, publisher.tokenId, bytes.byteLength, Date.now()).run();
  }
  return new Response(null, {
    status: 201,
    headers: { "Docker-Distribution-API-Version": "registry/2.0", Location: `/v2/${name}/manifests/${digest}`, "Docker-Content-Digest": digest, "Content-Length": "0" },
  });
}

// ---------- takedowns (also used by the registry API, which binds the same bucket) ----------

export async function imageExists(bucket: R2Bucket, name: string, digest: string): Promise<boolean> {
  return !!(await bucket.head(keys.manifest(name, digest)));
}

/** Stops serving an image (or, without a digest, a whole repository) to the public; the scanner credential still reads it. */
export async function hideImage(bucket: R2Bucket, name: string, digest: string | null) {
  await bucket.put(digest ? keys.hiddenImage(name, digest) : keys.hiddenRepo(name), String(Date.now()));
}

export async function unhideImage(bucket: R2Bucket, name: string, digest: string | null) {
  await bucket.delete(digest ? keys.hiddenImage(name, digest) : keys.hiddenRepo(name));
}

/** Serves a publisher's image to the public once a published version uses it: clears its pending marker and its platforms'. */
export async function releaseImage(bucket: R2Bucket, name: string, digest: string) {
  const doc = await readManifest(bucket, name, digest);
  await bucket.delete([digest, ...references(doc ?? {}).manifests].map((d) => keys.pending(name, d)));
}

/** The platforms ("linux/amd64", ...) of an index on the mirror, or null for a single-platform manifest or none. */
export async function imagePlatforms(bucket: R2Bucket, name: string, digest: string): Promise<string[] | null> {
  const obj = await bucket.get(keys.manifest(name, digest));
  if (!obj) return null;
  const doc = (await obj.json().catch(() => ({}))) as { manifests?: { platform?: { os?: string; architecture?: string } }[] };
  return doc.manifests ? doc.manifests.map((m) => `${m.platform?.os}/${m.platform?.architecture}`) : null;
}

async function readManifest(bucket: R2Bucket, name: string, digest: string): Promise<ManifestDoc | null> {
  const obj = await bucket.get(keys.manifest(name, digest));
  if (!obj) return null;
  try {
    return (await obj.json()) as ManifestDoc;
  } catch {
    return {};
  }
}

/**
 * Deletes an image: its manifest (and an index's platform manifests), the tags pointing at it, its signatures
 * and attestations (sha256-<hex> tags), then every blob in the repository no remaining manifest uses. With
 * `minAgeMs`, blobs uploaded more recently than that are kept, so a push in progress in the same repository survives.
 */
export async function deleteImage(bucket: R2Bucket, name: string, digest: string, opts: { minAgeMs?: number; now?: number } = {}): Promise<{ manifests: number; blobs: number }> {
  if (!(await bucket.head(keys.manifest(name, digest)))) return { manifests: 0, blobs: 0 };
  const tagPrefix = keys.tag(name, "");
  const tags = await listAll(bucket, tagPrefix);
  const tagTargets = new Map<string, string>();
  for (const t of tags) {
    const obj = await bucket.get(t.key);
    if (obj) tagTargets.set(t.key.slice(tagPrefix.length), (await obj.text()).trim());
  }
  const hex = digest.slice("sha256:".length);
  const doomed = new Set<string>([digest]);
  const doomedTags: string[] = [];
  for (const [tag, target] of tagTargets) {
    if (target === digest || tag.startsWith(`sha256-${hex}`)) {
      doomedTags.push(tag);
      doomed.add(target);
    }
  }
  // Platform manifests of the deleted indexes go too, unless another manifest still lists them.
  const manifestPrefix = keys.manifest(name, "");
  const all = (await listAll(bucket, manifestPrefix)).map((o) => o.key.slice(manifestPrefix.length));
  const docs = new Map<string, ManifestDoc>();
  for (const d of all) docs.set(d, (await readManifest(bucket, name, d)) ?? {});
  for (const d of [...doomed]) for (const child of references(docs.get(d) ?? {}).manifests) doomed.add(child);
  for (const [d, doc] of docs) {
    if (doomed.has(d)) continue;
    for (const child of references(doc).manifests) doomed.delete(child);
  }
  const toDelete = [...doomed].filter((d) => docs.has(d));
  await bucket.delete([
    ...toDelete.map((d) => keys.manifest(name, d)), ...toDelete.map((d) => keys.pending(name, d)), ...doomedTags.map((t) => keys.tag(name, t)), keys.hiddenImage(name, digest),
  ]);
  const used = new Set<string>();
  for (const [d, doc] of docs) if (!doomed.has(d)) for (const b of references(doc).blobs) used.add(b);
  return { manifests: toDelete.length, blobs: await deleteUnusedBlobs(bucket, name, used, (opts.now ?? Date.now()) - (opts.minAgeMs ?? 0)) };
}

/** Deletes the blobs of a repository no manifest in `used` names, uploaded before `before`, with their chunks. */
async function deleteUnusedBlobs(bucket: R2Bucket, name: string, used: Set<string>, before: number): Promise<number> {
  const blobPrefix = keys.blob(name, "");
  const unused = (await listAll(bucket, blobPrefix)).filter((o) => !used.has(o.key.slice(blobPrefix.length)) && o.uploaded.getTime() <= before);
  const doomedKeys: string[] = [];
  for (const o of unused) {
    const ptr = await readPointer(bucket, name, o.key.slice(blobPrefix.length));
    doomedKeys.push(o.key, ...(ptr?.parts ?? []));
  }
  for (let i = 0; i < doomedKeys.length; i += 1000) await bucket.delete(doomedKeys.slice(i, i + 1000));
  return unused.length;
}

/**
 * Clears what nothing needs from a repository publishers pushed to, by reachability from `keep` (the digests published
 * versions and backups use): their index children and the tags that hang off them (signatures, attestations) stay.
 * Anything else goes once it is older than `manifestAgeMs`, and blobs no remaining manifest uses once older than
 * `blobAgeMs`. One repository per call: listing a repository is the expensive part.
 */
export async function sweepRepo(bucket: R2Bucket, name: string, keep: Set<string>, opts: { now?: number; manifestAgeMs?: number; blobAgeMs?: number } = {}) {
  const now = opts.now ?? Date.now();
  const tagPrefix = keys.tag(name, "");
  const tagTargets = new Map<string, string>();
  for (const t of await listAll(bucket, tagPrefix)) {
    const obj = await bucket.get(t.key);
    if (obj) tagTargets.set(t.key.slice(tagPrefix.length), (await obj.text()).trim());
  }
  const manifestPrefix = keys.manifest(name, "");
  const stored = new Map((await listAll(bucket, manifestPrefix)).map((o) => [o.key.slice(manifestPrefix.length), o.uploaded.getTime()]));
  const docs = new Map<string, ManifestDoc>();
  for (const d of stored.keys()) docs.set(d, (await readManifest(bucket, name, d)) ?? {});

  const reachable = new Set([...keep].filter((d) => stored.has(d)));
  for (let grew = true; grew;) {
    grew = false;
    const add = (d: string) => {
      if (stored.has(d) && !reachable.has(d)) {
        reachable.add(d);
        grew = true;
      }
    };
    for (const d of [...reachable]) for (const child of references(docs.get(d) ?? {}).manifests) add(child);
    for (const [tag, target] of tagTargets) {
      const m = ATTACHED_TAG.exec(tag);
      if (m && reachable.has(`sha256:${m[1]}`)) add(target);
    }
  }
  const doomed = [...stored].filter(([d, at]) => !reachable.has(d) && at <= now - (opts.manifestAgeMs ?? 7 * DAY)).map(([d]) => d);
  const gone = new Set(doomed);
  const doomedTags = [...tagTargets].filter(([, target]) => gone.has(target)).map(([tag]) => tag);
  const del = [...doomed.map((d) => keys.manifest(name, d)), ...doomed.map((d) => keys.pending(name, d)), ...doomedTags.map((t) => keys.tag(name, t))];
  for (let i = 0; i < del.length; i += 1000) await bucket.delete(del.slice(i, i + 1000));
  const used = new Set<string>();
  for (const [d, doc] of docs) if (!gone.has(d)) for (const b of references(doc).blobs) used.add(b);
  return { manifests: doomed.length, blobs: await deleteUnusedBlobs(bucket, name, used, now - (opts.blobAgeMs ?? DAY)) };
}

/** Deletes blob uploads nobody finished within `maxAgeMs` (a day by default), with their chunks; at most `limit` a run. */
export async function purgeUploads(bucket: R2Bucket, opts: { now?: number; maxAgeMs?: number; limit?: number } = {}) {
  const before = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? DAY);
  const stale = (await bucket.list({ prefix: "uploads/", limit: opts.limit ?? 500 })).objects.filter((o) => o.uploaded.getTime() <= before);
  for (const o of stale) {
    const state = (await (await bucket.get(o.key))?.json().catch(() => null)) as UploadState | null;
    await bucket.delete([o.key, ...(state?.parts ?? []).map((p) => p.key)]);
  }
  return stale.length;
}
