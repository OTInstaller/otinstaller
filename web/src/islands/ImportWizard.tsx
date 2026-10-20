// /import: pick a GitHub or GitLab repository, review what was detected, complete the manifest, then open a
// pull/merge request or let the registry hold the manifest.
import { useEffect, useState } from "preact/hooks";
import { api, API_URL } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe } from "./shared";

interface Repo {
  project_id: string;
  path: string;
  url: string;
  description: string | null;
  archived: boolean;
  app_installed?: boolean;
  published_as: string | null;
}
interface Import {
  id: string;
  provider: "github" | "gitlab";
  repo: string;
  url: string | null;
  status: string;
  error?: { code: string; message: string };
  detected_kind: string | null;
  signals: string[];
  assumed: string[];
  warnings: string[];
  install_url?: string;
  finish_modes: ("pr" | "registry" | "connect" | "wrapper")[];
  draft_yaml: string | null;
  problems: { code: string; path?: string; message: string; hint?: string }[];
  missing: string[];
  suggested: string[];
  finish_mode?: string;
  pr_url?: string;
  package?: { ref: string; published: boolean };
}

const FINISH_LABEL: Record<string, string> = {
  pr: "Open a pull request with the manifest",
  registry: "Keep the manifest on the registry",
  connect: "Connect (the repository already has otinstaller.yaml)",
  wrapper: "Open a pull request in the wrapper repository",
};

export default function ImportWizard({ back }: { back: string }) {
  const me = useMe();
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [current, setCurrent] = useState<Import | null>(null);
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setRepos(null);
    setError(null);
    const t = setTimeout(() => {
      api<{ repos: Repo[] }>(`/me/repos?provider=${provider}&q=${encodeURIComponent(q)}`).then((r) => setRepos(r.repos), (e) => (setRepos([]), setError(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [me, provider, q]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in with the GitHub or GitLab account that owns the repositories you want to publish." />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const show = (imp: Import) => {
    setCurrent(imp);
    setYaml(imp.draft_yaml ?? "");
  };
  const start = (repo: Repo) => run(async () => show(await api<Import>("/imports", { method: "POST", body: JSON.stringify({ repo: repo.url, provider }) })));
  const save = () => run(async () => show(await api<Import>(`/imports/${current!.id}`, { method: "PATCH", body: JSON.stringify({ yaml }) })));
  const finish = (mode: string) => run(async () => {
    const r = await api<Import & { queued_tag?: string }>(`/imports/${current!.id}/finish`, { method: "POST", body: JSON.stringify({ mode }) });
    show(r);
    setDone(r.pr_url ? `Opened ${r.pr_url}. Merge it, then run the release workflow to publish.` : r.queued_tag ? `Saved. Publishing ${r.queued_tag} now.` : "Done. The next vX.Y.Z tag publishes a version.");
  });

  if (current) {
    const blocked = current.problems.length > 0 || current.missing.length > 0;
    return (
      <div class="stack">
        <button class="btn" type="button" onClick={() => (setCurrent(null), setDone(null))}>← Back to repositories</button>
        <h2>{current.repo} <Status value={current.status} /></h2>
        {current.error && <p class="notice bad">{current.error.message}</p>}
        {done && <p class="notice" role="status">{done} {current.pr_url && <a href={current.pr_url}>View it</a>}</p>}
        {current.package && <p class="notice">Already in the registry as <a href={`/${current.package.ref}`}>{current.package.ref}</a>.</p>}
        <p>Detected: <strong>{current.detected_kind ?? "nothing publishable yet"}</strong>{current.signals.length > 0 && <span class="muted"> (from {current.signals.join(", ")})</span>}</p>
        {current.install_url && <p class="notice warn">Install the OTInstaller GitHub App on this repository first: <a href={current.install_url}>install it</a>, then come back.</p>}
        {current.warnings.length > 0 && <ul class="small">{current.warnings.map((w) => <li>{w}</li>)}</ul>}
        {current.assumed.length > 0 && <details><summary>What was guessed</summary><ul class="small">{current.assumed.map((a) => <li>{a}</li>)}</ul></details>}
        <ErrorNote error={error} />
        {current.draft_yaml !== null && current.status !== "finished" && (
          <>
            <label for="yaml"><strong>otinstaller.yaml</strong>{current.missing.length > 0 && <span class="muted"> · still needed: {current.missing.join(", ")}</span>}</label>
            <textarea id="yaml" rows={22} value={yaml} onInput={(e) => setYaml((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
            {current.problems.length > 0 && (
              <ul class="small" aria-label="Problems">
                {current.problems.map((p) => <li><code>{p.code}</code>{p.path && <> at <code>{p.path}</code></>}: {p.message}{p.hint && <span class="muted"> ({p.hint})</span>}</li>)}
              </ul>
            )}
            {current.suggested.length > 0 && <p class="small muted">Worth adding: {current.suggested.join(", ")}.</p>}
            <div class="row">
              <button class="btn" type="button" onClick={save} disabled={busy || yaml === current.draft_yaml}>Check and save</button>
              {current.finish_modes.map((m) => (
                <button class="btn btn-primary" type="button" onClick={() => finish(m)} disabled={busy || blocked || yaml !== current.draft_yaml}>{FINISH_LABEL[m]}</button>
              ))}
            </div>
            {current.finish_modes.includes("registry") && <p class="small muted">A manifest held by the registry gets a label and a small ranking penalty until you move it into the repository.</p>}
          </>
        )}
      </div>
    );
  }

  return (
    <div class="stack">
      <div class="row" role="group" aria-label="Provider">
        <button class={`btn${provider === "github" ? " btn-primary" : ""}`} type="button" aria-pressed={provider === "github"} onClick={() => setProvider("github")}>GitHub</button>
        <button class={`btn${provider === "gitlab" ? " btn-primary" : ""}`} type="button" aria-pressed={provider === "gitlab"} onClick={() => setProvider("gitlab")}>GitLab</button>
        <label class="sr-only" for="rq">Filter repositories</label>
        <input id="rq" type="search" placeholder="Filter repositories" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <p class="small muted">Public repositories you administer (GitHub) or maintain (GitLab). {provider === "gitlab" && <>Opening merge requests needs GitLab write access: <a href={`${API_URL}/v1/auth/gitlab/login?scope=api&redirect=${encodeURIComponent(back)}`}>grant it</a>.</>}</p>
      <ErrorNote error={error} />
      {repos === null ? <Loading what="repositories" /> : repos.length === 0 ? <p class="muted">No repositories found.</p> : (
        <ul class="list-plain repos">
          {repos.map((r) => (
            <li class="card row">
              <div class="grow">
                <strong>{r.path}</strong>{r.archived && <span class="badge">archived</span>}
                {r.description && <div class="small muted">{r.description}</div>}
              </div>
              {r.published_as
                ? <a class="btn" href={`/${r.published_as}`}>Published as {r.published_as}</a>
                : <button class="btn btn-primary" type="button" disabled={busy || r.archived} onClick={() => start(r)}>Import</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
