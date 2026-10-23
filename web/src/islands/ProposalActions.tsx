// What a signed-in person can do on a change proposal: reviewers (never the proposer) read the proposed files and
// approve it (the registry merges the pull request and releases it), send it back or turn it down; the proposer edits
// it while it is open or sent back, or withdraws it.
import { useEffect, useState } from "preact/hooks";
import { api, type ChangeProposalDetail, type ProposalStatus, type ProposalViewer } from "../lib/api";
import { PROPOSAL_FILES, PROPOSAL_STATUS_LABEL } from "../lib/proposals";
import ProposeChange from "./ProposeChange";
import { Confirm, ErrorNote } from "./shared";

interface Props {
  refName: string;
  number: number;
  status: ProposalStatus;
  title: string;
  note: string | null;
  back: string;
}

export default function ProposalActions({ refName, number, status, title, note, back }: Props) {
  const [viewer, setViewer] = useState<ProposalViewer | null>(null);
  const [current, setCurrent] = useState(status);
  const [review, setReview] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"approve" | "reject" | "withdraw" | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<unknown>(null);
  const base = `/packages/${refName}/proposals/${number}`;

  useEffect(() => {
    api<ProposalViewer>(`${base}/viewer`).then(setViewer).catch(() => {});
  }, [base]);
  if (!viewer || (!viewer.can_review && !viewer.is_proposer && !viewer.can_withdraw)) return null;

  const act = async (run: () => Promise<ProposalStatus>, words: (s: ProposalStatus) => string) => {
    setBusy(true);
    setError(null);
    try {
      const s = await run();
      setCurrent(s);
      setSaved(words(s));
      setReview("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };
  const decide = (decision: "approve" | "changes_requested" | "reject") =>
    act(
      async () => (await api<{ proposal: ChangeProposalDetail }>(`${base}/review`, { method: "POST", body: JSON.stringify({ decision, note: review }) })).proposal.status,
      (s) => (s === "merged" ? "Merged. The release is being built and scanned; it is published when the checks pass." : `Saved: ${PROPOSAL_STATUS_LABEL[s].toLowerCase()}. The page shows it within a minute.`),
    );
  const withdraw = () =>
    act(async () => (await api<{ status: ProposalStatus }>(base, { method: "DELETE" })).status, () => "Withdrawn. The pull request is closed.");
  const open = current === "open" || current === "changes_requested";

  return (
    <div class="stack proposal-actions">
      {saved && <p class="notice ok small" role="status">{saved}</p>}
      <ErrorNote error={error} />
      {viewer.can_review && open && viewer.files && (
        <details class="files">
          <summary>The proposed files</summary>
          <p class="small muted">As the pull request writes them; the pull request on GitHub shows them as a diff.</p>
          {PROPOSAL_FILES.filter((f) => viewer.files![f] !== undefined).map((f) => (
            <section>
              <h4><code>{f}</code></h4>
              <pre><code>{viewer.files![f]}</code></pre>
            </section>
          ))}
        </details>
      )}
      {viewer.can_review && open && (
        <form class="card stack" onSubmit={(e) => e.preventDefault()}>
          <h3>Review</h3>
          <p class="small muted">Read the files and the pull request. Approving merges it and releases the version shown above; the release is scanned like any other, and published when its checks pass.</p>
          <label for="pr-note">Note for the proposer</label>
          <textarea id="pr-note" rows={3} maxLength={2000} value={review} onInput={(e) => setReview((e.target as HTMLTextAreaElement).value)} />
          <p class="row">
            {confirming === "approve"
              ? <Confirm text="Merge it and start the release?" confirm="Merge and release" danger={false} onConfirm={() => decide("approve")} onCancel={() => setConfirming(null)} />
              : current === "open" && <button class="btn btn-primary" type="button" disabled={busy} onClick={() => setConfirming("approve")}>Approve, merge and release</button>}
            {current === "open" && <button class="btn" type="button" disabled={busy || !review.trim()} onClick={() => decide("changes_requested")}>Ask for changes</button>}
            {confirming === "reject"
              ? <Confirm text="Turn it down? The pull request is closed." confirm="Turn down" onConfirm={() => decide("reject")} onCancel={() => setConfirming(null)} />
              : <button class="btn btn-ghost" type="button" disabled={busy || !review.trim()} onClick={() => setConfirming("reject")}>Turn down</button>}
          </p>
          {!review.trim() && <p class="small muted">Asking for changes or turning it down needs a note.</p>}
          {current === "changes_requested" && <p class="small muted">It was sent back; it can be approved once the proposer saves it again.</p>}
        </form>
      )}
      {viewer.can_edit && open && (editing
        ? <ProposeChange refName={refName} back={back} number={number} title={title} note={note} onSaved={(p) => setCurrent(p.status)} />
        : <p><button class="btn btn-sm" type="button" onClick={() => setEditing(true)}>Edit the proposal</button></p>)}
      {viewer.can_withdraw && open && (
        <p class="small">
          {confirming === "withdraw"
            ? <Confirm text="Withdraw it? The pull request is closed." confirm="Withdraw" onConfirm={withdraw} onCancel={() => setConfirming(null)} />
            : <button class="btn btn-sm btn-ghost" type="button" disabled={busy} onClick={() => setConfirming("withdraw")}>Withdraw the proposal</button>}
        </p>
      )}
    </div>
  );
}
