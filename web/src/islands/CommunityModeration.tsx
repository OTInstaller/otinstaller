// Community moderation for triagers and staff: posts waiting for review, open flags, and (for admins) who holds the
// triager and reviewer roles. Shown at /community/moderation and as the Admin console's Community tab.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { issueHref } from "../lib/community";
import { ErrorNote, Loading, SignIn, useMe, when } from "./shared";

interface Held { kind: "issue" | "comment"; id: string; title: string | null; body_html: string; hidden_reason: string | null; created_at: number; ref: string; number: number; handle: string | null }
interface Flag { id: string; target_kind: "issue" | "comment"; target_id: string; reason: string; note: string | null; created_at: number; flagger: string }
interface Role { handle: string; login: string; role: string; note: string | null; granted_at: number; granted_by: string | null }

const REASON: Record<string, string> = {
  new_account: "new account", first_post_with_links: "first post with links", redacted: "redacted", moderator: "hidden by a moderator",
};
const why = (r: string | null) => (r ? REASON[r] ?? r.replace(/^screen:/, "looks like: ").replace(/^flagged:/, "flagged: ").replace(/_/g, " ") : "");

function Queue({ staff, onError }: { staff: boolean; onError: (e: unknown) => void }) {
  const [held, setHeld] = useState<Held[] | null>(null);
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    Promise.all([api<{ items: Held[] }>("/moderation/queue?view=held"), api<{ flags: Flag[] }>("/moderation/queue?view=flags")])
      .then(([h, f]) => { setHeld(h.items); setFlags(f.flags); }, onError);
  useEffect(() => void load(), []);
  const act = async (kind: string, id: string, action: string) => {
    setBusy(id);
    try {
      await api(`/moderation/${kind}/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };
  if (!held || !flags) return <Loading what="the moderation queue" />;
  return (
    <div class="stack">
      <h3>Open flags ({flags.length})</h3>
      {flags.length === 0 ? <p class="muted small">No open flags.</p> : (
        <ul class="list-plain stack">
          {flags.map((f) => (
            <li class="card stack">
              <p class="small"><b>{f.reason.replace(/_/g, " ")}</b> on a {f.target_kind} by {f.flagger}, {when(f.created_at)}{f.note && <>: “{f.note}”</>}</p>
              <div class="row">
                <button class="btn btn-sm" type="button" disabled={busy === f.target_id} onClick={() => act(f.target_kind, f.target_id, "hide")}>Hide</button>
                <button class="btn btn-sm" type="button" disabled={busy === f.target_id} onClick={() => act(f.target_kind, f.target_id, "restore")}>Keep it up</button>
                {staff && <button class="btn btn-sm btn-danger" type="button" disabled={busy === f.target_id} onClick={() => act(f.target_kind, f.target_id, "redact")}>Redact</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3>Held and hidden posts ({held.length})</h3>
      {held.length === 0 ? <p class="muted small">Nothing is waiting.</p> : (
        <ul class="list-plain stack">
          {held.map((h) => (
            <li class="card stack">
              <p class="small muted"><a href={issueHref(h.ref, h.number)}>{h.ref} #{h.number}</a> · {h.kind} by {h.handle ?? "deleted account"} · {when(h.created_at)} · {why(h.hidden_reason)}</p>
              {h.title && <p><b>{h.title}</b></p>}
              <div class="prose small" dangerouslySetInnerHTML={{ __html: h.body_html }} />
              <div class="row">
                <button class="btn btn-sm btn-primary" type="button" disabled={busy === h.id} onClick={() => act(h.kind, h.id, "approve")}>Approve</button>
                <button class="btn btn-sm" type="button" disabled={busy === h.id} onClick={() => act(h.kind, h.id, "hide")}>Keep hidden</button>
                {staff && <button class="btn btn-sm btn-danger" type="button" disabled={busy === h.id} onClick={() => act(h.kind, h.id, "redact")}>Redact</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Roles({ onError }: { onError: (e: unknown) => void }) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState("triager");
  const [note, setNote] = useState("");
  const load = () => api<{ roles: Role[] }>("/admin/community/roles").then((r) => setRoles(r.roles), onError);
  useEffect(() => void load(), []);
  const grant = async (e: Event) => {
    e.preventDefault();
    try {
      await api("/admin/community/roles", { method: "POST", body: JSON.stringify({ handle: handle.trim(), role, note }) });
      setHandle("");
      setNote("");
      await load();
    } catch (err) {
      onError(err);
    }
  };
  const revoke = async (r: Role) => {
    try {
      await api(`/admin/community/roles/${encodeURIComponent(r.handle)}/${r.role}`, { method: "DELETE" });
      await load();
    } catch (err) {
      onError(err);
    }
  };
  return (
    <div class="stack">
      <h3>Triagers and reviewers</h3>
      <p class="small muted">Triagers triage any package's issues and moderate posts. Reviewers also approve community submissions. Every grant is audited and needs a reason.</p>
      <form class="row" onSubmit={grant}>
        <input value={handle} onInput={(e) => setHandle((e.target as HTMLInputElement).value)} placeholder="handle" aria-label="Handle" required />
        <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)} aria-label="Role">
          <option value="triager">Triager</option>
          <option value="reviewer">Reviewer</option>
        </select>
        <input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="Why" aria-label="Reason" required />
        <button class="btn btn-sm btn-primary" type="submit">Grant</button>
      </form>
      {!roles ? <Loading what="roles" /> : roles.length === 0 ? <p class="muted small">Nobody yet.</p> : (
        <ul class="list-plain stack">
          {roles.map((r) => (
            <li class="row small"><b>{r.handle}</b> {r.role} · {r.note} · by {r.granted_by ?? "?"} {when(r.granted_at)} <button class="btn btn-sm btn-ghost" type="button" onClick={() => revoke(r)}>Revoke</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The whole panel; `embedded` skips the sign-in checks when the Admin console already did them. */
export default function CommunityModeration({ back, embedded = false }: { back: string; embedded?: boolean }) {
  const me = useMe();
  const [error, setError] = useState<unknown>(null);
  if (me === null) return <Loading what="your account" />;
  if (me === false) return embedded ? null : <SignIn back={back} why="Triagers and staff sign in here to moderate community posts." />;
  const staff = me.admin || me.reviewer;
  if (!staff && !me.community_roles?.includes("triager")) return <p class="notice">This area is for the registry's triagers and staff.</p>;
  return (
    <div class="stack moderation">
      <ErrorNote error={error} />
      <Queue staff={staff} onError={setError} />
      {me.admin && <Roles onError={setError} />}
    </div>
  );
}
