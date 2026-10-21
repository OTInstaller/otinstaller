// /admin: an overview of what is waiting, the review queue, reports and takedowns, claims and transfers, the audit log,
// and for the closed beta its feedback queue and the metrics its exit criteria are measured by.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, SignIn, useMe, when } from "./shared";
import "../styles/admin.css";

type Tab = "review" | "reports" | "transfers" | "audit" | "feedback" | "beta";
const PATHS: Record<Tab, string> = {
  review: "/admin", reports: "/admin/reports", transfers: "/admin/transfers", audit: "/admin/audit", feedback: "/admin/feedback", beta: "/admin/beta",
};
const CATEGORIES = ["malware", "policy", "impersonation", "license", "legal", "other"];

interface Scan { kind: string; result: string; summary: any }
interface QueueVersion { version_id: string; ref: string; version: string; repo_url: string | null; summary: string; license: string; ethics: Record<string, boolean> | null; kind: string; scan_status: string; signed?: boolean; scans: Scan[] }
interface QueueNs { namespace: string; provider: string; members: string[]; profile_url: string | null; waiting_since: number; previous_notes: string | null; versions: QueueVersion[] }
interface Queue { queue: QueueNs[]; content_review: QueueVersion[] }
interface Report { id: string; ref: string; version: string | null; reason: string; details: string; status: string; action: string | null; reporter: string | null; created_at: number; resolution_note: string | null }
interface Transfer { id: string; kind: string; status: string; ref: string; from: string; to: string; requested_by: string; verification?: string; upstream_url?: string }
interface Entry { id: string; actor: string | null; actor_kind: string; action: string; target_kind: string; target_id: string; metadata: any; created_at: number }
interface Counts { publishers: number; releases: number; content: number; reports: number; claims: number | null; feedback: number }
interface Feedback { id: string; kind: string; message: string; email: string | null; page: string | null; source: string; client: string | null; status: string; note: string | null; sender: string | null; resolved_by: string | null; created_at: number }
interface FailedPublish { id: string; provider: string; repo: string; tag: string; status: string; error_code: string | null; error_detail: string | null; updated_at: number | null }
interface BetaMetrics {
  publishers: { external: number; by_host: Record<string, { publishers: number; names: string[] }> };
  packages: { published: number; external: number; guides: number };
  installs: { total: number; last_7d: number };
  failed_publishes_7d: { count: number; recent: FailedPublish[] };
  feedback_open: Record<string, number>;
  sev1_open: { count: number | null; url: string; error?: string };
  exit: { external_publishers: { target: number; met: boolean }; gitlab_publishers: { target: number; met: boolean }; no_open_sev1: { met: boolean } };
}

type Notify = (message: string) => void;
type OnError = (e: unknown) => void;

// ---------- small helpers ----------

/** "4 min ago", "3 h ago", "2 days ago"; the exact time is in the title. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function Ago({ ms }: { ms: number }) {
  return <time dateTime={new Date(ms).toISOString()} title={when(ms)}>{ago(ms)}</time>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CHECK_LABELS: Record<string, string> = {
  signature: "Signature", vuln: "Vulnerabilities", malware: "Malware", smoke: "Smoke test", sbom: "SBOM",
  secrets: "Secrets", pii: "Personal data", links: "Links", content: "Content",
};

const resultClass = (r: string) => (r === "pass" ? "ok" : r === "warn" ? "warn" : r === "fail" ? "bad" : "");

/** The worst result of a release's checks: fail, then warn, then pass. */
function worst(scans: Scan[]): "fail" | "warn" | "pass" {
  if (scans.some((s) => s.result === "fail")) return "fail";
  if (scans.some((s) => s.result === "warn")) return "warn";
  return "pass";
}

/** Only the latest result of each check counts (a re-tag runs the checks again). */
function latestScans(scans: Scan[]): Scan[] {
  const byKind = new Map<string, Scan>();
  for (const s of scans) byKind.set(s.kind, s);
  return [...byKind.values()];
}

/** A button that asks once more before acting: the first click arms it, the second acts. */
function ConfirmButton({ label, confirm, onConfirm, primary = false, danger = false, disabled = false }: {
  label: string; confirm: string; onConfirm: () => void | Promise<void>; primary?: boolean; danger?: boolean; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  const cls = `btn${primary ? " btn-primary" : ""}${danger && armed ? " btn-danger" : ""}`;
  return (
    <button class={cls} type="button" disabled={disabled || busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        setBusy(true);
        try { await onConfirm(); } finally { setBusy(false); }
      }}>
      {busy ? "Working…" : armed ? confirm : label}
    </button>
  );
}

/** An inline note form that replaces window.prompt: a textarea, a submit and a cancel. */
function NoteForm({ label, hint, submit, onSubmit, onCancel, danger = false }: {
  label: string; hint?: string; submit: string; onSubmit: (text: string) => Promise<void>; onCancel: () => void; danger?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useMemo(() => `note-${Math.random().toString(36).slice(2, 8)}`, []);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form class={`note-form${danger ? " is-danger" : ""}`} onSubmit={async (e) => {
      e.preventDefault();
      if (!text.trim()) return;
      setBusy(true);
      try { await onSubmit(text.trim()); } finally { setBusy(false); }
    }}>
      <label for={id}>{label}</label>
      {hint && <p class="small muted">{hint}</p>}
      <textarea id={id} ref={ref} rows={3} value={text} required onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
      <div class="row">
        <button class={`btn ${danger ? "btn-danger" : "btn-primary"}`} type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : submit}</button>
        <button class="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="admin-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      <div><p class="admin-empty-title">{title}</p>{children && <p class="small muted">{children}</p>}</div>
    </div>
  );
}

// ---------- release rows ----------

function CheckDots({ scans }: { scans: Scan[] }) {
  return (
    <ul class="check-dots" aria-label="Checks">
      {scans.map((s) => (
        <li class={`check-dot ${resultClass(s.result)}`} title={`${CHECK_LABELS[s.kind] ?? s.kind}: ${s.result}`}>
          <span class="sr-only">{CHECK_LABELS[s.kind] ?? s.kind}: {s.result}</span>
        </li>
      ))}
    </ul>
  );
}

function Flags({ ethics }: { ethics: Record<string, boolean> | null }) {
  if (!ethics) return <span class="small faint">—</span>;
  const on = [
    ethics.touches_target && "contacts target",
    ethics.auth_required && "needs account",
    ethics.collects_personal_data && "personal data",
  ].filter(Boolean) as string[];
  return on.length ? <span class="badges">{on.map((f) => <span class="badge plain">{f}</span>)}</span> : <span class="small faint">none</span>;
}

/** What a reviewer needs to judge one check: counts, identities, output, hits. */
function ScanDetail({ s }: { s: Scan }) {
  const x = s.summary ?? {};
  let body: ComponentChildren = null;
  if (s.kind === "vuln" && typeof x === "object") {
    body = <>{["critical", "high", "medium", "low"].filter((k) => x[k] !== undefined).map((k) => `${x[k]} ${k}`).join(" · ")}
      {(x.fixable_critical || x.fixable_high) ? <> · <strong>{(x.fixable_critical ?? 0) + (x.fixable_high ?? 0)} fixable critical/high</strong></> : null}</>;
  } else if (s.kind === "signature") {
    body = x.identity ? <code>{x.identity}</code> : x.detail ? x.detail : x.status === "absent" ? "not signed (no provenance published)" : null;
  } else if (s.kind === "smoke") {
    body = <>exit {x.exit_code ?? "?"}{x.duration_ms ? ` in ${(x.duration_ms / 1000).toFixed(1)} s` : ""}{x.network ? ` · network ${x.network}` : ""}
      {x.output_excerpt && s.result !== "pass" && <pre class="admin-pre">{String(x.output_excerpt).slice(-600)}</pre>}</>;
  } else if (s.kind === "malware" || s.kind === "secrets") {
    body = x.count ? `${x.count} finding(s)` : "none found";
  } else if (s.kind === "sbom") {
    body = x.packages !== undefined ? `${x.packages} packages` : null;
  } else if (s.kind === "pii" && x.hits?.length) {
    body = <ul class="list-plain">{x.hits.map((h: any) => <li><code>{h.page}:{h.line}</code> {h.kind}: <q>{h.excerpt}</q></li>)}</ul>;
  } else if (s.kind === "links" && x.dead_links?.length) {
    body = `${x.dead_links.length} dead or missing link(s)`;
  }
  return (
    <div class="scan-detail">
      <span class={`badge ${resultClass(s.result)}`}>{CHECK_LABELS[s.kind] ?? s.kind}</span>
      <div class="small">{body ?? <span class="muted">{s.result}</span>}</div>
    </div>
  );
}

function ReleaseRow({ v, actions }: { v: QueueVersion; actions?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const scans = latestScans(v.scans);
  const w = worst(scans);
  const id = `rel-${v.version_id}`;
  return (
    <>
      <tr class={open ? "is-open" : ""}>
        <td>
          <button class="row-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            <span class="sr-only">Details for {v.ref}</span>
          </button>
        </td>
        <td>
          <a class="rel-ref" href={`/${v.ref}`}>{v.ref.split("/")[1]}</a> <span class="rel-ver">{v.version}</span>
          <div class="small muted rel-sum">{v.summary}</div>
        </td>
        <td class="small">{v.license}<div class="faint">{v.kind}</div></td>
        <td><Flags ethics={v.ethics} /></td>
        <td><div class="check-cell"><CheckDots scans={scans} /><span class={`badge ${resultClass(w)}`}>{w === "pass" ? "passed" : w === "warn" ? "warnings" : "failing"}</span></div></td>
        {actions !== undefined && <td class="rel-actions">{actions}</td>}
      </tr>
      {open && (
        <tr class="rel-detail" id={id}>
          <td />
          <td colSpan={actions !== undefined ? 5 : 4}>
            <div class="rel-detail-grid">
              <div>
                <p class="small">{v.summary}</p>
                <p class="small">{v.repo_url && <a href={v.repo_url} rel="nofollow noopener">Source repository</a>} · <a href={`/${v.ref}`}>Package page</a></p>
              </div>
              <div class="scan-details">{scans.map((s) => <ScanDetail s={s} />)}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ReleaseTable({ versions, actions }: { versions: QueueVersion[]; actions?: (v: QueueVersion) => ComponentChildren }) {
  return (
    <div class="table-wrap">
      <table class="data rel-table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">Details</span></th>
            <th scope="col">Release</th>
            <th scope="col">License</th>
            <th scope="col">Flags</th>
            <th scope="col">Checks</th>
            {actions && <th scope="col"><span class="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>{versions.map((v) => <ReleaseRow v={v} actions={actions ? actions(v) : undefined} />)}</tbody>
      </table>
    </div>
  );
}

// ---------- review ----------

function PublisherCard({ n, reload, notify, onError }: { n: QueueNs; reload: () => void; notify: Notify; onError: OnError }) {
  const [form, setForm] = useState<"changes" | "reject" | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const v of n.versions) counts[worst(latestScans(v.scans))]++;
  const shown = attentionOnly ? n.versions.filter((v) => worst(latestScans(v.scans)) !== "pass") : n.versions;
  const post = async (path: string, body: unknown) => api<any>(path, { method: "POST", body: JSON.stringify(body) });
  const done = (msg: string) => { setForm(null); notify(msg); reload(); };

  return (
    <article class="admin-card">
      <header class="admin-card-head">
        <span class="avatar" aria-hidden="true">{n.namespace.slice(0, 1).toUpperCase()}</span>
        <div class="grow">
          <h3 class="admin-card-title"><a href={`/${n.namespace}`}>{n.namespace}</a></h3>
          <p class="small muted">
            {n.provider} · {n.members.length ? `members ${n.members.join(", ")}` : "no members yet"} · waiting <Ago ms={n.waiting_since} />
            {n.profile_url && <> · <a href={n.profile_url} rel="nofollow noopener">profile</a></>}
          </p>
        </div>
        <div class="row admin-card-actions">
          <ConfirmButton primary label={`Approve${n.versions.length > 1 ? ` all ${n.versions.length}` : ""}`} confirm={`Publish ${plural(n.versions.length, "release")}?`}
            onConfirm={async () => {
              try {
                const r = await post(`/admin/namespaces/${n.namespace}/approve`, { notes: "" });
                done(`Approved ${n.namespace}. ${plural(r.queued ?? r.published ?? n.versions.length, "release")} queued for publishing.`);
                // The queue publishes them within seconds; look again so they don't linger as "held".
                setTimeout(reload, 5000);
                setTimeout(reload, 15000);
              } catch (e) { onError(e); }
            }} />
          <button class="btn" type="button" aria-expanded={form === "changes"} onClick={() => setForm(form === "changes" ? null : "changes")}>Request changes</button>
          <button class="btn btn-ghost" type="button" aria-expanded={form === "reject"} onClick={() => setForm(form === "reject" ? null : "reject")}>Reject</button>
        </div>
      </header>

      {n.previous_notes && <p class="notice small">Earlier review notes: {n.previous_notes}</p>}
      {form === "changes" && (
        <NoteForm label="What should the author change?" hint="Sent to the publisher by email; their releases are closed until they tag again." submit="Send request"
          onCancel={() => setForm(null)}
          onSubmit={async (notes) => { try { await post(`/admin/namespaces/${n.namespace}/request-changes`, { notes }); done(`Asked ${n.namespace} for changes.`); } catch (e) { onError(e); } }} />
      )}
      {form === "reject" && (
        <NoteForm danger label="Why is the namespace rejected?" hint="Sent to the publisher. Their releases are rejected and the namespace can't publish." submit="Reject namespace"
          onCancel={() => setForm(null)}
          onSubmit={async (reason) => { try { await post(`/admin/namespaces/${n.namespace}/reject`, { reason }); done(`Rejected ${n.namespace}.`); } catch (e) { onError(e); } }} />
      )}

      <div class="admin-card-summary">
        <span class="small">{plural(n.versions.length, "release")}</span>
        {counts.pass > 0 && <span class="badge ok">{counts.pass} passed</span>}
        {counts.warn > 0 && <span class="badge warn">{counts.warn} with warnings</span>}
        {counts.fail > 0 && <span class="badge bad">{counts.fail} failing</span>}
        {counts.warn + counts.fail > 0 && n.versions.length > 3 && (
          <label class="admin-toggle small"><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly((e.target as HTMLInputElement).checked)} /> Only those needing attention</label>
        )}
      </div>
      <ReleaseTable versions={shown} />
    </article>
  );
}

function Review({ data, reload, notify, onError }: { data: Queue | null; reload: () => void; notify: Notify; onError: OnError }) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  if (!data) return <Loading what="the review queue" />;
  const post = (path: string, body: unknown) => api<any>(path, { method: "POST", body: JSON.stringify(body) });
  return (
    <div class="admin-sections">
      <section aria-labelledby="pub-h">
        <div class="admin-section-head">
          <h2 id="pub-h">New publishers</h2>
          <p class="small muted">A publisher's first releases are reviewed together; approving publishes them all.</p>
        </div>
        {data.queue.length === 0 ? <Empty title="No publishers waiting">New namespaces appear here with their first releases.</Empty>
          : <div class="admin-stack">{data.queue.map((n) => <PublisherCard n={n} reload={reload} notify={notify} onError={onError} />)}</div>}
      </section>

      <section aria-labelledby="content-h">
        <div class="admin-section-head">
          <h2 id="content-h">Content review</h2>
          <p class="small muted">Releases from approved publishers held for a person to check, such as a guide that may contain personal data.</p>
        </div>
        {data.content_review.length === 0 ? <Empty title="Nothing held for review" />
          : (
            <div class="admin-card">
              {rejecting && (
                <NoteForm danger label={`Why is ${data.content_review.find((v) => v.version_id === rejecting)?.ref ?? "this release"} rejected?`} hint="Sent to the author." submit="Reject release"
                  onCancel={() => setRejecting(null)}
                  onSubmit={async (reason) => {
                    try { await post(`/admin/versions/${rejecting}/reject`, { reason }); setRejecting(null); notify("Release rejected."); reload(); } catch (e) { onError(e); }
                  }} />
              )}
              <ReleaseTable versions={data.content_review} actions={(v) => (
                <div class="row">
                  <ConfirmButton primary label="Publish" confirm="Publish now?" onConfirm={async () => {
                    try { await post(`/admin/versions/${v.version_id}/approve`, {}); notify(`Published ${v.ref} ${v.version}.`); reload(); } catch (e) { onError(e); }
                  }} />
                  <button class="btn btn-ghost" type="button" onClick={() => setRejecting(v.version_id)}>Reject</button>
                </div>
              )} />
            </div>
          )}
      </section>
    </div>
  );
}

// ---------- reports and takedowns ----------

function Takedown({ initial, initialCategory = "malware", notify, onError, onClose }: {
  initial: string; initialCategory?: string; notify: Notify; onError: OnError; onClose: () => void;
}) {
  const [target, setTarget] = useState(initial);
  const [category, setCategory] = useState(initialCategory);
  const [reason, setReason] = useState("");
  const [suspend, setSuspend] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { setTarget(initial); setCategory(initialCategory); ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [initial, initialCategory]);
  const [pkg, version] = target.trim().split("@") as [string, string | undefined];
  const valid = /^[a-z0-9-]+\/[a-z0-9-]+$/.test(pkg ?? "") && reason.trim().length > 0;
  return (
    <form ref={ref} class="admin-card takedown" onSubmit={(e) => e.preventDefault()}>
      <header class="admin-card-head">
        <div class="grow">
          <h3 class="admin-card-title">Take down a package</h3>
          <p class="small muted">It stops installing at once and is listed on the public transparency page with its category.</p>
        </div>
        <button class="btn btn-ghost" type="button" onClick={onClose}>Close</button>
      </header>
      <div class="form-grid">
        <label for="td-target">Package</label>
        <div>
          <input id="td-target" type="text" value={target} placeholder="namespace/name or namespace/name@1.2.0" onInput={(e) => setTarget((e.target as HTMLInputElement).value)} />
          <p class="small muted">Add <code>@version</code> to remove one version; leave it off to remove every version.</p>
        </div>
        <label for="td-cat">Category</label>
        <div><select id="td-cat" value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>{CATEGORIES.map((c) => <option value={c}>{c}</option>)}</select>
          <p class="small muted">Public, on the transparency page.</p></div>
        <label for="td-reason">Reason</label>
        <div><textarea id="td-reason" rows={3} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
          <p class="small muted">Sent to the package's owners.</p></div>
        <span />
        <label class="admin-toggle"><input type="checkbox" checked={suspend} onChange={(e) => setSuspend((e.target as HTMLInputElement).checked)} /> Also suspend the namespace pending investigation</label>
      </div>
      <div class="row">
        <ConfirmButton danger disabled={!valid} label="Remove" confirm={`Remove ${version ? `${pkg} ${version}` : `${pkg || "it"} and every version`}?`}
          onConfirm={async () => {
            try {
              await api(`/admin/tools/${pkg}${version ? `/${encodeURIComponent(version)}` : ""}/remove`, { method: "POST", body: JSON.stringify({ category, reason, suspend_namespace: suspend }) });
              notify(`Removed ${target.trim()}.`);
              onClose();
            } catch (e) { onError(e); }
          }} />
      </div>
    </form>
  );
}

function Reports({ notify, onError, onChange }: { notify: Notify; onError: OnError; onChange: () => void }) {
  const [status, setStatus] = useState("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [takedown, setTakedown] = useState<{ target: string; category?: string } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const load = () => api<{ reports: Report[] }>(`/admin/reports?status=${status}`).then((r) => setReports(r.reports), onError);
  useEffect(() => { setReports(null); void load(); }, [status]);
  const resolve = async (r: Report, s: "actioned" | "dismissed", action = "") => {
    try {
      await api(`/admin/reports/${r.id}/resolve`, { method: "POST", body: JSON.stringify({ status: s, action, note: "" }) });
      setResolving(null);
      notify(s === "actioned" ? `Report on ${r.ref} marked actioned.` : `Report on ${r.ref} dismissed.`);
      load();
      onChange();
    } catch (e) { onError(e); }
  };
  return (
    <div class="admin-sections">
      <div class="admin-toolbar">
        <div class="segmented" role="group" aria-label="Report status">
          {["open", "actioned", "dismissed", "all"].map((s) => <button type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}
        </div>
        {takedown === null && <button class="btn" type="button" onClick={() => setTakedown({ target: "" })}>Take down a package…</button>}
      </div>
      {takedown !== null && <Takedown initial={takedown.target} initialCategory={takedown.category} notify={notify} onError={onError} onClose={() => setTakedown(null)} />}
      {reports === null ? <Loading what="reports" /> : reports.length === 0
        ? <Empty title={status === "open" ? "No open reports" : `No ${status === "all" ? "" : `${status} `}reports`} />
        : (
          <ul class="list-plain admin-stack">
            {reports.map((r) => (
              <li class="admin-card report" id={r.id}>
                <header class="admin-card-head">
                  <span class={`badge ${r.reason === "malware" ? "bad" : "warn"}`}>{r.reason}</span>
                  <div class="grow">
                    <h3 class="admin-card-title"><a href={`/${r.ref}`}>{r.ref}</a>{r.version && <span class="rel-ver"> {r.version}</span>}</h3>
                    <p class="small muted">Reported <Ago ms={r.created_at} /> by {r.reporter ?? "an anonymous visitor"}{r.status !== "open" && <> · {r.status}</>}</p>
                  </div>
                  {r.status === "open" && (
                    <div class="row admin-card-actions">
                      <button class="btn" type="button" onClick={() => setTakedown({ target: `${r.ref}${r.version ? `@${r.version}` : ""}`, category: CATEGORIES.includes(r.reason) ? r.reason : "other" })}>Take down…</button>
                      <button class="btn" type="button" aria-expanded={resolving === r.id} onClick={() => setResolving(resolving === r.id ? null : r.id)}>Mark actioned</button>
                      <ConfirmButton label="Dismiss" confirm="Dismiss report?" onConfirm={() => resolve(r, "dismissed")} />
                    </div>
                  )}
                </header>
                <blockquote class="report-text">{r.details || <em class="muted">No details given.</em>}</blockquote>
                {r.action && <p class="small muted">Action taken: {r.action}</p>}
                {resolving === r.id && (
                  <NoteForm label="What was done?" hint="For example: removed the version, or asked the author to fix it." submit="Mark actioned"
                    onCancel={() => setResolving(null)} onSubmit={(action) => resolve(r, "actioned", action)} />
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

// ---------- claims ----------

function Transfers({ admin, notify, onError, onChange }: { admin: boolean; notify: Notify; onError: OnError; onChange: () => void }) {
  const [rows, setRows] = useState<Transfer[] | null>(null);
  const load = () => api<{ transfers: Transfer[] }>("/admin/transfers?status=verified").then((r) => setRows(r.transfers), onError);
  useEffect(() => void (admin ? load() : setRows([])), []);
  if (!admin) return <p class="notice">Only admins complete claims and transfers.</p>;
  if (rows === null) return <Loading what="claims" />;
  if (rows.length === 0) return <Empty title="No verified claims waiting">When an upstream maintainer proves they own a community package, the claim waits here for you to complete it.</Empty>;
  return (
    <div class="admin-sections">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th scope="col">Package</th><th scope="col">Moves to</th><th scope="col">Claimed by</th><th scope="col">Verified by</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr>
                <td><a href={`/${t.ref}`}>{t.ref}</a>{t.upstream_url && <div class="small muted">{t.upstream_url}</div>}</td>
                <td><code>{t.to}</code></td>
                <td>{t.requested_by}</td>
                <td class="small">{t.verification?.replace(/_/g, " ") ?? "—"}</td>
                <td><ConfirmButton primary label="Complete" confirm={`Move to ${t.to}?`} onConfirm={async () => {
                  try { await api(`/admin/transfers/${t.id}/complete`, { method: "POST", body: "{}" }); notify(`Moved ${t.ref} to ${t.to}.`); load(); onChange(); } catch (e) { onError(e); }
                }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="small muted">Competing claims on one package are listed together; the verified upstream admin wins, ties are decided by hand.</p>
    </div>
  );
}

// ---------- audit log ----------

const actionClass = (a: string) =>
  /remove|reject|ban|suspend|deny/.test(a) ? "bad" : /approve|publish|verify|complete|create/.test(a) ? "ok" : /request|report|claim|transfer/.test(a) ? "warn" : "info";

function Meta({ data }: { data: any }) {
  if (!data || typeof data !== "object") return null;
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== "" && v !== undefined);
  if (!entries.length) return null;
  return (
    <dl class="audit-meta">
      {entries.slice(0, 6).map(([k, v]) => <><dt>{k.replace(/_/g, " ")}</dt><dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd></>)}
    </dl>
  );
}

function Audit({ onError }: { onError: OnError }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<number | undefined>();
  const [filter, setFilter] = useState("");
  const load = (before?: number) => api<{ entries: Entry[]; next_before?: number }>(`/admin/audit-log${before ? `?before=${before}` : ""}`)
    .then((r) => { setEntries((e) => [...(before ? e ?? [] : []), ...r.entries]); setNext(r.next_before); }, onError);
  useEffect(() => void load(), []);
  if (entries === null) return <Loading what="the audit log" />;
  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => `${e.action} ${e.actor ?? e.actor_kind} ${e.target_kind} ${e.target_id} ${JSON.stringify(e.metadata ?? "")}`.toLowerCase().includes(q)) : entries;
  return (
    <div class="admin-sections">
      <div class="admin-toolbar">
        <label class="sr-only" for="audit-filter">Filter the audit log</label>
        <input id="audit-filter" type="search" placeholder="Filter by action, person or package…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <span class="small muted">{q ? `${shown.length} of ${entries.length} loaded entries` : `${entries.length} entries loaded`}</span>
      </div>
      {shown.length === 0 ? <Empty title="No matching entries" /> : (
        <div class="table-wrap">
          <table class="data audit-table">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr>
                  <td class="small nowrap"><Ago ms={e.created_at} /></td>
                  <td class="small">{e.actor ?? <span class="muted">{e.actor_kind}</span>}</td>
                  <td><span class={`badge plain ${actionClass(e.action)}`}>{e.action}</span></td>
                  <td class="small"><span class="muted">{e.target_kind}</span> <code class="audit-id" title={e.target_id}>{e.target_id}</code></td>
                  <td class="small"><Meta data={e.metadata} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <button class="btn" type="button" onClick={() => load(next)}>Load older entries</button>}
    </div>
  );
}

// ---------- beta ----------

const FEEDBACK_KINDS: Record<string, string> = { bug: "bad", idea: "info", question: "warn", other: "" };

function FeedbackQueue({ notify, onError, onChange }: { notify: Notify; onError: OnError; onChange: () => void }) {
  const [status, setStatus] = useState("open");
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const load = () => api<{ feedback: Feedback[] }>(`/admin/feedback?status=${status}`).then((r) => setItems(r.feedback), onError);
  useEffect(() => { setItems(null); void load(); }, [status]);
  const resolve = async (f: Feedback, s: "done" | "dismissed" | "open", note = "") => {
    try {
      await api(`/admin/feedback/${f.id}/resolve`, { method: "POST", body: JSON.stringify({ status: s, note }) });
      setNoting(null);
      notify(s === "open" ? "Feedback reopened." : s === "done" ? "Feedback marked done." : "Feedback dismissed.");
      load();
      onChange();
    } catch (e) { onError(e); }
  };
  return (
    <div class="admin-sections">
      <div class="admin-toolbar">
        <div class="segmented" role="group" aria-label="Feedback status">
          {["open", "done", "dismissed", "all"].map((s) => <button type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}
        </div>
        <p class="small muted">A bug that blocks someone also belongs in a GitHub issue with a severity, so the beta's sev-1 count sees it.</p>
      </div>
      {items === null ? <Loading what="feedback" /> : items.length === 0
        ? <Empty title={status === "open" ? "No open feedback" : `No ${status === "all" ? "" : `${status} `}feedback`} />
        : (
          <ul class="list-plain admin-stack">
            {items.map((f) => (
              <li class="admin-card" id={f.id}>
                <header class="admin-card-head">
                  <span class={`badge ${FEEDBACK_KINDS[f.kind] ?? ""}`}>{f.kind}</span>
                  <div class="grow">
                    <h3 class="admin-card-title">{f.sender ?? f.email ?? "Anonymous"}{f.page && <span class="rel-ver"> {f.page}</span>}</h3>
                    <p class="small muted">
                      <Ago ms={f.created_at} /> · {f.source === "cli" ? "ot feedback" : "site form"}{f.client && <> · {f.client}</>}
                      {f.sender && f.email && <> · {f.email}</>}{f.status !== "open" && <> · {f.status}{f.resolved_by && ` by ${f.resolved_by}`}</>}
                    </p>
                  </div>
                  <div class="row admin-card-actions">
                    {f.status === "open"
                      ? <>
                        <button class="btn" type="button" aria-expanded={noting === f.id} onClick={() => setNoting(noting === f.id ? null : f.id)}>Mark done</button>
                        <ConfirmButton label="Dismiss" confirm="Dismiss feedback?" onConfirm={() => resolve(f, "dismissed")} />
                      </>
                      : <button class="btn" type="button" onClick={() => void resolve(f, "open")}>Reopen</button>}
                  </div>
                </header>
                <blockquote class="report-text">{f.message}</blockquote>
                {f.note && <p class="small muted">Note: {f.note}</p>}
                {noting === f.id && (
                  <NoteForm label="What was done?" hint="For example: fixed in ot 0.9.1, or opened an issue." submit="Mark done"
                    onCancel={() => setNoting(null)} onSubmit={(note) => resolve(f, "done", note)} />
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function Criterion({ met, label, detail }: { met: boolean | null; label: string; detail: ComponentChildren }) {
  return (
    <li class="row">
      <span class={`badge ${met ? "ok" : "warn"}`}>{met ? "met" : met === null ? "check" : "not yet"}</span>
      <span><strong>{label}</strong> <span class="small muted">{detail}</span></span>
    </li>
  );
}

function Beta({ onError }: { onError: OnError }) {
  const [m, setM] = useState<BetaMetrics | null>(null);
  useEffect(() => void api<BetaMetrics>("/admin/beta-metrics").then(setM, onError), []);
  if (!m) return <Loading what="beta metrics" />;
  const none = { publishers: 0, names: [] as string[] };
  const hosts: [string, { publishers: number; names: string[] }][] = [["GitHub", m.publishers.by_host.github ?? none], ["GitLab", m.publishers.by_host.gitlab ?? none]];
  const gl = hosts[1]![1];
  const openFeedback = Object.values(m.feedback_open).reduce((a, b) => a + b, 0);
  const tiles: [ComponentChildren, string, string][] = [
    [m.publishers.external, "External publishers", hosts.map(([h, x]) => `${x.publishers} ${h}`).join(" · ")],
    [m.packages.published, "Published packages", `${m.packages.external} external · ${m.packages.guides} guides`],
    [m.installs.last_7d, "Installs, 7 days", `${m.installs.total} in all`],
    [m.failed_publishes_7d.count, "Failed publishes, 7 days", "rejected or errored"],
    [m.sev1_open.count ?? "?", "Open sev-1 bugs", m.sev1_open.count === null ? "couldn't ask GitHub" : "GitHub issues"],
    [openFeedback, "Open feedback", Object.entries(m.feedback_open).map(([k, n]) => `${n} ${k}`).join(" · ") || "none"],
  ];
  return (
    <div class="admin-sections">
      <div class="admin-overview">
        {tiles.map(([n, label, hint]) => (
          <div class="admin-stat">
            <span class="admin-stat-n">{n}</span>
            <span class="admin-stat-label">{label}</span>
            <span class="admin-stat-hint">{hint}</span>
          </div>
        ))}
      </div>
      <section class="admin-card">
        <h3 class="admin-card-title">Exit criteria</h3>
        <ul class="list-plain admin-stack">
          <Criterion met={m.exit.external_publishers.met} label={`${m.exit.external_publishers.target}+ external authors have published`} detail={`${m.publishers.external} so far`} />
          <Criterion met={m.exit.gitlab_publishers.met} label={`At least ${m.exit.gitlab_publishers.target} of them from GitLab`} detail={`${gl.publishers} so far`} />
          <Criterion met={m.exit.no_open_sev1.met} label="No open severity-1 bugs"
            detail={m.sev1_open.count === null ? <>{m.sev1_open.error}. <a href={m.sev1_open.url}>Check on GitHub</a></> : <a href={m.sev1_open.url}>{plural(m.sev1_open.count, "open issue")}</a>} />
          <Criterion met={null} label="ot installs cleanly on Windows, macOS and Linux" detail="see the latest run of the CLI install workflow" />
        </ul>
        {hosts.filter(([, x]) => x.names.length > 0).map(([h, x]) => (
          <p class="small"><strong>{h}:</strong> {x.names.map((n, i) => <>{i > 0 && ", "}<a href={`/${n}`}>{n}</a></>)}</p>
        ))}
      </section>
      <section>
        <h3 class="admin-section-head">Failed publishes in the last 7 days</h3>
        {m.failed_publishes_7d.recent.length === 0 ? <Empty title="No failed publishes" /> : (
          <table class="data">
            <thead><tr><th scope="col">Repository</th><th scope="col">Tag</th><th scope="col">Result</th><th scope="col">Why</th><th scope="col">When</th></tr></thead>
            <tbody>
              {m.failed_publishes_7d.recent.map((j) => (
                <tr>
                  <td><span class="faint">{j.provider}</span> {j.repo}</td>
                  <td><code>{j.tag}</code></td>
                  <td><span class={`badge ${j.status === "error" ? "bad" : "warn"}`}>{j.status}</span></td>
                  <td class="small">{j.error_code && <code>{j.error_code}</code>} {j.error_detail}</td>
                  <td class="small nowrap">{j.updated_at ? <Ago ms={j.updated_at} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- console ----------

function Overview({ counts, tab, go }: { counts: Counts | null; tab: Tab; go: (t: Tab) => void }) {
  const tiles: { tab: Tab; n: number | null | undefined; label: string; hint: string; tone: string }[] = [
    { tab: "review", n: counts?.publishers, label: "New publishers", hint: counts ? plural(counts.releases, "release") + " waiting" : "", tone: "warn" },
    { tab: "review", n: counts?.content, label: "Content review", hint: "held releases", tone: "warn" },
    { tab: "reports", n: counts?.reports, label: "Open reports", hint: "need a decision", tone: "bad" },
    { tab: "transfers", n: counts?.claims, label: "Claims", hint: counts?.claims === null ? "admins only" : "verified, to complete", tone: "info" },
  ];
  return (
    <div class="admin-overview">
      {tiles.map((t) => (
        <button type="button" class={`admin-stat${t.n ? ` has-${t.tone}` : ""}${tab === t.tab ? " is-current" : ""}`} onClick={() => go(t.tab)}>
          <span class="admin-stat-n">{t.n === undefined ? "–" : t.n === null ? "—" : t.n}</span>
          <span class="admin-stat-label">{t.label}</span>
          <span class="admin-stat-hint">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}

export default function AdminConsole({ back, initialTab = "review" }: { back: string; initialTab?: Tab }) {
  const me = useMe();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<unknown>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const staff = me && (me.reviewer || me.admin);

  const refresh = async () => {
    if (!me || !staff) return;
    try {
      const [q, open, claims, feedback] = await Promise.all([
        api<Queue>("/admin/review-queue"),
        api<{ reports: Report[] }>("/admin/reports?status=open"),
        me.admin ? api<{ transfers: Transfer[] }>("/admin/transfers?status=verified") : Promise.resolve(null),
        api<{ feedback: Feedback[] }>("/admin/feedback?status=open"),
      ]);
      setQueue(q);
      setCounts({
        publishers: q.queue.length,
        releases: q.queue.reduce((n, ns) => n + ns.versions.length, 0),
        content: q.content_review.length,
        reports: open.reports.length,
        claims: claims ? claims.transfers.length : null,
        feedback: feedback.feedback.length,
      });
      setUpdated(Date.now());
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => void refresh(), [me]);

  // The tab is part of the address, so Back works and reviewer emails can link straight to a tab.
  useEffect(() => {
    const onPop = () => {
      const t = (Object.entries(PATHS).find(([, p]) => p === location.pathname.replace(/\/$/, ""))?.[0] ?? "review") as Tab;
      setTab(t);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (t: Tab) => {
    setError(null);
    setTab(t);
    if (location.pathname !== PATHS[t]) history.pushState(null, "", PATHS[t]);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  const notify: Notify = (m) => { setError(null); setToast(m); };

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Reviewers and admins sign in here." />;
  if (!staff) return <p class="notice">This area is for registry reviewers.</p>;

  const tabs: [Tab, string, number | null | undefined][] = [
    ["review", "Review queue", counts ? counts.publishers + counts.content : undefined],
    ["reports", "Reports", counts?.reports],
    ["transfers", "Claims", counts?.claims],
    ["audit", "Audit log", undefined],
    ["feedback", "Feedback", counts?.feedback],
    ["beta", "Beta", undefined],
  ];
  return (
    <div class="admin">
      <Overview counts={counts} tab={tab} go={go} />
      <div class="admin-bar">
        <div class="segmented admin-tabs" role="tablist" aria-label="Admin sections">
          {tabs.map(([key, label, n]) => (
            <button role="tab" type="button" aria-selected={tab === key} onClick={() => go(key)}>
              {label}{n ? <span class="tab-count">{n}</span> : null}
            </button>
          ))}
        </div>
        <div class="row small muted">
          {updated && <span>Updated <Ago ms={updated} /></span>}
          <button class="btn btn-sm" type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>
      <div class="admin-live" role="status" aria-live="polite">
        {toast && <p class="notice ok admin-toast">{toast}<button class="btn btn-ghost btn-sm" type="button" onClick={() => setToast(null)} aria-label="Dismiss">×</button></p>}
      </div>
      <ErrorNote error={error} />
      <div role="tabpanel" class="admin-panel">
        {tab === "review" && <Review data={queue} reload={refresh} notify={notify} onError={setError} />}
        {tab === "reports" && <Reports notify={notify} onError={setError} onChange={refresh} />}
        {tab === "transfers" && <Transfers admin={me.admin} notify={notify} onError={setError} onChange={refresh} />}
        {tab === "audit" && <Audit onError={setError} />}
        {tab === "feedback" && <FeedbackQueue notify={notify} onError={setError} onChange={refresh} />}
        {tab === "beta" && <Beta onError={setError} />}
      </div>
    </div>
  );
}
