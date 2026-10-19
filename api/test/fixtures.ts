import { webhook, fakeHosts } from "./helpers";

export const ghUser = (id: number, login: string) => ({
  "POST https://github.com/login/oauth/access_token": { access_token: `gho_${login}`, scope: "read:user" },
  "GET https://api.github.com/user/emails": [{ email: `${login}@example.com`, primary: true, verified: true }],
  "GET https://api.github.com/user": { id, login, name: login, email: null, avatar_url: null },
});

export const installation = (id: number, account: { id: number; login: string; type?: string }, repos: number[], sender = 9999) => ({
  action: "created",
  installation: { id, account: { type: "User", ...account }, repository_selection: "selected" },
  repositories: repos.map((r) => ({ id: r, full_name: `${account.login}/repo${r}` })),
  sender: { id: sender },
});

export const tagEvent = (installationId: number, repo: string, repoId: number, tag: string) => ({
  ref: tag,
  ref_type: "tag",
  repository: { id: repoId, full_name: repo },
  installation: { id: installationId },
  sender: { id: 1 },
});

export const README = "# Tool\n";
export const manifestFor = (ns: string, version = "1.0.0", over = "") => `schema: 1
name: whois-plus
namespace: ${ns}
version: ${version}
summary: WHOIS lookups with registrar and creation dates
readme: README.md
license: MIT
categories: [domain-dns]
inputs:
  - name: domain
    type: domain
    required: true
outputs:
  - type: organization
runtime:
  kind: docker
  image: ghcr.io/${ns}/whois-plus@sha256:${"e".repeat(64)}
  platforms: [linux/amd64]
  command: ["whois-plus", "{domain}"]
  output_format: json
ethics:
  touches_target: false
  auth_required: false
  collects_personal_data: true
${over}`;

/** Fakes GitHub (installation token, tag, files, statuses) and ghcr.io for one repository. */
export function fakeRelease(repo: string, files: Record<string, string | null>, opts: { imageStatus?: number } = {}) {
  return fakeHosts({
    "POST https://api.github.com/app/installations/": { token: "ghs_install" },
    [`GET https://api.github.com/repos/${repo}/commits/`]: { sha: "abc123" },
    [`GET https://api.github.com/repos/${repo}/contents/`]: (req) => {
      const path = decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!);
      const content = files[path];
      return content == null ? null : content;
    },
    [`POST https://api.github.com/repos/${repo}/statuses/abc123`]: { ok: true },
    "GET https://ghcr.io/v2/": (req) =>
      req.headers.get("authorization")
        ? new Response(JSON.stringify({ schemaVersion: 2 }), { status: opts.imageStatus ?? 200 })
        : new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"' } }),
    "GET https://ghcr.io/token": { token: "anon" },
    "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": new Response(null, { status: 204 }),
    "POST https://api.resend.com/emails": { id: "email" },
  });
}

export async function queuedJob(installationId: number, login: string, ownerId: number, repoId: number, tag = "v1.0.0") {
  await webhook("installation", installation(installationId, { id: ownerId, login }, [repoId]));
  const res = await webhook("create", tagEvent(installationId, `${login}/whois-plus`, repoId, tag));
  return ((await res.json()) as any).jobId as string;
}

export const statuses = (calls: { url: string; body: string }[]) =>
  calls.filter((c) => c.url.includes("/statuses/")).map((c) => JSON.parse(c.body) as { state: string; description: string });

