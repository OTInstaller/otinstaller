"""Build the website's otlite catalog from the registry.

Run `python scripts/web_catalog.py` to rewrite web/src/data/otlite-catalog.json, which the
otinstaller.com /otlite pages read at build time: the catalog and a page for each tool.
`tests/test_web_catalog.py` fails when it is stale.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

from otlite import __version__
from otlite.cli import _build_tool_args, _unattended_skip_reason
from otlite.examples import SAMPLE_VALUES, example_command
from otlite.notice import NOTICE_SHORT
from otlite.registry import Tool, load_registry

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "src" / "otlite" / "data" / "registry.yaml"
PLAYBOOKS = ROOT / "src" / "otlite" / "data" / "playbooks"
SEED = ROOT.parent / "seed" / "community"
OUTPUT = ROOT.parent / "web" / "src" / "data" / "otlite-catalog.json"

# The order a page offers a tool's inputs in: the one a newcomer most likely has first.
_ORDER = ("u", "e", "d", "p", "url", "ip", "q", "tg", "geo", "lat", "lng")
# Inputs that only make sense together.
_PAIRS = (("lat", "lng"),)


def _input_groups(tool: Tool) -> list[tuple[str, ...]]:
    prefixes = sorted(tool.input_types, key=lambda p: _ORDER.index(p) if p in _ORDER else 99)
    groups: list[tuple[str, ...]] = []
    for prefix in prefixes:
        pair = next((p for p in _PAIRS if prefix in p and set(p) <= set(prefixes)), None)
        if pair is None:
            groups.append((prefix,))
        elif prefix == pair[0]:
            groups.append(pair)
    return groups


def _inputs(tool: Tool) -> list[dict]:
    entries = []
    for group in _input_groups(tool):
        samples = {p: SAMPLE_VALUES.get(p, "example") for p in group}
        typed = " ".join(f"{p}:{samples[p]}" for p in group)
        entries.append(
            {
                "parts": [
                    {"prefix": p, "flag": tool.input_types[p], "sample": samples[p]} for p in group
                ],
                "command": f"otlite run {tool.name} -- {typed}",
                "tool_args": _build_tool_args(tool, samples),
            }
        )
    return entries


def _playbooks(name: str) -> list[str]:
    names = []
    for path in sorted(PLAYBOOKS.glob("*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if name in data.get("tools", []):
            names.append(path.stem)
    return names


def _registry_package(name: str) -> str | None:
    """The `ot` registry wrapper of this tool in the launch seed, published or not."""
    manifest = SEED / name / "otinstaller.yaml"
    if not manifest.exists():
        return None
    data = yaml.safe_load(manifest.read_text(encoding="utf-8"))
    return f"{data['namespace']}/{data['name']}"


def _entry(t: Tool) -> dict:
    install = t.install
    return {
        "name": t.name,
        "display_name": t.display_name,
        "description": t.description,
        "repo": t.repo,
        "license": t.license,
        "accepts": list(t.accepts),
        "input_types": sorted(t.input_types),
        "api_keys": {
            "required": list(t.api_keys.required),
            "optional": list(t.api_keys.optional),
        },
        "dual_use": "dual-use" in t.capabilities,
        "interactive": t.interactive,
        "example": example_command(t),
        "stars": t.stars,
        "capabilities": list(t.capabilities),
        "topics": list(t.topics),
        "install": {
            "method": install.method,
            "package": install.package,
            "version": install.version,
            "url": install.url,
            "ref": install.ref,
            "extra_packages": list(install.extra_packages),
            "playwright_browsers": list(install.playwright_browsers),
        },
        "entrypoint": {"command": t.entrypoint.command, "script": t.entrypoint.script},
        "requires_python": t.requires_python,
        "needs_config": t.needs_config,
        "long_running": t.long_running,
        "run_from_source": t.run_from_source,
        "default_args": list(t.default_args),
        "verified": (
            {
                "date": t.verified.date,
                "version": t.verified.version,
                "os": t.verified.os,
                "python": t.verified.python,
            }
            if t.verified
            else None
        ),
        "notes": list(t.notes),
        "inputs": _inputs(t),
        "batch_skip": _unattended_skip_reason(t, include_credentialed=False),
        "playbooks": _playbooks(t.name),
        "registry": _registry_package(t.name),
    }


def build() -> str:
    tools = sorted(load_registry(REGISTRY), key=lambda t: t.display_name.lower())
    catalog = {"otlite": __version__, "notice": NOTICE_SHORT, "tools": [_entry(t) for t in tools]}
    return json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(build(), encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT.relative_to(ROOT.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
