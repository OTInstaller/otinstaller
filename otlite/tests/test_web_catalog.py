"""The website's otlite catalog matches the registry."""

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "web_catalog.py"


def _load():
    spec = importlib.util.spec_from_file_location("web_catalog", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_web_catalog_is_up_to_date():
    catalog = _load()
    if not catalog.OUTPUT.parent.parent.exists():
        pytest.skip("not in a full checkout (no web/)")
    assert catalog.OUTPUT.exists(), "run: python scripts/web_catalog.py"
    current = catalog.OUTPUT.read_text(encoding="utf-8")
    assert current == catalog.build(), "stale; run: python scripts/web_catalog.py"


def test_web_catalog_lists_every_tool_with_an_example():
    data = json.loads(_load().build())
    assert len(data["tools"]) == 47
    for tool in data["tools"]:
        assert tool["example"].startswith(f"otlite run {tool['name']} -- ")
