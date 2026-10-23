// Pieces shared by the signed-in islands.
import { useEffect, useState } from "preact/hooks";
import { api, API_URL, ApiError, signInUrl } from "../lib/api";
import { hintParts } from "../lib/format";

export interface Me {
  login: string;
  /** The public name on issues and comments; older API answers omit it. */
  handle?: string;
  admin: boolean;
  reviewer: boolean;
  /** triager and reviewer roles staff granted (staff hold both); older API answers omit it. */
  community_roles?: ("triager" | "reviewer")[];
  /** Whether the person hid their contributor profile; older API answers omit it. */
  profile_hidden?: boolean;
  accounts: { provider: "github" | "gitlab" | "osintverse"; login: string }[];
  namespaces: { name: string; status: string; verified: number; role: string }[];
}

/** Keeps the header's account menu and Admin link (see Base.astro) in step with what /me just said. */
export function rememberStaff(staff: boolean, login: string | null = null) {
  try {
    sessionStorage.setItem("ot-account", JSON.stringify({ login, staff, at: Date.now() }));
  } catch {
    // Storage unavailable: the header asks again on the next page.
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-staff]")) el.hidden = !staff;
  for (const el of document.querySelectorAll<HTMLElement>("[data-signin]")) el.hidden = !!login;
  for (const el of document.querySelectorAll<HTMLElement>("[data-account]")) el.hidden = !login;
  for (const el of document.querySelectorAll<HTMLElement>("[data-login]")) el.textContent = login ?? "";
}

/** Loads /me; null while loading, false when signed out. */
export function useMe(): Me | null | false {
  const [me, setMe] = useState<Me | null | false>(null);
  useEffect(() => {
    api<Me>("/me").then((m) => { rememberStaff(m.admin || m.reviewer, m.login); setMe(m); })
      .catch((e) => { if (e instanceof ApiError && e.status === 401) rememberStaff(false); setMe(e instanceof ApiError && e.status === 401 ? false : (console.error(e), false)); });
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
      <p class="small muted">The registry only reads your public repositories and opens pull requests you ask for. Any account can publish: from GitHub or GitLab, or directly with <code>ot publish</code>.</p>
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

/** A hint with its links clickable; sign-in links (e.g. "sign in again at …?scope=api") come back to this page. */
function Hint({ text }: { text: string }) {
  const here = typeof location === "undefined" ? undefined : location.href;
  return <>{hintParts(text, API_URL, here).map((p) => (typeof p === "string" ? p : <a href={p.href}>{p.label}</a>))}</>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div class="notice bad" role="alert">
      <p>{e.message ?? String(error)}{e.hint && <> (<Hint text={e.hint} />)</>}</p>
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

/** An inline confirmation in place of window.confirm: a sentence and two buttons. */
export function Confirm({ text, confirm, onConfirm, onCancel, danger = true }: { text: string; confirm: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  return (
    <span class="confirm" role="group">
      <span class="small">{text}</span>
      <button class={`btn btn-sm${danger ? " btn-strong" : " btn-primary"}`} type="button" onClick={onConfirm}>{confirm}</button>
      <button class="btn btn-sm btn-ghost" type="button" onClick={onCancel}>Cancel</button>
    </span>
  );
}

export function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never";
}
