"""Sharing saved runs as a link on otinstaller.com that works for 24 hours.

The upload is spec/schema/share-v1.json in the OTInstaller repository: each run's envelope with
what the tool found, without the case name, the command line or file paths. Shares are always
anonymous; the delete token the registry hands back is kept in ~/.otlite/shares.json so
`otlite shares rm` can delete one early.
"""

from __future__ import annotations

import http.client
import json
import os
import time
import urllib.error
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from otlite import __version__
from otlite.config import env_value, get_home
from otlite.results import envelope_path_for, list_runs

API_URL = "https://api.otinstaller.com/v1"
TIMEOUT = 30
# The registry's limits (api/src/shares.ts), checked here first so a share that is too big
# fails before uploading.
MAX_RUNS = 50
MAX_BYTES = 5 * 1024 * 1024
# The most of one run's output a share carries; the entities still go when the output is larger.
MAX_RAW = 1024 * 1024
# Keys of a saved envelope that only mean something on this machine.
LOCAL_KEYS = ("case", "run_id", "command", "target", "meta_path", "envelope_path", "output_path")


class ShareError(Exception):
    def __init__(self, message: str, code: str = "", hint: str = ""):
        super().__init__(message)
        self.code = code
        self.hint = hint


def api_url() -> str:
    return (env_value("API_URL") or API_URL).rstrip("/")


def _meta_path(path: Path) -> Path:
    name = path.name
    for suffix in (".meta.json", ".envelope.json"):
        if name.endswith(suffix):
            return path.with_name(name.removesuffix(suffix) + ".meta.json")
    return path.with_suffix(".meta.json")


def find_run(path: Path) -> Path:
    """The .meta.json of the saved run a path names: its output, sidecar or envelope."""
    meta = _meta_path(Path(path))
    if not meta.is_file():
        raise ShareError(f"{path} is not a saved run (no .meta.json next to it)")
    return meta


def runs_in_case(base: Path, case: str) -> list[Path]:
    runs = list_runs(base, case=case)
    if not runs:
        raise ShareError(f"no saved runs in case {case} under {base}")
    runs.sort(key=lambda r: str(r.get("started_at", "")))
    return [base / r["meta_path"] for r in runs]


def newest_run(base: Path, tool: str, target: str | None) -> Path:
    runs = list_runs(base, tool=tool, target=target)
    if not runs:
        against = f" against {target}" if target else ""
        raise ShareError(f"no saved runs of {tool}{against} under {base}")
    newest = max(runs, key=lambda r: str(r.get("started_at", "")))
    return base / newest["meta_path"]


def _envelope(meta_path: Path) -> dict[str, Any]:
    path = envelope_path_for(meta_path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    # Runs saved before envelopes existed get one built from the sidecar.
    from otlite.results import RunMeta, build_envelope

    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        fields = {k: meta.get(k) for k in RunMeta.__dataclass_fields__}
        return build_envelope(
            RunMeta(**fields), _output_path(meta_path).read_text(errors="replace"), False
        )
    except (OSError, ValueError, TypeError) as exc:
        raise ShareError(f"can't read the run saved at {meta_path}: {exc}") from None


def _output_path(meta_path: Path) -> Path:
    return meta_path.with_name(meta_path.name.removesuffix(".meta.json") + ".txt")


def share_run(meta_path: Path) -> dict[str, Any]:
    """One saved run as it is shared: its envelope and output, without local details."""
    run = _envelope(meta_path)
    for key in LOCAL_KEYS:
        run.pop(key, None)
    output = {k: v for k, v in (run.get("output") or {}).items() if k in ("sha256", "bytes")}
    run["warnings"] = list(run.get("warnings") or [])
    out_path = _output_path(meta_path)
    size = out_path.stat().st_size if out_path.exists() else 0
    if size > MAX_RAW:
        run["raw"] = None
        output["raw_omitted"] = True
        run["warnings"].append(
            f"raw left out of the share: the output is {size} bytes, over {MAX_RAW}"
        )
    else:
        run["raw"] = out_path.read_text(encoding="utf-8", errors="replace") if size else ""
    run["output"] = output
    return run


def build_payload(meta_paths: list[Path]) -> dict[str, Any]:
    return {"share": 1, "source": "otlite", "runs": [share_run(p) for p in meta_paths]}


def encode(payload: dict[str, Any]) -> bytes:
    runs = payload.get("runs") or []
    if not runs:
        raise ShareError("nothing to share")
    if len(runs) > MAX_RUNS:
        raise ShareError(
            f"{len(runs)} runs; one share takes at most {MAX_RUNS}, so share them in parts"
        )
    body = json.dumps(payload).encode()
    if len(body) > MAX_BYTES:
        raise ShareError(
            f"the share would be {len(body) / 1048576:.1f} MB, "
            f"over the {MAX_BYTES // 1048576} MB limit; share fewer runs at once"
        )
    return body


def _send(method: str, path: str, body: dict[str, Any] | bytes | None) -> dict[str, Any] | None:
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    headers = {"User-Agent": f"otlite/{__version__}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = Request(api_url() + path, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=TIMEOUT) as resp:
            text = resp.read().decode() if resp.status != 204 else ""
            return json.loads(text) if text else None
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read().decode()).get("error") or {}
        except (OSError, ValueError, AttributeError):
            err = {}
        raise ShareError(
            err.get("message") or f"the registry answered {exc.code}",
            err.get("code", ""),
            err.get("hint", ""),
        ) from None
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise ShareError(f"can't reach the registry at {api_url()} ({exc})") from None


def upload(body: bytes) -> dict[str, Any]:
    made = _send("POST", "/shares", body)
    if not isinstance(made, dict) or "url" not in made:
        raise ShareError("the registry's answer had no link")
    return made


def delete(share_id: str, token: str) -> bool:
    """Delete a share; False when it was already gone (deleted or expired)."""
    try:
        _send("DELETE", "/shares/" + share_id, {"delete_token": token})
    except ShareError as exc:
        if exc.code == "share_not_found":
            return False
        raise
    return True


def shares_file() -> Path:
    return get_home() / "shares.json"


def load_shares() -> list[dict[str, Any]]:
    """Shares made here that still work, newest first; expired ones are dropped from the file."""
    try:
        saved = json.loads(shares_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    now = int(time.time() * 1000)
    live = [s for s in saved if isinstance(s, dict) and s.get("expires_at", 0) > now]
    if len(live) != len(saved):
        _save_shares(live)
    return sorted(live, key=lambda s: s.get("created_at", 0), reverse=True)


def remember(made: dict[str, Any]) -> None:
    keep = ("id", "url", "delete_token", "created_at", "expires_at", "tools")
    _save_shares([*load_shares(), {k: made.get(k) for k in keep}])


def forget(share_id: str) -> None:
    _save_shares([s for s in load_shares() if s.get("id") != share_id])


def _save_shares(shares: list[dict[str, Any]]) -> None:
    path = shares_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    # The delete tokens are credentials: only the owner may read the file.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(shares, f, indent=2)
    os.replace(tmp, path)


def tools(payload: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for run in payload.get("runs", []):
        name = str(run.get("tool", "")).split("@", 1)[0]
        if name not in names:
            names.append(name)
    return names


def question(payload: dict[str, Any]) -> str:
    runs = payload.get("runs", [])
    targets = sorted({v for r in runs for v in (r.get("input") or {}).values() if v})
    q = f"Share {len(runs)} run{'s' if len(runs) != 1 else ''} ({', '.join(tools(payload))})"
    if len(targets) > 3:
        q += f" on {', '.join(targets[:3])} and {len(targets) - 3} more"
    elif targets:
        q += " on " + ", ".join(targets)
    return q + " for 24 hours?"


DETAILS = (
    "Anyone with the link can see the target and everything the tools found, "
    "until it expires in 24 hours.",
    "File paths, the case name and the command line stay on this machine.",
    "It is not linked to anyone; `otlite shares rm` on this machine deletes it early.",
)
