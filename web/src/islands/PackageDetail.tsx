// /dashboard/{ns}/{name}: one package for its owners. Sync state and log with "Sync now", versions with yank and
// un-yank, deprecation with a replacement, and the backups section for this package.
import { useEffect, useState } from "preact/hooks";
import { api, type ToolDetail, type Version } from "../lib/api";
import { formatDate } from "../lib/format";
import { Confirm, ErrorNote, Loading, SignIn, Status, useMe, when } from "./shared";
import Backups from "./Backups";

interface SyncLog {
  source: { provider: string; url: string; sync_status: string; last_error: string | null; last_event_at: number | null; last_poll_at: number | null; manifest_mode: string };
  events: { kind: string; summary: string; status: string; error: string | null; received_at: number }[];
}

export default function PackageDetail({ refName, back }: { refName: string; back: string }) {
  const me = useMe();
  const [tool, setTool] = useState<ToolDetail | null>(null);
  const [owner, setOwner] = useState<boolean | null>(null);
  const [log, setLog] = useState<SyncLog | null | undefined>(undefined);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const [depMsg, setDepMsg] = useState("");
  const [depRepl, setDepRepl] = useState("");
  const [showLog, setShowLog] = useState(false);

  const load = () => {
    api<ToolDetail>(`/tools/${refName}`).then(setTool, setError);
    api<{ versions: Version[] }>(`/tools/${refName}/versions`).then((r) => setVersions(r.versions), setError);
    api<SyncLog>(`/packages/${refName}/sync-log`).then(setLog, () => setLog(null));
  };
  useEffect(() => {
    if (!me) return;
    api<{ owner: boolean }>(`/tools/${refName}/permissions`).then((p) => setOwner(p.owner), () => setOwner(false));
    load();
  }, [me]);
  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to manage this package." />;
  if (owner === false) return <p class="notice">You are not an owner of {refName}. <a href={`/${refName}`}>See its public page</a>.</p>;
  if (!tool || owner === null) return <Loading what="the package" />;

  const act = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    setAsk(null);
    try {
      await fn();
      setNote(done);
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const syncNow = () => act(async () => {
    const r = await api<{ queued: string[] }>(`/packages/${refName}/sync`, { method: "POST" });
    setNote(r.queued.length ? `Publishing ${r.queued.join(", ")}.` : "No new release tags.");
  }, "Synced.");
  const yank = (v: string, undo: boolean) => act(() => api(`/tools/${refName}/${encodeURIComponent(v)}/${undo ? "unyank" : "yank"}`, { method: "POST", body: "{}" }).then(() => {}), undo ? `${v} is back on @latest.` : `${v} is yanked.`);
  const deprecate = () => act(() => api(`/tools/${refName}/deprecate`, { method: "POST", body: JSON.stringify({ message: depMsg, replacement: depRepl || undefined }) }).then(() => {}), "Deprecated.");
  const undeprecate = () => act(() => api(`/tools/${refName}/deprecate`, { method: "DELETE" }).then(() => {}), "No longer deprecated.");
  const movePr = () => act(async () => {
    const r = await api<{ pr_url?: string }>(`/packages/${refName}/manifest/pr`, { method: "POST", body: "{}" });
    setNote(r.pr_url ? `Pull request opened: ${r.pr_url}` : "Pull request opened.");
  }, "Pull request opened.");

  return (
    <div class="stack pkg">
      <ErrorNote error={error} />
      {note && <p class="notice ok" role="status">{note}</p>}

      <section aria-labelledby="st">
        <h2 id="st">State</h2>
        <dl class="kv">
          <dt>Status</dt><dd><Status value={tool.status} />{tool.deprecated_message && <span class="small muted"> · {tool.deprecated_message}{tool.deprecated_replacement && <> → <a href={`/${tool.deprecated_replacement}`}>{tool.deprecated_replacement}</a></>}</span>}</dd>
          <dt>Latest</dt><dd>v{tool.latest_version}</dd>
          <dt>Health</dt><dd>{tool.kind === "guide" ? "—" : tool.health === "healthy" ? <span class="status ok">nightly check passing</span> : tool.health === "broken" ? <span class="status warn">possibly broken: three nightly checks failed</span> : <span class="status none">not checked{tool.manifest.test ? "" : " (no test input in the manifest)"}</span>}</dd>
          <dt>Source</dt><dd>{log === undefined ? "…" : log === null ? <span class="muted">{tool.repo_url ? "no source record" : "none: published directly with ot publish"}</span> : <><a href={log.source.url}>{log.source.url.replace(/^https?:\/\//, "")}</a> · <Status value={log.source.sync_status} />{log.source.last_error && <div class="small muted">{log.source.last_error}</div>}</>}</dd>
          {log && <><dt>Last event</dt><dd>{when(log.source.last_event_at)} · polled {when(log.source.last_poll_at)}</dd></>}
          {tool.manifest_held_by_registry && <><dt>Manifest</dt><dd>held by the registry (releases are unsigned until it moves into the repository)</dd></>}
        </dl>
        <p class="row">
          {log && <button class="btn" type="button" disabled={busy} onClick={syncNow}>Sync now</button>}
          {tool.manifest_held_by_registry && <button class="btn" type="button" disabled={busy} onClick={movePr}>Move the manifest into the repository (pull request)</button>}
          {log && log.events.length > 0 && <button class="btn btn-ghost btn-sm" type="button" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>{showLog ? "Hide" : "Show"} sync log ({log.events.length})</button>}
        </p>
        {showLog && log && (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead>
              <tbody>{log.events.map((e) => <tr><td>{when(e.received_at)}</td><td>{e.kind}</td><td><Status value={e.status} /></td><td class="small">{e.summary}{e.error && <div class="muted">{e.error}</div>}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="vs">
        <h2 id="vs">Versions</h2>
        <p class="small muted">Yanking hides a version from search and <code>@latest</code>; it stays installable by exact version.</p>
        {versions === null ? <Loading what="versions" /> : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">Scan</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {versions.map((v) => (
                  <tr>
                    <td><code>{v.version}</code>{v.version === tool.latest_version && <span class="badge info">latest</span>}</td>
                    <td>{formatDate(v.published_at)}</td>
                    <td><a href={`/${refName}/security?v=${encodeURIComponent(v.version)}`}>{v.scan_status}</a></td>
                    <td><Status value={v.status} /></td>
                    <td>{v.status === "published" ? (ask === `yank:${v.version}` ? <Confirm text="Hidden from search and @latest." confirm="Yank" onConfirm={() => yank(v.version, false)} onCancel={() => setAsk(null)} /> : <button class="btn btn-sm" type="button" disabled={busy} onClick={() => setAsk(`yank:${v.version}`)}>Yank</button>)
                      : v.status === "yanked" ? <button class="btn btn-sm" type="button" disabled={busy} onClick={() => yank(v.version, true)}>Un-yank</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="dp">
        <h2 id="dp">Deprecation</h2>
        {tool.status === "deprecated" ? (
          <p class="row"><span class="small muted">Deprecated: {tool.deprecated_message}</span><button class="btn btn-sm" type="button" disabled={busy} onClick={undeprecate}>Remove the deprecation</button></p>
        ) : (
          <form class="stack" onSubmit={(e) => { e.preventDefault(); setAsk("deprecate"); }}>
            <p class="small muted">A deprecated package stays installable; its page and <code>ot install</code> show your message and the replacement.</p>
            <div class="row">
              <input type="text" required maxLength={500} placeholder="Why, and what to use instead" class="grow" value={depMsg} onInput={(e) => setDepMsg((e.target as HTMLInputElement).value)} aria-label="Deprecation message" />
              <input type="text" placeholder="replacement ns/name (optional)" value={depRepl} onInput={(e) => setDepRepl((e.target as HTMLInputElement).value)} aria-label="Replacement package" pattern="[a-z0-9-]+/[a-z0-9-]+" />
              {ask === "deprecate" ? <Confirm text="Shown to everyone from now on." confirm="Deprecate" onConfirm={deprecate} onCancel={() => setAsk(null)} /> : <button class="btn btn-sm" type="submit" disabled={busy || !depMsg}>Deprecate</button>}
            </div>
          </form>
        )}
      </section>

      <Backups only={refName} />
    </div>
  );
}
