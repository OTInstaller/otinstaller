#!/bin/sh
# Looks up an IP address with the ipdata CLI. The key comes from IPDATA_API_KEY (set with `ot keys set IPDATA_API_KEY`)
# and is written only to the container's temporary home directory, because the CLI reads it only from ~/.ipdata
# (`ipdata init` would spend a lookup checking it).
set -eu
if [ -z "${IPDATA_API_KEY:-}" ]; then
  echo "IPDATA_API_KEY is not set" >&2
  exit 3
fi
printf '%s' "$IPDATA_API_KEY" > "$HOME/.ipdata"
exec ipdata lookup "$1"
