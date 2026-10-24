// The form that opens an issue on a package: the Issues tab's, and the signed-in half of the report page. Signed-in
// only; the version, platform and exit code are asked for as fields so nobody has to paste a command line with the
// value they were looking up, and an error message gets a field of its own.
import { useEffect, useState } from "preact/hooks";
import { api, type IssueKind } from "../lib/api";
import { guessPlatform, issueHref, KIND_HELP, KIND_LABEL } from "../lib/community";
import { MAX_ISSUE_BODY, withError } from "../lib/report";
import { ErrorNote, Loading, SignIn, useMe, type Me } from "./shared";

interface FormProps {
  me: Me;
  refName: string;
  versions: string[];
  /** A kind chosen on the page around the form (the report page), so the form doesn't ask for one. */
  kind?: IssueKind;
  /** The kind picked first when the form asks (the Issues tab's ?kind=). */
  initialKind?: IssueKind;
  /** A version chosen on the page around the form, so the form doesn't ask for one. */
  version?: string;
  /** "It shows an error": the error message is required and what happened is optional. */
  askError?: boolean;
}

export function IssueForm({ me, refName, versions, kind: fixedKind, initialKind, version: fixedVersion, askError = false }: FormProps) {
  const [chosenKind, setKind] = useState<IssueKind>(initialKind ?? "broken");
  const kind = fixedKind ?? chosenKind;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [errorText, setErrorText] = useState("");
  const [chosenVersion, setVersion] = useState(versions[0] ?? "");
  const version = fixedVersion ?? chosenVersion;
  const [platform, setPlatform] = useState("");
  const [engine, setEngine] = useState("");
  const [exitCode, setExitCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [held, setHeld] = useState<string | null>(null);

  useEffect(() => setPlatform(guessPlatform(navigator.userAgent)), []);

  if (held) return <p class="notice" role="status">{held}</p>;

  const runFields = kind === "broken" || kind === "wrong_info";
  const errorField = kind === "broken";
  const needsError = errorField && askError;
  async function submit(e: Event) {
    e.preventDefault();
    const text = errorField ? withError(body, errorText) : body;
    if (text.length > MAX_ISSUE_BODY) {
      setError(new Error(`What happened and the error message can be ${MAX_ISSUE_BODY} characters together; keep the lines of the error that matter.`));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ number: number; moderation: string; note?: string }>(`/tools/${refName}/issues`, {
        method: "POST",
        body: JSON.stringify({
          kind, title, body: text, version: version || undefined,
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
      {!fixedKind && (
        <fieldset class="stack">
          <legend>What kind of issue?</legend>
          {(Object.keys(KIND_LABEL) as IssueKind[]).map((k) => (
            <label class="option kind"><input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} /> <span><b>{KIND_LABEL[k]}</b> <span class="small muted">{KIND_HELP[k]}</span></span></label>
          ))}
        </fieldset>
      )}
      <label for="i-title">Title</label>
      <input id="i-title" class="wide" type="text" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} required minLength={5} maxLength={140}
        placeholder={kind === "outdated" ? "Upstream released 2.1.0" : needsError ? "Fails with KeyError: 'data' on every username" : "Exits with 1 on every email address"} />
      <label for="i-body">What happened{kind === "outdated" || needsError ? " (optional)" : ""}</label>
      <textarea id="i-body" rows={needsError ? 4 : 7} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} maxLength={MAX_ISSUE_BODY}
        required={kind !== "outdated" && !needsError} minLength={kind === "outdated" || needsError ? 0 : 10}
        placeholder={kind === "outdated" ? "Where upstream announced it, and anything the new version changes." : "What you ran, what you expected and what you got. Markdown works."} />
      {errorField && (
        <>
          <label for="i-error">Error message{needsError ? "" : " (optional)"}</label>
          <textarea id="i-error" rows={needsError ? 8 : 4} value={errorText} onInput={(e) => setErrorText((e.target as HTMLTextAreaElement).value)} maxLength={MAX_ISSUE_BODY}
            required={needsError} spellcheck={false} placeholder="Paste the error and the lines around it, as the tool printed them." />
        </>
      )}
      <p class="notice warn small">Never post personal data about the people you investigate. Reproduce the problem with the tool's test input or made-up values, and take the value you looked up out of any error message; posts that look like personal data, secrets or keys wait for a moderator.</p>
      {(fixedVersion === undefined || runFields) && (
        <div class="grid">
          {fixedVersion === undefined && (
            <label>Version
              <select value={version} onChange={(e) => setVersion((e.target as HTMLSelectElement).value)}>
                {versions.map((v) => <option value={v}>{v}</option>)}
              </select>
            </label>
          )}
          {runFields && (
            <>
              <label>Platform <input type="text" value={platform} onInput={(e) => setPlatform((e.target as HTMLInputElement).value)} placeholder="linux/amd64" maxLength={40} /></label>
              <label>Runs with
                <select value={engine} onChange={(e) => setEngine((e.target as HTMLSelectElement).value)}>
                  <option value="">Not sure</option>
                  <option value="docker">Docker</option>
                  <option value="podman">Podman</option>
                  <option value="native">--native</option>
                </select>
              </label>
              <label>Exit code <input type="text" inputMode="numeric" pattern="[0-9]*" value={exitCode} onInput={(e) => setExitCode((e.target as HTMLInputElement).value)} placeholder="1" maxLength={3} /></label>
            </>
          )}
        </div>
      )}
      <ErrorNote error={error} />
      <div class="row">
        <button class="btn btn-primary" type="submit" disabled={busy}>Open issue</button>
        <span class="small muted">Posting as {me.handle ?? me.login}.</span>
      </div>
    </form>
  );
}

/** The Issues tab's form: asks for the kind, with the one its ?kind= names picked first. */
export default function IssueComposer({ refName, versions, back, initialKind }: { refName: string; versions: string[]; back: string; initialKind?: IssueKind }) {
  const me = useMe();
  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to open an issue. Reading issues needs no account." />;
  return <IssueForm me={me} refName={refName} versions={versions} initialKind={initialKind} />;
}
