// "Follow" buttons: a tool's releases (on its page), a publisher's releases and new packages (on its profile), or new
// tools for an input type (on its page). A signed-in person gets an inbox item, and an email as their notification
// settings say. Signed-out visitors make no request until they click.
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

/** What can be followed: a package's releases, a publisher's releases and new packages, or new tools for an input type. */
type Kind = "package" | "publisher" | "input";

const WORDS: Record<Kind, { off: string; on: string; title: string; signin: string }> = {
  package: { off: "Follow releases", on: "Following releases", title: "a notification for each new version", signin: "follow its releases" },
  publisher: { off: "Follow publisher", on: "Following publisher", title: "a notification for each new version and new package", signin: "follow this publisher" },
  input: { off: "Follow new tools", on: "Following new tools", title: "a notification for each new tool or guide that takes this", signin: "hear about new tools for it" },
};

export default function FollowReleases({ refName, kind = "package", back }: { refName: string; kind?: Kind; back: string }) {
  const [following, setFollowing] = useState<boolean | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "signin" | "error">("idle");
  const path = kind === "package" ? `/tools/${refName}/follow` : `/me/follows/${kind}/${encodeURIComponent(refName)}`;
  const w = WORDS[kind];

  useEffect(() => {
    if (!signedIn()) return setFollowing(false);
    api<{ following: boolean }>(path).then((r) => setFollowing(r.following), () => setFollowing(false));
  }, [path]);

  const toggle = async () => {
    setState("busy");
    try {
      const r = await api<{ following: boolean }>(path, { method: following ? "DELETE" : "PUT" });
      setFollowing(r.following);
      setState("idle");
    } catch (e) {
      setState(e instanceof ApiError && e.status === 401 ? "signin" : "error");
    }
  };

  if (following === null) return null;
  if (state === "signin") {
    return <p class="small muted follow">Sign in with <a href={signInUrl("github", back)}>GitHub</a>, <a href={signInUrl("gitlab", back)}>GitLab</a> or <a href={signInUrl("osintverse", back)}>OSINTverse</a> to {w.signin}.</p>;
  }
  return (
    <span class="follow">
      <button class="btn btn-sm" type="button" aria-pressed={following} disabled={state === "busy"} onClick={toggle}
        title={following ? `You get ${w.title}` : `Get ${w.title}`}>
        {following ? w.on : w.off}
      </button>
      {state === "error" && <span class="small muted" role="status"> That didn't work; try again.</span>}
    </span>
  );
}
