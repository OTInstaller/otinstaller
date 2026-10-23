# Opsec for the investigator

Operational security here means two things: not exposing yourself or your organisation while you look, and not
tipping off the person or group you are looking into.

## What your requests reveal

Every website and API a tool contacts sees the request: your IP address, and sometimes the time zone and language of
your machine. It does not see your files or who you are looking for, unless the request itself names them.

- If your IP address matters for the case, run tools from a server you control or through a VPN you are allowed to
  use, and keep that choice the same for the whole case.
- Some tools contact the target's own services, and a few may notify them, for example a password-reset or sign-up
  check that sends an email. Each tool page says so under **Behaviour**, and `ot info <tool>` shows the same flags.
  Run those only when your scope allows it.

## What `ot` does for you

- Each tool runs in a container that cannot read your files, with no network unless the tool declares it.
- API keys are kept in your system keychain and passed only to the tool that declares them.
- Images are pinned to a digest and checked against their signature before every run.
- When an AI agent runs tools for you through `ot mcp`, it has to ask before anything that goes online or touches a
  target, and every run is written to a local audit log (`ot mcp audit`).

## Keep your work separate

- Use investigation accounts and API keys that are not tied to your personal ones.
- Do not log in to the platforms you are researching with your own accounts; a "people you may know" list works both
  ways.
- Do not open links, attachments or files sent by the person you are investigating on your everyday machine.
- Keep results on an encrypted disk, grouped by case (`ot run … --case <name>`), and out of folders that sync to the
  cloud.
