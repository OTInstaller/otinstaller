// "Merge and release" on a community package's page: for its maintainers and reviewers, when the community bot has
// opened a pull request bumping the pinned upstream release. The registry merges it and starts the release.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { Confirm, ErrorNote } from "./shared";

export default function BumpRelease({ refName }: { refName: string }) {
  const [bump, setBump] = useState<{ version: string; number: number; url: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ bump: { version: string; number: number; url: string } | null; can_release: boolean }>(`/packages/${refName}/bump`)
      .then((r) => setBump(r.can_release ? r.bump : null), () => {});
  }, [refName]);
  if (!bump) return null;

  const release = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ version: string }>(`/packages/${refName}/pulls/${bump.number}/release`, { method: "POST", body: "{}" });
      setDone(`Merged. Version ${r.version} is being built and scanned; it is published when the checks pass.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div class="stack bump small">
      {done ? <p class="notice ok" role="status">{done}</p> : (
        <p class="row">
          <span>You maintain this package: <a href={bump.url} rel="nofollow noopener">the bump to {bump.version}</a> is ready.</span>
          {confirming
            ? <Confirm text={`Merge it and release ${bump.version}?`} confirm="Merge and release" danger={false} onConfirm={release} onCancel={() => setConfirming(false)} />
            : <button class="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => setConfirming(true)}>Merge and release</button>}
        </p>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
