#!/usr/bin/env bash
# Checks against real artifacts through the local registry API:
#   1. sigstore/cosign             real keyless-signed image, correct signer  -> installs
#   2. sigstore/cosign-wrong-signer same image, wrong recorded signer          -> refused (exit 4)
#   3. osintverse-community/tldextract real PyPI wheel, hash-checked           -> installs and runs
#   4. tldextract with a tampered wheel hash                                    -> refused (exit 4)
# Needs Docker running, cosign on PATH, and the API running: (cd api && npm run db:seed && npm run dev)
set -uo pipefail
cd "$(dirname "$0")/.."
command -v cosign >/dev/null || { echo "cosign is not on PATH" >&2; exit 5; }
curl -sf http://127.0.0.1:8787/v1/health >/dev/null || { echo "start the API first: cd api && npm run dev" >&2; exit 5; }
(cd cli && go build -o ../bin/ot ./cmd/ot)
OT=./bin/ot
export OT_API_URL=http://127.0.0.1:8787/v1 OT_HOME="$(mktemp -d)" OT_NO_TELEMETRY=1
fail=0
expect() { # expect <wanted-exit> <label> <cmd...>
  local want=$1 label=$2; shift 2
  "$@" >"$OT_HOME/out.log" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then echo "ok   $label"; else echo "FAIL $label (exit $got, wanted $want)"; tail -5 "$OT_HOME/out.log"; fail=1; fi
}
expect 0 "signed image installs"            $OT install sigstore/cosign
expect 0 "signed image runs"                $OT run sigstore/cosign --subcommand version
expect 4 "wrong signer is refused"          $OT install sigstore/cosign-wrong-signer
expect 0 "PyPI wheel installs"              $OT install osintverse-community/tldextract
expect 0 "PyPI tool runs"                   $OT run osintverse-community/tldextract --url https://maps.google.co.uk
sed 's/7f02aed3/0f02aed3/' examples/tldextract/otinstaller.yaml > "$OT_HOME/tampered.yaml"
expect 4 "tampered wheel hash is refused"   $OT install "$OT_HOME/tampered.yaml"
exit $fail
