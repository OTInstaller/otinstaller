#!/bin/sh
# Creates (or updates) the labels the beta's bug reports use, with the GitHub CLI:
#
#   sh scripts/beta/labels.sh [owner/repo]      # default OTInstaller/otinstaller
#
# sev-1 is what the admin console's Beta tab counts. Safe to run again.
set -eu
repo="${1:-OTInstaller/otinstaller}"
label() { gh label create "$1" -R "$repo" --color "$2" --description "$3" --force; }

label sev-1 b60205 "Blocks installing, running or publishing, loses data, or the site or API is down"
label sev-2 d93f0b "Broken with a workaround, or one tool or platform"
label sev-3 fbca04 "Minor, cosmetic or docs"
label needs-triage ededed "Not looked at by a maintainer yet"
label beta 5319e7 "Found during the closed beta"
label area:ot 1d76db "The ot CLI"
label area:publishing 1d76db "Publishing, import, sync (GitHub and GitLab)"
label area:site 1d76db "Website, dashboard, admin console"
