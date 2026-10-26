#!/usr/bin/env bash
# Keeps the two repositories that are copies of folders here in step with their source:
#
#   agent-plugin   integrations/agent-plugin/   ->  OTInstaller/agent-plugin   (the repository's root)
#   registry-ops   ops/scanner/                 ->  OTInstaller/registry-ops   ops/scanner/
#                  ops/workflows/               ->                             .github/workflows/
#
# It compares committed git objects, never working files, so a Windows checkout's CRLF endings don't count as a
# difference. It never pushes; .github/workflows/copies.yml does that.
#
#   scripts/copies.sh check   <agent-plugin|registry-ops> <clone of the copy>
#       exit 0: in step (or, for the plugin, a new version is waiting to be published)
#       exit 1: out of step (registry-ops: the copy is stale; plugin: files changed without a version bump)
#   scripts/copies.sh publish <agent-plugin|registry-ops> <clone of the copy>
#       copies the source into the clone and commits ("Release X.Y.Z" plus the tag vX.Y.Z for the plugin)
#
# The source is this repository's HEAD, or SOURCE_REF (setup.ps1 passes origin/main).
set -euo pipefail
ref=${SOURCE_REF:-HEAD}

usage() { echo "usage: $0 check|publish agent-plugin|registry-ops <clone>" >&2; exit 2; }
[ $# -eq 3 ] || usage
action=$1 target=$2 clone=$3
case "$action" in check|publish) ;; *) usage ;; esac
case "$target" in agent-plugin|registry-ops) ;; *) usage ;; esac
git -C "$clone" rev-parse --git-dir >/dev/null 2>&1 || { echo "$clone is not a git clone" >&2; exit 2; }
cd "$(dirname "$0")/.."

# "<blob> <path>" for every file, at the paths the copy uses.
source_files() {
  if [ "$target" = agent-plugin ]; then
    git ls-tree -r "$ref":integrations/agent-plugin | awk -F'\t' '{split($1, a, " "); print a[3], $2}'
  else
    git ls-tree -r "$ref":ops/scanner | awk -F'\t' '{split($1, a, " "); print a[3], "ops/scanner/" $2}'
    git ls-tree -r "$ref":ops/workflows | awk -F'\t' '{split($1, a, " "); print a[3], ".github/workflows/" $2}'
  fi | sort
}
copy_files() {
  if [ "$target" = agent-plugin ]; then
    git -C "$clone" ls-tree -r HEAD
  else
    git -C "$clone" ls-tree -r HEAD ops/scanner .github/workflows
  fi | awk -F'\t' '{split($1, a, " "); print a[3], $2}' | sort
}
plugin_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1; }

src=$(mktemp) dst=$(mktemp)
trap 'rm -f "$src" "$dst"' EXIT
source_files >"$src"
copy_files >"$dst"
changed=$(comm -3 "$src" "$dst" | awk '{print $2}' | sort -u)

if [ "$target" = agent-plugin ]; then
  version=$(git show "$ref":integrations/agent-plugin/.claude-plugin/plugin.json | plugin_version)
  cursor=$(git show "$ref":integrations/agent-plugin/.cursor-plugin/plugin.json | plugin_version)
  published=$(git -C "$clone" show HEAD:.claude-plugin/plugin.json 2>/dev/null | plugin_version || true)
  if [ "$version" != "$cursor" ]; then
    echo "error: .claude-plugin/plugin.json says $version but .cursor-plugin/plugin.json says $cursor" >&2
    exit 1
  fi
fi

if [ "$action" = check ]; then
  if [ -z "$changed" ]; then
    echo "$target is in step with this repository"
    exit 0
  fi
  echo "$target differs from this repository in:"
  printf '  %s\n' $changed
  if [ "$target" = agent-plugin ]; then
    if [ "$version" = "$published" ]; then
      echo "error: these files changed after $version was published; bump version in both plugin.json files" >&2
      exit 1
    fi
    echo "$version is ready to publish (OTInstaller/agent-plugin has ${published:-nothing})"
    exit 0
  fi
  echo "error: registry-ops runs an older copy; publish it (Actions > copies > Run workflow)" >&2
  exit 1
fi

# publish
if [ -z "$changed" ]; then
  echo "$target is already in step; nothing to publish"
  exit 0
fi
if [ "$target" = agent-plugin ]; then
  if [ "$version" = "$published" ]; then
    echo "error: $version is already published; bump version in both plugin.json files first" >&2
    exit 1
  fi
  if git -C "$clone" rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    echo "error: OTInstaller/agent-plugin already has the tag v$version" >&2
    exit 1
  fi
  find "$clone" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  git archive "$ref":integrations/agent-plugin | tar -x -C "$clone"
  git -C "$clone" add -A
  git -C "$clone" commit -q -m "Release $version"
  git -C "$clone" tag -a "v$version" -m "Release $version"
  echo "committed and tagged v$version in $clone"
else
  rm -rf "$clone/ops/scanner" "$clone/.github/workflows"
  mkdir -p "$clone/ops/scanner" "$clone/.github/workflows"
  git archive "$ref":ops/scanner | tar -x -C "$clone/ops/scanner"
  git archive "$ref":ops/workflows | tar -x -C "$clone/.github/workflows"
  git -C "$clone" add -A ops/scanner .github/workflows
  git -C "$clone" commit -q -m "Copy ops/ from OTInstaller/otinstaller@$(git rev-parse --short "$ref")"
  echo "committed the copy in $clone"
fi
