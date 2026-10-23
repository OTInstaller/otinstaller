// Dashboard section: the GitHub Actions workflows and GitLab CI pipelines each namespace I own trusts to publish into it
// (trusted publishing, `ot publish --oidc`), with forms to add and remove them.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { Confirm, ErrorNote, Loading, when } from "./shared";

interface Publisher {
  id: string;
  provider: "github" | "gitlab";
  repository: string;
  workflow: string | null;
  environment: string | null;
  package: string | null;
  // Set once a run has published through it: the repository's id is then recorded.
  pinned: boolean;
  created_by: string | null;
  last_used_at: number | null;
}

const EMPTY = { provider: "github", repository: "", workflow: "", environment: "", package: "" };

export default function TrustedPublishers({ namespaces }: { namespaces: string[] }) {
  const [lists, setLists] = useState<Record<string, Publisher[]> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [ns, setNs] = useState(namespaces[0] ?? "");
  const [form, setForm] = useState(EMPTY);
  const load = () =>
    Promise.all(namespaces.map((n) => api<{ publishers: Publisher[] }>(`/me/namespaces/${n}/trusted-publishers`).then((r) => [n, r.publishers] as const)))
      .then((pairs) => setLists(Object.fromEntries(pairs)), setError);
  useEffect(() => {
    if (namespaces.length) load();
  }, [namespaces.join(",")]);
  if (namespaces.length === 0) return null;

  const field = (k: keyof typeof EMPTY) => (e: Event) => setForm({ ...form, [k]: (e.target as HTMLInputElement | HTMLSelectElement).value });
  async function add(e: Event) {
    e.preventDefault();
    setFormError(null);
    try {
      await api(`/me/namespaces/${ns}/trusted-publishers`, { method: "POST", body: JSON.stringify(form) });
      setForm(EMPTY);
      load();
    } catch (err) {
      setFormError(err);
    }
  }
  async function remove(n: string, id: string) {
    setRemoving(null);
    await api(`/me/namespaces/${n}/trusted-publishers/${id}`, { method: "DELETE" }).catch(setError);
    load();
  }
  const gitlab = form.provider === "gitlab";
  const rows = lists ? namespaces.flatMap((n) => (lists[n] ?? []).map((p) => ({ ns: n, p }))) : [];

  return (
    <section aria-labelledby="tp">
      <h2 id="tp">Trusted publishers</h2>
      <p class="small muted">
        A repository's CI can publish into a namespace you own without the GitHub App, a connected GitLab project or a stored token: it runs{" "}
        <code>ot publish --oidc</code>, and its OIDC ID token proves where it runs. The release workflow from <code>ot init</code> does this when the CI
        variable <code>OTINSTALLER_PUBLISH</code> is <code>oidc</code>. Only public repositories can publish; a repository's id is pinned the first time it does.{" "}
        <a href="/docs/publishing#publish-from-ci">How it works</a>.
      </p>
      <ErrorNote error={error} />
      {lists === null ? <Loading what="trusted publishers" /> : rows.length === 0 ? <p class="muted">None yet.</p> : (
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th scope="col">Namespace</th><th scope="col">Repository</th><th scope="col">Only</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map(({ ns: n, p }) => (
                <tr>
                  <td>{n}</td>
                  <td><code>{p.provider}:{p.repository}</code>{p.created_by && <div class="small muted">added by {p.created_by}</div>}</td>
                  <td class="small">{[p.workflow && `workflow ${p.workflow}`, p.environment && `environment ${p.environment}`, p.package && `package ${p.package}`].filter(Boolean).join(", ") || <span class="muted">any workflow</span>}</td>
                  <td>{when(p.last_used_at)}</td>
                  <td>{removing === p.id
                    ? <Confirm text="Its runs stop publishing at once." confirm="Remove" onConfirm={() => remove(n, p.id)} onCancel={() => setRemoving(null)} />
                    : <button class="btn btn-sm" type="button" onClick={() => setRemoving(p.id)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form class="stack" onSubmit={add}>
        <div class="row">
          {namespaces.length > 1 && (
            <>
              <label for="tp-ns">Namespace</label>
              <select id="tp-ns" value={ns} onChange={(e) => setNs((e.target as HTMLSelectElement).value)}>{namespaces.map((n) => <option value={n}>{n}</option>)}</select>
            </>
          )}
          <label for="tp-provider">Host</label>
          <select id="tp-provider" value={form.provider} onChange={field("provider")}>
            <option value="github">GitHub Actions</option>
            <option value="gitlab">GitLab CI</option>
          </select>
          <label for="tp-repo">Repository</label>
          <input id="tp-repo" type="text" value={form.repository} onInput={field("repository")} placeholder={gitlab ? "group/project" : "owner/repo"} required />
        </div>
        <div class="row">
          <label for="tp-workflow">Workflow</label>
          <input id="tp-workflow" type="text" value={form.workflow} onInput={field("workflow")} placeholder={gitlab ? ".gitlab-ci.yml" : "otinstaller-release.yml"} />
          <label for="tp-env">Environment</label>
          <input id="tp-env" type="text" value={form.environment} onInput={field("environment")} placeholder="optional" />
          <label for="tp-pkg">Package</label>
          <input id="tp-pkg" type="text" value={form.package} onInput={field("package")} placeholder="any" />
          <button class="btn" type="submit">Trust</button>
        </div>
        <p class="small muted">Leave workflow, environment and package empty to allow any. Runs triggered by <code>pull_request_target</code> or merge-request pipelines publish only through a publisher that requires an environment.</p>
      </form>
      <ErrorNote error={formError} />
    </section>
  );
}
