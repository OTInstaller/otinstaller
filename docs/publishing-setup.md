# Setting up publishing (GitHub App, OAuth apps, secrets)

Week 4 code is complete and tested against stand-ins for GitHub and GitLab. To run it for real you need
three registrations, which only the account owner can create. Use a separate set for staging.

## 1. GitHub App ("OTInstaller Registry")

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (create it under the org that will own the registry).

| Setting | Value |
| --- | --- |
| Homepage URL | `https://otinstaller.com` |
| Webhook URL | `https://api.otinstaller.com/v1/webhooks/github` |
| Webhook secret | a long random string → `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Contents: Read-only · Metadata: Read-only · Commit statuses: Read and write · Pull requests: Read and write (import wizard, week 7) |
| Subscribe to events | Create · Release · Push · Repository · Installation target |
| Where can it be installed | Any account |

Then generate a private key. GitHub gives a PKCS#1 key; convert it to PKCS#8 for Workers:

```bash
openssl pkcs8 -topk8 -nocrypt -in otinstaller-registry.private-key.pem -out github-app-pkcs8.pem
```

Note the App ID → `GITHUB_APP_ID`; the PKCS#8 file's contents → `GITHUB_APP_PRIVATE_KEY`.

## 2. GitHub OAuth app (sign-in)

GitHub → Developer settings → OAuth Apps → New OAuth App. Tick **Enable Device Flow** (needed by `ot login`).

- Authorization callback URL: `https://api.otinstaller.com/v1/auth/github/callback`
- Client ID → `GITHUB_CLIENT_ID`, client secret → `GITHUB_CLIENT_SECRET`

## 3. GitLab OAuth application (sign-in)

GitLab.com → Edit profile (or the group) → Applications → Add new application.

- Redirect URI: `https://api.otinstaller.com/v1/auth/gitlab/callback`
- Confidential: yes · Scopes: `read_user`, `read_api`
- Application ID → `GITLAB_CLIENT_ID`, secret → `GITLAB_CLIENT_SECRET`
- Device flow (`ot login --gitlab`) works with the same application.

## 4. Secrets

```bash
cd api
npx wrangler d1 create otinstaller            # put the ID in wrangler.jsonc
npx wrangler queues create otinstaller-publish
openssl rand -base64 32                        # → TOKEN_ENC_KEY
for s in GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET \
         GITLAB_CLIENT_ID GITLAB_CLIENT_SECRET TOKEN_ENC_KEY; do npx wrangler secret put $s; done
npx wrangler d1 migrations apply otinstaller --remote
npx wrangler deploy
```

For local development, copy `api/.dev.vars.example` to `api/.dev.vars` and fill it in. Use a tunnel
(for example `cloudflared tunnel --url http://127.0.0.1:8787`) as the staging app's webhook URL.

## 5. Check it

1. Install the app on a test repository that has a valid `otinstaller.yaml` (`ot init`), with the image pushed.
2. Push tag `v0.1.0`. Within a minute the tagged commit shows an `otinstaller/publish` status:
   *"Valid; new publisher awaiting review"* (pending), or a failure naming the error code.
3. `ot login`, then `ot whoami` lists the namespace as `owner, pending review`.
