// /{ns}/{name}/claim: the upstream owner of a community wrapper claims it.
import { useState } from "preact/hooks";
import { api } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe } from "./shared";

interface Transfer {
  id: string;
  status: string;
  to: string;
  upstream_url?: string;
  verification?: string;
  verification_error?: string;
  claim_file?: string;
  claim_token?: string;
  instructions?: string;
}

export default function ClaimFlow({ refName, upstream, back }: { refName: string; upstream: string | null; back: string }) {
  const me = useMe();
  const [to, setTo] = useState("");
  const [claim, setClaim] = useState<Transfer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (me === null) return <Loading what="your account" />;
  if (me === false) return <SignIn back={back} why="Sign in with the GitHub or GitLab account that maintains the upstream project." />;
  const owned = me.namespaces.filter((n) => n.role === "owner" && n.status !== "rejected" && n.status !== "suspended");

  const run = async (fn: () => Promise<Transfer>) => {
    setBusy(true);
    setError(null);
    try {
      const t = await fn();
      setClaim((c) => ({ ...c, ...t, claim_token: t.claim_token ?? c?.claim_token }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const start = (e: Event) => {
    e.preventDefault();
    run(() => api<Transfer>(`/tools/${refName}/claim`, { method: "POST", body: JSON.stringify({ to: to || owned[0]?.name }) }));
  };
  const verify = () => run(() => api<Transfer>(`/transfers/${claim!.id}/verify`, { method: "POST", body: "{}" }));

  if (claim) {
    return (
      <div class="stack">
        <p>Claim <code>{claim.id}</code> for <strong>{claim.to}</strong>: <Status value={claim.status} /></p>
        {claim.status === "verified"
          ? <p class="notice">Verified{claim.verification === "claim_file" ? " with the claim file" : " through your linked account"}. An admin completes the move, usually within 1 business day. You'll get an email.</p>
          : (
            <>
              {claim.verification_error && <p class="notice warn">Not verified yet: {claim.verification_error}</p>}
              <p>Prove you maintain <a href={claim.upstream_url}>{claim.upstream_url}</a> in one of two ways:</p>
              <ol>
                <li>Sign in with an account that is an admin (GitHub) or Maintainer (GitLab) of it, then verify again.</li>
                <li>Commit a file named <code>{claim.claim_file}</code> to its default branch containing only this token{claim.claim_token
                  ? <>: <code>{claim.claim_token}</code> (shown once; keep it until you verify)</>
                  : " (the one shown when you started the claim)"}.</li>
              </ol>
              <ErrorNote error={error} />
              <button class="btn btn-primary" type="button" onClick={verify} disabled={busy}>Verify again</button>
            </>
          )}
      </div>
    );
  }

  return (
    <form class="stack" onSubmit={start}>
      <p>This package wraps <a href={upstream ?? "#"}>{upstream ?? "an upstream project"}</a>. If you maintain that project, you can take the package over with its full history, stars and installs. The old address keeps working.</p>
      {owned.length === 0
        ? <p class="notice warn">You need a namespace first: install the OTInstaller GitHub App on your account, or <a href="/import">import a repository</a>.</p>
        : (
          <>
            <label for="to">Move it to</label>
            <select id="to" value={to || owned[0]!.name} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>
              {owned.map((n) => <option value={n.name}>{n.name}</option>)}
            </select>
            <ErrorNote error={error} />
            <button class="btn btn-primary" type="submit" disabled={busy}>Start the claim</button>
          </>
        )}
    </form>
  );
}
