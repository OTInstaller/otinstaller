"""The end-of-life notice printed by the console entry point."""

from __future__ import annotations

import os
from datetime import date

END_OF_LIFE = date(2027, 6, 30)
GUIDE = "https://github.com/OTInstaller/otinstaller/blob/main/docs/migrating-from-otinstaller.md"
HIDE_VAR = "OTINSTALLER_NO_DEPRECATION_WARNING"


def notice(today: date) -> str:
    if today > END_OF_LIFE:
        first = (
            f"warning: otinstaller reached end of life on {END_OF_LIFE.isoformat()} "
            "and gets no more fixes, including security fixes."
        )
    else:
        first = (
            "warning: otinstaller is in maintenance and gets security fixes only until "
            f"{END_OF_LIFE.isoformat()}, then none."
        )
    return f"{first}\nIts replacement is the ot command: {GUIDE}\nSet {HIDE_VAR}=1 to hide this."


def should_show(env: dict[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return not env.get(HIDE_VAR)
