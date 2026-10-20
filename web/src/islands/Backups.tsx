// The dashboard's Backups section: each package's latest git backup, Restore from backup (a download link and
// the steps to push it to a new repository), Switch source, and the git backup opt-out.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, Status, when } from "./shared";

interface Pkg {
  ref: string;
  role: string;
  status: string;
  source: { provider: string; url: string; sync_status: string } | null;
  git_backups: boolean;
  latest_bundle: { created_at: number; size_bytes: number | null; refs: number | null; weekly: boolean } | null;
  mirrored: boolean;
}
interface Restore {
  url: string;
  expires_at: number;
  filename: string;
  size_bytes: number | null;
  sha256: string | null;
  refs: number | null;
  created_at: number;
  steps: string[];
}

const size = (b: number | null) => (b === null ? "" : b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

function Row({ p, reload }: { p: Pkg; reload: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [restore, setRestore] = useState<Restore | null>(null);
  const [busy, setBusy] = useState(false);
  const [newRepo, setNewRepo] = useState("");
  const [switched, setSwitched] = useState<string | null>(null);
  const owner = p.role === "owner";

  async function getRestore() {
    setBusy(true);
    setError(null);
    try {
      setRestore(await api<Restore>(`/packages/${p.ref}/backups/restore`, { method: "POST" }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  }
  async function toggleGit() {
    const off = p.git_backups;
    if (off && !window.confirm(`Stop git backups of ${p.ref}? Existing bundles are deleted tonight. Images and wheels stay mirrored so installs keep working.`)) return;
    await api(`/packages/${p.ref}/backups`, { method: "PATCH", body: JSON.stringify({ git_backups: !off }) }).then(reload, setError);
  }
  async function switchSource(e: Event) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ source: { url: string } }>(`/packages/${p.ref}/source`, { method: "POST", body: JSON.stringify({ repo: newRepo }) });
      setSwitched(r.source.url);
      setNewRepo("");
      reload();
    } catch (err) {
      setError(err);
    }
  }

  const steps = restore?.steps.map((s) => s.replace("<url>", restore.url)) ?? [];
  return (
    <li class="card stack">
      <div class="row">
        <a href={`/${p.ref}`}><strong>{p.ref}</strong></a>
        {p.source && <span class="small muted">{p.source.url}</span>}
        {p.source && p.source.sync_status !== "ok" && <Status value={p.source.sync_status} />}
      </div>
      <p class="small">
        {p.latest_bundle
          ? <>Latest git backup: {when(p.latest_bundle.created_at)} ({p.latest_bundle.weekly ? "weekly" : "release"}{p.latest_bundle.refs !== null && `, ${p.latest_bundle.refs} branches and tags`}{p.latest_bundle.size_bytes !== null && `, ${size(p.latest_bundle.size_bytes)}`}).</>
          : p.git_backups ? "No git backup yet; one is made at the next release or on Monday." : "Git backups are off for this package."}
        {" "}{p.mirrored ? "Artifacts are mirrored, so installs keep working if the host removes them." : ""}
      </p>
      <ErrorNote error={error} />
      {owner && (
        <div class="row">
          <button class="btn btn-primary" type="button" disabled={busy || !p.latest_bundle} onClick={getRestore}>Restore from backup</button>
          <button class="btn" type="button" onClick={toggleGit}>{p.git_backups ? "Turn off git backups" : "Turn on git backups"}</button>
        </div>
      )}
      {restore && (
        <div class="notice" role="status">
          <p><a href={restore.url} download={restore.filename}>Download {restore.filename}</a> ({size(restore.size_bytes)}, from {when(restore.created_at)}). The link works until {when(restore.expires_at)}.</p>
          <p class="small">Create an empty repository on GitHub or GitLab, then:</p>
          <pre class="small"><code>{steps.slice(0, -1).join("\n")}</code></pre>
          <p class="small">{steps[steps.length - 1]}</p>
          {restore.sha256 && <p class="small muted">SHA-256 <code>{restore.sha256}</code></p>}
        </div>
      )}
      {owner && (
        <form class="row" onSubmit={switchSource}>
          <label for={`src-${p.ref}`}>Switch source to</label>
          <input id={`src-${p.ref}`} type="url" value={newRepo} required placeholder="https://gitlab.com/you/tool" onInput={(e) => setNewRepo((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit">Switch source</button>
        </form>
      )}
      {switched && <p class="small" role="status">New releases now come from {switched}. Versions and installs are kept.</p>}
    </li>
  );
}

export default function Backups() {
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => api<{ packages: Pkg[] }>("/me/backups").then((r) => setPkgs(r.packages), setError);
  useEffect(() => void load(), []);
  return (
    <section aria-labelledby="backups">
      <h2 id="backups">Backups</h2>
      <p class="small muted">
        The registry keeps a git bundle of each package's repository and a copy of every published image and wheel. If GitHub
        or GitLab removes your repository by mistake, installs keep working and you can move to the other host.{" "}
        <a href="/docs/publishing#backups">How backups work</a>
      </p>
      <ErrorNote error={error} />
      {pkgs === null ? <Loading what="backups" /> : pkgs.length === 0
        ? <p class="muted">No published packages yet.</p>
        : <ul class="list-plain stack">{pkgs.map((p) => <Row p={p} reload={load} />)}</ul>}
    </section>
  );
}
