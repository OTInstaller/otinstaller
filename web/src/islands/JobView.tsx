// /dashboard/publish/{jobId}: one publish job as a timeline (validate → scan → review → publish), with every
// problem and its fix. The commit status "Details" link on the tag points here.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe, when } from "./shared";

interface Job {
  id: string;
  repo: string;
  tag: string;
  status: string;
  error_code: string | null;
  problems: { code: string; path?: string; message: string; hint?: string }[];
  created_at: number;
  updated_at: number;
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
    api<{ jobs: Job[] }>("/me/publish-jobs").then((r) => setJob(r.jobs.find((j) => j.id === jobId) ?? null), setError);
  }, [me]);
  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in to see this publish job." />;
  if (job === undefined) return <><ErrorNote error={error} /><Loading what="the job" /></>;
  if (job === null) return <p class="notice">No publish job {jobId} among your namespaces' recent releases. <a href="/dashboard">Back to the dashboard</a>.</p>;

  const failed = ["error", "rejected", "failed"].includes(job.status);
  const stageIndex = job.status === "queued" ? -1 : Math.max(0, STAGES.findIndex((s) => s.key === job.status));
  const reached = (i: number) => (job.status === "published" ? true : failed ? i <= stageIndex : i < stageIndex);
  const current = (i: number) => !failed && job.status !== "published" && i === stageIndex;

  return (
    <div class="stack job">
      <dl class="kv">
        <dt>Repository</dt><dd>{job.repo}</dd>
        <dt>Tag</dt><dd><code>{job.tag}</code></dd>
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
            {job.problems.length === 0 && job.error_code && <li><a href={`/docs/errors#${job.error_code}`}><code>{job.error_code}</code></a></li>}
          </ul>
          <p class="small">Fix it, then push a new tag (the same version cannot be reused once a job ran for it). The <a href="/docs/errors">error codes</a> page explains each code.</p>
        </section>
      )}
      {job.status === "awaiting_review" && <p class="notice warn">Waiting for a reviewer, usually within 3 business days. You get an email either way.</p>}
      <p class="small muted"><a href="/dashboard">Back to the dashboard</a></p>
    </div>
  );
}
