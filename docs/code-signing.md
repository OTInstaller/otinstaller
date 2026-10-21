# Code signing for `ot` releases

Releases already work unsigned: checksums.txt is signed with the Ed25519 release key (checked by the install scripts
and `ot self-update`) and with cosign. Operating-system signing is extra, and stops the warnings people see on first
run: Windows SmartScreen ("Windows protected your PC") and macOS Gatekeeper ("cannot be opened because the developer
cannot be verified", which also blocks the Homebrew cask's binary until the user clears the quarantine flag).

Both are wired into `.github/workflows/release-cli.yml` and `cli/.goreleaser.yaml` and stay **off until their
settings exist**. Nothing has been bought or signed up for. Set them on the `OTInstaller/otinstaller` repository
(Settings → Secrets and variables → Actions), then push a tag as usual.

| Platform | How | Cost | Turns on when |
| --- | --- | --- | --- |
| Windows | Authenticode with **Azure Trusted Signing**, applied by [jsign](https://github.com/ebourg/jsign) 7.5 on the Linux runner, timestamped by Microsoft | About **$9.99 a month** (Basic: 5,000 signatures) plus a pay-as-you-go Azure subscription | variable `AZURE_CLIENT_ID` is set |
| Windows (alternative) | Authenticode with an **OV certificate** on a cloud HSM (SSL.com eSigner, DigiCert KeyLocker, Azure Key Vault, Google Cloud KMS…), also via jsign | Roughly $200–500 a year, depending on the vendor | variable `WINDOWS_SIGN_STORETYPE` is set |
| macOS | **Developer ID** signing and **notarization**, by GoReleaser's built-in `notarize` (runs on Linux, no Mac needed) | **$99 a year** (Apple Developer Program) | secret `MACOS_SIGN_P12` is set |

## How it works

- **Windows**: GoReleaser runs `cli/scripts/sign-windows.sh` after each build. For Windows targets it signs `ot.exe`
  in place, before the zip and checksums.txt are made, so what users download is signed and the checksums cover the
  signed file. For other targets, or when `WINDOWS_SIGN_STORETYPE` is empty, it does nothing. The workflow downloads
  jsign 7.5 and checks its SHA-256. With Trusted Signing it signs in to Azure with OIDC (no Azure secret stored) and
  gets a one-hour access token for `https://codesigning.azure.net`.
- **macOS**: GoReleaser signs both darwin binaries with the Developer ID certificate, sends them to Apple's notary
  service and waits (up to 20 minutes). A bare command-line binary can't be stapled, so Gatekeeper checks the
  notarization online on first run.
- Tested here: the hook signed an `ot.exe` with a throwaway certificate, Windows shows the signature and a Microsoft
  RFC 3161 timestamp, and the binary still runs; a GoReleaser snapshot without any signing settings builds as before.
  Not tested: the real Trusted Signing and Apple accounts (they don't exist yet). Check the first signed release
  (below).

## Windows: Azure Trusted Signing (recommended)

**Check eligibility first.** Public-trust certificates from Trusted Signing are issued after Microsoft validates the
identity: organisations need a verifiable history (Microsoft has asked for about three years of tax history) and
were limited to certain countries; individual developers have been accepted in the USA and Canada. If OSINTverse
doesn't qualify, use an OV certificate instead.

1. **Azure subscription**: sign up at https://azure.microsoft.com (pay as you go; a card is required).
2. **Trusted Signing account**: Azure portal → Create a resource → *Trusted Signing Account*, Basic SKU. Pick a
   region; its endpoint is the `TRUSTED_SIGNING_ENDPOINT`, e.g. `https://eus.codesigning.azure.net` (East US),
   `https://weu.codesigning.azure.net` (West Europe).
3. **Identity validation**: in the account → *Identity validations* → New → *Public*. Fill in OSINTverse's legal
   details; Microsoft verifies them (days to weeks).
4. **Certificate profile**: *Certificate profiles* → New → *Public Trust*, linked to the validated identity. Its name
   is `TRUSTED_SIGNING_PROFILE`; the account's name is `TRUSTED_SIGNING_ACCOUNT`.
5. **App registration for GitHub Actions** (Microsoft Entra ID → App registrations → New): then
   *Certificates & secrets* → *Federated credentials* → *GitHub Actions deploying Azure resources*, organisation
   `OTInstaller`, repository `otinstaller`, entity *Tag* (or *Branch* `main` if you prefer), so only this repository's
   release workflow can use it. No client secret is needed.
6. **Role**: on the Trusted Signing account → Access control (IAM) → add role *Trusted Signing Certificate Profile
   Signer* for the app registration.
7. **Variables** on `OTInstaller/otinstaller` (they are identifiers, not secrets): `AZURE_CLIENT_ID` (the app's
   Application ID), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `TRUSTED_SIGNING_ENDPOINT`, `TRUSTED_SIGNING_ACCOUNT`,
   `TRUSTED_SIGNING_PROFILE`.

## Windows alternative: an OV certificate

Since June 2023 code-signing keys must live on hardware, so an OV certificate comes on a USB token or a cloud HSM.
Only a cloud HSM works in CI. Buy one from a vendor whose cloud signing jsign supports (`ESIGNER` for SSL.com
eSigner, `DIGICERTONE` for DigiCert KeyLocker, `AZUREKEYVAULT`, `GOOGLECLOUD`, `AWS`…; see `jsign --help`). The vendor
validates OSINTverse as an organisation (D-U-N-S or business registry, phone call). Then set variables
`WINDOWS_SIGN_STORETYPE`, `WINDOWS_SIGN_KEYSTORE` and `WINDOWS_SIGN_ALIAS`, and secret `WINDOWS_SIGN_STOREPASS`, with
the values jsign documents for that store type (https://ebourg.github.io/jsign/). Don't set `AZURE_CLIENT_ID` at the
same time: Trusted Signing wins.

OV and Trusted Signing both start with little SmartScreen reputation; warnings fade as downloads accumulate.

## macOS: Developer ID and notarization

1. **Apple Developer Program**: https://developer.apple.com/programs/enroll/ — $99 a year. Enrol as an
   **organisation** so the signature shows "OSINTverse" (needs a D-U-N-S number for the entity, free from Dun &
   Bradstreet, and the right to sign for it); enrolling as an individual shows your personal name.
2. **Developer ID Application certificate**, created without a Mac:
   ```bash
   openssl req -new -newkey rsa:2048 -nodes -keyout developer-id.key -out developer-id.csr -subj "/CN=OSINTverse/emailAddress=support@otinstaller.com"
   ```
   Upload `developer-id.csr` at Certificates, Identifiers & Profiles → Certificates → + → *Developer ID Application*
   (only the Account Holder can create it), download `developerID_application.cer`, then:
   ```bash
   openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
   openssl pkcs12 -export -legacy -inkey developer-id.key -in developer-id.pem -out developer-id.p12
   ```
   Choose a password when asked. Keep `developer-id.key` and the `.p12` offline; delete working copies after.
3. **App Store Connect API key** for the notary service: App Store Connect → Users and Access → Integrations → Team
   Keys → +, role *Developer*. Note the **Issuer ID** and **Key ID**, download the `.p8` (only once).
4. **Secrets** on `OTInstaller/otinstaller` (paste the values yourself; nobody else needs to see them):
   ```bash
   base64 -w0 developer-id.p12 | gh secret set MACOS_SIGN_P12 -R OTInstaller/otinstaller
   gh secret set MACOS_SIGN_PASSWORD -R OTInstaller/otinstaller
   base64 -w0 AuthKey_XXXXXXXXXX.p8 | gh secret set MACOS_NOTARY_KEY -R OTInstaller/otinstaller
   gh secret set MACOS_NOTARY_KEY_ID -R OTInstaller/otinstaller
   gh secret set MACOS_NOTARY_ISSUER_ID -R OTInstaller/otinstaller
   ```
   (`gh secret set NAME` with no value prompts for it.)

## Checking the first signed release

- Windows (PowerShell): `Get-AuthenticodeSignature .\ot.exe` → `Status: Valid`, signer OSINTverse, a timestamp.
- macOS: `codesign -dv --verbose=2 ot` shows `Authority=Developer ID Application: OSINTverse (TEAMID)`, and
  `spctl -a -vvv -t install ot` says `accepted, source=Notarized Developer ID`.
- The release log shows "sign-windows: signed …ot.exe" twice (amd64, arm64) and the notarize step for two binaries.

If signing fails, the release fails before anything is published. To release unsigned in a hurry, clear the
variable (`AZURE_CLIENT_ID` or `WINDOWS_SIGN_STORETYPE`) or the `MACOS_SIGN_P12` secret and push the tag again.
