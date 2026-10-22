"""Tests for listing, filtering and sorting saved runs (otlite results)."""

import json
import sys
from datetime import datetime, timezone

import pytest
from typer.testing import CliRunner

from otlite.cli import app
from otlite.results import list_runs, parse_since, sort_runs

runner = CliRunner()


def _save(base, tool, target, started, *, status="complete", duration=1.0, size=10, case=None):
    folder = base / ("cases/" + case if case else "") / tool / target
    folder.mkdir(parents=True, exist_ok=True)
    stamp = started.replace(":", "").replace("-", "")[:15]
    meta = {
        "tool": tool,
        "target": target,
        "case": case,
        "started_at": started,
        "status": status,
        "duration_seconds": duration,
        "bytes": size,
        "output_path": f"{tool}/{target}/{stamp}_{tool}_{target}.txt",
    }
    (folder / f"{stamp}_{tool}_{target}.meta.json").write_text(json.dumps(meta))


@pytest.fixture
def base(tmp_path):
    b = tmp_path / "results"
    _save(b, "sherlock", "johndoe", "2026-10-20T10:00:00+00:00", duration=30, size=5000)
    _save(
        b, "sherlock", "janedoe", "2026-10-21T10:00:00+00:00", status="failed", duration=2, size=100
    )
    _save(b, "holehe", "a@example.com", "2026-10-22T09:00:00+00:00", duration=8, size=900)
    _save(
        b, "maigret", "johndoe", "2026-10-19T10:00:00+00:00", case="acme", duration=60, size=20000
    )
    return b


def test_lists_every_run_including_cases(base):
    assert len(list_runs(base)) == 4


def test_filters(base):
    assert {r["target"] for r in list_runs(base, tool="SHERLOCK")} == {"johndoe", "janedoe"}
    assert {r["tool"] for r in list_runs(base, target="JohnDoe")} == {"sherlock", "maigret"}
    assert [r["tool"] for r in list_runs(base, case="acme")] == ["maigret"]
    assert [r["target"] for r in list_runs(base, status="failed")] == ["janedoe"]
    since = datetime(2026, 10, 21, tzinfo=timezone.utc)
    assert {r["tool"] for r in list_runs(base, since=since)} == {"sherlock", "holehe"}


def test_meta_path_is_relative(base):
    run = list_runs(base, tool="holehe")[0]
    assert run["meta_path"].startswith("holehe/a_example.com/") or run["meta_path"].startswith(
        "holehe/"
    )
    assert not run["meta_path"].startswith("/")


def test_unreadable_and_foreign_sidecars_are_skipped(base):
    (base / "sherlock" / "johndoe" / "broken.meta.json").write_text("{not json")
    (base / "sherlock" / "johndoe" / "other.meta.json").write_text(json.dumps({"hello": 1}))
    assert len(list_runs(base)) == 4


def test_missing_folder_is_empty(tmp_path):
    assert list_runs(tmp_path / "nothing") == []


@pytest.mark.parametrize(
    ("key", "first"),
    [("time", "holehe"), ("tool", "holehe"), ("duration", "maigret"), ("size", "maigret")],
)
def test_sort_keys(base, key, first):
    assert sort_runs(list_runs(base), key)[0]["tool"] == first


def test_sort_by_target_and_reverse(base):
    targets = [r["target"] for r in sort_runs(list_runs(base), "target")]
    assert targets == sorted(targets, key=str.lower)
    assert [r["tool"] for r in sort_runs(list_runs(base), "time", reverse=True)][0] == "maigret"


def test_sort_rejects_unknown_key(base):
    with pytest.raises(ValueError):
        sort_runs(list_runs(base), "colour")


def test_parse_since():
    now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
    assert parse_since("7d", now) == datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
    assert parse_since("12h", now) == datetime(2026, 10, 22, 0, 0, tzinfo=timezone.utc)
    assert parse_since("30m", now) == datetime(2026, 10, 22, 11, 30, tzinfo=timezone.utc)
    assert parse_since("2w", now) == datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
    assert parse_since("2026-10-01", now) == datetime(2026, 10, 1, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        parse_since("last week", now)


@pytest.fixture
def cli_env(base, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("OTLITE_RESULTS_DIR", str(base))
    monkeypatch.setenv("OTLITE_NO_BANNER", "1")
    return base


def test_command_json_sorted_and_limited(cli_env):
    result = runner.invoke(app, ["results", "--sort", "size", "--limit", "2", "--json"])
    assert result.exit_code == 0, result.output
    runs = json.loads(result.output)
    assert [r["tool"] for r in runs] == ["maigret", "sherlock"]
    assert all("meta_path" in r for r in runs)


def test_command_table(cli_env):
    result = runner.invoke(app, ["results", "--tool", "sherlock"])
    assert result.exit_code == 0, result.output
    assert "johndoe" in result.output and "janedoe" in result.output
    assert "2 runs" in result.output


def test_command_says_when_more_runs_exist(cli_env):
    result = runner.invoke(app, ["results", "--limit", "1"])
    assert "1 run of 4; --limit 0 shows all" in result.output


def test_command_empty(cli_env):
    result = runner.invoke(app, ["results", "--tool", "nothing"])
    assert result.exit_code == 0
    assert "no saved runs match" in result.output


@pytest.mark.parametrize(
    "args",
    [["--sort", "colour"], ["--status", "done"], ["--since", "soon"], ["--limit", "-1"]],
)
def test_command_rejects_bad_input(cli_env, args):
    result = runner.invoke(app, ["results", *args])
    assert result.exit_code == 2
