// The private half of the report page (/{ns}/{name}/report): malware, abuse and legal problems go to the registry's
// reviewers, never to the public. Anonymous reports are allowed; signed-in ones carry the reporter.
import { useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote } from "./shared";

const REASONS: [string, string][] = [
  ["malware", "Malware or suspicious behaviour"],
  ["policy", "Breaks the acceptable use policy (stalkerware, credential stuffing, …)"],
  ["impersonation", "Impersonates another tool, vendor or person"],
  ["license", "Copyright or license problem"],
  ["other", "Something else the reviewers should see"],
];

export default function ReportForm({ refName, versions, version }: { refName: string; versions: string[]; version?: string }) {
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [v, setV] = useState(version ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ note: string }>(`/tools/${refName}/reports`, { method: "POST", body: JSON.stringify({ reason, details, ...(v ? { version: v } : {}) }) });
      setDone(r.note);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p class="notice" role="status">{done}</p>;
  return (
    <form class="stack" onSubmit={submit}>
      <fieldset class="stack">
        <legend>Which of these?</legend>
        {REASONS.map(([value, label]) => (
          <label class="row"><input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} required /> {label}</label>
        ))}
      </fieldset>
      <label for="ver">Version</label>
      <select id="ver" value={v} onChange={(e) => setV((e.target as HTMLSelectElement).value)}>
        <option value="">All versions / not sure</option>
        {versions.map((x) => <option value={x}>{x}</option>)}
      </select>
      <label for="details">Details</label>
      <textarea id="details" rows={7} value={details} onInput={(e) => setDetails((e.target as HTMLTextAreaElement).value)} required
        placeholder="What did you see, and how can a reviewer reproduce it? Links to evidence help." maxLength={4000} />
      <ErrorNote error={error} />
      <div class="row">
        <button class="btn btn-primary" type="submit" disabled={busy || !reason}>Send report</button>
        <span class="small muted">Malware reports are looked at within 24 hours, others within 72.</span>
      </div>
    </form>
  );
}
