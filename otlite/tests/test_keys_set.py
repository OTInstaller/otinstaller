"""otlite keys set / list / rm and the env-file writer."""

import json
import os
import stat
import sys

import pytest
from typer.testing import CliRunner

from otlite.cli import app
from otlite.keys import load_env_file, remove_key, set_key

runner = CliRunner()


@pytest.fixture
def home(monkeypatch, tmp_path):
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "linux")
    return tmp_path


def test_set_creates_private_file_and_round_trips(home):
    set_key("SHODAN_API_KEY", "abc123")
    env = home / ".env"
    assert load_env_file() == {"SHODAN_API_KEY": "abc123"}
    assert env.read_text().startswith("# API keys")
    if os.name == "posix":
        assert stat.S_IMODE(env.stat().st_mode) == 0o600


def test_set_replaces_and_keeps_other_lines(home):
    (home / ".env").write_text("# mine\nA_KEY=1\nB_KEY=2\nA_KEY=old\n")
    set_key("A_KEY", "new")
    text = (home / ".env").read_text()
    assert text == "# mine\nA_KEY=new\nB_KEY=2\n"


@pytest.mark.parametrize("value", ["  padded ", '"quoted"', "has spaces in it", "x=y#z"])
def test_values_survive_the_round_trip(home, value):
    set_key("K", value)
    assert load_env_file()["K"] == value


@pytest.mark.parametrize(
    ("name", "value"), [("lower", "x"), ("1BAD", "x"), ("OK", ""), ("OK", "a\nb")]
)
def test_set_rejects_bad_input(home, name, value):
    with pytest.raises(ValueError):
        set_key(name, value)


def test_remove(home):
    set_key("A_KEY", "1")
    set_key("B_KEY", "2")
    assert remove_key("A_KEY") is True
    assert remove_key("A_KEY") is False
    assert load_env_file() == {"B_KEY": "2"}


def test_cli_set_from_piped_stdin_never_prints_the_value(home):
    result = runner.invoke(app, ["keys", "set", "SHODAN_API_KEY"], input="s3cret\n")
    assert result.exit_code == 0, result.output
    assert "saved SHODAN_API_KEY" in result.output
    assert "used by: openosint, theharvester" in result.output
    assert "s3cret" not in result.output
    assert load_env_file()["SHODAN_API_KEY"] == "s3cret"


def test_cli_set_from_env(home, monkeypatch):
    monkeypatch.setenv("MY_SHODAN", "fromenv")
    result = runner.invoke(
        app, ["keys", "set", "SHODAN_API_KEY", "--from-env", "MY_SHODAN", "--json"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == {
        "key": "SHODAN_API_KEY",
        "saved": True,
        "used_by": ["openosint", "theharvester"],
    }
    assert "fromenv" not in result.output


def test_cli_set_errors(home):
    assert runner.invoke(app, ["keys", "set", "bad name"], input="x\n").exit_code == 2
    assert runner.invoke(app, ["keys", "set", "OK", "--from-env", "NOPE_UNSET"]).exit_code == 2


def test_cli_list_and_rm(home):
    set_key("SHODAN_API_KEY", "v")
    set_key("UNUSED_KEY", "w")
    listed = json.loads(runner.invoke(app, ["keys", "list", "--json"]).output)
    assert listed == [
        {"key": "SHODAN_API_KEY", "used_by": ["openosint", "theharvester"]},
        {"key": "UNUSED_KEY", "used_by": []},
    ]
    table = runner.invoke(app, ["keys", "list"]).output
    assert "SHODAN_API_KEY" in table and "v" not in table.split()
    assert runner.invoke(app, ["keys", "rm", "UNUSED_KEY"]).exit_code == 0
    assert runner.invoke(app, ["keys", "rm", "UNUSED_KEY"]).exit_code == 1
