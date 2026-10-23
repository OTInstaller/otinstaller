"""macOS support and the install hints doctor prints."""

import sys

import pytest
from typer.testing import CliRunner

from otlite import config
from otlite.cli import app

runner = CliRunner()


@pytest.mark.parametrize(
    ("platform", "name"), [("linux", "Linux"), ("darwin", "macOS"), ("win32", None)]
)
def test_platform_name(monkeypatch, platform, name):
    monkeypatch.setattr(sys, "platform", platform)
    assert config.platform_name() == name


def test_macos_family(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert config.get_distro_family() == "macos"


@pytest.mark.parametrize(
    ("family", "what", "expected"),
    [
        ("debian", "git", "sudo apt install git"),
        ("fedora", "git", "sudo dnf install git"),
        ("macos", "pipx", "brew install pipx && pipx ensurepath"),
        ("debian", "venv", "sudo apt install python3.12-venv"),
        ("unknown", "pipx", "python3 -m pip install --user pipx && python3 -m pipx ensurepath"),
    ],
)
def test_install_hint(monkeypatch, family, what, expected):
    monkeypatch.setattr(config, "get_distro_family", lambda: family)
    assert config.install_hint(what, "3.12") == expected


def _doctor(monkeypatch, tmp_path, platform, which, version=(3, 12, 0, "final", 0)):
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path))
    monkeypatch.setattr("sys.platform", platform)
    monkeypatch.setattr("sys.version_info", version)
    monkeypatch.setattr("shutil.which", which)

    class Result:
        returncode = 0

    monkeypatch.setattr("subprocess.run", lambda *a, **k: Result())
    return runner.invoke(app, ["doctor"])


def test_doctor_ok_on_macos(monkeypatch, tmp_path):
    result = _doctor(monkeypatch, tmp_path, "darwin", lambda x: f"/opt/homebrew/bin/{x}")
    assert result.exit_code == 0, result.output
    assert "[ok] platform is macOS" in result.output
    assert "[ok] pipx found" in result.output


def test_doctor_says_how_to_install_git_and_pipx_on_macos(monkeypatch, tmp_path):
    result = _doctor(monkeypatch, tmp_path, "darwin", lambda x: None)
    assert result.exit_code == 1
    assert "git not found; install it with: xcode-select --install" in result.output
    assert "[note] pipx not found" in result.output
    assert "brew install pipx" in result.output


@pytest.mark.parametrize(
    ("marker", "expected"),
    [("uv-receipt.toml", "uv"), ("pipx_metadata.json", "pipx"), (None, None)],
)
def test_installed_with(monkeypatch, tmp_path, marker, expected):
    if marker:
        (tmp_path / marker).write_text("")
    monkeypatch.setattr(sys, "prefix", str(tmp_path))
    assert config.installed_with() == expected


def test_doctor_on_a_uv_install_needs_no_pipx(monkeypatch, tmp_path):
    prefix = tmp_path / "uv-tool"
    prefix.mkdir()
    (prefix / "uv-receipt.toml").write_text("")
    monkeypatch.setattr(sys, "prefix", str(prefix))

    def which(name):
        return None if name == "pipx" else f"/usr/bin/{name}"

    result = _doctor(monkeypatch, tmp_path, "linux", which)
    assert result.exit_code == 0, result.output
    assert "[ok] installed with uv; upgrade it with: uv tool upgrade otlite" in result.output
    assert "pipx not found" not in result.output


def test_doctor_on_an_unsupported_python_says_how_to_reinstall_with_uv(monkeypatch, tmp_path):
    (tmp_path / "uv-receipt.toml").write_text("")
    monkeypatch.setattr(sys, "prefix", str(tmp_path))
    old = (3, 9, 0, "final", 0)
    result = _doctor(monkeypatch, tmp_path, "linux", lambda x: f"/usr/bin/{x}", old)
    assert result.exit_code == 1
    assert "uv tool install --force --managed-python --python 3.12 otlite" in result.output
