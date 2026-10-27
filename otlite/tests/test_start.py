"""otlite start: starter packs and tools in one go."""

import json
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

import otlite.cli as cli
from otlite.cli import app
from otlite.compat import incompatibility
from otlite.notice import has_accepted, record_acceptance
from otlite.registry import default_registry_path, load_registry
from otlite.start import (
    Choices,
    bundled_packs,
    check,
    command_line,
    fold,
    keys_to_set,
    sample_target,
    split_names,
    to_install,
)
from otlite.state import InstalledTool, add_installed

runner = CliRunner()


@pytest.fixture(autouse=True)
def _home(monkeypatch, tmp_path):
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path / "home"))
    # A ./playbooks folder must never become a starter pack.
    monkeypatch.chdir(tmp_path)


@pytest.fixture
def supported(monkeypatch):
    """The command checks the platform first; these tests are about what comes after."""
    monkeypatch.setattr(cli, "_require_supported_platform", lambda: None)


@pytest.fixture
def installs(monkeypatch):
    done = []

    def fake_install_tool(tool, force=False, stream=False):
        done.append(tool.name)
        now = "2026-10-27T00:00:00+00:00"
        add_installed(
            InstalledTool(tool.name, "1.0", "pip", "test", None, None, None, None, now, now)
        )
        return SimpleNamespace(name=tool.name, version="1.0")

    monkeypatch.setattr(cli, "install_tool", fake_install_tool)
    return done


def _tools():
    return load_registry(default_registry_path())


def test_packs_are_the_bundled_playbooks_only(tmp_path):
    (tmp_path / "playbooks").mkdir()
    (tmp_path / "playbooks" / "mine.yaml").write_text("name: mine\ntools: [sherlock]\n")
    packs = {p.name: p for p in bundled_packs()}
    assert set(packs) == {"domain-recon", "username-investigation"}
    assert packs["username-investigation"].tools == ["sherlock", "maigret"]
    assert packs["domain-recon"].description


def test_every_pack_tool_is_in_the_registry():
    names = {t.name for t in _tools()}
    for pack in bundled_packs():
        assert set(pack.tools) <= names, pack.name


def test_split_names_takes_commas_and_repeats():
    assert split_names(["a,b", "c", "a", " d ", ""]) == ["a", "b", "c", "d"]
    assert split_names(None) == []


def test_check_names_unknown_packs_and_tools():
    errors = check(Choices(playbooks=["people"], tools=["sherlok"]), _tools(), bundled_packs())
    assert errors[0].startswith("unknown starter pack 'people'")
    assert "domain-recon" in errors[0]
    assert errors[1].startswith("unknown tool 'sherlok'")
    assert "sherlock" in errors[1]
    ok = Choices(playbooks=["domain-recon"], tools=["sherlock"])
    assert check(ok, _tools(), bundled_packs()) == []


def test_to_install_puts_pack_tools_first_without_duplicates():
    c = Choices(playbooks=["username-investigation"], tools=["maigret", "holehe"])
    assert to_install(c, bundled_packs()) == ["sherlock", "maigret", "holehe"]


def test_fold_keeps_a_pack_only_when_all_its_tools_are_there():
    packs = bundled_packs()
    c = fold(["sherlock", "holehe"], ["username-investigation"], packs, installed={"maigret"})
    assert (c.playbooks, c.tools) == (["username-investigation"], ["holehe"])
    c = fold(["sherlock", "holehe"], ["username-investigation"], packs, installed=set())
    assert (c.playbooks, c.tools) == ([], ["sherlock", "holehe"])


def test_command_line_repeats_the_choices():
    c = Choices(playbooks=["domain-recon"], tools=["sherlock", "holehe"], keys=True)
    assert command_line(c, yes=True) == (
        "otlite start --playbooks domain-recon --tools sherlock,holehe --keys --yes"
    )
    assert command_line(Choices()) == "otlite start"


def test_keys_to_set_lists_unset_keys_required_first():
    tools = _tools()
    keyed = [t for t in tools if t.api_keys.required or t.api_keys.optional]
    assert keyed
    names = [t.name for t in keyed]
    wanted = keys_to_set(names, tools, env={})
    declared = {k for t in keyed for k in (*t.api_keys.required, *t.api_keys.optional)}
    assert {k for k, _, _ in wanted} == declared
    required = [r for _, r, _ in wanted]
    assert required == sorted(required, reverse=True)
    first = wanted[0][0]
    assert first not in {k for k, _, _ in keys_to_set(names, tools, env={first: "x"})}


def test_sample_target_follows_the_pack():
    assert sample_target("domain-recon") == "example.com"
    assert sample_target("username-investigation") == "johndoe"


def test_dry_run_shows_the_plan_and_writes_nothing(supported, tmp_path):
    result = runner.invoke(
        app,
        ["start", "--playbooks", "domain-recon", "--tools", "Sherlock", "--dry-run", "--json"],
    )
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data["install"] == ["dnstwist", "ctfr", "sherlock"]
    assert data["command"] == "otlite start --playbooks domain-recon --tools sherlock --yes"
    assert not (tmp_path / "home").exists()


def test_bad_names_change_nothing(supported, tmp_path):
    result = runner.invoke(app, ["start", "--playbooks", "people", "--yes"])
    assert result.exit_code == 2
    assert "unknown starter pack 'people'" in result.output
    assert not has_accepted()


def test_without_a_terminal_it_needs_yes(supported):
    result = runner.invoke(app, ["start", "--tools", "sherlock"])
    assert result.exit_code == 1
    assert "run with --yes" in result.output
    assert not has_accepted()


def test_json_needs_yes_or_dry_run(supported):
    result = runner.invoke(app, ["start", "--json"])
    assert result.exit_code == 2
    assert "--json needs --yes or --dry-run" in result.output


def test_yes_accepts_the_notice_and_installs(supported, installs, tmp_path):
    result = runner.invoke(app, ["start", "--playbooks", "username-investigation", "--yes"])
    assert result.exit_code == 0, result.output
    assert installs == ["sherlock", "maigret"]
    assert has_accepted()
    assert (tmp_path / "home" / ".env").exists()
    assert "otlite playbook username-investigation johndoe" in result.output


def _accept(tmp_path):
    (tmp_path / "home").mkdir(exist_ok=True)
    record_acceptance()


def test_keys_without_a_terminal_are_left_for_later(supported, installs):
    # One this Python can install: some keyed tools refuse newer Pythons.
    keyed = next(
        t
        for t in _tools()
        if (t.api_keys.required or t.api_keys.optional) and incompatibility(t) is None
    )
    result = runner.invoke(app, ["start", "--tools", keyed.name, "--keys", "--yes"])
    assert result.exit_code == 0, result.output
    assert "otlite keys set" in result.output


def test_the_wizard_decides_what_is_installed(supported, installs, monkeypatch, tmp_path):
    _accept(tmp_path)
    monkeypatch.setattr(cli, "_at_terminal", lambda: True)
    seen = {}

    def wizard(choices, tools, packs, installed):
        seen["playbooks"] = choices.playbooks
        return Choices(tools=["holehe"])

    monkeypatch.setattr(cli, "_start_wizard", wizard)
    result = runner.invoke(app, ["start", "--playbooks", "domain-recon"])
    assert result.exit_code == 0, result.output
    assert seen["playbooks"] == ["domain-recon"]
    assert installs == ["holehe"]


def test_the_wizard_declined_or_cancelled_changes_nothing(
    supported, installs, monkeypatch, tmp_path
):
    _accept(tmp_path)
    monkeypatch.setattr(cli, "_at_terminal", lambda: True)
    monkeypatch.setattr(cli, "_start_wizard", lambda *a: None)
    result = runner.invoke(app, ["start"])
    assert result.exit_code == 0
    assert "nothing was changed" in result.output

    def cancel(*a):
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "_start_wizard", cancel)
    result = runner.invoke(app, ["start"])
    assert result.exit_code == 130
    assert installs == []
