// The feedback form on /feedback. Anyone can send it; a signed-in sender is linked to their account.
import { useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote } from "./shared";

const KINDS: [string, string][] = [
  ["bug", "Something is broken"],
  ["idea", "An idea or a missing feature"],
  ["question", "A question"],
  ["other", "Something else"],
];

export default function FeedbackForm({ page, issuesUrl }: { page?: string; issuesUrl: string }) {
  const [kind, setKind] = useState("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ note: string }>("/feedback", { method: "POST", body: JSON.stringify({ kind, message, email, page, source: "web" }) });
      setDone(r.note);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p class="notice ok" role="status">{done}</p>;
  return (
    <form class="stack" onSubmit={submit}>
      <fieldset class="stack">
        <legend>What is it about?</legend>
        {KINDS.map(([value, label]) => (
          <label class="row"><input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} /> {label}</label>
        ))}
      </fieldset>
      <label for="fb-message">Your message</label>
      <textarea id="fb-message" rows={7} value={message} required minLength={3} maxLength={5000} onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
        placeholder={kind === "bug" ? "What did you do, what did you expect, and what happened? Include the ot command and its output if there was one." : "Tell us what you think."} />
      {kind === "bug" && <p class="small muted">If it stops you from installing, running or publishing, please also <a href={issuesUrl}>open a bug report</a> so we can track it.</p>}
      <label for="fb-email">Email for a reply (optional)</label>
      <input id="fb-email" type="email" value={email} maxLength={200} autoComplete="email" onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
      <ErrorNote error={error} />
      <div class="row">
        <button class="btn btn-primary" type="submit" disabled={busy || message.trim().length < 3}>{busy ? "Sending…" : "Send feedback"}</button>
        <span class="small muted">Or from the terminal: <code>ot feedback "…"</code></span>
      </div>
    </form>
  );
}
