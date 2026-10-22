"""Results handling: saving, naming, and organizing tool output."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from otlite.config import get_results_dir
from otlite.registry import Tool


class ResultsDirError(Exception):
    """The results folder can't be created (no write access, a file in the way, ...)."""


def sanitize_component(value: str) -> str:
    """Sanitize a path component for safe filesystem use."""
    # Lowercase
    value = value.lower()
    # Replace anything not [a-z0-9._-] with _
    value = re.sub(r"[^a-z0-9._-]", "_", value)
    # Collapse repeated _
    value = re.sub(r"_+", "_", value)
    # Strip leading/trailing _ and .
    value = value.strip("_.-")
    # Truncate to 80 chars
    if len(value) > 80:
        value = value[:80]
    # If empty, return "target"
    if not value:
        return "target"
    return value


def new_run_id() -> str:
    """Generate a new run ID (8 lowercase hex chars)."""
    return os.urandom(4).hex()


def ext_for_tool(tool: Tool) -> str:
    """Return the output file extension for a tool."""
    return "txt"


def results_paths(
    tool_name: str,
    target: str,
    case: str | None,
) -> tuple[Path, Path]:
    """Return (output_path, meta_path) for a tool run."""
    base = get_results_dir()
    if case:
        base = base / "cases" / sanitize_component(case)
    target_sanitized = sanitize_component(target)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    runid = new_run_id()
    ext = "txt"  # hardcoded for now
    filename = f"{timestamp}_{tool_name}_{target_sanitized}_{runid}.{ext}"
    output_path = base / tool_name / target_sanitized / filename
    meta_path = output_path.with_suffix(".meta.json")
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        reason = exc.strerror or exc.__class__.__name__
        raise ResultsDirError(
            f"can't save results in {get_results_dir()} ({reason.lower()}). "
            "Run otlite from a folder you can write to, such as your home folder, "
            "or choose one with: export OTLITE_RESULTS_DIR=~/otlite-results"
        ) from exc
    return output_path, meta_path


@dataclass
class RunMeta:
    command: list[str]
    tool: str
    tool_version: str
    target: str
    case: str | None
    started_at: str
    ended_at: str
    duration_seconds: float
    exit_code: int
    status: str
    output_path: str
    sha256: str
    bytes: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def write_meta(meta: RunMeta, path: Path) -> None:
    """Write RunMeta as pretty JSON with sorted keys."""
    path.write_text(json.dumps(meta.to_dict(), sort_keys=True, indent=2))


def hash_file(path: Path) -> str:
    """Compute SHA-256 of a file in streaming chunks."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


RUN_STATUSES = ("complete", "failed", "interrupted")
SORT_KEYS = ("time", "tool", "target", "duration", "size")
_SINCE_UNITS = {"m": 60, "h": 3600, "d": 86400, "w": 604800}


def parse_since(value: str, now: datetime | None = None) -> datetime:
    """Turn "30m", "12h", "7d", "2w" or an ISO date such as "2026-10-01" into a UTC time.

    Raises ValueError with a message the CLI can show as is.
    """
    now = now or datetime.now(timezone.utc)
    text = value.strip().lower()
    if len(text) > 1 and text[-1] in _SINCE_UNITS and text[:-1].isdigit():
        return now - timedelta(seconds=int(text[:-1]) * _SINCE_UNITS[text[-1]])
    try:
        when = datetime.fromisoformat(value.strip())
    except ValueError:
        raise ValueError(
            f"can't read --since {value!r}; use an age such as 30m, 12h, 7d or 2w, "
            "or a date such as 2026-10-01"
        ) from None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def _started(run: dict[str, Any]) -> datetime:
    try:
        when = datetime.fromisoformat(str(run.get("started_at", "")))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def list_runs(
    base: Path,
    *,
    tool: str | None = None,
    target: str | None = None,
    case: str | None = None,
    status: str | None = None,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return each saved run's .meta.json, plus meta_path, that matches every filter given."""
    if not base.is_dir():
        return []
    # Targets and cases compare as folder names, so "JohnDoe" finds runs saved as johndoe.
    want_target = sanitize_component(target) if target else None
    want_case = sanitize_component(case) if case else None
    runs: list[dict[str, Any]] = []
    for meta_path in base.rglob("*.meta.json"):
        # A damaged or foreign sidecar is skipped so it never hides the other runs.
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict) or "tool" not in meta or "started_at" not in meta:
            continue
        if tool and str(meta.get("tool", "")).lower() != tool.lower():
            continue
        if want_target and sanitize_component(str(meta.get("target", ""))) != want_target:
            continue
        if want_case and sanitize_component(str(meta.get("case") or "")) != want_case:
            continue
        if status and meta.get("status") != status:
            continue
        if since and _started(meta) < since:
            continue
        meta["meta_path"] = meta_path.relative_to(base).as_posix()
        runs.append(meta)
    return runs


def sort_runs(
    runs: list[dict[str, Any]], key: str = "time", reverse: bool = False
) -> list[dict[str, Any]]:
    # Each key starts with what people look for first: newest, A to Z, longest, largest.
    # Ties stay newest first.
    if key not in SORT_KEYS:
        raise ValueError(f"can't sort by {key!r}; use one of: {', '.join(SORT_KEYS)}")
    newest = sorted(runs, key=_started, reverse=True)
    if key == "time":
        ordered = newest
    elif key in ("tool", "target"):
        ordered = sorted(newest, key=lambda r: str(r.get(key, "")).lower())
    elif key == "duration":
        ordered = sorted(newest, key=lambda r: float(r.get("duration_seconds") or 0), reverse=True)
    else:
        ordered = sorted(newest, key=lambda r: int(r.get("bytes") or 0), reverse=True)
    return list(reversed(ordered)) if reverse else ordered
