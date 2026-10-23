// /import: four steps. Pick a repository (yours, or someone else's open-source tool to package for the community),
// see what was detected, complete what the detector could not guess (small forms that write their part of the draft
// manifest; the YAML stays editable), then finish as a pull request, a registry-held manifest or a community
// submission (with a Dockerfile when the wrapper builds its own image), with what happens next spelled out.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, API_URL, type Types } from "../lib/api";
import { categoryLabel, entityLabel, inputLabel } from "../lib/format";
import { categoriesBlock, ethicsBlock, inputsBlock, outputsBlock, problemKey, secretsBlock, setTopLevel, testBlock, type InputField } from "../lib/yaml-blocks";
import { dockerfileTemplate, TEMPLATE_LABEL, type TemplateKind } from "../lib/dockerfile-templates";
import { ErrorNote, Loading, SignIn, useMe } from "./shared";

interface Repo {
  project_id: string;
  path: string;
  url: string;
  description: string | null;
  archived: boolean;
  app_installed?: boolean;
  published_as: string | null;
}
interface Problem { code: string; path?: string; message: string; hint?: string }
interface Import {
  id: string;
  provider: "github" | "gitlab";
  repo: string;
  url: string | null;
  status: string;
  error?: { code: string; message: string };
  detected_kind: string | null;
  signals: string[];
  assumed: string[];
  warnings: string[];
  install_url?: string;
  finish_modes: ("pr" | "registry" | "connect" | "wrapper" | "submit")[];
  community?: boolean;
  draft?: Record<string, any> | null;
  draft_yaml: string | null;
  problems: Problem[];
  missing: string[];
  suggested: string[];
  finish_mode?: string;
  pr_url?: string;
  package?: { ref: string; published: boolean };
}

const STEPS = ["Pick a repository", "What was detected", "Complete the manifest", "Finish"];
const FINISH: Record<string, { title: string; body: string }> = {
  pr: { title: "Open a pull request", body: "The manifest and the release workflow go into your repository. Releases are signed by your CI; no label, no ranking penalty." },
  wrapper: { title: "Open a pull request in the wrapper repository", body: "The community wrapper repository gets the manifest; the upstream project is credited and can claim the package later." },
  submit: { title: "Submit for review", body: "The registry creates the wrapper repository in osintverse-community and starts its release; a community reviewer approves the first one. You become a maintainer of the package." },
  registry: { title: "Keep the manifest on the registry", body: "Nothing changes in your repository. The package is labelled, releases are unsigned and ranked a little lower; a one-click pull request moves it in later." },
  connect: { title: "Connect the repository", body: "It already has otinstaller.yaml, so the next vX.Y.Z tag publishes." },
};
const HELP: Record<string, string> = {
  summary: "One sentence, 10 to 140 characters, that says what the tool finds.",
  license: "An SPDX licence identifier such as MIT or Apache-2.0.",
  readme: "The path of the README the registry renders, usually README.md.",
  inputs: "What the tool takes. Each input becomes a --flag, and its type lets ot auto and the search find it.",
  outputs: "What the tool finds, as entity types; these feed the pivots and the result envelope.",
  command: "The command as an array, with {input_name} placeholders; never a shell string.",
  ethics: "Three yes/no answers shown on the tool page in plain words.",
  content: "The guide's pages: a root folder and the navigation order.",
  kind: "Whether this is a Docker tool, a Python (pipx) tool or a guide.",
  test: "A test input the scanner runs once offline and the nightly health check repeats.",
  related_tools: "Tools the guide uses, as namespace/name, so readers can install them all at once.",
};
const INPUT_TYPES = ["email", "username", "phone", "domain", "ip", "url", "name", "image", "crypto_address", "hash", "company", "string", "integer", "boolean"];

export default function ImportWizard({ back }: { back: string }) {
  const me = useMe();
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [current, setCurrent] = useState<Import | null>(null);
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ text: string; url?: string } | null>(null);
  const [step, setStep] = useState(0);
  const [types, setTypes] = useState<Types | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  // Packaging someone else's tool: the upstream URL, the request it answers, and the Dockerfile when it builds.
  const [community, setCommunity] = useState(false);
  const [upstream, setUpstream] = useState("");
  const [request, setRequest] = useState<number | null>(null);
  const [dockerfile, setDockerfile] = useState("");

  useEffect(() => {
    api<Types>("/types").then(setTypes, () => setTypes({ inputs: INPUT_TYPES, outputs: [], categories: [] }));
    // A request's "Package this" link: /import?community=1&repo=<url>&request=<number>.
    const q = new URLSearchParams(location.search);
    if (q.get("community") === "1") setCommunity(true);
    if (q.get("repo")) setUpstream(q.get("repo")!);
    if (/^\d+$/.test(q.get("request") ?? "")) setRequest(Number(q.get("request")));
  }, []);
  useEffect(() => {
    // Your own repositories are listed only when publishing one of them.
    if (!me || community) return;
    setRepos(null);
    setError(null);
    const t = setTimeout(() => {
      api<{ repos: Repo[] }>(`/me/repos?provider=${provider}&q=${encodeURIComponent(q)}`).then((r) => setRepos(r.repos), (e) => (setRepos([]), setError(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [me, provider, q, community]);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in with the GitHub or GitLab account that owns the repository you want to publish." />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const show = (imp: Import, to?: number) => {
    setCurrent(imp);
    setYaml(imp.draft_yaml ?? "");
    if (to !== undefined) setStep(to);
    else if (imp.status === "finished") setStep(3);
    else if (imp.install_url || imp.detected_kind === null) setStep(1);
    else setStep(imp.problems.length || imp.missing.length ? 2 : 2);
  };
  const start = (repo: Repo) => run(async () => show(await api<Import>("/imports", { method: "POST", body: JSON.stringify({ repo: repo.url, provider }) }), 1));
  const startCommunity = (e: Event) => {
    e.preventDefault();
    void run(async () => show(await api<Import>("/imports", { method: "POST", body: JSON.stringify({ repo: upstream.trim(), community: true }) }), 1));
  };
  const recheck = () => run(async () => show(await api<Import>(`/imports/${current!.id}`), 1));
  const save = (text = yaml) => run(async () => show(await api<Import>(`/imports/${current!.id}`, { method: "PATCH", body: JSON.stringify({ yaml: text }) }), 2));
  const finish = (mode: string) => run(async () => {
    const body = mode === "submit" ? { mode, dockerfile: dockerfile || undefined, request: request ?? undefined } : { mode };
    const r = await api<Import & { queued_tag?: string; submission?: { number: number; status: string; url: string } }>(`/imports/${current!.id}/finish`, { method: "POST", body: JSON.stringify(body) });
    show(r, 3);
    setDone(r.submission
      ? {
        text: r.submission.status === "releasing"
          ? `Submitted as #${r.submission.number}. The release is on its way; a reviewer looks at it once its scans pass.`
          : `Submitted as #${r.submission.number}. A reviewer starts the build after reading the Dockerfile.`,
        url: `/submissions/${r.submission.number}`,
      }
      : r.pr_url ? { text: "Pull request opened.", url: r.pr_url } : r.queued_tag ? { text: `Saved. ${r.queued_tag} is being published now.` } : { text: "Connected. The next vX.Y.Z tag publishes a version." });
  });
  const write = (key: string, block: string) => {
    const next = setTopLevel(yaml, key, block);
    setYaml(next);
    return next;
  };
  const back0 = () => (setCurrent(null), setDone(null), setStep(0));

  const header = (
    <ol class="wsteps" aria-label="Steps">
      {STEPS.map((s, i) => <li aria-current={i === step ? "step" : undefined} class={i < step ? "done" : ""}><span class="n">{i + 1}</span> {s}</li>)}
    </ol>
  );

  // Step 1: pick.
  if (!current) {
    return (
      <div class="stack wizard">
        {header}
        <div class="segmented" role="group" aria-label="Whose tool">
          <button type="button" aria-pressed={!community} onClick={() => setCommunity(false)}>My repository</button>
          <button type="button" aria-pressed={community} onClick={() => setCommunity(true)}>Someone else's tool</button>
        </div>
        {community ? (
          <form class="stack" onSubmit={startCommunity}>
            <p class="small muted">Package an open-source tool you don't maintain as a community wrapper in <code>osintverse-community</code>. Its license must allow redistribution, and it mustn't be packaged or submitted already.{request && <> This answers <a href={`/requests/${request}`}>request #{request}</a>.</>}</p>
            <label for="up">The tool's GitHub or GitLab repository</label>
            <input id="up" type="url" required placeholder="https://github.com/owner/tool" value={upstream} onInput={(e) => setUpstream((e.target as HTMLInputElement).value)} />
            <p><button class="btn btn-primary" type="submit" disabled={busy || !upstream.trim()}>Package it</button></p>
            <ErrorNote error={error} />
          </form>
        ) : <>
        <div class="row" role="group" aria-label="Provider">
          <div class="segmented">
            <button type="button" aria-pressed={provider === "github"} onClick={() => setProvider("github")}>GitHub</button>
            <button type="button" aria-pressed={provider === "gitlab"} onClick={() => setProvider("gitlab")}>GitLab</button>
          </div>
          <label class="sr-only" for="rq">Filter repositories</label>
          <input id="rq" type="search" placeholder="Filter repositories" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <p class="small muted">Public repositories you administer (GitHub) or maintain (GitLab). {provider === "gitlab" && <>Opening merge requests needs GitLab write access: <a href={`${API_URL}/v1/auth/gitlab/login?scope=api&redirect=${encodeURIComponent(back)}`}>grant it</a>.</>}</p>
        <ErrorNote error={error} />
        {repos === null ? <Loading what="repositories" /> : repos.length === 0 ? <p class="muted">No repositories found. The registry sees public repositories only.</p> : (
          <ul class="list-plain rows repos">
            {repos.map((r) => (
              <li class="trow">
                <div>
                  <strong>{r.path}</strong>
                  {r.description && <p class="sum small">{r.description}</p>}
                </div>
                <div class="io">{r.archived ? "Archived repositories cannot be imported." : r.published_as ? <>Published as <a href={`/${r.published_as}`}>{r.published_as}</a></> : ""}</div>
                <div class="state">{!r.published_as && !r.archived && <button class="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => start(r)}>Import</button>}</div>
              </li>
            ))}
          </ul>
        )}
        </>}
      </div>
    );
  }

  const byKey = new Map<string, Problem[]>();
  for (const p of current.problems) {
    const k = problemKey(p.path) ?? "_";
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  const Problems = ({ k }: { k: string }) => {
    const ps = byKey.get(k);
    return ps?.length ? <ul class="problems small">{ps.map((p) => <li><code>{p.code}</code>: {p.message}{p.hint && <span class="muted"> ({p.hint})</span>}</li>)}</ul> : null;
  };
  const dirty = yaml !== (current.draft_yaml ?? "");
  const blocked = current.problems.length > 0 || current.missing.length > 0;

  // Step 2: detected.
  if (step === 1) {
    return (
      <div class="stack wizard">
        {header}
        <h2 class="wtitle">{current.repo}</h2>
        {current.error && <p class="notice bad">{current.error.message}</p>}
        {current.package && <p class="notice">Already in the registry as <a href={`/${current.package.ref}`}>{current.package.ref}</a>.</p>}
        <dl class="kv">
          <dt>Detected</dt><dd><strong>{current.detected_kind ? { docker: "Docker tool", pipx: "Python tool (pipx)", guide: "Guide" }[current.detected_kind] ?? current.detected_kind : "nothing publishable yet"}</strong>{current.signals.length > 0 && <span class="muted"> from {current.signals.join(", ")}</span>}</dd>
          {current.assumed.length > 0 && <><dt>Assumed</dt><dd><ul class="small">{current.assumed.map((a) => <li>{a}</li>)}</ul></dd></>}
          {current.warnings.length > 0 && <><dt>Warnings</dt><dd><ul class="small">{current.warnings.map((w) => <li>{w}</li>)}</ul></dd></>}
        </dl>
        {current.install_url ? (
          <div class="notice warn">
            <p><b>One thing first.</b> The OTInstaller GitHub App is not installed on this repository, so the registry cannot read tags or open a pull request.</p>
            <p class="row"><a class="btn btn-primary" href={current.install_url}>Install the app</a><button class="btn" type="button" disabled={busy} onClick={recheck}>Check again</button></p>
          </div>
        ) : null}
        <ErrorNote error={error} />
        <div class="row">
          <button class="btn" type="button" onClick={back0}>← Repositories</button>
          <button class="btn btn-strong" type="button" disabled={busy || !!current.install_url || current.draft_yaml === null} onClick={() => setStep(2)}>Complete the manifest →</button>
        </div>
      </div>
    );
  }

  // Step 3: complete.
  if (step === 2) {
    return (
      <div class="stack wizard">
        {header}
        <h2 class="wtitle">{current.repo}</h2>
        <p class="small muted">{current.missing.length ? <>Still needed: <b>{current.missing.join(", ")}</b>.</> : "Everything required is present."} {current.suggested.length > 0 && <>Worth adding: {current.suggested.join(", ")}.</>} Each section below writes its part of <code>otinstaller.yaml</code>; check and save when done.</p>
        <Problems k="_" />
        {["name", "namespace", "version", "summary", "license", "readme", "command", "runtime", "kind", "content", "related_tools"].filter((k) => byKey.has(k)).map((k) => <section class="wsec"><h3>{k}</h3><p class="small muted">{HELP[k]}</p><Problems k={k} /><p class="small muted">Edit this in the YAML below.</p></section>)}
        <InputsForm yaml={yaml} missing={current.missing.includes("inputs")} problems={<Problems k="inputs" />} write={write} types={types?.inputs ?? INPUT_TYPES} />
        <OutputsForm missing={current.missing.includes("outputs")} problems={<Problems k="outputs" />} write={write} types={types?.outputs ?? []} />
        <EthicsForm missing={current.missing.includes("ethics")} problems={<Problems k="ethics" />} write={write} />
        <CategoriesForm problems={<Problems k="categories" />} write={write} types={types?.categories ?? []} />
        <TestForm suggested={current.suggested.includes("test")} problems={<Problems k="test" />} write={write} />
        <SecretsForm problems={<Problems k="secrets" />} write={write} />
        <section class="wsec">
          <h3>otinstaller.yaml</h3>
          <button class="btn btn-sm" type="button" onClick={() => setShowYaml(!showYaml)} aria-expanded={showYaml}>{showYaml ? "Hide the YAML" : "Edit the YAML"}</button>
          {showYaml && <textarea id="yaml" rows={22} value={yaml} onInput={(e) => setYaml((e.target as HTMLTextAreaElement).value)} spellcheck={false} aria-label="otinstaller.yaml" />}
        </section>
        <ErrorNote error={error} />
        <div class="row">
          <button class="btn" type="button" onClick={() => setStep(1)}>← Detected</button>
          <button class="btn btn-primary" type="button" disabled={busy || !dirty} onClick={() => save()}>Check and save</button>
          <button class="btn btn-strong" type="button" disabled={busy || blocked || dirty} onClick={() => setStep(3)}>Finish →</button>
          {dirty && <span class="small muted">Save to check the changes.</span>}
          {!dirty && blocked && <span class="small muted">Fix the problems above to continue.</span>}
        </div>
      </div>
    );
  }

  // Step 4: finish. A community wrapper builds its own image when upstream publishes none (a placeholder digest).
  const builds = current.draft?.runtime?.kind === "docker" && /@sha256:0{64}$/.test(String(current.draft?.runtime?.image ?? ""));
  return (
    <div class="stack wizard">
      {header}
      <h2 class="wtitle">{current.repo}</h2>
      {done ? (
        <div class="notice ok" role="status">
          <p><b>{done.text}</b> {done.url && <a href={done.url}>Open it</a>}</p>
        </div>
      ) : (
        <div class="finish">
          {current.finish_modes.filter((m) => m !== "wrapper").map((m) => (
            <button class="fcard" type="button" disabled={busy} onClick={() => finish(m)}>
              <strong>{FINISH[m]?.title ?? m}</strong>
              <span class="small muted">{FINISH[m]?.body}</span>
            </button>
          ))}
        </div>
      )}
      {current.community && !done && builds && (
        <section class="wsec">
          <h3>Packaging</h3>
          <p class="small muted">The project publishes no image, so the wrapper builds one. Start from a template and check the command and version; official base images, a non-root user and a pinned release let it build straight away, anything else waits for a reviewer to read it.</p>
          <div class="row">
            {(Object.keys(TEMPLATE_LABEL) as TemplateKind[]).map((k) => (
              <button class="btn btn-sm" type="button" onClick={() => setDockerfile(dockerfileTemplate(k, {
                repo: (current.url ?? "").replace(/^https?:\/\//, ""), version: String(current.draft?.version ?? "0.1.0"),
                command: String(current.draft?.runtime?.command?.[0] ?? current.repo.split("/").pop()), pkg: current.repo.split("/").pop(),
              }))}>{TEMPLATE_LABEL[k]}</button>
            ))}
          </div>
          <label for="df">Dockerfile</label>
          <textarea id="df" rows={14} value={dockerfile} spellcheck={false} onInput={(e) => setDockerfile((e.target as HTMLTextAreaElement).value)} placeholder="FROM …" />
        </section>
      )}
      <ErrorNote error={error} />
      <section class="wsec">
        <h3>What happens next</h3>
        <ol class="next small">
          {current.community ? (
            <>
              <li>The registry checks the license, that nobody packaged or submitted it, and the Dockerfile; then it creates <code>osintverse-community/{String(current.draft?.name ?? "")}</code> with the manifest, a README crediting the project{builds && ", the Dockerfile and the release workflow"}.</li>
              <li>The first release is built, scanned and smoke-tested like any other, then waits for a community reviewer. You get updates in your <a href="/settings/notifications">inbox</a>, and the submission's page shows each step.</li>
              <li>Once it is published you are listed as a maintainer of the package.</li>
            </>
          ) : (current.finish_mode ?? current.finish_modes[0]) === "registry" ? (
            <>
              <li>The registry holds the manifest; your next <code>vX.Y.Z</code> tag (or the one queued now) is validated and scanned.</li>
              <li>A new publisher's first release waits for a reviewer, usually within 3 business days; later ones publish when the checks pass.</li>
              <li>When you are ready, the dashboard's "Move the manifest into the repository" opens a pull request so releases become signed.</li>
            </>
          ) : (
            <>
              <li>Merge the pull request{current.pr_url && <> (<a href={current.pr_url}>open it</a>)</>}.</li>
              <li>Run the <b>otinstaller release</b> workflow from the Actions tab with the version to publish. It builds, signs, writes the digest and pushes the tag. Guides: <code>ot release 1.0.0</code> instead.</li>
              <li>Within a minute the registry validates the tag and scans the release; a new publisher's first release then waits for a reviewer, usually within 3 business days.</li>
              <li>You get an email at each step, and the <a href="/dashboard">dashboard</a> shows the release and why anything failed.</li>
            </>
          )}
        </ol>
      </section>
      <div class="row">
        {!done && <button class="btn" type="button" onClick={() => setStep(2)}>← Complete</button>}
        {done && (done.url?.startsWith("/submissions/")
          ? <a class="btn btn-strong" href={done.url}>Open the submission</a>
          : <a class="btn btn-strong" href="/dashboard">Go to the dashboard</a>)}
        <button class="btn btn-ghost" type="button" onClick={back0}>Import another repository</button>
      </div>
    </div>
  );
}

// ---------- the small forms ----------

function Section({ title, help, missing, problems, children }: { title: string; help: string; missing?: boolean; problems: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class={`wsec${missing ? " need" : ""}`}>
      <h3>{title}{missing && <span class="badge warn">needed</span>}</h3>
      <p class="small muted">{help}</p>
      {problems}
      {children}
    </section>
  );
}

function InputsForm({ yaml, missing, problems, write, types }: { yaml: string; missing: boolean; problems: ComponentChildren; write: (k: string, b: string) => string; types: string[] }) {
  const [rows, setRows] = useState<InputField[]>([{ name: "", type: "email", required: true }]);
  const set = (i: number, patch: Partial<InputField>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const has = /^inputs:/m.test(yaml);
  return (
    <Section title="Inputs" help={HELP.inputs!} missing={missing} problems={problems}>
      {has && !missing && <p class="small muted">The draft already declares inputs; writing here replaces them.</p>}
      {rows.map((r, i) => (
        <div class="row frow">
          <input type="text" placeholder="name, e.g. email" value={r.name} aria-label="Input name" pattern="[a-z][a-z0-9_]{0,31}" onInput={(e) => set(i, { name: (e.target as HTMLInputElement).value })} />
          <select value={r.type} aria-label="Input type" onChange={(e) => set(i, { type: (e.target as HTMLSelectElement).value })}>{types.map((t) => <option value={t}>{inputLabel(t)}</option>)}</select>
          <label class="small"><input type="checkbox" checked={r.required} onChange={(e) => set(i, { required: (e.target as HTMLInputElement).checked })} /> required</label>
          <input type="text" placeholder="description (optional)" class="grow" value={r.description ?? ""} aria-label="Description" onInput={(e) => set(i, { description: (e.target as HTMLInputElement).value })} />
          {rows.length > 1 && <button class="btn btn-ghost btn-sm" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove input">✕</button>}
        </div>
      ))}
      <p class="row">
        <button class="btn btn-sm" type="button" onClick={() => setRows([...rows, { name: "", type: "string", required: false }])}>Add input</button>
        <button class="btn btn-primary btn-sm" type="button" disabled={rows.some((r) => !/^[a-z][a-z0-9_]{0,31}$/.test(r.name))} onClick={() => write("inputs", inputsBlock(rows))}>Write inputs</button>
      </p>
    </Section>
  );
}

function OutputsForm({ missing, problems, write, types }: { missing: boolean; problems: ComponentChildren; write: (k: string, b: string) => string; types: string[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (t: string) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]);
  return (
    <Section title="Outputs" help={HELP.outputs!} missing={missing} problems={problems}>
      <p class="row chips">{types.map((t) => <button class={`chip${picked.includes(t) ? " on" : ""}`} type="button" aria-pressed={picked.includes(t)} onClick={() => toggle(t)}>{entityLabel(t)}</button>)}</p>
      <p><button class="btn btn-primary btn-sm" type="button" disabled={picked.length === 0} onClick={() => write("outputs", outputsBlock(picked))}>Write outputs</button></p>
    </Section>
  );
}

function EthicsForm({ missing, problems, write }: { missing: boolean; problems: ComponentChildren; write: (k: string, b: string) => string }) {
  const [e, setE] = useState({ touches_target: false, auth_required: false, collects_personal_data: false });
  const Q = ({ k, label, help }: { k: keyof typeof e; label: string; help: string }) => (
    <div class="q">
      <span>{label} <span class="muted small">{help}</span></span>
      <span class="segmented"><button type="button" aria-pressed={!e[k]} onClick={() => setE({ ...e, [k]: false })}>No</button><button type="button" aria-pressed={e[k]} onClick={() => setE({ ...e, [k]: true })}>Yes</button></span>
    </div>
  );
  return (
    <Section title="Behaviour" help={HELP.ethics!} missing={missing} problems={problems}>
      <Q k="touches_target" label="Contacts the target directly?" help="(sends requests to the person's or domain's own servers, which can be noticed)" />
      <Q k="auth_required" label="Logs in to accounts?" help="(uses credentials or session cookies on third-party sites)" />
      <Q k="collects_personal_data" label="Collects personal data?" help="(returns names, addresses, accounts or similar about a person)" />
      <p><button class="btn btn-primary btn-sm" type="button" onClick={() => write("ethics", ethicsBlock(e))}>Write behaviour</button></p>
    </Section>
  );
}

function CategoriesForm({ problems, write, types }: { problems: ComponentChildren; write: (k: string, b: string) => string; types: string[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (t: string) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : picked.length < 3 ? [...picked, t] : picked);
  return (
    <Section title="Categories" help="One to three. The detector guesses from repository topics; pick to overwrite." problems={problems}>
      <p class="row chips">{types.map((t) => <button class={`chip${picked.includes(t) ? " on" : ""}`} type="button" aria-pressed={picked.includes(t)} onClick={() => toggle(t)}>{categoryLabel(t)}</button>)}</p>
      <p><button class="btn btn-primary btn-sm" type="button" disabled={picked.length === 0} onClick={() => write("categories", categoriesBlock(picked))}>Write categories</button></p>
    </Section>
  );
}

function TestForm({ suggested, problems, write }: { suggested: boolean; problems: ComponentChildren; write: (k: string, b: string) => string }) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>([{ k: "", v: "" }]);
  return (
    <Section title="Test input" help={HELP.test!} missing={false} problems={problems}>
      {suggested && <p class="small"><span class="badge">suggested</span> Without it the tool is listed as not health-checked.</p>}
      {rows.map((r, i) => (
        <div class="row frow">
          <input type="text" placeholder="input name" value={r.k} aria-label="Input name" onInput={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: (e.target as HTMLInputElement).value } : x)))} />
          <input type="text" placeholder="value, e.g. example.com" class="grow" value={r.v} aria-label="Value" onInput={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: (e.target as HTMLInputElement).value } : x)))} />
        </div>
      ))}
      <p class="row">
        <button class="btn btn-sm" type="button" onClick={() => setRows([...rows, { k: "", v: "" }])}>Add value</button>
        <button class="btn btn-primary btn-sm" type="button" disabled={!rows.some((r) => r.k && r.v)} onClick={() => write("test", testBlock(Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k, r.v]))))}>Write test input</button>
      </p>
      <p class="small muted">Use public, harmless values (example.com, your own handle). The test runs offline unless the manifest declares network egress.</p>
    </Section>
  );
}

function SecretsForm({ problems, write }: { problems: ComponentChildren; write: (k: string, b: string) => string }) {
  const [rows, setRows] = useState<{ name: string; required: boolean; url: string }[]>([]);
  return (
    <Section title="API keys" help="Keys the tool needs, as environment variable names. ot stores them in the OS keychain and passes them to this container only." problems={problems}>
      {rows.map((r, i) => (
        <div class="row frow">
          <input type="text" placeholder="NAME, e.g. SHODAN_API_KEY" value={r.name} aria-label="Key name" pattern="[A-Z][A-Z0-9_]{2,63}" onInput={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x)))} />
          <label class="small"><input type="checkbox" checked={r.required} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, required: (e.target as HTMLInputElement).checked } : x)))} /> required</label>
          <input type="url" placeholder="where to get one (URL)" class="grow" value={r.url} aria-label="Where to get a key" onInput={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, url: (e.target as HTMLInputElement).value } : x)))} />
        </div>
      ))}
      <p class="row">
        <button class="btn btn-sm" type="button" onClick={() => setRows([...rows, { name: "", required: true, url: "" }])}>Add key</button>
        {rows.length > 0 && <button class="btn btn-primary btn-sm" type="button" disabled={rows.some((r) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(r.name))} onClick={() => write("secrets", secretsBlock(rows))}>Write keys</button>}
      </p>
    </Section>
  );
}
