# Read the message headers

Get the full headers from the mail client:

- **Gmail**: open the message, ⋮ → *Show original*, then *Copy to clipboard*.
- **Outlook**: *File* → *Properties* → *Internet headers*.
- **Apple Mail**: *View* → *Message* → *All Headers*.

Save them to `headers.txt` and run:

```
ot run osintverse-community/email-header-parser --headers "$(cat headers.txt)" --format table
```

On Windows PowerShell use `--headers (Get-Content -Raw headers.txt)`.

## What to look at

| Field | Question it answers |
| --- | --- |
| `auth` (SPF, DKIM, DMARC) | Did the sending domain authorise this server? A `fail` on a domain that publishes a strict DMARC policy is a strong sign of spoofing. |
| `From` vs `Reply-To` vs `Return-Path` | Do replies and bounces go somewhere else? A free-mail `Reply-To` on a corporate `From` is a classic fraud pattern. |
| `hops` | The servers the message passed through, oldest first, with times. Gaps of hours or unexpected countries are worth a note. |
| `ip` entities | The public IPs in the hops. The first public one is often the sender's mail server or, for webmail, sometimes the sender's own connection. |
| `Message-ID` domain | The system that created the message. It should match the sending service. |

> [!TIP]
> Look up the hop IPs with the [IP investigation playbook](https://otinstaller.com/guides/osintverse-community/ip-investigation).

Next: [check the domain](03-domain.md).
