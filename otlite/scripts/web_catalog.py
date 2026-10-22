"""Build the website's otlite catalog from the registry.

Run `python scripts/web_catalog.py` to rewrite web/src/data/otlite-catalog.json, which the
otinstaller.com /otlite/tools page reads at build time. `tests/test_web_catalog.py` fails when it
is stale.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from otlite import __version__
from otlite.examples import example_command
from otlite.registry import load_registry

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "src" / "otlite" / "data" / "registry.yaml"
OUTPUT = ROOT.parent / "web" / "src" / "data" / "otlite-catalog.json"


def build() -> str:
    tools = sorted(load_registry(REGISTRY), key=lambda t: t.display_name.lower())
    entries = [
        {
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
        }
        for t in tools
    ]
    return (
        json.dumps({"otlite": __version__, "tools": entries}, indent=2, ensure_ascii=False) + "\n"
    )


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(build(), encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT.relative_to(ROOT.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
