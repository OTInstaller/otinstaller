// Checks that what a manifest points to really exists: an image digest in an OCI registry
// (with a linux/amd64 variant) or a PyPI wheel with the declared SHA-256.
import { HostError, type Fetch } from "./github";
import type { Problem } from "../lib/manifest";

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Splits "ghcr.io/owner/tool@sha256:abc" into its registry host, repository and digest. */
export function parseImage(ref: string) {
  const at = ref.indexOf("@");
  const name = ref.slice(0, at), digest = ref.slice(at + 1);
  const slash = name.indexOf("/");
  return { host: name.slice(0, slash), repo: name.slice(slash + 1), digest };
}

// Registries answer 401 with a Bearer challenge; anonymous tokens are enough for public images.
async function anonymousToken(f: Fetch, challenge: string | null): Promise<string | null> {
  if (!challenge?.startsWith("Bearer ")) return null;
  const params = Object.fromEntries([...challenge.slice(7).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!params.realm) return null;
  const u = new URL(params.realm);
  if (params.service) u.searchParams.set("service", params.service);
  if (params.scope) u.searchParams.set("scope", params.scope);
  const res = await f(u, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

async function registryGet(f: Fetch, url: string): Promise<Response> {
  let res = await f(url, { headers: { Accept: MANIFEST_TYPES } });
  if (res.status === 401) {
    const token = await anonymousToken(f, res.headers.get("www-authenticate"));
    if (token) res = await f(url, { headers: { Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}` } });
  }
  return res;
}

export async function checkImage(f: Fetch, image: string): Promise<Problem[]> {
  const { host, repo, digest } = parseImage(image);
  const res = await registryGet(f, `https://${host}/v2/${repo}/manifests/${digest}`);
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return [{ code: "artifact_image_not_found", path: "/runtime/image", message: `${image} was not found or is not public`, hint: "push the image and make the package public" }];
  }
  if (!res.ok) throw new HostError(`registry ${host} returned ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  const body = (await res.json()) as { manifests?: { platform?: { os?: string; architecture?: string } }[] };
  // A single-platform manifest has no platform list; its architecture is in the config blob, which we
  // accept as-is. A multi-platform index must include linux/amd64.
  if (body.manifests && !body.manifests.some((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64")) {
    return [{ code: "artifact_platform_missing", path: "/runtime/image", message: `${image} has no linux/amd64 variant` }];
  }
  return [];
}

export async function checkWheel(f: Fetch, pkg: string, version: string, sha256: string): Promise<Problem[]> {
  const res = await f(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`, { headers: { Accept: "application/json" } });
  if (res.status === 404) {
    return [{ code: "artifact_package_not_found", path: "/runtime/package_version", message: `${pkg} ${version} is not on PyPI` }];
  }
  if (!res.ok) throw new HostError(`PyPI returned ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  const body = (await res.json()) as { urls: { packagetype: string; digests: { sha256: string } }[] };
  if (!body.urls.some((u) => u.packagetype === "bdist_wheel" && u.digests.sha256 === sha256)) {
    return [{ code: "artifact_wheel_mismatch", path: "/runtime/wheel_sha256", message: `no wheel of ${pkg} ${version} has sha256 ${sha256}` }];
  }
  return [];
}
