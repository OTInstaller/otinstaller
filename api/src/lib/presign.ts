// Short-lived signed URLs for backup uploads and downloads.
//
// With R2 API credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) the URLs are S3 presigned URLs
// that go straight to R2, so a 500 MB bundle never passes through a Worker. Without them, the URLs point at this
// API (/v1/internal/backups/objects/...), which checks an HMAC and streams to the bucket; Workers cap request
// bodies at 100 MB, so that is for local development and small objects.

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding, as SigV4 wants it (slashes kept in paths). */
function uriEncode(s: string, keepSlash: boolean): string {
  return [...enc.encode(s)].map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export interface PresignInput {
  method: "GET" | "PUT";
  host: string;
  path: string; // already including the bucket for path-style URLs, unencoded
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now?: Date;
}

/** AWS Signature Version 4 query-string presigning (what S3 and R2 accept). */
export async function presignSigV4(p: PresignInput): Promise<string> {
  const now = p.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${p.region}/s3/aws4_request`;
  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${p.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(p.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query.map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).sort().join("&");
  const path = uriEncode(p.path, true);
  const canonical = [p.method, path, canonicalQuery, `host:${p.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, toHex(await crypto.subtle.digest("SHA-256", enc.encode(canonical)))].join("\n");
  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${p.secretAccessKey}`), day);
  for (const part of [p.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = toHex(await hmac(key, toSign));
  return `https://${p.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------- URLs served by the API itself ----------

export async function objectSignature(secret: string, method: string, key: string, expires: number): Promise<string> {
  return toHex(await hmac(enc.encode(`backup-url|${secret}`), `${method}\n${key}\n${expires}`));
}

export async function apiObjectUrl(apiUrl: string, secret: string, method: "GET" | "PUT", key: string, expires: number): Promise<string> {
  const sig = await objectSignature(secret, method, key, expires);
  return `${apiUrl}/v1/internal/backups/objects/${key.split("/").map(encodeURIComponent).join("/")}?method=${method}&expires=${expires}&sig=${sig}`;
}
