// "Follow releases" on a tool or guide page: a signed-in person gets an inbox item (and an email, as their notification
// settings say) when a new version becomes the latest. Signed-out visitors make no request until they click.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, signInUrl } from "../lib/api";

/** Whether the page has seen this person signed in (Base.astro and useMe remember it for the session). */
function signedIn(): boolean {
  try {
    return !!JSON.parse(sessionStorage.getItem("ot-account") ?? "null")?.login;
  } catch {
    return false;
  }
}

export default function FollowReleases({ refName, back }: { refName: string; back: string }) {
  const [following, setFollowing] = useState<boolean | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "signin" | "error">("idle");

  useEffect(() => {
    if (!signedIn()) return setFollowing(false);
    api<{ following: boolean }>(`/tools/${refName}/follow`).then((r) => setFollowing(r.following), () => setFollowing(false));
  }, [refName]);

  const toggle = async () => {
    setState("busy");
    try {
      const r = await api<{ following: boolean }>(`/tools/${refName}/follow`, { method: following ? "DELETE" : "PUT" });
      setFollowing(r.following);
      setState("idle");
    } catch (e) {
      setState(e instanceof ApiError && e.status === 401 ? "signin" : "error");
    }
  };

  if (following === null) return null;
  if (state === "signin") {
    return <p class="small muted follow">Sign in with <a href={signInUrl("github", back)}>GitHub</a>, <a href={signInUrl("gitlab", back)}>GitLab</a> or <a href={signInUrl("osintverse", back)}>OSINTverse</a> to follow its releases.</p>;
  }
  return (
    <span class="follow">
      <button class="btn btn-sm" type="button" aria-pressed={following} disabled={state === "busy"} onClick={toggle}
        title={following ? "You get a notification for each new version" : "Get a notification for each new version"}>
        {following ? "Following releases" : "Follow releases"}
      </button>
      {state === "error" && <span class="small muted" role="status"> That didn't work; try again.</span>}
    </span>
  );
}
