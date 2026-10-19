#!/usr/bin/env bash
# End-to-end check with a real container engine: build the example tool, push it to a local
# registry so it gets a real digest, then validate, smoke-test and run it with ot.
set -euo pipefail
cd "$(dirname "$0")/.."

docker info >/dev/null 2>&1 || { echo "Docker is not running; start Docker Desktop first." >&2; exit 5; }
(cd cli && go build -o ../bin/ot ./cmd/ot)
OT=./bin/ot
export OT_HOME="$(mktemp -d)" OT_NO_TELEMETRY=1

docker inspect ot-e2e-registry >/dev/null 2>&1 || docker run -d --rm --name ot-e2e-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
docker build -q -t localhost:5000/osintverse/dns-lookup:0.1.0 examples/dns-lookup >/dev/null
docker push -q localhost:5000/osintverse/dns-lookup:0.1.0 >/dev/null
IMAGE=$(docker inspect --format '{{index .RepoDigests 0}}' localhost:5000/osintverse/dns-lookup:0.1.0)
sed "s|__IMAGE__|${IMAGE}|" examples/dns-lookup/otinstaller.yaml.tmpl > examples/dns-lookup/otinstaller.yaml

$OT validate examples/dns-lookup
$OT validate --smoke examples/dns-lookup
$OT run examples/dns-lookup/otinstaller.yaml --domain example.com --format table
$OT list
echo "e2e passed"
