// Asking for a tool to be packaged: a repository URL and an optional note. The API checks the repository; this shows
// what it found, and offers a vote when someone asked for the same repository already.
import { useState } from "preact/hooks";
import { api, ApiError, type ToolRequestDetail } from "../lib/api";
import { ErrorNote, SignIn, useMe } from "./shared";

type Made = { request: ToolRequestDetail; held: boolean; notes: string[]; url: string };

export default function RequestForm() {
  const me = useMe();
  const [repo, setRepo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [existing, setExisting] = useState<{ number: number; voted: boolean } | null>(null);
  const [packaged, setPackaged] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (me === null) return null;
  if (me === false) return <SignIn back="/requests" why="Sign in to ask for a tool, or to vote for one someone else asked for." />;

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setExisting(null);
    setPackaged(null);
    try {
      setMade(await api<Made>("/requests", { method: "POST", body: JSON.stringify({ repo, note }) }));
      setRepo("");
      setNote("");
    } catch (err) {
      const extra = err instanceof ApiError ? err.extra : undefined;
      if (err instanceof ApiError && err.code === "request_exists" && typeof extra?.number === "number") setExisting({ number: extra.number, voted: false });
      else if (err instanceof ApiError && err.code === "already_in_registry" && typeof extra?.ref === "string") setPackaged(extra.ref);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function voteExisting() {
    if (!existing) return;
    setBusy(true);
    try {
      await api(`/requests/${existing.number}/vote`, { method: "PUT" });
      setExisting({ ...existing, voted: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="stack request-form" onSubmit={submit}>
      <label for="r-repo">Repository</label>
      <input id="r-repo" type="url" required placeholder="https://github.com/owner/tool" value={repo} onInput={(e) => setRepo((e.target as HTMLInputElement).value)} />
      <label for="r-note">Why it's worth packaging <span class="muted">(optional)</span></label>
      <textarea id="r-note" rows={3} maxLength={500} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        placeholder="What it finds, and what you'd use it with. Never personal data about anyone." />
      <p><button class="btn btn-primary" type="submit" disabled={busy || !repo.trim()}>Ask for it</button></p>
      <p class="small muted">Five a day. The registry checks the license, and that nobody has packaged or asked for it yet.</p>
      <ErrorNote error={error} />
      {existing && (
        <div class="notice" role="status">
          <p>Someone asked for this already: <a href={`/requests/${existing.number}`}>request #{existing.number}</a>.</p>
          {existing.voted
            ? <p class="small">Your vote is in.</p>
            : <p><button class="btn btn-sm" type="button" disabled={busy} onClick={voteExisting}>Vote for #{existing.number}</button></p>}
        </div>
      )}
      {packaged && (
        <p class="notice" role="status">It's in the registry already as <a href={`/${packaged}`}>{packaged}</a>. If it's broken or out of date, open an issue there.</p>
      )}
      {made && (
        <div class={`notice ${made.request.status === "declined" ? "" : "ok"}`} role="status">
          <p>
            {made.request.status === "declined" ? "Recorded, and declined:" : made.held ? "Thanks. A moderator will look at it first:" : "Thanks. Others can vote for it now:"}
            {" "}<a href={`/requests/${made.request.number}`}>{made.request.repo} (#{made.request.number})</a>
          </p>
          {made.notes.length > 0 && <ul class="small">{made.notes.map((n) => <li>{n}</li>)}</ul>}
        </div>
      )}
    </form>
  );
}
