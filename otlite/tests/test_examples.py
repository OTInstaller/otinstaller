"""Example commands in otlite info, and the ip: typed input."""

import json
import sys

from typer.testing import CliRunner

from otlite.cli import _build_tool_args, _parse_typed_inputs, app
from otlite.examples import SAMPLE_VALUES, example_command
from otlite.registry import default_registry_path, load_registry

runner = CliRunner()
TOOLS = {t.name: t for t in load_registry(default_registry_path())}


def test_every_tool_has_an_example_command():
    for tool in TOOLS.values():
        cmd = example_command(tool)
        assert cmd.startswith(f"otlite run {tool.name} -- "), cmd


def test_example_uses_a_typed_input_and_a_safe_value():
    assert example_command(TOOLS["sherlock"]) == "otlite run sherlock -- u:johndoe"
    assert example_command(TOOLS["holehe"]) == "otlite run holehe -- e:ada@example.com"


def test_tools_without_typed_inputs_show_their_help():
    assert example_command(TOOLS["fsociety"]) == "otlite run fsociety -- --help"


def test_lat_and_lng_go_together():
    cmd = example_command(TOOLS["instagram-location-search"])
    assert f"lat:{SAMPLE_VALUES['lat']}" in cmd and f"lng:{SAMPLE_VALUES['lng']}" in cmd


def test_example_values_parse_back_into_the_tools_flags():
    for tool in TOOLS.values():
        if not tool.input_types:
            continue
        args = example_command(tool).split(" -- ", 1)[1].split()
        typed, rest = _parse_typed_inputs(args)
        assert rest == [], tool.name
        built = _build_tool_args(tool, typed)
        for value in typed.values():
            assert value in built, (tool.name, built)


def test_ip_prefix_reaches_the_tool():
    typed, _ = _parse_typed_inputs(["ip:192.0.2.1"])
    assert typed == {"ip": "192.0.2.1"}
    assert _build_tool_args(TOOLS["bbot"], typed)[-2:] == ["-t", "192.0.2.1"]
    assert _build_tool_args(TOOLS["spiderfoot"], typed)[-2:] == ["-s", "192.0.2.1"]


def test_info_prints_the_example(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    out = runner.invoke(app, ["info", "sherlock"]).output
    assert "Example: otlite run sherlock -- u:johndoe" in out
    data = json.loads(runner.invoke(app, ["info", "sherlock", "--json"]).output)
    assert data["example_command"] == "otlite run sherlock -- u:johndoe"
