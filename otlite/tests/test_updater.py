"""Tests for the newer-otlite check."""

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from otlite import updater


@pytest.fixture
def online(monkeypatch, tmp_path):
    """The check switched on, with PyPI answering through the returned list of versions."""
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    for name in ("OTLITE_NO_UPDATE_CHECK", "OTINSTALLER_NO_UPDATE_CHECK", "DO_NOT_TRACK", "CI"):
        monkeypatch.delenv(name, raising=False)
    answers: list[str | None] = ["1.4.0"]
    asked: list[str] = []

    def fake(package: str, timeout: float = 10) -> str | None:
        asked.append(package)
        return answers[0]

    monkeypatch.setattr(updater, "get_latest_pip_version", fake)
    return answers, asked


@pytest.mark.parametrize("env", ["OTLITE_NO_UPDATE_CHECK", "DO_NOT_TRACK", "CI"])
def test_switched_off(monkeypatch, tmp_path, env):
    """each opt-out stops the check before any request."""
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    for name in ("OTLITE_NO_UPDATE_CHECK", "DO_NOT_TRACK", "CI"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(env, "1")
    with patch("urllib.request.urlopen", side_effect=AssertionError("no request")):
        assert updater.check_disabled()
        assert updater.latest_otlite(cached=False) is None
        assert updater.notice("1.2.0", cached=False) is None


def test_explicit_check_asks_pypi(online):
    answers, asked = online
    assert updater.latest_otlite(cached=False) == "1.4.0"
    assert updater.latest_otlite(cached=False) == "1.4.0"
    assert asked == ["otlite", "otlite"]


def test_passive_check_uses_a_day_old_answer(online, tmp_path):
    answers, asked = online
    assert updater.latest_otlite(cached=True) == "1.4.0"
    answers[0] = "1.5.0"
    assert updater.latest_otlite(cached=True) == "1.4.0"
    assert len(asked) == 1
    # A day later it asks again.
    path = tmp_path / "update-check.json"
    data = json.loads(path.read_text())
    data["checked_at"] = time.time() - 25 * 3600
    path.write_text(json.dumps(data))
    assert updater.latest_otlite(cached=True) == "1.5.0"
    assert len(asked) == 2


def test_offline_tries_once_a_day(online):
    answers, asked = online
    answers[0] = None
    assert updater.latest_otlite(cached=True) is None
    assert updater.latest_otlite(cached=True) is None
    assert len(asked) == 1


def test_corrupt_cache_is_asked_again(online, tmp_path):
    answers, asked = online
    (tmp_path / "update-check.json").write_text("{not json")
    assert updater.latest_otlite(cached=True) == "1.4.0"
    assert len(asked) == 1


@pytest.mark.parametrize(
    ("latest", "current", "newer"),
    [
        ("1.10.0", "1.9.0", True),
        ("1.3.0", "1.3.0", False),
        ("1.2.9", "1.3.0", False),
        ("1.3.0rc1", "1.2.0", False),
        ("unknown", "1.2.0", False),
        ("2.0", "1.9.9", True),
    ],
)
def test_is_newer(latest, current, newer):
    assert updater.is_newer(latest, current) is newer


def test_notice(online):
    assert updater.notice("1.2.0", cached=False) == {
        "current": "1.2.0",
        "latest": "1.4.0",
        "outdated": True,
        "upgrade": updater.upgrade_command(),
    }
    assert updater.notice("1.4.0", cached=False)["outdated"] is False


def _prefix(tmp_path: Path, *files: str, cfg: str = "") -> Path:
    prefix = tmp_path / "venv"
    prefix.mkdir()
    for f in files:
        (prefix / f).write_text("")
    if cfg:
        (prefix / "pyvenv.cfg").write_text(cfg)
    return prefix


def test_upgrade_command_pipx(tmp_path):
    assert updater.upgrade_command(_prefix(tmp_path, "pipx_metadata.json")) == "pipx upgrade otlite"


def test_upgrade_command_pipx_shim(tmp_path):
    prefix = tmp_path / "otinstaller"
    prefix.mkdir()
    (prefix / "pipx_metadata.json").write_text("")
    assert updater.upgrade_command(prefix) == "pipx install otlite"


def test_upgrade_command_uv_tool(tmp_path):
    assert updater.upgrade_command(_prefix(tmp_path, "uv-receipt.toml")) == "uv tool upgrade otlite"


def test_upgrade_command_uv_venv(tmp_path):
    prefix = _prefix(tmp_path, cfg="home = /usr/bin\nuv = 0.9.0\n")
    assert updater.upgrade_command(prefix) == "uv pip install --upgrade otlite"


def test_upgrade_command_deb(tmp_path):
    assert (
        updater.upgrade_command(
            Path("/usr"), module=Path("/usr/lib/python3/dist-packages/otlite/updater.py")
        )
        is None
    )


def test_upgrade_command_pip(tmp_path):
    prefix = _prefix(tmp_path, cfg="home = /usr/bin\n")
    assert (
        updater.upgrade_command(prefix, python="/opt/py/bin/python3")
        == "/opt/py/bin/python3 -m pip install --upgrade otlite"
    )
