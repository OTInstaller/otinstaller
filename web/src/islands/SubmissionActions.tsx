// What a signed-in person can do on a submission: reviewers (never the submitter) start a build that waits for them,
// approve the first release, send it back or turn it down; the submitter changes the Dockerfile while it waits or
// was sent back, or withdraws it.
import { useEffect, useState } from "preact/hooks";
import { api, type SubmissionStatus, type SubmissionViewer } from "../lib/api";
import { SUBMISSION_STATUS_LABEL } from "../lib/submissions";
import { Confirm, ErrorNote } from "./shared";

export default function SubmissionActions({ number, status, conformant, dockerfile }: { number: number; status: SubmissionStatus; conformant: boolean; dockerfile: string }) {
  const [viewer, setViewer] = useState<SubmissionViewer | null>(null);
  const [current, setCurrent] = useState(status);
  const [note, setNote] = useState("");
  const [text, setText] = useState(dockerfile);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"reject" | "withdraw" | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<SubmissionViewer>(`/submissions/${number}/viewer`).then(setViewer).catch(() => {});
  }, [number]);
  if (!viewer || (!viewer.can_review && !viewer.is_submitter)) return null;

  const act = async (path: string, method: "POST" | "PUT", body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: SubmissionStatus }>(`/submissions/${number}${path}`, { method, body: JSON.stringify(body) });
      setCurrent(r.status);
      setSaved(`Saved: the submission is now ${SUBMISSION_STATUS_LABEL[r.status].toLowerCase()}. The page shows it within a minute.`);
      setNote("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };
  const open = ["submitted", "releasing", "in_review", "changes_requested", "failed"].includes(current);

  return (
    <div class="stack subactions">
      {saved && <p class="notice ok small" role="status">{saved}</p>}
      <ErrorNote error={error} />
      {viewer.can_review && open && (
        <form class="card stack" onSubmit={(e) => e.preventDefault()}>
          <h3>Review</h3>
          <p class="small muted">Read the manifest, the Dockerfile and the scans. Approving publishes the first release; later releases publish on their own when their checks pass.</p>
          <label for="rv-note">Note for the submitter</label>
          <textarea id="rv-note" rows={3} maxLength={2000} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
          <p class="row">
            {current === "submitted" && !conformant && <button class="btn" type="button" disabled={busy} onClick={() => act("/start", "POST", {})}>Start the build</button>}
            {current === "in_review" && <button class="btn btn-primary" type="button" disabled={busy} onClick={() => act("/approve", "POST", { note })}>Approve and publish</button>}
            <button class="btn" type="button" disabled={busy || !note.trim()} onClick={() => act("/request-changes", "POST", { note })}>Ask for changes</button>
            {confirming === "reject"
              ? <Confirm text="Turn it down? The wrapper repository is archived." confirm="Turn down" onConfirm={() => act("/reject", "POST", { note })} onCancel={() => setConfirming(null)} />
              : <button class="btn btn-ghost" type="button" disabled={busy || !note.trim()} onClick={() => setConfirming("reject")}>Turn down</button>}
          </p>
          {!note.trim() && <p class="small muted">Asking for changes or turning it down needs a note.</p>}
        </form>
      )}
      {viewer.is_submitter && viewer.can_edit && dockerfile && (
        <form class="card stack" onSubmit={(e) => { e.preventDefault(); void act("", "PUT", { dockerfile: text }); }}>
          <h3>Change the Dockerfile</h3>
          <p class="small muted">It is checked again, committed to the wrapper repository and released again.</p>
          <label for="sb-df">Dockerfile</label>
          <textarea id="sb-df" rows={12} spellcheck={false} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <p><button class="btn btn-primary" type="submit" disabled={busy || text === dockerfile}>Save and release</button></p>
        </form>
      )}
      {viewer.is_submitter && open && (
        <p class="small">
          {confirming === "withdraw"
            ? <Confirm text="Withdraw it? The wrapper repository is archived." confirm="Withdraw" onConfirm={() => act("/withdraw", "POST", {})} onCancel={() => setConfirming(null)} />
            : <button class="btn btn-sm btn-ghost" type="button" disabled={busy} onClick={() => setConfirming("withdraw")}>Withdraw my submission</button>}
        </p>
      )}
    </div>
  );
}
