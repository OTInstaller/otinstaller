// What a signed-in person can do on a tool request's discussion: reply, follow it, see their replies waiting for a
// moderator, and (triagers and staff) lock it. The replies above are server-rendered and cached for a minute, so a new
// reply shows here at once and on the page shortly after.
import { useEffect, useState } from "preact/hooks";
import { api, type RequestViewer } from "../lib/api";
import { requestViewer } from "../lib/requests";
import { ErrorNote, Loading, SignIn, useMe } from "./shared";

export default function RequestThread({ number, back }: { number: number; back: string }) {
  const me = useMe();
  const [viewer, setViewer] = useState<RequestViewer | null>(null);
  const [reply, setReply] = useState("");
  const [posted, setPosted] = useState<{ id: string; html: string; held: boolean }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const base = `/requests/${number}`;

  useEffect(() => {
    if (me) void requestViewer(number).then(setViewer);
  }, [me]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <div class="thread-actions"><SignIn back={back} why="Sign in to reply to this request or follow it." /></div>;
  if (!viewer) return <Loading what="the discussion" />;
  if (viewer.held) return null;

  /** Runs one change and shows what happened. */
  const run = async (fn: () => Promise<void>, message: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote(message);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const send = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const out = await api<{ id: string; moderation: string; body_html: string }>(`${base}/comments`, { method: "POST", body: JSON.stringify({ body: reply }) });
      setPosted((p) => [...p, { id: out.id, html: out.body_html, held: out.moderation === "held" }]);
      setReply("");
      setViewer({ ...viewer, subscribed: true });
    }, null);
  };
  const follow = () =>
    run(async () => {
      await api(`${base}/subscription`, { method: viewer.subscribed ? "DELETE" : "PUT" });
      setViewer({ ...viewer, subscribed: !viewer.subscribed });
    }, viewer.subscribed ? "You no longer follow this request." : "You follow this request now: replies and decisions reach your inbox.");
  const lock = () =>
    run(async () => {
      await api(`${base}/lock`, { method: "POST", body: JSON.stringify({ locked: !viewer.locked }) });
      setViewer({ ...viewer, locked: !viewer.locked, can_reply: true });
    }, viewer.locked ? "Replies are open again." : "Locked: only triagers and staff can reply now. The page shows it within a minute.");

  return (
    <section class="thread-actions stack" aria-label="Take part in the discussion">
      {[...viewer.held_comments.map((h) => ({ id: h.id, html: h.body_html, held: true })), ...posted].map((p) => (
        <div class="post mine">
          <p class="small muted">{p.held ? "Your reply, waiting for a moderator: new accounts, first posts with links, and anything that looks like personal data or a secret are checked first." : "Your reply"}</p>
          <div class="prose" dangerouslySetInnerHTML={{ __html: p.html }} />
        </div>
      ))}
      <div class="row">
        <button class="btn btn-sm" type="button" disabled={busy} onClick={follow}>{viewer.subscribed ? "Stop following" : "Follow"}</button>
        {viewer.can_decide && <button class="btn btn-sm" type="button" disabled={busy} onClick={lock}>{viewer.locked ? "Unlock replies" : "Lock replies"}</button>}
      </div>
      {viewer.can_reply ? (
        <form class="stack" onSubmit={send}>
          <label for="request-reply">Reply</label>
          <textarea id="request-reply" rows={4} value={reply} onInput={(e) => setReply((e.target as HTMLTextAreaElement).value)} required minLength={2} maxLength={8000}
            placeholder="Why it's worth packaging, how you'd use it, or what to watch out for. Markdown works." />
          <div class="row">
            <button class="btn btn-primary" type="submit" disabled={busy}>Reply</button>
            <span class="small muted">As {me.handle ?? me.login}. <a href="/policy/community">Community guidelines</a></span>
          </div>
        </form>
      ) : <p class="small muted">Replies to this request are closed.</p>}
      {note && <p class="notice" role="status">{note}</p>}
      <ErrorNote error={error} />
    </section>
  );
}
