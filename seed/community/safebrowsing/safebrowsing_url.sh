#!/bin/sh
# Checks a URL with the pysafebrowsing CLI. The key comes from SAFEBROWSING_API_KEY (set with
# `ot keys set SAFEBROWSING_API_KEY`) and is written only to the container's temporary home directory, because the CLI
# reads it from its config file. Writing the file here keeps the key out of argv and off stdout.
set -eu
if [ -z "${SAFEBROWSING_API_KEY:-}" ]; then
  echo "SAFEBROWSING_API_KEY is not set" >&2
  exit 3
fi
mkdir -p "$HOME/.config"
printf '[SafeBrowsing]\nkey = %s\n' "$SAFEBROWSING_API_KEY" > "$HOME/.config/safebrowsing"
exec safebrowsing url --json "$1"
