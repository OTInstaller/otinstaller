// The form that opens an issue on a package. Signed-in only; the version, platform and exit code are asked for as
// fields so nobody has to paste a command line with the value they were looking up.
import { useEffect, useState } from "preact/hooks";
import { api, type IssueKind } from "../lib/api";
import { guessPlatform, issueHref, KIND_HELP, KIND_LABEL } from "../lib/community";
import { ErrorNote, Loading, SignIn, useMe } from "./shared";

export default function IssueComposer({ refName, versions, back }: { refName: string; versions: string[]; back: string }) {
  const me = useMe();
  const [kind, setKind] = useState<IssueKind>("broken");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [version, setVersion] = useState(versions[0] ?? "");
  const [platform, setPlatform] = useState("");
  const [engine, setEngine] = useState("");
  const [exitCode, setExitCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [held, setHeld] = useState<string | null>(null);

  useEffect(() => {
    setPlatform(guessPlatform(navigator.userAgent));
    const k = new URLSearchParams(location.search).get("kind") as IssueKind | null;
    if (k && k in KIND_LABEL) setKind(k);
  }, []);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to open an issue. Reading issues needs no account." />;
  if (held) return <p class="notice" role="status">{held}</p>;

  const runFields = kind === "broken" || kind === "wrong_info";
  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ number: number; moderation: string; note?: string }>(`/tools/${refName}/issues`, {
        method: "POST",
        body: JSON.stringify({
          kind, title, body, version: version || undefined,
          ...(runFields ? { platform: platform || undefined, engine: engine || undefined, exit_code: exitCode === "" ? undefined : Number(exitCode) } : {}),
        }),
      });
      if (r.moderation === "held") setHeld(r.note ?? "Thanks. A moderator will check it before it is shown.");
      else location.assign(issueHref(refName, r.number));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="stack composer" onSubmit={submit}>
      <fieldset class="stack">
        <legend>What kind of issue?</legend>
        {(Object.keys(KIND_LABEL) as IssueKind[]).map((k) => (
          <label class="row kind"><input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} /> <span><b>{KIND_LABEL[k]}</b> <span class="small muted">{KIND_HELP[k]}</span></span></label>
        ))}
      </fieldset>
      <label for="i-title">Title</label>
      <input id="i-title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} required minLength={5} maxLength={140}
        placeholder={kind === "outdated" ? "Upstream released 2.1.0" : "Exits with 1 on every email address"} />
      <label for="i-body">What happened{kind === "outdated" ? " (optional)" : ""}</label>
      <textarea id="i-body" rows={7} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} maxLength={8000}
        required={kind !== "outdated"} minLength={kind === "outdated" ? 0 : 10}
        placeholder="What you ran, what you expected and what you got. Markdown works." />
      <p class="notice warn small">Never post personal data about the people you investigate. Reproduce the problem with the tool's test input or made-up values; posts that look like personal data, secrets or keys wait for a moderator.</p>
      <div class="grid">
        <label>Version
          <select value={version} onChange={(e) => setVersion((e.target as HTMLSelectElement).value)}>
            {versions.map((v) => <option value={v}>{v}</option>)}
          </select>
        </label>
        {runFields && (
          <>
            <label>Platform <input value={platform} onInput={(e) => setPlatform((e.target as HTMLInputElement).value)} placeholder="linux/amd64" maxLength={40} /></label>
            <label>Runs with
              <select value={engine} onChange={(e) => setEngine((e.target as HTMLSelectElement).value)}>
                <option value="">Not sure</option>
                <option value="docker">Docker</option>
                <option value="podman">Podman</option>
                <option value="native">--native</option>
              </select>
            </label>
            <label>Exit code <input inputMode="numeric" pattern="[0-9]*" value={exitCode} onInput={(e) => setExitCode((e.target as HTMLInputElement).value)} placeholder="1" maxLength={3} /></label>
          </>
        )}
      </div>
      <ErrorNote error={error} />
      <div class="row">
        <button class="btn btn-primary" type="submit" disabled={busy}>Open issue</button>
        <span class="small muted">Posting as {me.handle ?? me.login}.</span>
      </div>
    </form>
  );
}
