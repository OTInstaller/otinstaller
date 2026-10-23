// The vote button on a tool request: one vote per signed-in person, which they can take back. On lists it starts
// from the server's count; on a request's own page it asks whether this person voted already.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, signInUrl, type RequestViewer } from "../lib/api";

export default function RequestVote({ number, votes, checkViewer = false }: { number: number; votes: number; checkViewer?: boolean }) {
  const [count, setCount] = useState(votes);
  const [voted, setVoted] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "signin" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!checkViewer) return;
    api<RequestViewer>(`/requests/${number}/viewer`).then((v) => setVoted(v.voted)).catch(() => {});
  }, [number, checkViewer]);

  async function toggle() {
    setState("busy");
    try {
      const r = await api<{ votes: number; voted: boolean }>(`/requests/${number}/vote`, { method: voted ? "DELETE" : "PUT" });
      setCount(r.votes);
      setVoted(r.voted);
      setState("idle");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState("signin");
      else {
        setMessage(e instanceof Error ? e.message : "That didn't work.");
        setState("error");
      }
    }
  }

  if (state === "signin") {
    const back = typeof location === "undefined" ? "/requests" : location.pathname;
    return <p class="small muted vote-signin">{count} · <a href={signInUrl("github", back)}>Sign in</a> to vote</p>;
  }
  return (
    <span class="vote">
      <button class={`btn btn-sm${voted ? " btn-primary" : ""}`} type="button" aria-pressed={voted} disabled={state === "busy"} onClick={toggle}
        aria-label={`${voted ? "Take back your vote" : "Vote for this request"} (${count} ${count === 1 ? "vote" : "votes"})`}>
        <span aria-hidden="true">▲</span> {count}
      </button>
      {state === "error" && <span class="small muted" role="status">{message}</span>}
    </span>
  );
}
