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
    assert catalog.OUTPUT.exists(), "run: python scripts/web_catalog.py"
    current = catalog.OUTPUT.read_text(encoding="utf-8")
    assert current == catalog.build(), "stale; run: python scripts/web_catalog.py"


def test_web_catalog_lists_every_tool_with_an_example():
    data = json.loads(_load().build())
    assert len(data["tools"]) == 47
    for tool in data["tools"]:
        assert tool["example"].startswith(f"otlite run {tool['name']} -- ")


def test_web_catalog_has_what_a_tool_page_needs():
    from otlite.notice import NOTICE_SHORT

    data = json.loads(_load().build())
    assert data["notice"] == NOTICE_SHORT
    for tool in data["tools"]:
        assert tool["install"]["method"] in ("pip", "git"), tool["name"]
        assert tool["verified"]["date"], tool["name"]
        assert bool(tool["entrypoint"]["command"]) != bool(tool["entrypoint"]["script"])
        # Every typed input is offered once, with a command that runs it.
        covered = sorted(part["prefix"] for entry in tool["inputs"] for part in entry["parts"])
        assert covered == tool["input_types"], tool["name"]
        for entry in tool["inputs"]:
            assert entry["command"].startswith(f"otlite run {tool['name']} -- ")
            for part in entry["parts"]:
                assert part["sample"] in entry["tool_args"], tool["name"]


def test_web_catalog_inputs_show_what_the_tool_receives():
    by_name = {t["name"]: t for t in json.loads(_load().build())["tools"]}

    sherlock = by_name["sherlock"]["inputs"][0]
    assert sherlock["command"] == "otlite run sherlock -- u:johndoe"
    assert sherlock["tool_args"] == ["johndoe"]

    domain = next(e for e in by_name["mailaccess"]["inputs"] if e["parts"][0]["prefix"] == "d")
    assert domain["tool_args"] == ["--no-banner", "harvest-emails", "--domain", "example.com"]

    located = by_name["instagram-location-search"]["inputs"]
    assert [[p["prefix"] for p in e["parts"]] for e in located] == [["lat", "lng"]]


def test_web_catalog_batches_playbooks_and_registry():
    by_name = {t["name"]: t for t in json.loads(_load().build())["tools"]}
    assert by_name["sherlock"]["batch_skip"] is None
    assert by_name["sherlock"]["playbooks"] == ["username-investigation"]
    assert "asks questions" in by_name["ghunt"]["batch_skip"]
    assert by_name["ghunt"]["notes"]

    seed = SCRIPT.parents[2] / "seed" / "community"
    if not seed.exists():
        pytest.skip("not in a full checkout (no seed/)")
    assert by_name["sherlock"]["registry"] == "osintverse-community/sherlock"
    assert by_name["ghunt"]["registry"] is None
