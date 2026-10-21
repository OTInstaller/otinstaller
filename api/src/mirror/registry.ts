// The image mirror (mirror.otinstaller.com): a small OCI registry (distribution spec v1.1) with everything in R2.
// Anyone can pull public repositories; pushing, deleting and pulling `private/...` need the scanner credential
// (MIRROR_PUSH_TOKEN). Clients authenticate the usual way: a 401 with a Bearer challenge, then /token, with the
// credential as HTTP Basic (any user name) for a push token or without it for a pull token.
//
// R2 layout (each repository keeps its own blobs, so deleting a repository never touches another):
//   repos/<name>/blobs/<digest>       a layer or config: JSON listing the chunks it was uploaded in, and its size
//   repos/<name>/data/<id>/<n>        those chunks, as uploaded (a blob is never copied once it is in R2)
//   repos/<name>/manifests/<digest>   manifests and indexes (content type in the object's metadata)
//   repos/<name>/tags/<tag>           the digest the tag points to
//   uploads/<id>.json                 a blob upload in progress
//   hidden/<name>, hidden/<name>@<digest> taken-down images: not served to the public while they wait for deletion
//
// The referrers API is not implemented, so cosign and other clients use the tag schema (sha256-<hex>.sig,
// sha256-<hex>) and signatures copied with `cosign copy` keep verifying.

export interface MirrorEnv {
  MIRROR: R2Bucket;
  MIRROR_PUSH_TOKEN?: string;
}

const NAME = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST = 4 * 1024 * 1024;
const TOKEN_TTL = 300;
const enc = new TextEncoder();

export const keys = {
  blob: (n: string, d: string) => `repos/${n}/blobs/${d}`,
  manifest: (n: string, d: string) => `repos/${n}/manifests/${d}`,
  tag: (n: string, t: string) => `repos/${n}/tags/${t}`,
  upload: (id: string) => `uploads/${id}.json`,
  hiddenRepo: (n: string) => `hidden/${n}`,
  hiddenImage: (n: string, d: string) => `hidden/${n}@${d}`,
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

async function basicIsScanner(env: MirrorEnv, header: string): Promise<boolean | null> {
  if (!header.startsWith("Basic ")) return null;
  const secret = env.MIRROR_PUSH_TOKEN;
  let pass = "";
  try {
    pass = atob(header.slice(6).trim()).split(":").slice(1).join(":");
  } catch {
    return false;
  }
  return !!secret && !!pass && (await sameSecret(pass, secret));
}

async function issueToken(env: MirrorEnv, admin: boolean, now = Date.now()): Promise<string> {
  const body = b64url(JSON.stringify({ adm: admin, exp: Math.floor(now / 1000) + TOKEN_TTL }));
  // Pull tokens are not secret; they are signed with a fixed key when no credential is configured.
  return `${body}.${await hmac(env.MIRROR_PUSH_TOKEN || "anonymous-pull", body)}`;
}

async function verifyToken(env: MirrorEnv, token: string): Promise<{ adm: boolean } | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig || sig !== (await hmac(env.MIRROR_PUSH_TOKEN || "anonymous-pull", body))) return null;
  try {
    const p = JSON.parse(fromB64url(body)) as { adm: boolean; exp: number };
    return p.exp * 1000 > Date.now() ? { adm: p.adm === true && !!env.MIRROR_PUSH_TOKEN } : null;
  } catch {
    return null;
  }
}

/** Whether the request carries the scanner credential (directly or as a push token), and whether it carries anything valid. */
async function caller(req: Request, env: MirrorEnv): Promise<{ admin: boolean; authed: boolean }> {
  const h = req.headers.get("authorization") ?? "";
  const basic = await basicIsScanner(env, h);
  if (basic !== null) return { admin: basic, authed: basic };
  if (h.startsWith("Bearer ")) {
    const t = await verifyToken(env, h.slice(7).trim());
    return { admin: !!t?.adm, authed: !!t };
  }
  return { admin: false, authed: false };
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

export async function mirrorFetch(req: Request, env: MirrorEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const base = { "Docker-Distribution-API-Version": "registry/2.0" };

  if (path === "/" && req.method === "GET") {
    return new Response("OTInstaller image mirror. Pull with the digest from the registry, e.g. docker pull mirror.otinstaller.com/<namespace>/<name>@sha256:...\n");
  }
  if (path === "/token") {
    const basic = await basicIsScanner(env, req.headers.get("authorization") ?? "");
    if (basic === false) return ociError(401, "UNAUTHORIZED", "wrong credential");
    const token = await issueToken(env, basic === true);
    return Response.json({ token, access_token: token, expires_in: TOKEN_TTL, issued_at: new Date().toISOString() });
  }
  if (path === "/v2/" || path === "/v2") {
    const who = await caller(req, env);
    return who.authed ? new Response("{}", { headers: { ...base, "Content-Type": "application/json" } }) : challenge(req);
  }
  const r = route(path);
  if (!r) return ociError(404, "NAME_UNKNOWN", "no such repository or endpoint");

  const who = await caller(req, env);
  const write = !["GET", "HEAD"].includes(req.method);
  if (write || isPrivate(r.name)) {
    if (!who.admin) return challenge(req, `repository:${r.name}:${write ? "pull,push" : "pull"}`);
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
      if (req.method === "PUT") return putManifest(req, env, r.name, r.ref);
      if (req.method === "DELETE") {
        if (!DIGEST.test(r.ref)) return ociError(400, "UNSUPPORTED", "delete manifests by digest");
        const out = await deleteImage(env.MIRROR, r.name, r.ref);
        return out.manifests ? new Response(null, { status: 202, headers: base }) : ociError(404, "MANIFEST_UNKNOWN", "manifest unknown");
      }
      return getManifest(env, r.name, r.ref, req.method === "HEAD", who.admin);
    case "uploads":
      if (req.method !== "POST") return ociError(405, "UNSUPPORTED", "start uploads with POST");
      return startUpload(req, env, r.name, url);
    case "upload":
      return continueUpload(req, env, r.name, r.id, url);
  }
}

// ---------- reads ----------

async function resolve(env: MirrorEnv, name: string, ref: string): Promise<string | null> {
  if (DIGEST.test(ref)) return ref;
  const t = await env.MIRROR.get(keys.tag(name, ref));
  return t ? (await t.text()).trim() : null;
}

async function getManifest(env: MirrorEnv, name: string, ref: string, head: boolean, admin: boolean) {
  const digest = await resolve(env, name, ref);
  if (!digest || (!admin && (await hidden(env, name, digest)))) return ociError(404, "MANIFEST_UNKNOWN", "manifest unknown");
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

/** Stores a request body as an object. R2 needs a known length; bodies without Content-Length are buffered. */
async function putBody(bucket: R2Bucket, key: string, req: Request): Promise<number> {
  const len = req.headers.get("content-length");
  if (!req.body || len === "0") return 0;
  const obj = len ? await bucket.put(key, req.body) : await bucket.put(key, await req.arrayBuffer());
  return obj?.size ?? 0;
}

async function startUpload(req: Request, env: MirrorEnv, name: string, url: URL) {
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
    const key = chunkKey(name, id, 0);
    const size = await putBody(env.MIRROR, key, req);
    state.parts.push({ key, size });
    return finishUpload(env, name, id, state, digest);
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

async function continueUpload(req: Request, env: MirrorEnv, name: string, id: string, url: URL) {
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
    const key = chunkKey(name, id, state.parts.length);
    const size = await putBody(env.MIRROR, key, req);
    if (size > 0) {
      state.parts.push({ key, size });
      state.offset += size;
    }
    if (req.method === "PATCH") {
      await env.MIRROR.put(keys.upload(id), JSON.stringify(state));
      return accepted(name, id, state.offset);
    }
    const digest = url.searchParams.get("digest");
    if (!digest || !DIGEST.test(digest)) return ociError(400, "DIGEST_INVALID", "finish the upload with ?digest=sha256:...");
    return finishUpload(env, name, id, state, digest);
  }
  return ociError(405, "UNSUPPORTED", "unsupported method");
}

/**
 * Checks the uploaded chunks against the digest by reading them once, then records the blob as those chunks.
 * Nothing is copied, so a blob of any size finishes in one pass; a blob whose content does not match is deleted.
 */
async function finishUpload(env: MirrorEnv, name: string, id: string, state: UploadState, digest: string) {
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

async function putManifest(req: Request, env: MirrorEnv, name: string, ref: string) {
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
  await env.MIRROR.put(keys.manifest(name, digest), bytes, { httpMetadata: { contentType } });
  if (!DIGEST.test(ref)) await env.MIRROR.put(keys.tag(name, ref), digest);
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
 * and attestations (sha256-<hex> tags), then every blob in the repository no remaining manifest uses.
 */
export async function deleteImage(bucket: R2Bucket, name: string, digest: string): Promise<{ manifests: number; blobs: number }> {
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
  await bucket.delete([...toDelete.map((d) => keys.manifest(name, d)), ...doomedTags.map((t) => keys.tag(name, t)), keys.hiddenImage(name, digest)]);

  const used = new Set<string>();
  for (const [d, doc] of docs) if (!doomed.has(d)) for (const b of references(doc).blobs) used.add(b);
  const blobPrefix = keys.blob(name, "");
  const unused = (await listAll(bucket, blobPrefix)).map((o) => o.key).filter((k) => !used.has(k.slice(blobPrefix.length)));
  const doomedKeys: string[] = [];
  for (const k of unused) {
    const ptr = await readPointer(bucket, name, k.slice(blobPrefix.length));
    doomedKeys.push(k, ...(ptr?.parts ?? []));
  }
  for (let i = 0; i < doomedKeys.length; i += 1000) await bucket.delete(doomedKeys.slice(i, i + 1000));
  return { manifests: toDelete.length, blobs: unused.length };
}
