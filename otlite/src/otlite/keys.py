"""API key management: loading and distributing keys to tools."""

from __future__ import annotations

import os
import re
from pathlib import Path

from otlite.config import get_env_file
from otlite.registry import Tool


def get_env_file_path() -> Path:
    """Return the path to the .env file."""
    return get_env_file()


def load_env_file() -> dict[str, str]:
    """Load and parse the .env file.

    Parses KEY=VALUE lines, skipping blank lines and comments.
    Strips whitespace and optional surrounding quotes from values.
    Returns empty dict if file doesn't exist.
    Silently skips malformed lines.
    """
    path = get_env_file_path()
    if not path.exists():
        return {}

    result: dict[str, str] = {}
    content = path.read_text()
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes if present
        if len(value) >= 2 and (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        if key:
            result[key] = value
    return result


def keys_for_tool(tool: Tool, available: dict[str, str]) -> dict[str, str]:
    """Return only the keys that the tool declares needing."""
    needed = set(tool.api_keys.required) | set(tool.api_keys.optional)
    return {k: v for k, v in available.items() if k in needed}


def missing_required_keys(tool: Tool, available: dict[str, str]) -> list[str]:
    """Return list of required keys that are missing from available."""
    return [k for k in tool.api_keys.required if k not in available]


KEY_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
ENV_HEADER = (
    "# API keys for tools managed by otlite.\n"
    "# Add one KEY=value per line. Keep this file private.\n"
)


def _format_value(value: str) -> str:
    # load_env_file strips one pair of matching quotes and surrounding spaces, so quote only when
    # the value would otherwise change on the way back in.
    if value != value.strip() or (len(value) > 1 and value[0] == value[-1] and value[0] in "\"'"):
        return f"'{value}'" if '"' in value else f'"{value}"'
    return value


def _write_private(path: Path, text: str) -> None:
    # Created with mode 600 from the start and swapped in whole, so the file is never readable by
    # others and never half written.
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def _key_of(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    return stripped.split("=", 1)[0].strip()


def set_key(name: str, value: str) -> None:
    """Save NAME=value in the env file, replacing any earlier value for NAME."""
    if not KEY_NAME_RE.match(name):
        raise ValueError(
            f"{name!r} is not a key name; use capitals, digits and _ (like SHODAN_API_KEY)"
        )
    if "\n" in value or "\r" in value:
        raise ValueError("a key value can't contain a line break")
    if not value:
        raise ValueError("the value is empty")
    path = get_env_file_path()
    lines = (
        path.read_text(encoding="utf-8").splitlines() if path.exists() else ENV_HEADER.splitlines()
    )
    out, written = [], False
    for line in lines:
        if _key_of(line) == name:
            if not written:
                out.append(f"{name}={_format_value(value)}")
                written = True
            continue
        out.append(line)
    if not written:
        out.append(f"{name}={_format_value(value)}")
    _write_private(path, "\n".join(out) + "\n")


def remove_key(name: str) -> bool:
    """Remove NAME from the env file. Returns False when it wasn't there."""
    path = get_env_file_path()
    if not path.exists():
        return False
    lines = path.read_text(encoding="utf-8").splitlines()
    kept = [line for line in lines if _key_of(line) != name]
    if len(kept) == len(lines):
        return False
    _write_private(path, "\n".join(kept) + "\n")
    return True
