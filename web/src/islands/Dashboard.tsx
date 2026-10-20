// /dashboard: my namespaces, publish history with errors, backups, and CLI tokens.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, rememberStaff, SignIn, Status, useMe, when } from "./shared";
import Backups from "./Backups";

interface Job {
  id: string;
  repo: string;
  tag: string;
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

export default function Dashboard({ back }: { back: string }) {
  const me = useMe();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");

  const loadTokens = () => api<{ tokens: Token[] }>("/me/tokens").then((r) => setTokens(r.tokens), setError);
  useEffect(() => {
    if (!me) return;
    api<{ jobs: Job[] }>("/me/publish-jobs").then((r) => setJobs(r.jobs), setError);
    loadTokens();
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
  async function revoke(id: string) {
    if (!window.confirm("Revoke this token? Anything using it stops working.")) return;
    await api(`/me/tokens/${id}`, { method: "DELETE" }).catch(setError);
    loadTokens();
  }
  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    rememberStaff(false);
    window.location.href = "/";
  }

  return (
    <div class="stack">
      <div class="row">
        <p>Signed in as <strong>{me.login}</strong>{me.accounts.length > 0 && <> ({me.accounts.map((a) => `${a.provider}: ${a.login}`).join(", ")})</>}.</p>
        {(me.admin || me.reviewer) && <a class="btn btn-primary" href="/admin">Admin console</a>}
        <a class="btn" href="/settings/accounts">Accounts</a>
        <button class="btn" type="button" onClick={signOut}>Sign out</button>
      </div>
      <ErrorNote error={error} />

      <section aria-labelledby="ns">
        <h2 id="ns">Namespaces</h2>
        {me.namespaces.length === 0
          ? <p class="muted">None yet. <a href="/import">Import a repository</a> to create one.</p>
          : (
            <ul class="list-plain">
              {me.namespaces.map((n) => (
                <li class="row"><a href={`/${n.name}`}>{n.name}</a> <Status value={n.status} /> <span class="small muted">{n.role}</span>
                  {n.status === "pending_review" && <span class="small muted">A reviewer checks your first release before it goes public (usually within 3 business days).</span>}</li>
              ))}
            </ul>
          )}
      </section>

      <section aria-labelledby="jobs">
        <h2 id="jobs">Publish history</h2>
        {jobs === null ? <Loading what="publish jobs" /> : jobs.length === 0 ? <p class="muted">No releases yet. Push a <code>vX.Y.Z</code> tag to publish.</p> : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">Repository</th><th scope="col">Tag</th><th scope="col">Status</th><th scope="col">When</th><th scope="col">Problem</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr id={j.id}>
                    <td>{j.repo}</td>
                    <td><code>{j.tag}</code></td>
                    <td><Status value={j.status} /></td>
                    <td>{when(j.created_at)}</td>
                    <td>{j.problems.length > 0
                      ? <ul class="list-plain small">{j.problems.map((p) => <li><a href={`/docs/errors#${p.code}`}><code>{p.code}</code></a>: {p.message}{p.hint && <span class="muted"> ({p.hint})</span>}</li>)}</ul>
                      : j.error_code ? <code>{j.error_code}</code> : ""}</td>
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
            <div class="cmd"><code>{newToken}</code><button class="btn" type="button" data-copy={newToken} onClick={() => navigator.clipboard.writeText(newToken)}>Copy</button></div>
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
                  <tr><td>{t.name}</td><td>{when(t.created_at)}</td><td>{when(t.last_used_at)}</td><td><button class="btn" type="button" onClick={() => revoke(t.id)}>Revoke</button></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
