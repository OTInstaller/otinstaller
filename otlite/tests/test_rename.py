"""The otinstaller name: old environment variables still work and an old home is migrated."""

from pathlib import Path

from otlite import config


def test_new_variable_wins_over_old(monkeypatch):
    monkeypatch.setenv("OTLITE_HOME", "/new")
    monkeypatch.setenv("OTINSTALLER_HOME", "/old")
    assert config.env_value("HOME") == "/new"


def test_old_variable_is_read_when_new_is_unset(monkeypatch):
    monkeypatch.delenv("OTLITE_HOME", raising=False)
    monkeypatch.setenv("OTINSTALLER_HOME", "/old")
    assert config.env_value("HOME") == "/old"
    assert config.get_home() == Path("/old")


def test_empty_new_variable_counts_as_unset(monkeypatch):
    monkeypatch.setenv("OTLITE_RESULTS_DIR", "")
    monkeypatch.setenv("OTINSTALLER_RESULTS_DIR", "/r")
    assert config.get_results_dir() == Path("/r")


def test_neither_set(monkeypatch):
    monkeypatch.delenv("OTLITE_REGISTRY", raising=False)
    monkeypatch.delenv("OTINSTALLER_REGISTRY", raising=False)
    assert config.env_value("REGISTRY") is None


def _fake_home(monkeypatch, tmp_path):
    monkeypatch.delenv("OTLITE_HOME", raising=False)
    monkeypatch.delenv("OTINSTALLER_HOME", raising=False)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    return tmp_path


def test_migrates_keys_and_settings_once(monkeypatch, tmp_path):
    home = _fake_home(monkeypatch, tmp_path)
    old = home / ".otinstaller"
    old.mkdir()
    (old / ".env").write_text("EXAMPLE_KEY=value\n")
    (old / "accepted.json").write_text("{}")
    (old / "tools").mkdir()

    assert config.migrate_old_home() == [".env", "accepted.json"]
    new = home / ".otlite"
    assert (new / ".env").read_text() == "EXAMPLE_KEY=value\n"
    assert (new / "accepted.json").exists()
    assert not (new / "tools").exists()
    assert (old / ".env").exists()
    # The second run finds the new home and leaves it alone
    (new / ".env").write_text("CHANGED=1\n")
    assert config.migrate_old_home() == []
    assert (new / ".env").read_text() == "CHANGED=1\n"


def test_nothing_to_migrate(monkeypatch, tmp_path):
    home = _fake_home(monkeypatch, tmp_path)
    assert config.migrate_old_home() == []
    assert not (home / ".otlite").exists()


def test_env_var_home_is_never_migrated_into(monkeypatch, tmp_path):
    home = _fake_home(monkeypatch, tmp_path)
    (home / ".otinstaller").mkdir()
    (home / ".otinstaller" / ".env").write_text("K=v\n")
    monkeypatch.setenv("OTINSTALLER_HOME", str(home / ".otinstaller"))
    assert config.old_home() is None
    assert config.migrate_old_home() == []
    assert not (home / ".otlite").exists()


def test_entry_point_prints_the_note_on_stderr(monkeypatch, tmp_path, capsys):
    from otlite import cli

    home = _fake_home(monkeypatch, tmp_path)
    (home / ".otinstaller").mkdir()
    (home / ".otinstaller" / ".env").write_text("K=v\n")
    monkeypatch.setattr(cli, "app", lambda: None)
    cli.run_cli()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "copied .env from ~/.otinstaller to ~/.otlite" in captured.err
    cli.run_cli()
    assert capsys.readouterr().err == ""
