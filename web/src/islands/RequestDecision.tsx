// What a signed-in person can do on a request besides voting: triagers and staff accept, start, publish, decline or
// reopen it; the person who asked can withdraw it, and sees their note while it waits for a moderator.
import { useEffect, useState } from "preact/hooks";
import { api, type DeclineCode, type RequestStatus, type RequestViewer } from "../lib/api";
import { DECLINE_LABEL, REQUEST_STATUS_LABEL, TRIAGE_DECLINE_CODES, takesVotes } from "../lib/requests";
import { Confirm, ErrorNote } from "./shared";

const MOVES: Record<RequestStatus, RequestStatus[]> = {
  open: ["accepted", "in_progress", "published", "declined"],
  accepted: ["in_progress", "published", "declined", "open"],
  in_progress: ["published", "declined", "accepted"],
  published: ["published"],
  declined: ["open"],
};

export default function RequestDecision({ number, status }: { number: number; status: RequestStatus }) {
  const [viewer, setViewer] = useState<RequestViewer | null>(null);
  const [current, setCurrent] = useState(status);
  const [next, setNext] = useState<RequestStatus>(MOVES[status][0]!);
  const [code, setCode] = useState<DeclineCode>("not_osint");
  const [tool, setTool] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<RequestViewer>(`/requests/${number}/viewer`).then(setViewer).catch(() => {});
  }, [number]);

  if (!viewer) return null;

  async function decide(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: RequestStatus }>(`/requests/${number}/status`, { method: "POST", body: JSON.stringify(body) });
      setCurrent(r.status);
      setNext(MOVES[r.status][0]!);
      setSaved(`Saved: the request is now ${REQUEST_STATUS_LABEL[r.status].toLowerCase()}. The page shows it within a minute.`);
      setNote("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setWithdrawing(false);
    }
  }

  function submit(e: Event) {
    e.preventDefault();
    const body: Record<string, string> = { status: next };
    if (next === "declined") body.decline_code = code;
    if (next === "published") body.tool = tool.trim();
    if (note.trim()) body.note = note.trim();
    void decide(body);
  }

  return (
    <div class="stack decision">
      {viewer.held && viewer.is_requester && (
        <div class="notice" role="status">
          <p>Only you can see this request until a moderator has looked at it.</p>
          {viewer.note && <p class="small">Your note: “{viewer.note}”</p>}
        </div>
      )}
      {saved && <p class="notice ok small" role="status">{saved}</p>}
      <ErrorNote error={error} />
      {viewer.can_decide && (
        <form class="card stack" onSubmit={submit}>
          <h3>Decide (triagers)</h3>
          <label for="d-status">Move it to</label>
          <select id="d-status" value={next} onChange={(e) => setNext((e.target as HTMLSelectElement).value as RequestStatus)}>
            {MOVES[current].map((s) => <option value={s}>{s === "published" && current === "published" ? "Published (change the package)" : s === "open" ? "Open (reopen)" : REQUEST_STATUS_LABEL[s]}</option>)}
          </select>
          {next === "declined" && (
            <>
              <label for="d-code">Why</label>
              <select id="d-code" value={code} onChange={(e) => setCode((e.target as HTMLSelectElement).value as DeclineCode)}>
                {TRIAGE_DECLINE_CODES.map((c) => <option value={c}>{DECLINE_LABEL[c]}</option>)}
              </select>
            </>
          )}
          {next === "published" && (
            <>
              <label for="d-tool">The package that answers it</label>
              <input id="d-tool" type="text" required pattern="[a-z0-9-]+/[a-z0-9-]+" placeholder="osintverse-community/tool" value={tool} onInput={(e) => setTool((e.target as HTMLInputElement).value)} />
            </>
          )}
          <label for="d-note">Note for the person who asked <span class="muted">(optional, public)</span></label>
          <textarea id="d-note" rows={2} maxLength={500} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
          <p><button class="btn btn-primary" type="submit" disabled={busy}>Save</button></p>
        </form>
      )}
      {viewer.is_requester && !viewer.can_decide && takesVotes(current) && (
        <p class="small">
          {withdrawing
            ? <Confirm text="Withdraw your request? Someone else can still ask for it again." confirm="Withdraw" onConfirm={() => decide({ status: "declined", decline_code: "withdrawn" })} onCancel={() => setWithdrawing(false)} />
            : <button class="btn btn-sm btn-ghost" type="button" disabled={busy} onClick={() => setWithdrawing(true)}>Withdraw my request</button>}
        </p>
      )}
    </div>
  );
}
