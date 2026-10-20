// /transfers/{id}: the receiving owner accepts or declines a transfer; either side can see where it stands.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../lib/api";
import { ErrorNote, Loading, SignIn, Status, useMe } from "./shared";

interface Transfer {
  id: string;
  kind: "claim" | "transfer";
  status: string;
  ref: string;
  from: string;
  to: string;
  requested_by: string;
  verification_error?: string;
}

export default function TransferView({ id, back }: { id: string; back: string }) {
  const me = useMe();
  const [t, setT] = useState<Transfer | null | false>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (me) api<Transfer>(`/transfers/${encodeURIComponent(id)}`).then(setT, (e) => (e instanceof ApiError && e.status === 404 ? setT(false) : setError(e)));
  }, [me]);

  if (me === null || (me && t === null && !error)) return <Loading what="the transfer" />;
  if (me === false) return <SignIn back={back} why="Sign in to see this transfer." />;
  if (t === false) return <p class="notice">No such transfer, or you are not part of it.</p>;
  if (!t) return <ErrorNote error={error} />;

  const act = async (action: "accept" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Transfer & { ref?: string }>(`/transfers/${t.id}/${action}`, { method: "POST", body: "{}" });
      setDone(action === "accept" ? `Done: the package is now ${r.ref}.` : "Declined.");
      setT({ ...t, status: action === "accept" ? "completed" : "declined" });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const receiving = me.namespaces.some((n) => n.name === t.to && n.role === "owner");

  return (
    <div class="stack">
      <p>{t.kind === "claim" ? "Claim" : "Transfer"} of <a href={`/${t.ref}`}>{t.ref}</a> from <strong>{t.from}</strong> to <strong>{t.to}</strong>, requested by {t.requested_by}: <Status value={t.status} /></p>
      {done && <p class="notice" role="status">{done}</p>}
      {t.kind === "transfer" && t.status === "pending" && receiving && (
        <>
          <p>Accepting moves the package, its versions, stars and installs into <strong>{t.to}</strong>. Its old address keeps working.</p>
          <div class="row">
            <button class="btn btn-primary" type="button" disabled={busy} onClick={() => act("accept")}>Accept</button>
            <button class="btn" type="button" disabled={busy} onClick={() => act("decline")}>Decline</button>
          </div>
        </>
      )}
      {t.status === "pending" && !receiving && <button class="btn" type="button" disabled={busy} onClick={() => act("decline")}>Withdraw</button>}
      <ErrorNote error={error} />
    </div>
  );
}
