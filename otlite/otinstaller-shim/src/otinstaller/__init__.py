"""The old name of otlite. Prints one line about the rename, then runs otlite."""

from __future__ import annotations

import sys

__version__ = "0.2.0"


def main() -> None:
    # stderr, so --json output on stdout stays clean
    print(
        "note: otinstaller is now otlite. Use the `otlite` command; this one runs it.",
        file=sys.stderr,
    )
    from otlite.cli import run_cli

    run_cli()
