// Owner controls on /{ns}/{name}/versions: yank or un-yank a version. Shown only to the package's owners.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote } from "./shared";

export default function VersionActions({ refName, versions }: { refName: string; versions: { version: string; status: string }[] }) {
  const [owner, setOwner] = useState(false);
  const [state, setState] = useState(Object.fromEntries(versions.map((v) => [v.version, v.status])));
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ owner: boolean }>(`/tools/${refName}/permissions`).then((p) => setOwner(p.owner), () => setOwner(false));
  }, []);
  if (!owner) return null;

  const toggle = async (version: string) => {
    const yank = state[version] === "published";
    setError(null);
    try {
      await api(`/tools/${refName}/${encodeURIComponent(version)}/${yank ? "yank" : "unyank"}`, { method: "POST", body: "{}" });
      setState({ ...state, [version]: yank ? "yanked" : "published" });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section class="panel stack" aria-labelledby="owner-actions">
      <h2 id="owner-actions">Owner actions</h2>
      <p class="small muted">Yanking hides a version from search and <code>@latest</code>; it stays installable by exact version. Reload to see the table change.</p>
      <ul class="list-plain">
        {versions.filter((v) => state[v.version] === "published" || state[v.version] === "yanked").map((v) => (
          <li class="row">
            <code>{v.version}</code> <span class="small muted">{state[v.version]}</span>
            <button class="btn" type="button" onClick={() => toggle(v.version)}>{state[v.version] === "published" ? "Yank" : "Un-yank"}</button>
          </li>
        ))}
      </ul>
      <ErrorNote error={error} />
    </section>
  );
}
