// The admin console's Upstream tab: what the nightly upstream watcher found for each community wrapper (current,
// behind, archived, gone, relicensed, unknown), each wrapper's latest bump pull request and where its release stands, a
// check-now button, and for admins a pin override when the watcher can't read the pin from the Dockerfile.
import { useEffect, useState } from "preact/hooks";
import { api, type BumpDetail, type UpstreamMode } from "../lib/api";
import { ErrorNote, Loading, when } from "./shared";

interface Watch {
  ref: string; upstream: string | null; state: string; pinned: string | null; latest: string | null; latest_at: number | null; commits_behind: number | null;
  checked_at: number | null; pin_kind: string | null; upstream_license: string | null; error: string | null; override: { pin_kind: string; pinned: string } | null;
  provider: "github" | "gitlab" | null; auto_release: boolean; bump: NonNullable<BumpDetail["bump"]> | null;
}

const BUMPS = ["", "open", "merged", "failed", "released", "closed"];
const BUMP_TONE: Record<string, string> = { open: "plain", merged: "plain", released: "ok", failed: "bad", closed: "plain" };
// What each UPSTREAM_WATCH mode does, and what the next step would add.
const MODE_TEXT: Record<UpstreamMode, string> = {
  report: "it records what it finds; set UPSTREAM_WATCH=issues to have it open and close outdated issues",
  issues: "it also opens and closes outdated issues; UPSTREAM_WATCH=prs also has the community bot open bump pull requests",
  prs: "it also opens bump pull requests, which maintainers release; UPSTREAM_WATCH=auto also releases pin-only bumps on their own",
  auto: "it also opens bump pull requests and releases pin-only ones on their own a week after upstream's release, unless a package's maintainers turned that off",
};

const STATES = ["", "behind", "unknown", "error", "archived", "gone", "renamed", "license_changed", "current"];
const TONE: Record<string, string> = { current: "ok", behind: "warn", unknown: "plain", error: "bad", archived: "bad", gone: "bad", renamed: "warn", license_changed: "bad" };

export default function UpstreamWatch({ admin }: { admin: boolean }) {
  const [state, setState] = useState("behind");
  const [bumpFilter, setBumpFilter] = useState("");
  const [data, setData] = useState<{ mode: UpstreamMode; watches: Watch[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    const q = new URLSearchParams();
    if (state) q.set("state", state);
    if (bumpFilter) q.set("bump", bumpFilter);
    return api<{ mode: UpstreamMode; watches: Watch[] }>(`/admin/upstream${q.size ? `?${q}` : ""}`).then(setData, setError);
  };
  useEffect(() => void load(), [state, bumpFilter]);

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
        The watcher checks every community wrapper nightly. Mode: <b>{data?.mode ?? "…"}</b>{data && <> ({MODE_TEXT[data.mode]})</>}.
      </p>
      <div class="row">
        <label for="uw-state" class="small">Show</label>
        <select id="uw-state" value={state} onChange={(e) => setState((e.target as HTMLSelectElement).value)}>
          {STATES.map((s) => <option value={s}>{s ? s.replace(/_/g, " ") : "all"}</option>)}
        </select>
        <label for="uw-bump" class="small">Latest bump</label>
        <select id="uw-bump" value={bumpFilter} onChange={(e) => setBumpFilter((e.target as HTMLSelectElement).value)}>
          {BUMPS.map((s) => <option value={s}>{s || "any"}</option>)}
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
                {w.upstream && <a class="small" href={`https://${w.provider === "gitlab" ? "gitlab.com" : "github.com"}/${w.upstream}`} rel="nofollow noopener">{w.upstream}</a>}
              </p>
              <p class="small">
                Pins <code>{w.pinned ?? "?"}</code>{w.pin_kind && <span class="muted"> ({w.override ? "override" : w.pin_kind})</span>}; upstream <code>{w.latest ?? "?"}</code>
                {w.latest_at && <span class="muted"> from {when(w.latest_at)}</span>}{w.commits_behind ? <span class="muted">, {w.commits_behind} commits on</span> : null}
                {w.upstream_license && <span class="muted"> · {w.upstream_license}</span>}
              </p>
              {w.error && <p class="small muted">{w.error}</p>}
              {w.bump && (
                <p class="small row">
                  <span class={`badge ${BUMP_TONE[w.bump.status] ?? "plain"}`}>bump {w.bump.status}</span>
                  <a href={w.bump.url} rel="nofollow noopener">#{w.bump.number} to {w.bump.version}</a>
                  {w.bump.released_version && <span class="muted">as {w.bump.released_version}</span>}
                  {w.bump.auto && <span class="muted">released on its own</span>}
                  {w.bump.status === "failed" && <span>{w.bump.error_code}: {w.bump.error}{w.bump.run_url && <> (<a href={w.bump.run_url} rel="nofollow noopener">run</a>)</>}</span>}
                  {!w.auto_release && <span class="muted">auto-release off</span>}
                </p>
              )}
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
