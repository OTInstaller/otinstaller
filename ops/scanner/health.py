#!/usr/bin/env python3
"""OTInstaller Registry nightly health checks.

Runs each published tool's test input against its latest version, with network access (unlike the publish
smoke test), in the same sandbox `ot` uses, and posts pass/fail back to the registry.

  health.py targets            print tonight's targets as JSON batches (for the workflow's matrix)
  health.py run batch.json     check one batch of targets and post the results

Needs REGISTRY_API (e.g. https://api.otinstaller.com) and HEALTH_TOKEN in the environment.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import scan  # noqa: E402  (the scanner's sandboxed smoke run and helpers)

BATCH = 10
# Tools that talk to the same site are spaced out so one night's checks never hammer it.
PER_DOMAIN_GAP = 20


def api(path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        os.environ["REGISTRY_API"].rstrip("/") + "/v1" + path,
        data=json.dumps(body).encode() if body is not None else None,
        method="POST" if body is not None else "GET",
        headers={"Authorization": f"Bearer {os.environ['HEALTH_TOKEN']}", "Content-Type": "application/json", "User-Agent": "otinstaller-health"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def image_for(target: dict, work: Path) -> str:
    """The image to run: the tool's own (Docker), or its pinned wheel installed into a Python image (pipx)."""
    rt = target["runtime"]
    if rt["kind"] == "docker":
        pulled = scan.run(["docker", "pull", rt["image"]], timeout=1200)
        if pulled.returncode != 0:
            raise RuntimeError(f"cannot pull {rt['image']}: {pulled.stderr[-300:]}")
        return rt["image"]
    meta = scan.http_json(f"https://pypi.org/pypi/{rt['package']}/{rt['package_version']}/json")
    wheel = next((u for u in (meta or {}).get("urls", []) if u["packagetype"] == "bdist_wheel" and u["digests"]["sha256"] == rt["wheel_sha256"]), None)
    if not wheel:
        raise RuntimeError("the pinned wheel is no longer on PyPI")
    with urllib.request.urlopen(wheel["url"], timeout=300) as r:
        (work / wheel["filename"]).write_bytes(r.read())
    (work / "Dockerfile").write_text(scan.PYTHON_DOCKERFILE)
    tag = f"ot-health/{re.sub(r'[^a-z0-9]+', '-', target['ref'].lower())}:latest"
    built = scan.run(["docker", "build", "-q", "-t", tag, str(work)], timeout=1200)
    if built.returncode != 0:
        raise RuntimeError(f"building the wheel image failed: {built.stderr[-300:]}")
    return tag


def check(target: dict) -> dict:
    started = time.time()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            image = image_for(target, Path(tmp))
            result = scan.smoke(image, target["runtime"], target["test_input"], egress=True)
        ok = result.get("status") == "pass"
        return {"version_id": target["version_id"], "result": "pass" if ok else "fail", "duration_ms": result.get("duration_ms", 0),
                "error_excerpt": "" if ok else result.get("output_excerpt", "")[-1000:]}
    except Exception as e:  # a tool that cannot even start is a failed check, not a crashed job
        return {"version_id": target["version_id"], "result": "fail", "duration_ms": int((time.time() - started) * 1000), "error_excerpt": str(e)[-1000:]}


def domains(target: dict) -> set[str]:
    return {d.lstrip("*.").lower() for d in target.get("domains") or []}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in ("targets", "run"):
        print(__doc__, file=sys.stderr)
        return 2
    if sys.argv[1] == "targets":
        targets = api("/internal/health/targets")["targets"]
        batches = [targets[i:i + BATCH] for i in range(0, len(targets), BATCH)]
        print(json.dumps([{"n": i, "targets": b} for i, b in enumerate(batches)]))
        return 0
    batch = json.loads(Path(sys.argv[2]).read_text())
    last_seen: dict[str, float] = {}
    results = []
    for target in batch["targets"]:
        wait = max((last_seen.get(d, 0) + PER_DOMAIN_GAP - time.time() for d in domains(target)), default=0)
        if wait > 0:
            time.sleep(wait)
        res = check(target)
        for d in domains(target):
            last_seen[d] = time.time()
        scan.log(f"{target['ref']}@{target['version']}: {res['result']}")
        results.append(res)
    answer = api("/internal/health", {"results": results})
    scan.log(f"registry applied {answer.get('applied')} result(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
