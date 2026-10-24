"""The newer-otlite notice in check-updates, update and install, and the unpinned git comparison."""

import json
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from otlite import updater
from otlite.cli import app
from otlite.registry import ApiKeys, Entrypoint, Install, Tool
from otlite.state import InstalledTool, add_installed


@pytest.fixture
def one_tool(monkeypatch, tmp_path):
    """testtool 1.0.0 installed from pip, with the registry knowing it."""
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    now = datetime.now(timezone.utc).isoformat()
    add_installed(
        InstalledTool(
            name="testtool",
            version="1.0.0",
            method="pip",
            source="testpkg",
            ref=None,
            commit=None,
            entry_command="testtool",
            entry_script=None,
            installed_at=now,
            updated_at=now,
        )
    )
    tool = Tool(
        name="testtool",
        display_name="Test Tool",
        description="A tool",
        install=Install(method="pip", package="testpkg"),
        entrypoint=Entrypoint(command="testtool"),
        api_keys=ApiKeys(required=(), optional=()),
        capabilities=[],
        tier="community",
    )
    with patch("otlite.installer.core.get_latest_pip_version", return_value="1.0.0"):
        with patch("otlite.registry.load_registry", return_value=[tool]):
            yield


def _switch_on(monkeypatch, latest="9.0.0"):
    monkeypatch.delenv("OTLITE_NO_UPDATE_CHECK", raising=False)
    monkeypatch.delenv("DO_NOT_TRACK", raising=False)
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setattr(updater, "get_latest_pip_version", lambda package, timeout=10: latest)


def test_check_updates_json_carries_otlite(monkeypatch, one_tool):
    _switch_on(monkeypatch)
    result = CliRunner().invoke(app, ["check-updates", "--all", "--json"])
    assert result.exit_code == 0
    out = json.loads(result.stdout)
    assert out["otlite"]["latest"] == "9.0.0"
    assert out["otlite"]["outdated"] is True
    assert out["otlite"]["upgrade"]


def test_check_updates_json_otlite_is_null_when_off(one_tool):
    result = CliRunner().invoke(app, ["check-updates", "--all", "--json"])
    assert json.loads(result.stdout)["otlite"] is None


def test_check_updates_text_says_how_to_upgrade(monkeypatch, one_tool):
    _switch_on(monkeypatch)
    monkeypatch.setattr(updater, "upgrade_command", lambda *a, **k: "pipx upgrade otlite")
    result = CliRunner().invoke(app, ["check-updates", "--all"])
    assert "otlite 9.0.0 is out" in result.output
    assert "pipx upgrade otlite" in result.output


def test_check_updates_quiet_when_current(monkeypatch, one_tool):
    from otlite import __version__

    _switch_on(monkeypatch, latest=__version__)
    result = CliRunner().invoke(app, ["check-updates", "--all"])
    assert "is out" not in result.output


def test_update_check_only_json_stays_a_list(monkeypatch, one_tool):
    _switch_on(monkeypatch)
    result = CliRunner().invoke(app, ["update", "--all", "--check-only", "--json"])
    assert result.exit_code == 0
    assert isinstance(json.loads(result.stdout), list)
    assert "otlite 9.0.0 is out" in result.stderr


def test_reminder_once_a_day(monkeypatch, tmp_path):
    from otlite.cli import _remind_newer_otlite

    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    _switch_on(monkeypatch)
    printed: list[str] = []
    monkeypatch.setattr("otlite.cli._stderr_is_terminal", lambda: True)
    monkeypatch.setattr("typer.echo", lambda msg="", err=False, **k: printed.append(msg))
    _remind_newer_otlite()
    _remind_newer_otlite()
    assert len(printed) == 1
    assert "otlite 9.0.0 is out" in printed[0]


def test_reminder_not_without_a_terminal(monkeypatch, tmp_path):
    from otlite.cli import _remind_newer_otlite

    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    _switch_on(monkeypatch)
    printed: list[str] = []
    monkeypatch.setattr("otlite.cli._stderr_is_terminal", lambda: False)
    monkeypatch.setattr("typer.echo", lambda msg="", err=False, **k: printed.append(msg))
    _remind_newer_otlite()
    assert printed == []


def _git_tool(monkeypatch, tmp_path, installed: str, head: str):
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    now = datetime.now(timezone.utc).isoformat()
    add_installed(
        InstalledTool(
            name="gittool",
            version=installed,
            method="git",
            source="https://github.com/user/repo",
            ref=None,
            commit=installed,
            entry_command="gittool",
            entry_script=None,
            installed_at=now,
            updated_at=now,
        )
    )
    tool = Tool(
        name="gittool",
        display_name="Git Tool",
        description="A tool",
        install=Install(method="git", url="https://github.com/user/repo"),
        entrypoint=Entrypoint(command="gittool"),
        api_keys=ApiKeys(required=(), optional=()),
        capabilities=[],
        tier="community",
    )
    with patch("otlite.installer.core.get_latest_git_ref", return_value=head):
        with patch("otlite.registry.load_registry", return_value=[tool]):
            return json.loads(
                CliRunner().invoke(app, ["check-updates", "gittool", "--json"]).stdout
            )


def test_unpinned_git_tool_at_head_is_current(monkeypatch, tmp_path):
    head = "0123456789abcdef0123456789abcdef01234567"
    out = _git_tool(monkeypatch, tmp_path, head[:12], head)
    assert out["results"][0]["outdated"] is False


def test_unpinned_git_tool_behind_head_is_outdated(monkeypatch, tmp_path):
    out = _git_tool(
        monkeypatch, tmp_path, "aaaaaaaaaaaa", "0123456789abcdef0123456789abcdef01234567"
    )
    assert out["results"][0] == {
        "tool": "gittool",
        "current": "aaaaaaaaaaaa",
        "latest": "0123456789ab",
        "outdated": True,
    }
