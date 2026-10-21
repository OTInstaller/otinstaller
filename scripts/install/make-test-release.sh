#!/bin/sh
# Builds a local ot release laid out like a GitHub release and signed with a throwaway Ed25519 key, so the install
# scripts can be tested end to end without publishing anything:
#
#   scripts/install/make-test-release.sh <out-dir> <version> <os/arch>...
#
# <out-dir> gets the archives, checksums.txt, checksums.txt.sig, and install.sh / install.ps1 with the throwaway
# public key filled in. Serve it over HTTP and run an install script with OT_DOWNLOAD_BASE=<url> OT_VERSION=v<version>.
# Needs go, openssl 3 (Ed25519), python3 (for the Windows zip) and sha256sum or shasum.
set -eu

[ $# -ge 3 ] || { echo "usage: $0 <out-dir> <version> <os/arch>..." >&2; exit 2; }
out="$1"
version="$2"
shift 2
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# python3, or python where python3 is missing or only a stub (Windows).
py=python3
"$py" -c "" 2>/dev/null || py=python

key="$(mktemp -d)/key.pem"
openssl genpkey -algorithm ed25519 -out "$key"
pub="$(openssl pkey -in "$key" -pubout -outform DER | tail -c 32 | openssl base64 -A)"
pkg="github.com/otinstaller/otinstaller/cli/internal"

for target in "$@"; do
  os="${target%/*}"
  arch="${target#*/}"
  exe=ot
  [ "$os" = windows ] && exe=ot.exe
  build="$(mktemp -d)"
  (cd "$root/cli" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X $pkg/cli.Version=v$version -X $pkg/selfupdate.PublicKey=$pub" -o "$build/$exe" ./cmd/ot)
  name="ot_${version}_${os}_${arch}"
  if [ "$os" = windows ]; then
    "$py" -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED); z.write(sys.argv[2], "ot.exe"); z.close()' \
      "$out/$name.zip" "$build/$exe"
  else
    tar -czf "$out/$name.tar.gz" -C "$build" ot
  fi
  rm -rf "$build"
done

cd "$out"
# GoReleaser's format, "<hash>  <file>" (sha256sum on Windows marks binary files with "*").
if command -v sha256sum >/dev/null 2>&1; then sha256sum ot_*; else shasum -a 256 ot_*; fi | sed 's/ [ *]/  /' > checksums.txt
openssl pkeyutl -sign -rawin -inkey "$key" -in checksums.txt -out checksums.txt.sig
rm -rf "$(dirname "$key")"
for s in install.sh install.ps1; do
  sed "s|__OT_RELEASE_PUBLIC_KEY__|$pub|" "$root/scripts/install/$s" > "$out/$s"
done
echo "test release v$version in $out (public key $pub)"
