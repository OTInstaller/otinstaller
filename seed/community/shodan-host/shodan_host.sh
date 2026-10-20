#!/bin/sh
# Looks up an IP with the Shodan CLI. The key comes from SHODAN_API_KEY (set with `ot keys set SHODAN_API_KEY`) and is
# written only to the container's temporary home directory.
set -eu
if [ -z "${SHODAN_API_KEY:-}" ]; then
  echo "SHODAN_API_KEY is not set" >&2
  exit 3
fi
shodan init "$SHODAN_API_KEY" >/dev/null
exec shodan host "$1"
