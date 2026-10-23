#!/usr/bin/env bash
# End-to-end check for direct publishing: `ot publish` with the image hosted on the registry's own mirror.
#
#   1. Starts the registry API and the mirror Worker locally (wrangler dev, one shared local state, migrated) and adds
#      two users with tokens.
#   2. `ot namespace create`, builds examples/dns-lookup, runs `ot publish --image ... --dry-run`, then publishes for
#      real: the image goes to the mirror, its digest is pinned in otinstaller.yaml, and the release is uploaded and
#      validated.
#   3. Checks that the pushed image is hidden from anonymous pulls but there for the scanner's credential, and that
#      another user's token can't push into the namespace.
#   4. Plays the scanner: approves the namespace and reports a passing scan, so the version is published and the image
#      released; then `ot install` pulls it from the mirror by digest.
#
# Needs Docker, Go, Node, Python and curl, and network access (namespace names are checked against GitHub and GitLab).
# Uses ports 8787 (API), 8788 (the mirror, through a proxy container so the Docker daemon can reach it) and 8789 (the
# mirror Worker).
set -uo pipefail
cd "$(dirname "$0")/.."
for tool in docker go node python curl; do command -v "$tool" >/dev/null || { echo "$tool is not on PATH" >&2; exit 5; }; done
docker info >/dev/null 2>&1 || { echo "Docker is not running; start Docker Desktop first." >&2; exit 5; }

WORK=$(mktemp -d)
mixed() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
WORKM=$(mixed "$WORK")
STATE="$WORKM/state"
PUSH_TOKEN="e2e-push-$RANDOM$RANDOM"
ENC_KEY=$(python -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())")
API=http://127.0.0.1:8787
MIRROR=127.0.0.1:8788
WORKER=http://127.0.0.1:8789
NS="e2e-direct-$RANDOM$RANDOM"
PIDS=()
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  docker rm -f ot-e2e-direct-proxy >/dev/null 2>&1
  [ "$fail" = 0 ] && rm -rf "$WORK" || echo "work files kept in $WORK"
}
trap cleanup EXIT

wait_for() { # wait_for <url> <what>
  for _ in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 2; done
  echo "$2 did not start" >&2; exit 5
}
sql() { # runs SQL statements from a file (wrangler's --command runs only the first of several)
  printf '%s\n' "$1" >"$WORK/stmt.sql"
  (cd api && npx wrangler d1 execute otinstaller --local --persist-to "$STATE" --file "$WORKM/stmt.sql" >>"$WORK/sql.log" 2>&1)
}
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
basic() { printf 'Basic %s' "$(printf '%s:%s' "$1" "$2" | base64 | tr -d '\n')"; }
mirror_token() { # mirror_token <user> <password> <scope>: a bearer token from the mirror's /token
  curl -sf -H "Authorization: $(basic "$1" "$2")" "$WORKER/token?scope=$3" | python -c "import json,sys;print(json.load(sys.stdin)['token'])"
}

echo "== starting the API and the mirror (state in $STATE)"
(cd api && npx wrangler d1 migrations apply otinstaller --local --persist-to "$STATE" >"$WORK/migrate.log" 2>&1) || { cat "$WORK/migrate.log"; exit 5; }
(cd api && exec npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$STATE" --inspector-port 9341 \
  --var "API_URL:$API" --var "MIRROR_HOST:$MIRROR" --var "TOKEN_ENC_KEY:$ENC_KEY" >"$WORK/api.log" 2>&1) &
PIDS+=($!)
(cd api && exec npx wrangler dev -c wrangler.mirror.jsonc --port 8789 --ip 127.0.0.1 --persist-to "$STATE" --inspector-port 9342 \
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
docker rm -f ot-e2e-direct-proxy >/dev/null 2>&1
docker run -d --name ot-e2e-direct-proxy --add-host host.docker.internal:host-gateway -p 8788:8788 \
  -v "$WORKM/proxy.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null || exit 5
wait_for "$API/v1/health" "the API"
wait_for "http://$MIRROR/" "the mirror"

TOKEN_A="ot_e2e_owner_$RANDOM$RANDOM"
TOKEN_B="ot_e2e_other_$RANDOM$RANDOM"
sql "INSERT INTO users (id, login, email, created_at) VALUES ('usr_e2e_a', 'e2e-owner', 'owner@example.com', 0);
     INSERT INTO users (id, login, email, created_at) VALUES ('usr_e2e_b', 'e2e-other', 'other@example.com', 0);
     INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES ('tok_e2e_a', 'usr_e2e_a', 'e2e', '$(sha "$TOKEN_A")', 'read,publish,manage,feedback', 1, 0);
     INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES ('tok_e2e_b', 'usr_e2e_b', 'e2e', '$(sha "$TOKEN_B")', 'read,publish,manage,feedback', 1, 0);" \
  || { cat "$WORK/sql.log"; exit 1; }

echo "== ot namespace create and ot publish --image"
(cd cli && go build -o ../bin/ot ./cmd/ot) || exit 1
OT="$(pwd)/bin/ot"
export OT_HOME="$WORKM/home" OT_NO_TELEMETRY=1 OT_API_URL="$API/v1" OT_MIRROR_URL="http://$MIRROR" OTINSTALLER_TOKEN="$TOKEN_A"
"$OT" namespace create "$NS" >"$WORK/ns.log" 2>&1 && ok "created the namespace $NS" || { bad "ot namespace create"; cat "$WORK/ns.log"; exit 1; }

PKG="$WORK/pkg"
mkdir -p "$PKG" && cp examples/dns-lookup/Dockerfile examples/dns-lookup/dns_lookup.py examples/dns-lookup/README.md "$PKG/"
# Any pinned digest validates; ot publish --image replaces it with the pushed image's.
sed -e "s|^namespace: .*|namespace: $NS|" -e "s|__IMAGE__|docker.io/library/placeholder@sha256:$(printf '0%.0s' $(seq 1 64))|" \
  examples/dns-lookup/otinstaller.yaml.tmpl >"$PKG/otinstaller.yaml"
docker build -q --platform linux/amd64 -t ot-e2e/dns-lookup:dev "$PKG" >/dev/null || { bad "docker build"; exit 1; }

"$OT" publish --image ot-e2e/dns-lookup:dev --dry-run "$PKG" >"$WORK/dry.log" 2>&1 && grep -q "would upload" "$WORK/dry.log" \
  && ok "the dry run lists the files and pushes nothing" || { bad "ot publish --dry-run"; cat "$WORK/dry.log"; }
"$OT" --json publish --image ot-e2e/dns-lookup:dev "$PKG" >"$WORK/publish.json" 2>"$WORK/publish.log" \
  && ok "ot publish pushed the image and uploaded the release" || { bad "ot publish"; cat "$WORK/publish.log" "$WORK/publish.json"; exit 1; }
status=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['status'])" "$WORK/publish.json")
[ "$status" = scanning ] && ok "the release validated (status scanning)" || bad "the release is $status: $(cat "$WORK/publish.json")"
IMAGE=$(sed -n 's/^  image: *//p' "$PKG/otinstaller.yaml")
DIGEST=${IMAGE#*@}
case "$IMAGE" in "$MIRROR/$NS/dns-lookup@sha256:"*) ok "runtime.image pinned to $IMAGE" ;; *) bad "runtime.image is $IMAGE" ;; esac

# The registry can't reach the scanner from here: record a scan token for the version, as dispatchScan would, and mark
# it dispatched so the queue's retries leave it alone.
SCAN_TOKEN="scan-$RANDOM$RANDOM"
sql "UPDATE versions SET scan_token_hash = '$(sha "$SCAN_TOKEN")', scan_token_expires_at = 9999999999999, scan_dispatched_at = 1
       WHERE status = 'scanning' AND tool_id = (SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = '$NS' AND t.name = 'dns-lookup');" \
  || { cat "$WORK/sql.log"; exit 1; }

echo "== who can see and push the image"
manifest_status() { # manifest_status <bearer token>
  curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "$WORKER/v2/$NS/dns-lookup/manifests/$DIGEST"
}
anon=$(curl -sf "$WORKER/token?scope=repository:$NS/dns-lookup:pull" | python -c "import json,sys;print(json.load(sys.stdin)['token'])")
[ "$(manifest_status "$anon")" = 404 ] && ok "the unreleased image is hidden from anonymous pulls" || bad "anonymous pull of the unreleased image"
scanner=$(mirror_token scanner "$PUSH_TOKEN" "repository:$NS/dns-lookup:pull")
got=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $scanner" -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
  "$WORKER/v2/$NS/dns-lookup/manifests/$DIGEST" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p')
[ "$got" = "$DIGEST" ] && ok "the scanner's credential reads it, digest $DIGEST" || bad "the scanner read digest '$got'"
other=$(mirror_token ot "$TOKEN_B" "repository:$NS/dns-lookup:pull,push")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $other" "$WORKER/v2/$NS/dns-lookup/blobs/uploads/")
[ "$code" = 403 ] && ok "another user's token can't push into $NS" || bad "another user's push answered $code"

echo "== the scan passes, the version is published, ot install pulls it"
sql "UPDATE namespaces SET status = 'active' WHERE name = '$NS';" || { cat "$WORK/sql.log"; exit 1; }
results='{"signature":{"status":"absent"},"vulnerabilities":null,"secrets":{"count":0},"malware":{"count":0},"smoke":{"status":"pass","exit_code":0}}'
curl -sf -X POST -H "Authorization: Bearer $SCAN_TOKEN" -H "Content-Type: application/json" -d "$results" "$API/v1/internal/scans" >"$WORK/scan.json" \
  && python -c "import json,sys;sys.exit(0 if json.load(open(sys.argv[1]))['status']=='published' else 1)" "$WORK/scan.json" \
  && ok "the scan callback published the version" || { bad "the scan callback: $(cat "$WORK/scan.json")"; tail -30 "$WORK/api.log"; }
[ "$(manifest_status "$anon")" = 200 ] && ok "publishing released the image to anonymous pulls" || bad "the image is still hidden after publishing"
unset OTINSTALLER_TOKEN
"$OT" install "$NS/dns-lookup" >"$WORK/install.log" 2>&1 && ok "ot install pulled $NS/dns-lookup from the mirror" || { bad "ot install"; cat "$WORK/install.log"; }
"$OT" list 2>/dev/null | grep -q "$NS/dns-lookup" && ok "ot list shows it" || bad "ot list"

[ "$fail" = 0 ] && echo "e2e-direct passed" || echo "e2e-direct FAILED"
exit "$fail"
