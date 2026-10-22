// /dashboard/profile/{ns}: the owner's Profile tab. Linked GitHub and GitLab accounts, sync status and "Sync now",
// per-field host value or custom value, hiding host details, pins and the About editor with a preview.
import { useEffect, useState } from "preact/hooks";
import { api, signInUrl, type ProfileField, type ProfileSettings } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe, when } from "./shared";

type Mode = "host" | "custom";
type Draft = Record<ProfileField, { mode: Mode; value: string }>;

const LABELS: Record<ProfileField, string> = {
  display_name: "Name", bio: "Bio", location: "Location", website: "Website", company: "Company", avatar_url: "Avatar URL", socials: "Social links",
};
const HOSTS = { github: "GitHub", gitlab: "GitLab" } as const;
const MAX_PINS = 6;

/** A field's value as the form edits it: text, or social links one per line. */
function asText(field: ProfileField, v: unknown): string {
  if (field === "socials") return Array.isArray(v) ? v.map((s: { url: string }) => s.url).join("\n") : "";
  return typeof v === "string" ? v : "";
}

function draftFrom(d: ProfileSettings): Draft {
  const out = {} as Draft;
  for (const f of d.fields) {
    const custom = f in d.custom;
    out[f] = { mode: custom ? "custom" : "host", value: asText(f, custom ? d.custom[f] : f === "display_name" ? d.host.display_name : (d.host as Record<string, unknown>)[f]) };
  }
  return out;
}

export default function ProfileEditor({ ns, back }: { ns: string; back: string }) {
  const me = useMe();
  const [data, setData] = useState<ProfileSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [about, setAbout] = useState("");
  const [pins, setPins] = useState<string[]>([]);
  const [hide, setHide] = useState(false);
  const [preview, setPreview] = useState<{ html: string; problems: { code: string; message: string }[] } | null>(null);
  const [account, setAccount] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const path = `/me/namespaces/${encodeURIComponent(ns)}/profile`;
  const take = (d: ProfileSettings) => {
    setData(d);
    setDraft(draftFrom(d));
    setAbout(d.about_md ?? "");
    setPins(d.pins);
    setHide(d.hide_details);
  };
  useEffect(() => {
    if (me) api<ProfileSettings>(path).then(take, setError);
  }, [me]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to edit this publisher's profile." />;
  if (!data || !draft) return error ? <ErrorNote error={error} /> : <Loading what="the profile" />;

  /** Runs a request that answers with the new settings, with one busy flag and a note on success. */
  async function run(what: string, req: () => Promise<ProfileSettings>, done: string) {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      take(await req());
      setNote(done);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const save = (e: Event) => {
    e.preventDefault();
    const custom: Record<string, unknown> = {};
    for (const f of data.fields) {
      const d = draft[f];
      if (d.mode === "host") {
        if (f in data.custom) custom[f] = null;
      } else {
        custom[f] = f === "socials" ? d.value.split(/\s+/).map((u) => u.trim()).filter(Boolean) : d.value.trim();
      }
    }
    run("save", () => api<ProfileSettings>(path, { method: "PATCH", body: JSON.stringify({ custom, about: about.trim() ? about : null, pins, hide_details: hide }) }),
      "Saved. The public page updates within 5 minutes.");
  };
  const sync = () => run("sync", () => api<ProfileSettings>(`${path}/sync`, { method: "POST" }), "Synced from your hosts.");
  const link = (provider: "github" | "gitlab") =>
    run(`link-${provider}`, () => api<ProfileSettings>(`${path}/hosts`, { method: "POST", body: JSON.stringify({ provider, account: account[provider]?.trim() || undefined }) }),
      `${HOSTS[provider]} is now shown on the profile.`);
  const unlink = (provider: string) => run(`unlink-${provider}`, () => api<ProfileSettings>(`${path}/hosts/${provider}`, { method: "DELETE" }), "Removed from the profile.");
  async function showPreview() {
    setBusy("preview");
    try {
      setPreview(await api(`${path}/preview`, { method: "POST", body: JSON.stringify({ about }) }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  const setField = (f: ProfileField, patch: Partial<Draft[ProfileField]>) => setDraft({ ...draft, [f]: { ...draft[f], ...patch } });
  const togglePin = (name: string) => setPins(pins.includes(name) ? pins.filter((x) => x !== name) : pins.length < MAX_PINS ? [...pins, name] : pins);
  const hostValue = (f: ProfileField): string => {
    const v = f === "socials" ? data.host.socials.map((s) => s.url).join(", ") : asText(f, (data.host as Record<string, unknown>)[f]);
    return v || "nothing";
  };
  const primaryHost = data.namespace.provider === "github" || data.namespace.provider === "gitlab" ? HOSTS[data.namespace.provider] : null;
  const linkable = (["github", "gitlab"] as const).filter((p) => p !== data.namespace.provider);

  return (
    <div class="stack pe">
      <p class="row small">
        <a href={`/${ns}`}>View the public profile</a>
        <Status value={data.namespace.status} />
        {data.namespace.verified && <span class="badge ok">Verified</span>}
      </p>
      <ErrorNote error={error} />
      {note && <p class="notice ok" role="status">{note}</p>}

      <section aria-labelledby="hosts-h">
        <h2 id="hosts-h">GitHub and GitLab</h2>
        <p class="small muted">The profile copies public details (never email addresses) from these accounts every 6 hours, and when an organization's members change. Your own values below win until you switch a field back.</p>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th scope="col">Host</th><th scope="col">Account</th><th scope="col">Shown as</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.hosts.map((h) => (
                <tr>
                  <td>{HOSTS[h.provider]}</td>
                  <td><a href={h.url} rel="noopener">{h.login}</a></td>
                  <td>{h.primary ? "the namespace's own account" : "linked by an owner"}</td>
                  <td>{!h.primary && <button class="btn btn-sm" type="button" disabled={!!busy} onClick={() => unlink(h.provider)}>Remove</button>}</td>
                </tr>
              ))}
              {linkable.filter((p) => !data.hosts.some((h) => h.provider === p)).map((p) => {
                const acct = data.accounts.find((a) => a.provider === p);
                return (
                  <tr>
                    <td>{HOSTS[p]}</td>
                    <td colSpan={3}>
                      {acct ? (
                        <form class="row" onSubmit={(e) => { e.preventDefault(); link(p); }}>
                          <label for={`acct-${p}`} class="sr-only">{p === "github" ? "Organization" : "Group"} to show</label>
                          <input id={`acct-${p}`} type="text" value={account[p] ?? ""} placeholder={`${acct.login} (or an ${p === "github" ? "org you own" : "group you own"})`}
                            onInput={(e) => setAccount({ ...account, [p]: (e.target as HTMLInputElement).value })} />
                          <button class="btn btn-sm btn-primary" type="submit" disabled={!!busy}>Show on profile</button>
                        </form>
                      ) : (
                        <span class="row"><span class="muted small">Not connected.</span><a class="btn btn-sm" href={signInUrl(p, back)}>Connect {HOSTS[p]}</a></span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div class="row sync">
          <span>Last synced <strong>{when(data.sync.synced_at)}</strong></span>
          <Status value={data.sync.status === "never" ? "queued" : data.sync.status} />
          <button class="btn btn-sm" type="button" disabled={!!busy} onClick={sync}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>
        </div>
        {data.sync.error && <p class="notice warn small">{data.sync.error}</p>}
      </section>

      <form class="stack" onSubmit={save}>
        <section aria-labelledby="fields-h">
          <h2 id="fields-h">Profile details</h2>
          <p class="small muted">{primaryHost ? `Use the ${primaryHost} value, or write your own.` : "Write your own, or link a host above to copy its details."}</p>
          <div class="fields">
            {data.fields.map((f) => (
              <fieldset class="field">
                <legend>{LABELS[f]}</legend>
                <label class="row small"><input type="radio" name={`m-${f}`} value="host" aria-label={`${LABELS[f]}: use the host value`} checked={draft[f].mode === "host"} onChange={() => setField(f, { mode: "host" })} /> Host value: <span class="muted">{hostValue(f)}</span></label>
                <label class="row small"><input type="radio" name={`m-${f}`} value="custom" aria-label={`${LABELS[f]}: custom value`} checked={draft[f].mode === "custom"} onChange={() => setField(f, { mode: "custom" })} /> Custom</label>
                {draft[f].mode === "custom" && (f === "bio" || f === "socials"
                  ? <textarea aria-label={`Custom ${LABELS[f].toLowerCase()}`} rows={f === "bio" ? 3 : 4} maxLength={f === "bio" ? 400 : 3000} value={draft[f].value}
                      placeholder={f === "socials" ? "One URL per line, up to 8" : "Leave empty to show no bio"} onInput={(e) => setField(f, { value: (e.target as HTMLTextAreaElement).value })} />
                  : <input type={f === "website" || f === "avatar_url" ? "url" : "text"} aria-label={`Custom ${LABELS[f].toLowerCase()}`} maxLength={f === "website" || f === "avatar_url" ? 300 : 100} value={draft[f].value}
                      placeholder={f === "avatar_url" ? "https://avatars.githubusercontent.com/…" : "Leave empty to show nothing"} onInput={(e) => setField(f, { value: (e.target as HTMLInputElement).value })} />)}
              </fieldset>
            ))}
          </div>
          <label class="row hide"><input type="checkbox" checked={hide} onChange={(e) => setHide((e.target as HTMLInputElement).checked)} /> Hide profile details: bio, location, website, company, social links and people. The name, avatar and host links stay.</label>
        </section>

        <section aria-labelledby="pins-h">
          <h2 id="pins-h">Pinned packages <span class="small muted">({pins.length} of {MAX_PINS})</span></h2>
          {data.packages.length === 0 ? <p class="muted small">Nothing to pin yet.</p> : (
            <ul class="list-plain pins">
              {data.packages.map((p) => (
                <li>
                  <label class="row small">
                    <input type="checkbox" checked={pins.includes(p.name)} disabled={!pins.includes(p.name) && pins.length >= MAX_PINS} onChange={() => togglePin(p.name)} />
                    {pins.includes(p.name) && <span class="badge plain">{pins.indexOf(p.name) + 1}</span>}
                    <strong>{p.name}</strong> <span class="muted">{p.kind} · {p.summary}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p class="small muted">Pins show in the order you tick them.</p>
        </section>

        <section aria-labelledby="about-h">
          <h2 id="about-h">About</h2>
          <p class="small muted">Markdown, shown above your packages. Raw HTML and images are not rendered. Without it the profile shows the bio only.</p>
          <textarea id="about" aria-labelledby="about-h" rows={10} maxLength={20000} value={about} onInput={(e) => { setAbout((e.target as HTMLTextAreaElement).value); setPreview(null); }}
            placeholder={"## What we build\n\nTools for…"} />
          <div class="row">
            <button class="btn btn-sm" type="button" disabled={!!busy || !about.trim()} onClick={showPreview}>{busy === "preview" ? "Rendering…" : "Preview"}</button>
            {!about.trim() && data.host.bio && <button class="btn btn-sm btn-ghost" type="button" onClick={() => setAbout(data.host.bio ?? "")}>Start from the host bio</button>}
          </div>
          {preview && (
            <div class="preview">
              {preview.problems.length > 0 && <ul class="small notice warn">{preview.problems.map((p) => <li><code>{p.code}</code>: {p.message}</li>)}</ul>}
              {/* Sanitized by the registry's renderer, the same HTML the public page shows. */}
              <div class="prose" dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          )}
        </section>

        <div class="row">
          <button class="btn btn-strong" type="submit" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save profile"}</button>
          <span class="small muted">Saved changes reach the public page within 5 minutes.</span>
        </div>
      </form>
    </div>
  );
}
