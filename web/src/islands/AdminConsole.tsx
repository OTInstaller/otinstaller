// /admin: the review queue, reports and takedowns, claims and transfers, and the audit log.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe, when } from "./shared";

type Tab = "review" | "reports" | "transfers" | "audit";
const CATEGORIES = ["malware", "policy", "impersonation", "license", "legal", "other"];

interface Scan { kind: string; result: string; summary: any }
interface QueueVersion { version_id: string; ref: string; version: string; repo_url: string | null; summary: string; license: string; ethics: Record<string, boolean> | null; kind: string; scan_status: string; signed?: boolean; scans: Scan[] }
interface QueueNs { namespace: string; provider: string; members: string[]; profile_url: string | null; waiting_since: number; previous_notes: string | null; versions: QueueVersion[] }
interface Report { id: string; ref: string; version: string | null; reason: string; details: string; status: string; action: string | null; reporter: string | null; created_at: number; resolution_note: string | null }
interface Transfer { id: string; kind: string; status: string; ref: string; from: string; to: string; requested_by: string; verification?: string; upstream_url?: string }
interface Entry { id: string; actor: string | null; actor_kind: string; action: string; target_kind: string; target_id: string; metadata: any; created_at: number }

const ask = (label: string) => window.prompt(label)?.trim() ?? "";

function ScanList({ scans }: { scans: Scan[] }) {
  return (
    <ul class="list-plain small">
      {scans.map((s) => (
        <li>
          <span class={`badge ${s.result === "pass" ? "ok" : s.result === "warn" ? "warn" : "bad"}`}>{s.kind}: {s.result}</span>
          {s.kind === "pii" && s.summary?.hits?.length > 0 && (
            <ul>{s.summary.hits.map((h: any) => <li><code>{h.page}:{h.line}</code> {h.kind}: <q>{h.excerpt}</q></li>)}</ul>
          )}
          {s.kind === "links" && s.summary?.dead_links?.length > 0 && <span class="muted"> {s.summary.dead_links.length} dead or missing link(s)</span>}
        </li>
      ))}
    </ul>
  );
}

function Review({ setError }: { setError: (e: unknown) => void }) {
  const [data, setData] = useState<{ queue: QueueNs[]; content_review: QueueVersion[] } | null>(null);
  const load = () => api<{ queue: QueueNs[]; content_review: QueueVersion[] }>("/admin/review-queue").then(setData, setError);
  useEffect(() => void load(), []);
  const act = async (path: string, body: Record<string, unknown>) => {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      load();
    } catch (e) {
      setError(e);
    }
  };
  if (!data) return <Loading what="the review queue" />;
  return (
    <div class="stack">
      <h2>New publishers ({data.queue.length})</h2>
      {data.queue.length === 0 && <p class="muted">Nobody is waiting.</p>}
      {data.queue.map((n) => (
        <article class="card stack">
          <div class="row"><strong>{n.namespace}</strong> <span class="small muted">{n.provider} · members {n.members.join(", ") || "none"} · waiting since {when(n.waiting_since)}</span>
            {n.profile_url && <a class="small" href={n.profile_url} rel="nofollow noopener">profile</a>}</div>
          {n.previous_notes && <p class="small muted">Earlier notes: {n.previous_notes}</p>}
          {n.versions.map((v) => (
            <div class="panel">
              <p><strong>{v.ref} {v.version}</strong> ({v.kind}, {v.license}) {v.repo_url && <a href={v.repo_url} rel="nofollow noopener">source</a>}</p>
              <p class="small">{v.summary}</p>
              {v.ethics && <p class="small muted">{Object.entries(v.ethics).map(([k, val]) => `${k.replace(/_/g, " ")}: ${val ? "yes" : "no"}`).join(" · ")}</p>}
              <ScanList scans={v.scans} />
            </div>
          ))}
          <div class="row">
            <button class="btn btn-primary" type="button" onClick={() => act(`/admin/namespaces/${n.namespace}/approve`, { notes: "" })}>Approve</button>
            <button class="btn" type="button" onClick={() => { const notes = ask("What should the author change?"); if (notes) act(`/admin/namespaces/${n.namespace}/request-changes`, { notes }); }}>Request changes</button>
            <button class="btn" type="button" onClick={() => { const reason = ask("Why is it rejected? (sent to the author)"); if (reason) act(`/admin/namespaces/${n.namespace}/reject`, { reason }); }}>Reject</button>
          </div>
        </article>
      ))}
      <h2>Content review ({data.content_review.length})</h2>
      <p class="small muted">Releases from approved publishers held because a guide may contain personal data.</p>
      {data.content_review.map((v) => (
        <article class="card stack">
          <p><strong>{v.ref} {v.version}</strong> <span class="small muted">{v.summary}</span></p>
          <ScanList scans={v.scans} />
          <div class="row">
            <button class="btn btn-primary" type="button" onClick={() => act(`/admin/versions/${v.version_id}/approve`, {})}>Publish</button>
            <button class="btn" type="button" onClick={() => { const reason = ask("Why is it rejected? (sent to the author)"); if (reason) act(`/admin/versions/${v.version_id}/reject`, { reason }); }}>Reject</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function Takedown({ setError, initial }: { setError: (e: unknown) => void; initial?: string }) {
  const [target, setTarget] = useState(initial ?? "");
  const [category, setCategory] = useState("malware");
  const [reason, setReason] = useState("");
  const [suspend, setSuspend] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => setTarget(initial ?? ""), [initial]);
  const submit = async (e: Event) => {
    e.preventDefault();
    const [ref, version] = target.trim().split("@") as [string, string | undefined];
    if (!window.confirm(`Remove ${version ? `${ref} ${version}` : `${ref} and every version`}? It stops installing at once.`)) return;
    try {
      await api(`/admin/tools/${ref}${version ? `/${encodeURIComponent(version)}` : ""}/remove`, { method: "POST", body: JSON.stringify({ category, reason, suspend_namespace: suspend }) });
      setDone(`Removed ${target}.`);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <form class="panel stack" onSubmit={submit}>
      <h2>Take down</h2>
      <label for="td-target">Package (namespace/name, or namespace/name@version for one version)</label>
      <input id="td-target" type="text" value={target} onInput={(e) => setTarget((e.target as HTMLInputElement).value)} required pattern="[a-z0-9-]+/[a-z0-9-]+(@.+)?" />
      <label for="td-cat">Category (public, on the transparency page)</label>
      <select id="td-cat" value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>{CATEGORIES.map((c) => <option value={c}>{c}</option>)}</select>
      <label for="td-reason">Reason (sent to the owners)</label>
      <textarea id="td-reason" rows={3} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} required />
      <label class="row"><input type="checkbox" checked={suspend} onChange={(e) => setSuspend((e.target as HTMLInputElement).checked)} /> Also suspend the namespace pending investigation</label>
      <div class="row"><button class="btn btn-primary" type="submit">Remove</button>{done && <span role="status">{done}</span>}</div>
    </form>
  );
}

function Reports({ setError }: { setError: (e: unknown) => void }) {
  const [status, setStatus] = useState("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [target, setTarget] = useState<string | undefined>();
  const load = () => api<{ reports: Report[] }>(`/admin/reports?status=${status}`).then((r) => setReports(r.reports), setError);
  useEffect(() => void load(), [status]);
  const resolve = async (r: Report, s: "actioned" | "dismissed") => {
    const action = s === "actioned" ? ask("What was done? (e.g. removed version, asked author to fix)") : "";
    if (s === "actioned" && !action) return;
    try {
      await api(`/admin/reports/${r.id}/resolve`, { method: "POST", body: JSON.stringify({ status: s, action, note: "" }) });
      load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div class="stack">
      <div class="row" role="group" aria-label="Report status">
        {["open", "actioned", "dismissed", "all"].map((s) => <button class={`btn${status === s ? " btn-primary" : ""}`} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s}</button>)}
      </div>
      {reports === null ? <Loading what="reports" /> : reports.length === 0 ? <p class="muted">No reports.</p> : reports.map((r) => (
        <article class="card stack" id={r.id}>
          <div class="row"><span class={`badge ${r.reason === "malware" ? "bad" : "warn"}`}>{r.reason}</span> <a href={`/${r.ref}`}>{r.ref}</a>{r.version && <code>@{r.version}</code>}
            <span class="small muted">{when(r.created_at)} · {r.reporter ?? "anonymous"}</span> <Status value={r.status} /></div>
          <p class="small">{r.details || <em>no details</em>}</p>
          {r.action && <p class="small muted">Action: {r.action}</p>}
          {r.status === "open" && (
            <div class="row">
              <button class="btn" type="button" onClick={() => setTarget(`${r.ref}${r.version ? `@${r.version}` : ""}`)}>Take down…</button>
              <button class="btn" type="button" onClick={() => resolve(r, "actioned")}>Mark actioned</button>
              <button class="btn" type="button" onClick={() => resolve(r, "dismissed")}>Dismiss</button>
            </div>
          )}
        </article>
      ))}
      <Takedown setError={setError} initial={target} />
    </div>
  );
}

function Transfers({ setError, admin }: { setError: (e: unknown) => void; admin: boolean }) {
  const [rows, setRows] = useState<Transfer[] | null>(null);
  const load = () => api<{ transfers: Transfer[] }>("/admin/transfers?status=verified").then((r) => setRows(r.transfers), setError);
  useEffect(() => void (admin ? load() : setRows([])), []);
  if (!admin) return <p class="muted">Only admins complete claims.</p>;
  const complete = async (t: Transfer) => {
    if (!window.confirm(`Move ${t.ref} to ${t.to}?`)) return;
    try {
      await api(`/admin/transfers/${t.id}/complete`, { method: "POST", body: "{}" });
      load();
    } catch (e) {
      setError(e);
    }
  };
  if (rows === null) return <Loading what="claims" />;
  return rows.length === 0 ? <p class="muted">No verified claims waiting.</p> : (
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th scope="col">Package</th><th scope="col">To</th><th scope="col">Claimed by</th><th scope="col">Verified by</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr><td><a href={`/${t.ref}`}>{t.ref}</a>{t.upstream_url && <div class="small muted">{t.upstream_url}</div>}</td><td>{t.to}</td><td>{t.requested_by}</td><td>{t.verification?.replace(/_/g, " ")}</td>
              <td><button class="btn btn-primary" type="button" onClick={() => complete(t)}>Complete</button></td></tr>
          ))}
        </tbody>
      </table>
      <p class="small muted">Competing claims on one package are listed together; the verified upstream admin wins, ties are decided by hand.</p>
    </div>
  );
}

function Audit({ setError }: { setError: (e: unknown) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<number | undefined>();
  const load = (before?: number) => api<{ entries: Entry[]; next_before?: number }>(`/admin/audit-log${before ? `?before=${before}` : ""}`)
    .then((r) => { setEntries((e) => [...(before ? e ?? [] : []), ...r.entries]); setNext(r.next_before); }, setError);
  useEffect(() => void load(), []);
  if (entries === null) return <Loading what="the audit log" />;
  return (
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr><td>{when(e.created_at)}</td><td>{e.actor ?? e.actor_kind}</td><td><code>{e.action}</code></td><td class="small">{e.target_kind} {e.target_id}</td>
              <td class="small"><code>{e.metadata ? JSON.stringify(e.metadata).slice(0, 160) : ""}</code></td></tr>
          ))}
        </tbody>
      </table>
      {next && <button class="btn" type="button" onClick={() => load(next)}>Older</button>}
    </div>
  );
}

export default function AdminConsole({ back, initialTab = "review" }: { back: string; initialTab?: Tab }) {
  const me = useMe();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<unknown>(null);
  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Reviewers and admins sign in here." />;
  if (!me.reviewer && !me.admin) return <p class="notice">This area is for registry reviewers.</p>;
  const tabs: [Tab, string][] = [["review", "Review queue"], ["reports", "Reports and takedowns"], ["transfers", "Claims"], ["audit", "Audit log"]];
  return (
    <div class="stack">
      <div class="row" role="tablist" aria-label="Admin sections">
        {tabs.map(([key, label]) => <button class={`btn${tab === key ? " btn-primary" : ""}`} role="tab" type="button" aria-selected={tab === key} onClick={() => (setTab(key), setError(null))}>{label}</button>)}
      </div>
      <ErrorNote error={error} />
      {tab === "review" && <Review setError={setError} />}
      {tab === "reports" && <Reports setError={setError} />}
      {tab === "transfers" && <Transfers setError={setError} admin={me.admin} />}
      {tab === "audit" && <Audit setError={setError} />}
    </div>
  );
}
