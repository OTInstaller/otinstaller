#!/usr/bin/env bash
# Week 11 exit test: with the original registry blocked, ot installs a seeded package from the mirror with its
# signature verified; and a git bundle restores into an empty repository on the other host.
#
#   1. Starts the registry API and the mirror Worker locally (wrangler dev, one shared local state) and seeds the API.
#   2. Copies the seeded sigstore/cosign image (keyless-signed) into a local registry that plays its "original
#      registry", and points the seeded package at it. Its source repository is a local repository playing GitHub.
#   3. Runs the scanner's backup job (ops/scanner/scan.py) as registry-ops would: crane copy + signatures to the
#      mirror, the tldextract wheel and a git bundle through signed upload URLs, then the report.
#   4. Blocks the original registry (it now answers 403 DENIED) and removes tldextract from "PyPI", then runs
#      `ot install`: the image comes from the mirror (cosign verifies the same signature) and the wheel from the
#      registry's copy (same SHA-256).
#   5. Gets the owner's Restore from backup link, and restores the bundle into an empty repository ("GitLab").
#
# Needs Docker, cosign, crane, git, Go, Node and Python. Uses ports 8787 (API), 8788 (mirror, through a proxy
# container so the Docker daemon can reach it), 8789 (mirror Worker) and 5001 (the "original" registry).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
for tool in docker cosign crane git go node python; do command -v "$tool" >/dev/null || { echo "$tool is not on PATH" >&2; exit 5; }; done

WORK=$(mktemp -d)
mixed() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
WORKM=$(mixed "$WORK")
STATE="$WORKM/state"
PUSH_TOKEN="e2e-push-$RANDOM$RANDOM"
ENC_KEY=$(python -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())")
API=http://127.0.0.1:8787
MIRROR=127.0.0.1:8788
IMG=ghcr.io/sigstore/cosign/cosign@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8
DIGEST=${IMG#*@}
ORIGINAL=127.0.0.1:5001/sigstore/cosign
PIDS=()
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  docker rm -f ot-e2e-original ot-e2e-mirror-proxy >/dev/null 2>&1
  [ "$fail" = 0 ] && rm -rf "$WORK" || echo "work files kept in $WORK"
}
trap cleanup EXIT

wait_for() { # wait_for <url> <what>
  for _ in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 2; done
  echo "$2 did not start" >&2; exit 5
}

echo "== starting the API and the mirror (state in $STATE)"
(cd api && npx wrangler d1 migrations apply otinstaller --local --persist-to "$STATE" >"$WORK/migrate.log" 2>&1 \
  && node scripts/seed.mjs >/dev/null && npx wrangler d1 execute otinstaller --local --persist-to "$STATE" --file=.wrangler/seed.sql >"$WORK/seed.log" 2>&1) \
  || { cat "$WORK/migrate.log" "$WORK/seed.log"; exit 5; }
(cd api && exec npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$STATE" --inspector-port 9331 \
  --var "API_URL:$API" --var "MIRROR_HOST:$MIRROR" --var "TOKEN_ENC_KEY:$ENC_KEY" >"$WORK/api.log" 2>&1) &
PIDS+=($!)
(cd api && exec npx wrangler dev -c wrangler.mirror.jsonc --port 8789 --ip 127.0.0.1 --persist-to "$STATE" --inspector-port 9332 \
  --var "MIRROR_PUSH_TOKEN:$PUSH_TOKEN" >"$WORK/mirror.log" 2>&1) &
PIDS+=($!)
# The Docker daemon runs in a VM where localhost is not this machine; a proxy container publishes the mirror there.
cat >"$WORK/proxy.conf" <<'EOF'
server {
  listen 8788;
  client_max_body_size 0;
  location / {
    proxy_pass http://host.docker.internal:8789;
    proxy_set_header Host $http_host;
    proxy_request_buffering off;
    proxy_buffering off;
  }
}
EOF
docker rm -f ot-e2e-mirror-proxy >/dev/null 2>&1
docker run -d --name ot-e2e-mirror-proxy -p 8788:8788 -v "$WORKM/proxy.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null || exit 5
wait_for "$API/v1/health" "the API"
wait_for "http://$MIRROR/" "the mirror"

sql() { # runs SQL statements from a file (wrangler's --command runs only the first of several)
  printf '%s
' "$1" >"$WORK/stmt.sql"
  (cd api && npx wrangler d1 execute otinstaller --local --persist-to "$STATE" --file "$WORKM/stmt.sql" >>"$WORK/sql.log" 2>&1)
}

echo "== the original registry and the source repository"
docker rm -f ot-e2e-original >/dev/null 2>&1
docker run -d --name ot-e2e-original -p 5001:5000 registry:2 >/dev/null || exit 5
wait_for "http://127.0.0.1:5001/v2/" "the original registry"
crane copy "$IMG" "$ORIGINAL@$DIGEST" >"$WORK/crane.log" 2>&1 || { cat "$WORK/crane.log"; exit 1; }
SIGTAG="sha256-${DIGEST#sha256:}"
crane copy "ghcr.io/sigstore/cosign/cosign:$SIGTAG" "$ORIGINAL:$SIGTAG" >>"$WORK/crane.log" 2>&1 || { cat "$WORK/crane.log"; exit 1; }
cosign verify --certificate-identity keyless@projectsigstore.iam.gserviceaccount.com --certificate-oidc-issuer https://accounts.google.com \
  "$ORIGINAL@$DIGEST" >/dev/null 2>"$WORK/verify-original.log" && ok "the original registry serves the signed image" || { bad "signature on the original registry"; cat "$WORK/verify-original.log"; }

SRC="$WORK/github/sigstore-cosign"
mkdir -p "$SRC" && git -C "$SRC" init -q -b main
gitc() { git -C "$SRC" -c user.name=e2e -c user.email=e2e@example.com "$@"; }
echo "# cosign wrapper" >"$SRC/README.md"; gitc add . && gitc commit -qm "first release" && gitc tag v3.1.3
gitc checkout -qb feature && echo "wip" >"$SRC/wip.txt" && gitc add . && gitc commit -qm "work between releases" && gitc checkout -q main
SRC_URL="file:///$(mixed "$SRC" | sed 's#^/##')"

ADMIN_TOKEN="ot_e2e_admin_$RANDOM$RANDOM"
TOKEN_HASH=$(printf '%s' "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)
sql "INSERT INTO users (id, login, email, is_admin, created_at) VALUES ('usr_e2e', 'e2e-owner', 'e2e@example.com', 1, 0);
     INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES ('tok_e2e', 'usr_e2e', 'e2e', '$TOKEN_HASH', 0);
     INSERT OR IGNORE INTO namespace_members (namespace_id, user_id, role) VALUES ('ns_sigstore', 'usr_e2e', 'owner');
     UPDATE versions SET manifest_json = json_set(manifest_json, '\$.runtime.image', '$ORIGINAL@$DIGEST')
       WHERE tool_id = (SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = 'sigstore' AND t.name = 'cosign');
     INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url, visibility, sync_status, created_at)
       SELECT 'src_e2e_cosign', t.id, t.namespace_id, 'github', 'e2e-cosign', 'sigstore/cosign', '$SRC_URL', 'public', 'ok', 0
       FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = 'sigstore' AND t.name = 'cosign';" || { cat "$WORK/sql.log"; exit 1; }
AUTH=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json")

echo "== the scanner's backup jobs"
export DOCKER_CONFIG="$WORKM/docker-config"   # crane and cosign log in here, not in your own Docker config
mkdir -p "$DOCKER_CONFIG"
printf '%s' "$PUSH_TOKEN" | crane auth login "$MIRROR" -u scanner --password-stdin >/dev/null 2>&1 || { bad "crane auth login to the mirror"; exit 1; }
backup_job() { # backup_job <ns/name> <version>
  curl -sf "${AUTH[@]}" -X POST "$API/v1/admin/tools/$1/$2/backup" -d '{"dispatch":false}' >"$WORK/job.json" || { bad "creating the backup job for $1"; return 1; }
  python -c "import json,sys;j=json.load(open(sys.argv[1]));sys.exit(0 if j.get('job') else 1)" "$WORK/job.json" || { bad "no backup job for $1: $(cat "$WORK/job.json")"; return 1; }
  # One blob upload at a time: local workerd drops concurrent upload finishes (the deployed mirror does not).
  CRANE_JOBS=1 MIRROR_PUSH_TOKEN="$PUSH_TOKEN" python ops/scanner/scan.py "$WORK/job.json" >"$WORK/backup-${1//\//-}.log" 2>&1 \
    && ok "scanner backed up $1 $2" || { bad "scanner backup of $1"; tail -20 "$WORK/backup-${1//\//-}.log"; }
}
backup_job sigstore/cosign 3.1.3
backup_job osintverse-community/tldextract 5.4.0
unset DOCKER_CONFIG

stored=$(curl -sf "${AUTH[@]}" "$API/v1/packages/sigstore/cosign/backups")
echo "$stored" | python -c "import json,sys;b=json.load(sys.stdin)['backups'];s={x['kind']:x['status'] for x in b};print('     backups:',s);sys.exit(0 if s.get('image')=='stored' and s.get('git')=='stored' else 1)" \
  && ok "image and git bundle recorded as stored" || bad "backups not stored: $stored"
curl -sf "http://$MIRROR/v2/sigstore/cosign/manifests/$SIGTAG" -o /dev/null -w '%{http_code}' -H "Accept: application/vnd.oci.image.index.v1+json" >/dev/null \
  && ok "the signature tag is on the mirror" || bad "the signature tag is missing on the mirror"

echo "== block the original registry and remove the wheel from PyPI"
docker rm -f ot-e2e-original >/dev/null
cat >"$WORK/blocked.conf" <<'EOF'
server {
  listen 5000;
  default_type application/json;
  location / { return 403 '{"errors":[{"code":"DENIED","message":"repository is disabled"}]}'; }
}
EOF
docker run -d --name ot-e2e-original -p 5001:5000 -v "$WORKM/blocked.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
sleep 2
docker rmi -f "$ORIGINAL@$DIGEST" "$MIRROR/sigstore/cosign@$DIGEST" >/dev/null 2>&1
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:5001/v2/sigstore/cosign/manifests/$DIGEST")
[ "$code" = 403 ] && ok "the original registry now answers 403 DENIED" || bad "the original registry answered $code"
# "PyPI no longer has it": the manifest now names a project PyPI does not know; the hash is unchanged.
sql "UPDATE versions SET manifest_json = json_set(manifest_json, '\$.runtime.package', 'tldextract-removed-from-pypi-e2e')
     WHERE tool_id = (SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = 'osintverse-community' AND t.name = 'tldextract');"

echo "== ot install"
(cd cli && go build -o ../bin/ot ./cmd/ot) || exit 1
export OT_API_URL="$API/v1" OT_HOME="$WORKM/ot-home" OT_NO_TELEMETRY=1
./bin/ot install sigstore/cosign </dev/null >"$WORK/install.log" 2>&1
if [ $? = 0 ] && grep -q "OTInstaller mirror" "$WORK/install.log" && ! grep -q "not verified" "$WORK/install.log"; then
  ok "ot installed sigstore/cosign from the mirror, signature verified"
else bad "ot install from the mirror"; cat "$WORK/install.log"; fi
./bin/ot run sigstore/cosign --subcommand version </dev/null >"$WORK/run.log" 2>&1 && ok "the mirrored image runs" || { bad "running the mirrored image"; tail -5 "$WORK/run.log"; }
./bin/ot install osintverse-community/tldextract </dev/null >"$WORK/install-wheel.log" 2>&1
if [ $? = 0 ] && grep -q "backup copy" "$WORK/install-wheel.log"; then ok "ot installed tldextract from the registry's wheel copy (same SHA-256)"
else bad "wheel fallback"; cat "$WORK/install-wheel.log"; fi
./bin/ot run osintverse-community/tldextract --url https://maps.google.co.uk </dev/null >"$WORK/run-wheel.log" 2>&1 && ok "the restored wheel runs" || { bad "running tldextract"; tail -5 "$WORK/run-wheel.log"; }

echo "== restore from backup onto the other host"
curl -sf "${AUTH[@]}" -X POST "$API/v1/packages/sigstore/cosign/backups/restore" >"$WORK/restore.json" || { bad "restore link"; cat "$WORK/restore.json"; }
url=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['url'])" "$WORK/restore.json")
curl -sfLo "$WORK/cosign.bundle" "$url" && ok "downloaded the latest bundle" || bad "bundle download"
OTHER="$WORK/gitlab/cosign.git"
git init -q --bare "$OTHER"
git bundle verify "$WORK/cosign.bundle" >/dev/null 2>&1 \
  && git clone -q --mirror "$WORK/cosign.bundle" "$WORK/restore.git" \
  && git -C "$WORK/restore.git" push -q --mirror "file:///$(mixed "$OTHER" | sed 's#^/##')" \
  && git -C "$OTHER" fsck --full --no-progress >/dev/null 2>&1 \
  || bad "restoring the bundle"
want=$(git -C "$SRC" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags | sort)
got=$(git -C "$OTHER" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags | sort)
if [ -n "$want" ] && [ "$want" = "$got" ]; then ok "the empty repository on the other host has every branch and tag ($(echo "$want" | wc -l | tr -d ' ') refs)"
else bad "restored refs differ"; echo "want: $want"; echo "got:  $got"; fi

exit $fail
