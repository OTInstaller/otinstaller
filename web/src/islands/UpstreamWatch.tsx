// The admin console's Upstream tab: what the nightly upstream watcher found for each community wrapper (current,
// behind, archived, gone, relicensed, unknown), a check-now button, and for admins a pin override when the watcher
// can't read the pin from the Dockerfile.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, when } from "./shared";

interface Watch {
  ref: string; upstream: string | null; state: string; pinned: string | null; latest: string | null; latest_at: number | null; commits_behind: number | null;
  checked_at: number | null; pin_kind: string | null; upstream_license: string | null; error: string | null; override: { pin_kind: string; pinned: string } | null;
}

const STATES = ["", "behind", "unknown", "error", "archived", "gone", "renamed", "license_changed", "current"];
const TONE: Record<string, string> = { current: "ok", behind: "warn", unknown: "plain", error: "bad", archived: "bad", gone: "bad", renamed: "warn", license_changed: "bad" };

export default function UpstreamWatch({ admin }: { admin: boolean }) {
  const [state, setState] = useState("behind");
  const [data, setData] = useState<{ mode: string; watches: Watch[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const load = () => api<{ mode: string; watches: Watch[] }>(`/admin/upstream${state ? `?state=${state}` : ""}`).then(setData, setError);
  useEffect(() => void load(), [state]);

  const run = async (ref: string, fn: () => Promise<unknown>) => {
    setBusy(ref);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="stack">
      <p class="small muted">
        The watcher checks every community wrapper nightly. Mode: <b>{data?.mode ?? "…"}</b>{data?.mode === "report" ? " (it records what it finds; set UPSTREAM_WATCH=issues to have it open and close outdated issues)" : " (it also opens and closes outdated issues)"}.
      </p>
      <div class="row">
        <label for="uw-state" class="small">Show</label>
        <select id="uw-state" value={state} onChange={(e) => setState((e.target as HTMLSelectElement).value)}>
          {STATES.map((s) => <option value={s}>{s ? s.replace(/_/g, " ") : "all"}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading what="the upstream watcher" /> : data.watches.length === 0 ? <p class="muted small">Nothing here.</p> : (
        <ul class="list-plain stack">
          {data.watches.map((w) => (
            <li class="card stack">
              <p class="row">
                <a href={`/${w.ref}`}><b>{w.ref}</b></a>
                <span class={`badge ${TONE[w.state] ?? "plain"}`}>{w.state.replace(/_/g, " ")}</span>
                {w.upstream && <a class="small" href={`https://github.com/${w.upstream}`} rel="nofollow noopener">{w.upstream}</a>}
              </p>
              <p class="small">
                Pins <code>{w.pinned ?? "?"}</code>{w.pin_kind && <span class="muted"> ({w.override ? "override" : w.pin_kind})</span>}; upstream <code>{w.latest ?? "?"}</code>
                {w.latest_at && <span class="muted"> from {when(w.latest_at)}</span>}{w.commits_behind ? <span class="muted">, {w.commits_behind} commits on</span> : null}
                {w.upstream_license && <span class="muted"> · {w.upstream_license}</span>}
              </p>
              {w.error && <p class="small muted">{w.error}</p>}
              <p class="row small">
                <span class="muted">Checked {when(w.checked_at)}</span>
                <button class="btn btn-sm" type="button" disabled={busy === w.ref} onClick={() => run(w.ref, () => api(`/admin/upstream/${w.ref}/check`, { method: "POST", body: "{}" }))}>Check now</button>
                {admin && (
                  <>
                    <label class="sr-only" for={`pin-${w.ref}`}>Pinned release for {w.ref}</label>
                    <input id={`pin-${w.ref}`} type="text" placeholder="pinned release, e.g. 1.2.3" value={pins[w.ref] ?? ""} onInput={(e) => setPins({ ...pins, [w.ref]: (e.target as HTMLInputElement).value })} />
                    <button class="btn btn-sm" type="button" disabled={busy === w.ref || !(pins[w.ref] ?? "").trim()}
                      onClick={() => run(w.ref, () => api(`/admin/upstream/${w.ref}`, { method: "PUT", body: JSON.stringify({ pinned: pins[w.ref]!.trim(), pin_kind: "override" }) }))}>Set the pin</button>
                    {w.override && <button class="btn btn-sm btn-ghost" type="button" disabled={busy === w.ref} onClick={() => run(w.ref, () => api(`/admin/upstream/${w.ref}`, { method: "PUT", body: JSON.stringify({ clear: true }) }))}>Clear the override</button>}
                  </>
                )}
                {["archived", "gone", "license_changed"].includes(w.state) && <a class="btn btn-sm btn-ghost" href={`/dashboard/${w.ref}`}>Deprecate or take down</a>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
