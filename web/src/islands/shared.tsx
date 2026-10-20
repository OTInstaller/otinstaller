// Pieces shared by the signed-in islands.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, signInUrl } from "../lib/api";

export interface Me {
  login: string;
  admin: boolean;
  reviewer: boolean;
  accounts: { provider: "github" | "gitlab"; login: string }[];
  namespaces: { name: string; status: string; verified: number; role: string }[];
}

/** Loads /me; null while loading, false when signed out. */
export function useMe(): Me | null | false {
  const [me, setMe] = useState<Me | null | false>(null);
  useEffect(() => {
    api<Me>("/me").then(setMe).catch((e) => setMe(e instanceof ApiError && e.status === 401 ? false : (console.error(e), false)));
  }, []);
  return me;
}

const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" /></svg>
);
const GitLabIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m23.6 9.6-.03-.09-3.2-8.4a.84.84 0 0 0-1.6.1l-2.2 6.7H7.4L5.2 1.2a.84.84 0 0 0-1.6-.1L.4 9.5l-.03.08a6 6 0 0 0 2 6.9l5.5 4.1 2.7 2 1.7 1.3a1.1 1.1 0 0 0 1.4 0l1.7-1.3 2.7-2 5.5-4.2a6 6 0 0 0 2-6.8z" /></svg>
);

export function SignIn({ back, why }: { back: string; why: string }) {
  return (
    <div class="card stack signin">
      <p>{why}</p>
      <div class="row">
        <a class="btn btn-primary" href={signInUrl("github", back)}><GitHubIcon /> Sign in with GitHub</a>
        <a class="btn" href={signInUrl("gitlab", back)}><GitLabIcon /> Sign in with GitLab</a>
        <a class="btn" href={signInUrl("osintverse", back)}>Sign in with OSINTverse</a>
      </div>
      <p class="small muted">The registry only reads your public repositories and opens pull requests you ask for. Publishing needs a GitHub or GitLab account; you can link one later.</p>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div class="stack" role="status" aria-label={`Loading ${what}`}>
      <span class="skeleton" />
      <span class="skeleton" />
      <span class="skeleton" />
      <span class="sr-only">Loading {what}…</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div class="notice bad" role="alert">
      <p>{e.message ?? String(error)}{e.hint && <> ({e.hint})</>}</p>
      {e.problems && e.problems.length > 0 && (
        <ul>{e.problems.map((p) => <li><code>{p.code}</code>{p.path && <> at <code>{p.path}</code></>}: {p.message}</li>)}</ul>
      )}
    </div>
  );
}

export const STATUS_CLASS: Record<string, string> = {
  published: "ok", active: "ok", ok: "ok", finished: "ok", ready: "ok",
  scanning: "info", validating: "info", queued: "info", detecting: "info", draft: "info", awaiting_review: "warn", pending_review: "warn",
  rejected: "bad", error: "bad", failed: "bad", suspended: "bad", unavailable: "bad",
};

export function Status({ value }: { value: string }) {
  return <span class={`badge ${STATUS_CLASS[value] ?? ""}`}>{value.replace(/_/g, " ")}</span>;
}

export function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never";
}
