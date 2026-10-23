// /dashboard/publish/{jobId}: one publish job (a tag, an upload from CI or a direct upload) as a timeline (validate →
// scan → review → publish), with the CI run it came from and every problem and its fix. The commit status "Details"
// link on a tag, and `ot publish`, point here.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe, when } from "./shared";

interface Job {
  id: string;
  method: "tag" | "ci" | "direct";
  repo: string;
  tag: string;
  ref: string | null;
  version: string | null;
  status: string;
  error_code: string | null;
  error_detail: string | null;
  problems: { code: string; path?: string; message: string; hint?: string }[];
  // The CI run an upload came from (trusted publishing).
  ci: { workflow: string; ref: string; sha: string; run: string } | null;
  provider: string;
  commit_sha: string | null;
  created_at: number;
  updated_at: number;
}

/** A link to the CI run, where the host's URLs allow one. */
function runUrl(job: Job): string | null {
  const [id] = (job.ci?.run ?? "").split("/");
  if (!id) return null;
  return job.provider === "github" ? `https://github.com/${job.repo}/actions/runs/${id}` : `https://gitlab.com/${job.repo}/-/pipelines/${id}`;
}

const STAGES = [
  { key: "validating", title: "Validate", d: "The manifest, the files it names, and the image or wheel." },
  { key: "scanning", title: "Scan", d: "Signature, vulnerabilities, secrets, malware heuristics, SBOM, smoke test." },
  { key: "awaiting_review", title: "Review", d: "A new publisher's first release only." },
  { key: "published", title: "Publish", d: "Listed, emailed, backed up." },
];

export default function JobView({ jobId, back }: { jobId: string; back: string }) {
  const me = useMe();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!me) return;
    api<Job>(`/me/publish-jobs/${encodeURIComponent(jobId)}`)
      .then(setJob, (e) => (e instanceof ApiError && e.status === 404 ? setJob(null) : setError(e)));
  }, [me]);
  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to see this publish job." />;
  if (job === undefined) return <><ErrorNote error={error} /><Loading what="the job" /></>;
  if (job === null) return <p class="notice">No publish job {jobId} in your namespaces. <a href="/dashboard">Back to the dashboard</a>.</p>;

  const uploaded = job.method !== "tag";
  const again = job.method === "direct" ? "run ot publish again" : job.method === "ci" ? "run the release workflow again" : "push a new tag";
  const run = runUrl(job);
  const failed = ["error", "rejected", "failed"].includes(job.status);
  const stageIndex = job.status === "queued" ? -1 : Math.max(0, STAGES.findIndex((s) => s.key === job.status));
  const reached = (i: number) => (job.status === "published" ? true : failed ? i <= stageIndex : i < stageIndex);
  const current = (i: number) => !failed && job.status !== "published" && i === stageIndex;

  return (
    <div class="stack job">
      <dl class="kv">
        {job.method === "direct"
          ? <><dt>Package</dt><dd>{job.ref ?? job.repo}</dd><dt>From</dt><dd>an upload with <code>ot publish</code></dd></>
          : <><dt>Repository</dt><dd>{job.repo}</dd></>}
        {job.ci && (
          <>
            <dt>From</dt>
            <dd>
              {job.provider === "github" ? "GitHub Actions" : "GitLab CI"}, <code>{job.ci.workflow}</code> on <code>{job.ci.ref.replace(/^refs\/(heads|tags)\//, "")}</code>
              {run && <> (<a href={run} rel="nofollow noopener">run {job.ci.run.split("/")[0]}</a>)</>}
            </dd>
            <dt>Commit</dt><dd><code>{(job.commit_sha ?? job.ci.sha).slice(0, 12)}</code>{!job.commit_sha && <span class="small muted"> (the run's commit, before the release commit)</span>}</dd>
          </>
        )}
        <dt>{uploaded ? "Version" : "Tag"}</dt><dd><code>{uploaded ? job.version ?? job.tag.replace(/^v/, "") : job.tag}</code></dd>
        <dt>Status</dt><dd><Status value={job.status} /></dd>
        <dt>Started</dt><dd>{when(job.created_at)} · updated {when(job.updated_at)}</dd>
      </dl>
      <ol class="jtimeline">
        {STAGES.map((s, i) => (
          <li class={failed && i === stageIndex ? "bad" : reached(i) ? "ok" : current(i) ? "now" : ""} aria-current={current(i) ? "step" : undefined}>
            <span class="mark" aria-hidden="true">{failed && i === stageIndex ? "✕" : reached(i) ? "✓" : current(i) ? "…" : "–"}</span>
            <div><strong>{s.title}</strong><p class="small muted">{s.d}</p></div>
          </li>
        ))}
      </ol>
      {(job.problems.length > 0 || job.error_code) && (
        <section class="notice bad">
          <p><b>What failed</b></p>
          <ul class="small">
            {job.problems.map((p) => <li><a href={`/docs/errors#${p.code}`}><code>{p.code}</code></a>{p.path && <> at <code>{p.path}</code></>}: {p.message}{p.hint && <span class="muted"> Fix: {p.hint}</span>}</li>)}
            {job.problems.length === 0 && job.error_code && <li><a href={`/docs/errors#${job.error_code}`}><code>{job.error_code}</code></a>{job.error_detail && <>: {job.error_detail}</>}</li>}
          </ul>
          {job.problems.length === 0 && job.error_code === "internal_error"
            ? <p class="small">Something failed on the registry's side; there is nothing to fix in your {job.method === "direct" ? "package" : "repository"}. {job.method === "direct" ? "Run ot publish again" : job.method === "ci" ? "Run the release workflow again" : "Push the tag again (delete and recreate it, or tag the next version)"}; if it keeps failing, write to <a href="mailto:support@otinstaller.com">support@otinstaller.com</a> with this page's address.</p>
            : <p class="small">Fix it, then {again}. The <a href="/docs/errors">error codes</a> page explains each code.</p>}
        </section>
      )}
      {job.status === "awaiting_review" && <p class="notice warn">Waiting for a reviewer, usually within 3 business days. You get an email either way.</p>}
      <p class="small muted"><a href="/dashboard">Back to the dashboard</a></p>
    </div>
  );
}
