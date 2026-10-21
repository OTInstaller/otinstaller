# otinstaller is now otlite

The package manager that was published here as `otinstaller` is now
[otlite](https://pypi.org/project/otlite/), the no-Docker edition of [OTInstaller](https://otinstaller.com).
This release of `otinstaller` only depends on otlite and keeps an `otinstaller` command that runs it, so
`pip install -U otinstaller` and existing scripts keep working.

Install otlite directly instead:

```bash
pipx install otlite
```

The first `otlite` run copies your API keys and settings from `~/.otinstaller` to `~/.otlite`. The
`OTINSTALLER_*` environment variables are still read. Tools installed by otinstaller stay where they
were; install them again with `otlite install <tool>`.

Documentation: https://otinstaller.com/docs/otlite. Source:
https://github.com/OTInstaller/otinstaller/tree/main/otlite.
