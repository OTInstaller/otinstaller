// Proposing a change to a community package, for its maintainers and reviewers: edit the manifest, the Dockerfile or
// the README as they are on the wrapper repository's main branch, say why, and the community bot opens a pull request
// that a reviewer approves. With `number`, the proposer edits their own proposal instead.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, signInUrl, type ChangeProposalDetail, type ProposalFile, type ProposalViewer, type WrapperFiles } from "../lib/api";
import { PROPOSAL_FILES, proposalHref } from "../lib/proposals";
import { ErrorNote, useMe } from "./shared";

interface Props {
  refName: string;
  back: string;
  /** Edit this proposal (its proposer only). */
  number?: number;
  title?: string;
  note?: string | null;
  onSaved?: (p: ChangeProposalDetail) => void;
}

const HELP: Record<ProposalFile, string> = {
  "otinstaller.yaml": "Inputs, command, outputs, keys, ethics and the summary. The name, namespace, homepage, license and readme stay as they are; the version is set for you.",
  Dockerfile: "How the image is built. Official base images pinned by tag, a non-root USER and a readable upstream pin, as for submissions.",
  "README.md": "What the package page shows. Credit the upstream project.",
};

export default function ProposeChange({ refName, back, number, title: title0 = "", note: note0 = "", onSaved }: Props) {
  const me = useMe();
  const [base, setBase] = useState<WrapperFiles | null>(null);
  const [files, setFiles] = useState<Partial<Record<ProposalFile, string>>>({});
  const [title, setTitle] = useState(title0);
  const [note, setNote] = useState(note0 ?? "");
  const [open, setOpen] = useState(!!number);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ChangeProposalDetail | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!me) return;
    (async () => {
      const current = await api<WrapperFiles>(`/packages/${refName}/files`);
      // Editing starts from the proposal's own files; the rest are main's.
      const mine = number ? (await api<ProposalViewer>(`/packages/${refName}/proposals/${number}/viewer`)).files ?? {} : {};
      setBase(current);
      setFiles(Object.fromEntries(PROPOSAL_FILES.filter((f) => current.files[f] !== null).map((f) => [f, mine[f] ?? current.files[f]!])));
    })().catch((e) => (e instanceof ApiError && e.status === 403 ? setAllowed(false) : setError(e)));
  }, [me, refName, number]);

  if (me === false) {
    return number ? null : <p class="small muted">Maintain this package? Sign in with <a href={signInUrl("github", back)}>GitHub</a>, <a href={signInUrl("gitlab", back)}>GitLab</a> or <a href={signInUrl("osintverse", back)}>OSINTverse</a> to propose a change.</p>;
  }
  if (!me || !allowed) return null;
  if (!base) return <ErrorNote error={error} />;
  if (done) {
    return <p class="notice ok small" role="status">{number ? "Saved: the pull request shows the new files, and the reviewers hear about it." : <>Proposed as <a href={proposalHref(refName, done.number)}>#{done.number}</a>. A reviewer will look at it; you'll hear when they do.</>}</p>;
  }
  if (!open) {
    return <p class="row"><button class="btn btn-primary btn-sm" type="button" onClick={() => setOpen(true)}>Propose a change</button><span class="small muted">You maintain this package.</span></p>;
  }

  const changed = PROPOSAL_FILES.filter((f) => files[f] !== undefined && files[f] !== base.files[f]);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ title, note, files });
      const r = number
        ? await api<{ proposal: ChangeProposalDetail }>(`/packages/${refName}/proposals/${number}`, { method: "PATCH", body })
        : await api<{ proposal: ChangeProposalDetail }>(`/packages/${refName}/proposals`, { method: "POST", body });
      setDone(r.proposal);
      onSaved?.(r.proposal);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="card stack propose" onSubmit={submit}>
      <h3>{number ? `Edit proposal #${number}` : "Propose a change"}</h3>
      <p class="small muted">
        The files as they are on <a href={`https://github.com/${base.repo}`} rel="nofollow noopener">{base.repo}</a>. The community bot opens a pull request with
        what you change, and a reviewer who isn't you approves it; the registry then releases {base.next_version}
        {base.builds ? ", built by the release workflow," : ""} signed and scanned like any other release.
      </p>
      <label for="pc-title">What it changes</label>
      <input id="pc-title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} required minLength={5} maxLength={100} placeholder="Add the --json output" />
      <label for="pc-note">Why (shown as plain text)</label>
      <textarea id="pc-note" rows={3} maxLength={2000} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        placeholder="What was wrong or missing, and how you checked the change. Never data about anyone you investigated." />
      {PROPOSAL_FILES.filter((f) => files[f] !== undefined).map((f) => (
        <details open={f === "otinstaller.yaml" || changed.includes(f)}>
          <summary>{f}{changed.includes(f) && <span class="badge info">changed</span>}</summary>
          <p class="small muted">{HELP[f]}</p>
          <textarea aria-label={f} rows={f === "README.md" ? 14 : 18} spellcheck={false} value={files[f]}
            onInput={(e) => setFiles({ ...files, [f]: (e.target as HTMLTextAreaElement).value })} />
          {changed.includes(f) && <p><button class="btn btn-sm btn-ghost" type="button" onClick={() => setFiles({ ...files, [f]: base.files[f]! })}>Undo changes to {f}</button></p>}
        </details>
      ))}
      <p class="row">
        <button class="btn btn-primary" type="submit" disabled={busy || (!number && changed.length === 0) || title.trim().length < 5}>{number ? "Save" : "Open the pull request"}</button>
        {!number && <button class="btn btn-ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>}
        {!number && changed.length === 0 && <span class="small muted">Change at least one file.</span>}
      </p>
      <ErrorNote error={error} />
    </form>
  );
}
