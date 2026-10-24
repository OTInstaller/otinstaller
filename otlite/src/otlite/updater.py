"""Telling people when a newer otlite is out.

The catalog ships inside otlite, so newer tool versions arrive with a newer otlite. The check asks
PyPI only: the explicit commands every time, the passive reminder at most once a day.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from otlite import __version__
from otlite.config import ensure_dir, env_value, get_home
from otlite.installer.core import get_latest_pip_version

DAY = 24 * 3600
TIMEOUT = 3


def check_disabled() -> bool:
    return bool(
        env_value("NO_UPDATE_CHECK") or os.environ.get("DO_NOT_TRACK") or os.environ.get("CI")
    )


def _cache_path() -> Path:
    return get_home() / "update-check.json"


def _read_cache() -> dict:
    try:
        data = json.loads(_cache_path().read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(data: dict) -> None:
    path = _cache_path()
    try:
        ensure_dir(path.parent)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(path)
    except OSError:
        pass


def latest_otlite(*, cached: bool) -> str | None:
    """The newest otlite on PyPI, or None when switched off or unknown.

    With cached, an answer (or a failed attempt) from the last day is reused, so an offline machine
    waits on PyPI at most once a day.
    """
    if check_disabled():
        return None
    if cached:
        data = _read_cache()
        checked = data.get("checked_at")
        if isinstance(checked, (int, float)) and time.time() - checked < DAY:
            return data.get("latest") or None
    latest = get_latest_pip_version("otlite", timeout=TIMEOUT)
    _write_cache({**_read_cache(), "checked_at": time.time(), "latest": latest})
    return latest


def _release(version: str) -> tuple[int, ...] | None:
    if not re.fullmatch(r"\d+(\.\d+)*", version):
        return None
    return tuple(int(part) for part in version.split("."))


def is_newer(latest: str, current: str) -> bool:
    """Whether latest is a later plain release than current; prereleases never are."""
    a, b = _release(latest), _release(current)
    if a is None or b is None:
        return False
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def upgrade_command(
    prefix: Path | None = None, *, module: Path | None = None, python: str | None = None
) -> str | None:
    """The command that upgrades otlite the way it was installed, or None for the Debian package."""
    prefix = prefix or Path(sys.prefix)
    module = module or Path(__file__)
    if "dist-packages" in module.parts and module.as_posix().startswith("/usr/lib/"):
        return None
    if (prefix / "uv-receipt.toml").exists():
        return "uv tool upgrade otlite"
    if (prefix / "pipx_metadata.json").exists():
        # Installed under the old name: the shim only follows otlite's minimum version.
        return "pipx install otlite" if prefix.name == "otinstaller" else "pipx upgrade otlite"
    try:
        cfg = (prefix / "pyvenv.cfg").read_text()
    except OSError:
        cfg = ""
    if re.search(r"^uv\s*=", cfg, re.MULTILINE):
        return "uv pip install --upgrade otlite"
    return f"{python or sys.executable} -m pip install --upgrade otlite"


def notice(current: str = __version__, *, cached: bool) -> dict | None:
    """What check-updates and update say about otlite; None when off or PyPI is unreachable."""
    latest = latest_otlite(cached=cached)
    if not latest:
        return None
    return {
        "current": current,
        "latest": latest,
        "outdated": is_newer(latest, current),
        "upgrade": upgrade_command(),
    }


def notice_line(n: dict | None) -> str | None:
    """One sentence about a newer otlite, or None when there isn't one."""
    if not n or not n["outdated"]:
        return None
    how = f"upgrade with: {n['upgrade']}" if n["upgrade"] else "update it with your package manager"
    return f"otlite {n['latest']} is out (you have {n['current']}), with newer tool versions; {how}"


def daily_reminder() -> str | None:
    """The notice at most once a day, for commands that don't check on purpose."""
    line = notice_line(notice(cached=True))
    if not line:
        return None
    data = _read_cache()
    reminded = data.get("reminded_at")
    if isinstance(reminded, (int, float)) and time.time() - reminded < DAY:
        return None
    data["reminded_at"] = time.time()
    _write_cache(data)
    return line
