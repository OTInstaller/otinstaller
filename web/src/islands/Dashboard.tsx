// /dashboard: my packages first (state, health, sync, what needs me), then namespaces, publish history, backups
// and CLI tokens. Signed-in data only; the page is never cached.
import { useEffect, useState } from "preact/hooks";
import { api, type Namespace, type ToolSummary } from "../lib/api";
import { Confirm, ErrorNote, Loading, rememberStaff, SignIn, Status, useMe, when } from "./shared";
import Backups from "./Backups";

interface Job {
  id: string;
  // tag: a vX.Y.Z tag on GitHub or GitLab; ci: an upload from a trusted workflow; direct: an upload with `ot publish`.
  method: "tag" | "ci" | "direct";
  repo: string;
  tag: string;
  ref: string | null;
  status: string;
  error_code: string | null;
  problems: { code: string; path?: string; message: string; hint?: string }[];
  created_at: number;
}
interface Token {
  id: string;
  name: string;
  scopes: string;
  last_used_at: number | null;
  created_at: number;
}
interface BackupPkg {
  ref: string;
  role: string;
  status: string;
  source: { provider: string; url: string; sync_status: string } | null;
  git_backups: boolean;
  mirrored: boolean;
}

export default function Dashboard({ back }: { back: string }) {
  const me = useMe();
  const [pkgs, setPkgs] = useState<ToolSummary[] | null>(null);
  const [sources, setSources] = useState<Map<string, BackupPkg>>(new Map());
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [nsName, setNsName] = useState("");
  const [nsError, setNsError] = useState<unknown>(null);
  const loadTokens = () => api<{ tokens: Token[] }>("/me/tokens").then((r) => setTokens(r.tokens), setError);
  useEffect(() => {
    if (!me) return;
    api<{ jobs: Job[] }>("/me/publish-jobs").then((r) => setJobs(r.jobs), setError);
    loadTokens();
    Promise.all(me.namespaces.map((n) => api<Namespace>(`/namespaces/${n.name}`).catch(() => null)))
      .then((ns) => setPkgs(ns.flatMap((n) => n?.tools ?? [])))
      .catch(setError);
    api<{ packages: BackupPkg[] }>("/me/backups").then((r) => setSources(new Map(r.packages.map((p) => [p.ref, p]))), () => {});
  }, [me]);
  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to see your packages, publish history and CLI tokens." />;

  async function createToken(e: Event) {
    e.preventDefault();
    try {
      const r = await api<{ token: string }>("/me/tokens", { method: "POST", body: JSON.stringify({ name: tokenName || "CLI" }) });
      setNewToken(r.token);
      setTokenName("");
      loadTokens();
    } catch (err) {
      setError(err);
    }
  }
  async function createNamespace(e: Event) {
    e.preventDefault();
    setNsError(null);
    try {
      await api("/namespaces", { method: "POST", body: JSON.stringify({ name: nsName.trim().toLowerCase() }) });
      // The new namespace comes back with /me.
      window.location.reload();
    } catch (err) {
      setNsError(err);
    }
  }
  async function revoke(id: string) {
    setRevoking(null);
    await api(`/me/tokens/${id}`, { method: "DELETE" }).catch(setError);
    loadTokens();
  }
  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    rememberStaff(false, null);
    window.location.href = "/";
  }
  const pending = me.namespaces.filter((n) => n.status === "pending_review");
  const failed = (jobs ?? []).filter((j) => j.status === "error" || j.status === "rejected" || j.status === "failed");
  const needs = (t: ToolSummary): string | null => {
    const s = sources.get(`${t.namespace}/${t.name}`);
    if (t.health === "broken") return "health check failing";
    if (s?.source && s.source.sync_status !== "ok") return `sync ${s.source.sync_status.replace(/_/g, " ")}`;
    if (t.source_unavailable) return "source unavailable";
    if (t.manifest_held_by_registry) return "manifest held by registry";
    return null;
  };

  return (
    <div class="stack dash">
      <div class="row acct-row">
        <p>Signed in as <strong>{me.login}</strong>{me.accounts.length > 0 && <span class="muted"> ({me.accounts.map((a) => `${a.provider}: ${a.login}`).join(", ")})</span>}.</p>
        {(me.admin || me.reviewer) && <a class="btn btn-primary btn-sm" href="/admin">Admin console</a>}
        <a class="btn btn-sm" href="/settings/accounts">Accounts and sync</a>
        <button class="btn btn-sm" type="button" onClick={signOut}>Sign out</button>
      </div>
      <ErrorNote error={error} />

      {pending.length > 0 && (
        <div class="notice warn">
          <p><b>Waiting for review.</b> {pending.map((n) => n.name).join(", ")} {pending.length === 1 ? "is" : "are"} new to the registry, so a reviewer checks the first release before it goes public, usually within 3 business days. Later releases publish as soon as their checks pass.</p>
          <p class="small">The reviewer checks that the tool fits the <a href="/policy/acceptable-use">acceptable-use rules</a>, that the README says what data it touches, that the licence allows redistribution, and that the namespace impersonates nobody.</p>
        </div>
      )}
      {failed.length > 0 && <p class="notice bad"><b>{failed.length} {failed.length === 1 ? "release" : "releases"} failed.</b> See <a href="#jobs">publish history</a> for the error and its fix.</p>}

      <section aria-labelledby="pk">
        <div class="section-head"><h2 id="pk">Packages</h2><a class="btn btn-strong btn-sm" href="/import">Import a repository</a></div>
        {pkgs === null ? <Loading what="packages" /> : pkgs.length === 0 ? (
          <p class="muted">None yet. <a href="/import">Import a repository</a>, push a <code>vX.Y.Z</code> tag on a repository that has <code>otinstaller.yaml</code> and the GitHub App, or <a href="/docs/publishing#publish-directly">publish directly</a> with <code>ot publish</code>.</p>
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">Package</th><th scope="col">State</th><th scope="col">Health</th><th scope="col">Sync</th><th scope="col">Needs you</th><th scope="col"><span class="sr-only">Manage</span></th></tr></thead>
              <tbody>
                {pkgs.map((t) => {
                  const ref = `${t.namespace}/${t.name}`;
                  const s = sources.get(ref);
                  const need = needs(t);
                  return (
                    <tr>
                      <td><a href={`/${ref}`}><strong>{ref}</strong></a><div class="small muted">{t.kind === "guide" ? "guide" : "tool"} · v{t.latest_version}</div></td>
                      <td><Status value={t.status} /></td>
                      <td>{t.kind === "guide" ? <span class="muted">—</span> : t.health === "healthy" ? <span class="status ok">passing</span> : t.health === "broken" ? <span class="status warn">possibly broken</span> : <span class="status none">not checked</span>}</td>
                      <td>{s?.source ? <Status value={s.source.sync_status} /> : <span class="muted">—</span>}</td>
                      <td>{need ? <span class="status warn">{need}</span> : <span class="muted">nothing</span>}</td>
                      <td><a class="btn btn-sm" href={`/dashboard/${ref}`}>Manage</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="ns">
        <h2 id="ns">Namespaces and profiles</h2>
        {me.namespaces.length === 0 ? <p class="muted">None yet. Importing a repository creates one, or create one below to publish directly.</p> : (
          <ul class="list-plain">
            {me.namespaces.map((n) => (
              <li class="row">
                <a href={`/${n.name}`}>{n.name}</a> <Status value={n.status} /> <span class="small muted">{n.role}{n.verified ? " · verified" : ""}</span>
                {n.role === "owner" && <a class="btn btn-sm" href={`/dashboard/profile/${n.name}`}>Edit profile</a>}
              </li>
            ))}
          </ul>
        )}
        <p class="small muted">Each namespace has a public profile, synced from GitHub or GitLab when it has an account there. Owners can change any detail, pin packages and write an About section.</p>
        <form class="row" onSubmit={createNamespace}>
          <label for="nsname">New namespace</label>
          <input id="nsname" type="text" value={nsName} onInput={(e) => setNsName((e.target as HTMLInputElement).value)} placeholder="acme-osint" minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" required />
          <button class="btn" type="submit">Create</button>
        </form>
        <p class="small muted">For publishing without GitHub or GitLab: create it here or with <code>ot namespace create</code>, then release into it with <code>ot publish</code>. A GitHub or GitLab user's name needs that account linked; at most three per account.</p>
        <ErrorNote error={nsError} />
      </section>

      <section aria-labelledby="jobs">
        <h2 id="jobs">Publish history</h2>
        {jobs === null ? <Loading what="publish jobs" /> : jobs.length === 0 ? <p class="muted">No releases yet. Push a <code>vX.Y.Z</code> tag, or run <code>ot publish</code>.</p> : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">From</th><th scope="col">Tag</th><th scope="col">Status</th><th scope="col">When</th><th scope="col">Problem</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr id={j.id}>
                    <td>{j.method === "direct" ? <>{j.ref ?? j.repo} <span class="small muted">· uploaded</span></> : j.repo}</td>
                    <td><a href={`/dashboard/publish/${j.id}`}><code>{j.tag}</code></a></td>
                    <td><Status value={j.status} /></td>
                    <td>{when(j.created_at)}</td>
                    <td>{j.problems.length > 0
                      ? <ul class="list-plain small">{j.problems.slice(0, 2).map((p) => <li><a href={`/docs/errors#${p.code}`}><code>{p.code}</code></a>: {p.message}</li>)}{j.problems.length > 2 && <li><a href={`/dashboard/publish/${j.id}`}>{j.problems.length - 2} more</a></li>}</ul>
                      : j.error_code ? <a href={`/docs/errors#${j.error_code}`}><code>{j.error_code}</code></a> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Backups />

      <section aria-labelledby="tokens">
        <h2 id="tokens">CLI tokens</h2>
        <p class="small muted"><code>ot login</code> creates one for you. Create one here for CI or another machine.</p>
        {newToken && (
          <div class="notice warn" role="status">
            <p>Copy this token now; it is not shown again.</p>
            <div class="cmd"><code>{newToken}</code><button class="btn copy" type="button" data-copy={newToken}><span class="label">Copy</span></button></div>
          </div>
        )}
        <form class="row" onSubmit={createToken}>
          <label for="tname">Name</label>
          <input id="tname" type="text" value={tokenName} onInput={(e) => setTokenName((e.target as HTMLInputElement).value)} placeholder="CI on my server" maxLength={60} />
          <button class="btn btn-primary" type="submit">Create token</button>
        </form>
        {tokens === null ? <Loading what="tokens" /> : tokens.length > 0 && (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {tokens.map((t) => (
                  <tr>
                    <td>{t.name}</td><td>{when(t.created_at)}</td><td>{when(t.last_used_at)}</td>
                    <td>{revoking === t.id
                      ? <Confirm text="Anything using it stops working." confirm="Revoke" onConfirm={() => revoke(t.id)} onCancel={() => setRevoking(null)} />
                      : <button class="btn btn-sm" type="button" onClick={() => setRevoking(t.id)}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
