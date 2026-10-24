// A community package's bump, for its maintainers and reviewers: "Merge and release" when the community bot has
// opened a pull request (a wrapper's pin, or a first-party tool's dependencies), where its release (or a rebuild on a
// newer base image) stands once started, why it failed and "Release again", and in auto mode when it goes out on its
// own, with the switch that lets the registry release this package's updates or not.
import { useEffect, useState } from "preact/hooks";
import { api, type BumpDetail } from "../lib/api";
import { bumpName } from "../lib/format";
import { Confirm, ErrorNote, when } from "./shared";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function BumpRelease({ refName }: { refName: string }) {
  const [data, setData] = useState<BumpDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState<unknown>(null);

  const load = () => api<BumpDetail>(`/packages/${refName}/bump`).then((r) => setData(r.can_release ? r : null), () => {});
  useEffect(() => void load(), [refName]);
  const bump = data?.bump;
  if (!data || !bump || bump.status === "closed") return null;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const release = () => act(async () => {
    const r = await api<{ version: string }>(`/packages/${refName}/pulls/${bump.number}/release`, { method: "POST", body: "{}" });
    setDone(bump.status === "failed"
      ? `Version ${r.version} is being built and scanned again; it is published when the checks pass.`
      : `Merged. Version ${r.version} is being built and scanned; it is published when the checks pass.`);
    await load();
  });
  const setAuto = (enabled: boolean) => act(async () => {
    await api(`/packages/${refName}/auto-release`, { method: "PUT", body: JSON.stringify({ enabled }) });
    await load();
  });

  const link = <a href={bump.url} rel="nofollow noopener">{bumpName(bump)}</a>;
  const releasable = bump.status === "open" || bump.status === "failed";
  return (
    <div class="stack bump small">
      {done && <p class="notice ok" role="status">{done}</p>}
      {!done && bump.status === "open" && (
        <p>
          You maintain this package: {link} is ready.
          {bump.auto_release_at && <> It is released on its own on {day(bump.auto_release_at)}.</>}
        </p>
      )}
      {!done && bump.status === "merged" && (
        <p>{link} {bump.kind === "rebuild" ? "started" : "is merged"}; version {bump.released_version} is being built and scanned{bump.merged_at && <>, started {when(bump.merged_at)}</>}.</p>
      )}
      {!done && bump.status === "failed" && (
        <p class="notice warn">
          <b>The release of {link} failed</b>{bump.error_code && <> (<code>{bump.error_code}</code>)</>}: {bump.error ?? "see the release workflow"}.
          {bump.run_url && <> <a href={bump.run_url} rel="nofollow noopener">The workflow run</a>.</>} Fix it on GitHub, then release it again; it gets a new version.
        </p>
      )}
      {!done && bump.status === "released" && <p>{link} was released as version {bump.released_version}.</p>}
      {releasable && !done && (
        <p class="row">
          {confirming
            ? <Confirm text={bump.status === "failed" ? `Release ${bumpName(bump)} again?` : `Merge and release ${bumpName(bump)}?`}
                confirm={bump.status === "failed" ? "Release again" : "Merge and release"} danger={false} onConfirm={release} onCancel={() => setConfirming(false)} />
            : <button class="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => setConfirming(true)}>{bump.status === "failed" ? "Release again" : "Merge and release"}</button>}
        </p>
      )}
      {data.mode === "auto" && (
        <p class="row">
          <label class="row">
            <input type="checkbox" checked={data.auto_release} disabled={busy} onChange={(e) => setAuto((e.target as HTMLInputElement).checked)} />
            Release this package's pin-only updates (and rebuilds on a newer base image) on their own, a week after the release they update to
          </label>
        </p>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
