#!/bin/sh
# Authenticode-signs a Windows build of ot. GoReleaser runs it after each build (builds[].hooks.post), before the
# archives and checksums are made, so the signed ot.exe is what ships and what checksums.txt covers.
#
#   sh scripts/sign-windows.sh <binary> <target>
#
# Does nothing for other targets, or when WINDOWS_SIGN_STORETYPE is empty, so releases still work unsigned.
# The release workflow sets these (docs/code-signing.md):
#   WINDOWS_SIGN_STORETYPE  jsign keystore type: TRUSTEDSIGNING (Azure Trusted Signing), or for an OV certificate
#                           on a cloud HSM one of ESIGNER, DIGICERTONE, AZUREKEYVAULT, GOOGLECLOUD, ...
#   WINDOWS_SIGN_KEYSTORE   TRUSTEDSIGNING: the endpoint host, e.g. eus.codesigning.azure.net
#   WINDOWS_SIGN_ALIAS      TRUSTEDSIGNING: <account>/<certificate profile>
#   WINDOWS_SIGN_STOREPASS  TRUSTEDSIGNING: an Azure access token for https://codesigning.azure.net
#   JSIGN_JAR               path to jsign's jar
set -eu

bin=$1
target=$2
case "$target" in
  windows_*) ;;
  *) exit 0 ;;
esac
if [ -z "${WINDOWS_SIGN_STORETYPE:-}" ]; then
  echo "sign-windows: WINDOWS_SIGN_STORETYPE is not set; $bin stays unsigned" >&2
  exit 0
fi
: "${JSIGN_JAR:?JSIGN_JAR is not set}"
: "${WINDOWS_SIGN_STOREPASS:?WINDOWS_SIGN_STOREPASS is not set}"

# jsign reads the password from the environment, so it never appears in the process list.
export WINDOWS_SIGN_STOREPASS
set -- --storetype "$WINDOWS_SIGN_STORETYPE" --storepass env:WINDOWS_SIGN_STOREPASS \
  --name ot --url https://otinstaller.com \
  --tsaurl "${WINDOWS_SIGN_TSAURL:-http://timestamp.acs.microsoft.com}" --tsmode RFC3161 --alg SHA-256
[ -n "${WINDOWS_SIGN_KEYSTORE:-}" ] && set -- "$@" --keystore "$WINDOWS_SIGN_KEYSTORE"
[ -n "${WINDOWS_SIGN_ALIAS:-}" ] && set -- "$@" --alias "$WINDOWS_SIGN_ALIAS"
[ -n "${WINDOWS_SIGN_CERTFILE:-}" ] && set -- "$@" --certfile "$WINDOWS_SIGN_CERTFILE"
java -jar "$JSIGN_JAR" "$@" "$bin"
echo "sign-windows: signed $bin" >&2
