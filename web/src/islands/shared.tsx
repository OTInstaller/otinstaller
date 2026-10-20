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

export function SignIn({ back, why }: { back: string; why: string }) {
  return (
    <div class="card stack">
      <p>{why}</p>
      <div class="row">
        <a class="btn btn-primary" href={signInUrl("github", back)}>Sign in with GitHub</a>
        <a class="btn" href={signInUrl("gitlab", back)}>Sign in with GitLab</a>
      </div>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p class="muted" role="status">Loading {what}…</p>;
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
