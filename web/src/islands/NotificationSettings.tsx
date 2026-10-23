// Your notifications on /settings/notifications: what happened on the issues you follow and the packages you
// maintain, how often each kind reaches you by email, and whether your contributor profile is public.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, SignIn, useMe, when } from "./shared";

type Pref = "immediate" | "daily" | "off";
interface Prefs { community: Pref; owner_issues: Pref }
interface Item { id: string; kind: string; summary: string; path: string; created_at: number; read_at: number | null }

const LABEL: Record<Pref, string> = { immediate: "Within 15 minutes", daily: "Once a day", off: "Never (inbox only)" };

export default function NotificationSettings({ back }: { back: string }) {
  const me = useMe();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [hidden, setHidden] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!me) return;
    setHidden(!!me.profile_hidden);
    Promise.all([api<Prefs>("/me/email-prefs"), api<{ items: Item[] }>("/me/inbox")]).then(([p, i]) => { setPrefs(p); setItems(i.items); }, setError);
  }, [me]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to see your notifications and choose which emails you get." />;
  if (!prefs || !items) return error ? <ErrorNote error={error} /> : <Loading what="your notifications" />;

  const change = async (key: keyof Prefs, value: Pref) => {
    setSaved(false);
    try {
      setPrefs(await api<Prefs>("/me/email-prefs", { method: "PUT", body: JSON.stringify({ [key]: value }) }));
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };
  const readAll = async () => {
    try {
      await api("/me/inbox/read", { method: "POST", body: "{}" });
      setItems(items.map((i) => ({ ...i, read_at: i.read_at ?? Date.now() })));
    } catch (e) {
      setError(e);
    }
  };
  const hide = async (value: boolean) => {
    try {
      setHidden((await api<{ hidden: boolean }>("/me/community-profile", { method: "PUT", body: JSON.stringify({ hidden: value }) })).hidden);
    } catch (e) {
      setError(e);
    }
  };
  const unread = items.filter((i) => !i.read_at).length;

  return (
    <div class="stack notifications">
      <section class="card stack" aria-labelledby="email-h">
        <h2 id="email-h">Email</h2>
        <label class="row">Issues you follow (yours, ones you replied to or confirmed)
          <select value={prefs.community} onChange={(e) => change("community", (e.target as HTMLSelectElement).value as Pref)}>
            {(Object.keys(LABEL) as Pref[]).map((p) => <option value={p}>{LABEL[p]}</option>)}
          </select>
        </label>
        {me.namespaces.length > 0 && (
          <label class="row">New issues on packages you maintain
            <select value={prefs.owner_issues} onChange={(e) => change("owner_issues", (e.target as HTMLSelectElement).value as Pref)}>
              {(Object.keys(LABEL) as Pref[]).map((p) => <option value={p}>{LABEL[p]}</option>)}
            </select>
          </label>
        )}
        <p class="small muted">Moderators' decisions about your posts always reach you. Publishing results keep coming by email as before.{saved && " Saved."}</p>
      </section>

      <section class="card stack" aria-labelledby="profile-h">
        <h2 id="profile-h">Contributor profile</h2>
        <p class="small">{hidden ? "Your profile is hidden." : <>Your profile at <a href={`/people/${me.handle ?? me.login.toLowerCase()}`}>/people/{me.handle ?? me.login.toLowerCase()}</a> shows your handle, avatar, roles and what you did in the community; never your email.</>}</p>
        <label class="row"><input type="checkbox" checked={!!hidden} onChange={(e) => hide((e.target as HTMLInputElement).checked)} /> Hide my profile, and my avatar on my posts</label>
        <p class="small muted">Your handle still shows on what you wrote.</p>
      </section>

      <section class="stack" aria-labelledby="inbox-h">
        <div class="row between">
          <h2 id="inbox-h">Inbox{unread > 0 && ` (${unread} new)`}</h2>
          {unread > 0 && <button class="btn btn-sm" type="button" onClick={readAll}>Mark all read</button>}
        </div>
        {items.length === 0 ? <p class="muted">Nothing yet. Follow an issue, or open one, and replies show up here.</p> : (
          <ul class="list-plain inbox">
            {items.map((i) => (
              <li class={i.read_at ? undefined : "unread"}>
                <a href={i.path}>{i.summary}</a>
                <span class="small muted"> · {when(i.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ErrorNote error={error} />
    </div>
  );
}
