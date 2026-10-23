// "Works for me" on a tool page: a signed-in person says the latest version works on their platform, or goes to
// open a broken issue. Each answer is one count by version and platform, never a rating.
import { useState } from "preact/hooks";
import { api, ApiError, signInUrl } from "../lib/api";
import { guessPlatform } from "../lib/community";

export default function WorksForMe({ refName, version, back }: { refName: string; version: string; back: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "signin" | "error">("idle");
  const [message, setMessage] = useState("");

  async function works() {
    setState("busy");
    try {
      const r = await api<{ works: number }>(`/tools/${refName}/confirmations`, {
        method: "PUT",
        body: JSON.stringify({ result: "works", version, platform: guessPlatform(navigator.userAgent) }),
      });
      setMessage(`Thanks. ${r.works} ${r.works === 1 ? "person says" : "people say"} ${version} works in the last 30 days.`);
      setState("done");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState("signin");
      else {
        setMessage(e instanceof Error ? e.message : "That didn't work.");
        setState("error");
      }
    }
  }

  if (state === "done" || state === "error") return <p class="small muted" role="status">{message}</p>;
  if (state === "signin") return <p class="small muted">Sign in with <a href={signInUrl("github", back)}>GitHub</a>, <a href={signInUrl("gitlab", back)}>GitLab</a> or <a href={signInUrl("osintverse", back)}>OSINTverse</a> to say whether it works for you.</p>;
  return (
    <p class="row small works">
      <span class="muted">Used {version}?</span>
      <button class="btn btn-sm" type="button" disabled={state === "busy"} onClick={works}>It works for me</button>
      <a class="btn btn-sm" href={`/${refName}/issues?kind=broken#new`}>It's broken for me</a>
    </p>
  );
}
