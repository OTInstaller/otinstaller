// The report page's form (/{ns}/{name}/report): what is wrong, then where it goes. Signed in, a problem with the tool
// becomes a public issue; signed out, "broken" and "out of date" can be counted without an account; malware, abuse
// and legal problems go privately to the reviewers. The choices live in lib/report.ts.
import { useEffect, useState } from "preact/hooks";
import { api, type IssueSummary } from "../lib/api";
import { guessPlatform, issueHref } from "../lib/community";
import { REPORT_CHOICES, reportChoice, reportHref, type ReportChoice, type ReportChoiceKey } from "../lib/report";
import { IssueForm } from "./IssueComposer";
import ReportForm from "./ReportForm";
import { ErrorNote, Loading, SignIn, useMe } from "./shared";

/** What a sign-in lets someone add to each choice. */
const SIGN_IN_TO: Record<ReportChoiceKey, string> = {
  broken: "describe what happened",
  error: "paste the error message",
  outdated: "say which newer version is out",
  wrong_info: "say what is wrong",
  abuse: "",
};

interface Props {
  refName: string;
  /** Versions that can be reported, newest first. */
  versions: string[];
  latest: string;
  /** The package's open issues (the first page), to point at before someone files the same thing again. */
  open: IssueSummary[];
  initialChoice?: ReportChoiceKey;
  initialVersion?: string;
}

export default function ReportProblem({ refName, versions, latest, open, initialChoice, initialVersion }: Props) {
  const me = useMe();
  const [key, setKey] = useState<ReportChoiceKey | null>(initialChoice ?? null);
  const [version, setVersion] = useState(initialVersion && versions.includes(initialVersion) ? initialVersion : latest);
  const choice = reportChoice(key);

  // The address keeps the choice and the version, so a reload or a sign-in comes back to them.
  const here = (k: ReportChoiceKey | null, v: string) => reportHref(refName, { kind: k ?? undefined, version: v === latest ? undefined : v });
  const pick = (k: ReportChoiceKey) => {
    setKey(k);
    history.replaceState(null, "", here(k, version));
  };
  const pickVersion = (v: string) => {
    setVersion(v);
    history.replaceState(null, "", here(key, v));
  };

  return (
    <div class="stack report">
      <fieldset class="stack">
        <legend>What's wrong?</legend>
        {REPORT_CHOICES.map((c) => (
          <label class="option choice"><input type="radio" name="what" value={c.key} checked={key === c.key} onChange={() => pick(c.key)} /> <span><b>{c.label}</b> <span class="small muted">{c.help}</span></span></label>
        ))}
      </fieldset>
      {choice?.key === "abuse" && <ReportForm refName={refName} versions={versions} version={initialVersion} />}
      {choice?.issue && (
        <>
          {choice.issue === "outdated" ? (
            <p class="small muted">About the latest version, {latest}: only the latest can be behind its project.</p>
          ) : (
            <p class="row small">
              <label for="r-ver">Version</label>
              <select id="r-ver" value={version} onChange={(e) => pickVersion((e.target as HTMLSelectElement).value)}>
                {versions.map((v) => <option value={v}>{v}{v === latest ? " (latest)" : ""}</option>)}
              </select>
            </p>
          )}
          <Known refName={refName} choice={choice} version={version} open={open} />
          {me === null ? (
            <Loading what="your account" />
          ) : me ? (
            <IssueForm me={me} refName={refName} versions={versions} kind={choice.issue} version={choice.issue === "outdated" ? latest : version} askError={choice.key === "error"} />
          ) : (
            <>
              {/* Keyed, so a count already sent for one kind and version doesn't show against another. */}
              {choice.counts && <CountIt key={`${choice.counts}:${version}`} refName={refName} kind={choice.counts} version={choice.counts === "outdated" ? latest : version} needsWords={choice.key === "error"} />}
              <SignIn back={here(choice.key, version)} why={`Sign in to ${SIGN_IN_TO[choice.key]} in a public issue: the package's maintainers hear about it at once, and you hear back.`} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Open issues that may already say it: the chosen version's first. */
function Known({ refName, choice, version, open }: { refName: string; choice: ReportChoice; version: string; open: IssueSummary[] }) {
  const same = open
    .filter((i) => i.kind === choice.issue)
    .sort((a, b) => Number(b.version === version) - Number(a.version === version))
    .slice(0, 5);
  if (!same.length) return null;
  return (
    <div class="notice small known">
      <p><b>Already reported?</b> {choice.issue === "broken"
        ? <>If one of these is your problem, open it and press <b>I have this problem too</b> (it needs a sign-in) rather than reporting it again.</>
        : <>If one of these says it, open it to follow it or add what you know.</>}</p>
      <ul class="list-plain">
        {same.map((i) => (
          <li><a href={issueHref(refName, i.number)}>#{i.number} {i.title}</a>{i.version && <span class="muted"> · {i.version}</span>}{i.me_too > 0 && <span class="muted"> · {i.me_too} {i.me_too === 1 ? "person has" : "people have"} it</span>}</li>
        ))}
      </ul>
    </div>
  );
}

/** One click without an account: counted, never stored with who sent it (POST /problem-reports). */
function CountIt({ refName, kind, version, needsWords }: { refName: string; kind: "broken" | "outdated"; version: string; needsWords: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "counted" | "already">("idle");
  const [error, setError] = useState<unknown>(null);
  const [platform, setPlatform] = useState("");
  useEffect(() => setPlatform(guessPlatform(navigator.userAgent)), []);

  async function send() {
    setState("busy");
    setError(null);
    try {
      const r = await api<{ counted: boolean }>(`/tools/${refName}/problem-reports`, {
        method: "POST",
        body: JSON.stringify(kind === "broken" ? { kind, version, ...(platform ? { platform } : {}) } : { kind }),
      });
      setState(r.counted ? "counted" : "already");
    } catch (e) {
      setError(e);
      setState("idle");
    }
  }

  const what = kind === "broken" ? "broken" : "out of date";
  if (state === "counted") {
    return <p class="notice ok small" role="status">Thanks: {version} is counted as {what}. Three reports in a week open an issue marked unconfirmed, which the package's maintainers hear about. Signing in to describe it gets it fixed sooner.</p>;
  }
  if (state === "already") return <p class="notice small" role="status">A report of {version} as {what} from this address is already counted today; each address counts once a day.</p>;
  return (
    <div class="card stack count">
      <p><b>No account?</b> Count {version} as {what} in one click. {kind === "broken"
        ? <>This sends the version{platform && <> and your platform as this browser reports it ({platform})</>}: </>
        : <>This sends nothing but the tool: </>}no text and nothing about you. Three reports in a week open an issue marked unconfirmed.{needsWords && <> The error message itself needs a sign-in.</>}</p>
      <ErrorNote error={error} />
      <div class="row"><button class="btn" type="button" disabled={state === "busy"} onClick={send}>Count it as {what}</button></div>
    </div>
  );
}
