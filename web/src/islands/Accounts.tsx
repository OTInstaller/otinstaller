// /settings/accounts: linked GitHub, GitLab and OSINTverse accounts, and the sync status of each package I publish.
import { useEffect, useState } from "preact/hooks";
import { api, signInUrl } from "../lib/api";
import type { Namespace } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe, when } from "./shared";

interface SyncLog {
  source: { provider: string; url: string; sync_status: string; last_error: string | null; last_event_at: number | null; last_poll_at: number | null; manifest_mode: string };
  events: { kind: string; summary: string; status: string; error: string | null; received_at: number }[];
}

type Provider = "github" | "gitlab" | "osintverse";
const PROVIDER_NAMES: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab", osintverse: "OSINTverse" };

export default function Accounts({ back }: { back: string }) {
  const me = useMe();
  const [packages, setPackages] = useState<{ ref: string; log: SyncLog | null }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async (names: string[]) => {
    const refs = (await Promise.all(names.map((n) => api<Namespace>(`/namespaces/${n}`).catch(() => null))))
      .flatMap((n) => n?.tools.map((t) => `${t.namespace}/${t.name}`) ?? []);
    setPackages(await Promise.all(refs.map(async (ref) => ({ ref, log: await api<SyncLog>(`/packages/${ref}/sync-log`).catch(() => null) }))));
  };
  useEffect(() => {
    if (me) load(me.namespaces.map((n) => n.name)).catch(setError);
  }, [me]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to manage linked accounts." />;

  const linked = (p: Provider) => me.accounts.find((a) => a.provider === p);
  async function syncNow(ref: string) {
    try {
      const r = await api<{ status: string; queued: string[] }>(`/packages/${ref}/sync`, { method: "POST" });
      setNote(`${ref}: ${r.queued.length ? `publishing ${r.queued.join(", ")}` : "no new release tags"}.`);
      load(me ? me.namespaces.map((n) => n.name) : []);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div class="stack">
      <section aria-labelledby="accts">
        <h2 id="accts">Linked accounts</h2>
        <ul class="list-plain">
          {(["github", "gitlab", "osintverse"] as const).map((p) => (
            <li class="row">
              <strong>{PROVIDER_NAMES[p]}</strong>
              {linked(p) ? <span>{linked(p)!.login}</span> : <a class="btn" href={signInUrl(p, back)}>Link {PROVIDER_NAMES[p]}</a>}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="sync">
        <h2 id="sync">Sync status</h2>
        <ErrorNote error={error} />
        {note && <p class="notice" role="status">{note}</p>}
        {packages === null ? <Loading what="packages" /> : packages.length === 0 ? <p class="muted">No packages yet. <a href="/import">Import a repository</a>.</p> : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th scope="col">Package</th><th scope="col">Source</th><th scope="col">Sync</th><th scope="col">Last event</th><th scope="col">Last poll</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {packages.map(({ ref, log }) => (
                  <tr>
                    <td><a href={`/${ref}`}>{ref}</a></td>
                    <td>{log ? <a href={log.source.url}>{log.source.provider}</a> : "—"}{log?.source.manifest_mode === "registry" && <div class="small muted">manifest held by registry</div>}</td>
                    <td>{log ? <Status value={log.source.sync_status} /> : "—"}{log?.source.last_error && <div class="small muted">{log.source.last_error}</div>}</td>
                    <td>{when(log?.source.last_event_at)}</td>
                    <td>{when(log?.source.last_poll_at)}</td>
                    <td><button class="btn" type="button" onClick={() => syncNow(ref)}>Sync now</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
