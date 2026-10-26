#!/bin/sh
# Installs ot, the OTInstaller Registry CLI, on macOS and Linux:
#
#   curl -fsSL https://get.otinstaller.com/ot | sh
#
# Downloads the latest release for this machine, checks its SHA-256 against checksums.txt, checks
# checksums.txt against the ot release key (when openssl is available), and installs to OT_INSTALL_DIR
# (default /usr/local/bin, or ~/.local/bin without write access there).
set -eu

REPO="${OT_RELEASE_REPO:-otinstaller/ot}"
# Base64 Ed25519 public key; the release workflow fills it in.
PUBLIC_KEY="__OT_RELEASE_PUBLIC_KEY__"

say() { printf '%s\n' "$*" >&2; }
fail() { say "error: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need curl
need tar
need uname

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac

# The latest release: get.otinstaller.com answers for the default repository without GitHub's API limit (60 requests
# an hour per address, shared by everyone behind the same one); GitHub's API is the fallback.
latest_tag() {
  case "$REPO" in
    [Oo][Tt][Ii][Nn][Ss][Tt][Aa][Ll][Ll][Ee][Rr]/ot)
      t="$(curl -fsSL https://get.otinstaller.com/ot/latest 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1)" || t=""
      if [ -n "$t" ]; then printf '%s\n' "$t"; return; fi
      ;;
  esac
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
}
tag="${OT_VERSION:-$(latest_tag)}"
[ -n "$tag" ] || fail "could not find the latest release of $REPO"
version="${tag#v}"
archive="ot_${version}_${os}_${arch}.tar.gz"
# OT_DOWNLOAD_BASE serves a release from elsewhere (the CI install test uses a local server); the checksum and
# signature checks below still apply.
base="${OT_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/$tag}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say "Downloading ot $tag for $os/$arch..."
curl -fsSL -o "$tmp/$archive" "$base/$archive"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
curl -fsSL -o "$tmp/checksums.txt.sig" "$base/checksums.txt.sig"

# An openssl that can check Ed25519 signatures. macOS ships LibreSSL, which can't, so Homebrew's OpenSSL 3 is tried too.
ed25519_openssl() {
  for o in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    if command -v "$o" >/dev/null 2>&1 && "$o" genpkey -algorithm ed25519 >/dev/null 2>&1; then
      echo "$o"
      return
    fi
  done
}

case "$PUBLIC_KEY" in
  __*) say "warning: this copy of the script has no release key; only the checksum is checked" ;;
  *)
    ssl="$(ed25519_openssl)"
    if [ -n "$ssl" ]; then
      # Ed25519 SubjectPublicKeyInfo: a fixed 12-byte prefix, then the 32-byte key.
      { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; printf '%s' "$PUBLIC_KEY" | "$ssl" base64 -d -A; } > "$tmp/key.der"
      "$ssl" pkey -pubin -inform DER -in "$tmp/key.der" -out "$tmp/key.pem" 2>/dev/null || fail "the release key in this script is malformed"
      "$ssl" pkeyutl -verify -pubin -inkey "$tmp/key.pem" -rawin -in "$tmp/checksums.txt" -sigfile "$tmp/checksums.txt.sig" >/dev/null 2>&1 \
        || fail "checksums.txt is not signed by the ot release key"
      say "Signature verified."
    else
      say "warning: no openssl with Ed25519 support (OpenSSL 3) found; only the checksum is checked"
    fi
    ;;
esac

want="$(grep "  $archive\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$want" ] || fail "checksums.txt has no entry for $archive"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"; fi
[ "$want" = "$got" ] || fail "$archive does not match its checksum"

tar -xzf "$tmp/$archive" -C "$tmp" ot
dir="${OT_INSTALL_DIR:-/usr/local/bin}"
if [ ! -w "$dir" ] && [ -z "${OT_INSTALL_DIR:-}" ]; then
  dir="$HOME/.local/bin"
  mkdir -p "$dir"
fi
install -m 0755 "$tmp/ot" "$dir/ot" 2>/dev/null || { cp "$tmp/ot" "$dir/ot" && chmod 0755 "$dir/ot"; }
say "Installed ot $tag to $dir/ot."
case ":$PATH:" in *":$dir:"*) ;; *) say "Add $dir to your PATH to run ot." ;; esac
say "Next: ot start (pick tools and settings), or ot doctor to check your setup"
