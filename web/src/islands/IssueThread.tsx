// What a signed-in person can do on an issue: reply, say they have the same problem, follow the thread, close their
// own issue as fixed, and (for maintainers, triagers and staff) triage and lock it. The thread above is
// server-rendered and cached for a minute, so changes show here at once and on the page shortly after.
import { useEffect, useState } from "preact/hooks";
import { api, type IssueKind, type IssueStatus, type IssueViewer } from "../lib/api";
import { guessPlatform, STATUS_LABEL } from "../lib/community";
import { ErrorNote, Loading, SignIn, useMe } from "./shared";

interface Props {
  refName: string;
  number: number;
  kind: IssueKind;
  status: IssueStatus;
  locked: boolean;
  version: string;
  back: string;
}

const LATER = "Saved. The page shows it to everyone within a minute.";

export default function IssueThread({ refName, number, kind, status: initialStatus, locked: initialLocked, version, back }: Props) {
  const me = useMe();
  const [viewer, setViewer] = useState<IssueViewer | null>(null);
  const [reply, setReply] = useState("");
  const [posted, setPosted] = useState<{ id: string; html: string; held: boolean }[]>([]);
  const [status, setStatus] = useState<IssueStatus>(initialStatus);
  const [locked, setLocked] = useState(initialLocked);
  const [next, setNext] = useState<IssueStatus>(initialStatus);
  const [extra, setExtra] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const base = `/tools/${refName}/issues/${number}`;

  useEffect(() => {
    if (me) api<IssueViewer>(`${base}/viewer`).then(setViewer, setError);
  }, [me]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <div class="thread-actions"><SignIn back={back} why="Sign in to reply, say you have the same problem, or follow this issue." /></div>;
  if (!viewer) return <ErrorNote error={error} />;

  /** Runs one change; `after` updates what this island shows. */
  const run = async (fn: () => Promise<unknown>, after: () => void, message = LATER) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
      setNote(message);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const send = (e: Event) => {
    e.preventDefault();
    let out: { id: string; moderation: string; body_html: string } | null = null;
    void run(
      async () => (out = await api(`${base}/comments`, { method: "POST", body: JSON.stringify({ body: reply }) })),
      () => {
        setPosted((p) => [...p, { id: out!.id, html: out!.body_html, held: out!.moderation === "held" }]);
        setReply("");
      },
      "",
    ).then(() => setNote(null));
  };
  const meToo = () =>
    run(() => api(`/tools/${refName}/confirmations`, { method: "PUT", body: JSON.stringify({ result: "broken", version, platform: guessPlatform(navigator.userAgent), issue: number }) }),
      () => {}, "Thanks. You're counted, and you'll follow this issue.");
  const follow = () =>
    run(() => api(`${base}/subscription`, { method: viewer.subscribed ? "DELETE" : "PUT" }), () => setViewer({ ...viewer, subscribed: !viewer.subscribed }),
      viewer.subscribed ? "You no longer follow this issue." : "You follow this issue now.");
  const changeStatus = (s: IssueStatus, body: Record<string, unknown> = {}) =>
    run(() => api(`${base}/status`, { method: "POST", body: JSON.stringify({ status: s, ...body }) }), () => setStatus(s), `Status set to ${STATUS_LABEL[s].toLowerCase()}. ${LATER}`);
  const toggleLock = () =>
    run(() => api(`${base}/lock`, { method: "POST", body: JSON.stringify({ locked: !locked }) }), () => setLocked(!locked));
  const canReply = !locked || viewer.can_triage;
  const open = status === "open" || status === "confirmed";

  return (
    <section class="thread-actions stack" aria-label="Take part">
      {[...viewer.held_comments.map((h) => ({ id: h.id, html: h.body_html, held: true })), ...posted].map((p) => (
        <div class="post mine">
          <p class="small muted">{p.held ? "Your reply, waiting for a moderator: new accounts, first posts with links, and anything that looks like personal data or a secret are checked first." : "Your reply"}</p>
          <div class="prose" dangerouslySetInnerHTML={{ __html: p.html }} />
        </div>
      ))}
      <div class="row">
        {kind === "broken" && open && !viewer.is_author && <button class="btn btn-sm" type="button" disabled={busy} onClick={meToo}>I have this problem too</button>}
        <button class="btn btn-sm" type="button" disabled={busy} onClick={follow}>{viewer.subscribed ? "Stop following" : "Follow"}</button>
        {viewer.is_author && open && <button class="btn btn-sm" type="button" disabled={busy} onClick={() => changeStatus("fixed")}>It's fixed for me</button>}
      </div>
      {canReply ? (
        <form class="stack" onSubmit={send}>
          <label for="reply">Reply</label>
          <textarea id="reply" rows={5} value={reply} onInput={(e) => setReply((e.target as HTMLTextAreaElement).value)} required minLength={2} maxLength={8000}
            placeholder="Markdown works. Never post personal data about anyone you investigate." />
          <div class="row">
            <button class="btn btn-primary" type="submit" disabled={busy}>Reply</button>
            <span class="small muted">As {me.handle ?? me.login}. <a href="/policy/community">Community guidelines</a></span>
          </div>
        </form>
      ) : <p class="small muted">This thread is locked. Open a new issue if something has changed.</p>}
      {viewer.can_triage && (
        <details class="triage">
          <summary>Triage</summary>
          <div class="row">
            <select value={next} onChange={(e) => setNext((e.target as HTMLSelectElement).value as IssueStatus)} aria-label="Status">
              {(Object.keys(STATUS_LABEL) as IssueStatus[]).map((s) => <option value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            {(next === "duplicate" || next === "fixed") && (
              <input value={extra} onInput={(e) => setExtra((e.target as HTMLInputElement).value)} placeholder={next === "duplicate" ? "Duplicate of #" : "Fixed in version"}
                aria-label={next === "duplicate" ? "Duplicate of issue number" : "Fixed in version"} />
            )}
            <button class="btn btn-sm" type="button" disabled={busy || (next === status && !extra)}
              onClick={() => changeStatus(next, next === "duplicate" ? { duplicate_of: Number(extra.replace(/^#/, "")) } : next === "fixed" && extra ? { fixed_in: extra } : {})}>Set status</button>
            <button class="btn btn-sm" type="button" disabled={busy} onClick={toggleLock}>{locked ? "Unlock" : "Lock"}</button>
          </div>
        </details>
      )}
      {note && <p class="notice" role="status">{note}</p>}
      <ErrorNote error={error} />
    </section>
  );
}
