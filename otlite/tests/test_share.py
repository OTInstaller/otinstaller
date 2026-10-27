"""Sharing saved runs as a link that works for 24 hours (otlite share, otlite shares)."""

import io
import json
import os
import sys
import time
import urllib.error

import pytest
from typer.testing import CliRunner

from otlite import share
from otlite.cli import app
from otlite.config import get_results_dir
from otlite.results import RunMeta, results_paths, write_meta

runner = CliRunner()


@pytest.fixture(autouse=True)
def _homes(tmp_path, monkeypatch):
    monkeypatch.setenv("OTLITE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("OTLITE_RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.delenv("OTLITE_API_URL", raising=False)


def _save(
    tool="sherlock", target="johndoe", case=None, output="[+] GitHub: https://github.com/johndoe\n"
):
    out, meta_path = results_paths(tool, target, case)
    out.write_text(output)
    meta = RunMeta(
        command=[tool, target, "--api-key", "***"],
        tool=tool,
        tool_version="0.16.2",
        target=target,
        case=case,
        started_at="2026-10-27T10:00:00+00:00",
        ended_at="2026-10-27T10:00:04+00:00",
        duration_seconds=4.0,
        exit_code=0,
        status="complete",
        output_path=out.relative_to(get_results_dir()).as_posix(),
        sha256="0" * 64,
        bytes=len(output),
    )
    write_meta(meta, meta_path)
    return out, meta_path


class _Answer(io.BytesIO):
    def __init__(self, body: dict, status: int = 201):
        super().__init__(json.dumps(body).encode())
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeRegistry:
    """Stands in for urllib.request.urlopen against the share routes."""

    def __init__(self):
        self.requests = []
        self.fail: urllib.error.URLError | None = None

    def __call__(self, req, timeout=None):
        body = json.loads(req.data) if req.data else None
        self.requests.append((req.get_method(), req.full_url, dict(req.header_items()), body))
        if self.fail:
            raise self.fail
        if req.get_method() == "POST":
            now = int(time.time() * 1000)
            return _Answer(
                {
                    "id": "A" * 22,
                    "url": "https://otinstaller.com/r/" + "A" * 22,
                    "created_at": now,
                    "expires_at": now + 86_400_000,
                    "delete_token": "secret-token",
                    "owned": False,
                    "runs": len(body["runs"]),
                    "tools": [r["tool"] for r in body["runs"]],
                }
            )
        return _Answer({}, 204)


@pytest.fixture
def registry(monkeypatch):
    fake = FakeRegistry()
    monkeypatch.setattr(share, "urlopen", fake)
    return fake


def _http_error(status, code, message):
    body = json.dumps({"error": {"code": code, "message": message, "hint": "wait"}}).encode()
    return urllib.error.HTTPError("https://x", status, message, {}, io.BytesIO(body))


def test_a_shared_run_keeps_what_was_found_and_drops_local_details():
    _, meta_path = _save(case="acme")
    payload = share.build_payload([meta_path])
    assert payload["share"] == 1 and payload["source"] == "otlite"
    run = payload["runs"][0]
    assert run["tool"] == "sherlock@0.16.2"
    assert run["runtime"] == "otlite"
    assert run["input"] == {"target": "johndoe"}
    assert run["raw"] == "[+] GitHub: https://github.com/johndoe\n"
    assert {"type": "url", "value": "https://github.com/johndoe", "source": "text"} in run[
        "entities"
    ]
    assert "case" not in run and "command" not in run
    assert run["output"] == {"sha256": "0" * 64, "bytes": 39}
    text = json.dumps(payload)
    assert "acme" not in text and "results" not in text and "***" not in text


def test_large_output_goes_without_raw(monkeypatch):
    monkeypatch.setattr(share, "MAX_RAW", 10)
    _, meta_path = _save()
    run = share.build_payload([meta_path])["runs"][0]
    assert run["raw"] is None
    assert run["output"]["raw_omitted"] is True
    assert run["entities"]
    assert any("raw left out" in w for w in run["warnings"])


def test_a_run_is_found_by_any_of_its_files():
    out, meta_path = _save()
    for path in (out, meta_path, meta_path.with_name(out.stem + ".envelope.json")):
        assert share.find_run(path) == meta_path
    with pytest.raises(share.ShareError):
        share.find_run(out.with_name("nothing.txt"))


def test_runs_by_case_and_by_tool_and_target():
    _save("sherlock", "johndoe", case="acme")
    _save("maigret", "johndoe", case="acme")
    _save("holehe", "a@example.com")
    base = get_results_dir()
    assert len(share.runs_in_case(base, "acme")) == 2
    newest = share.newest_run(base, "holehe", None)
    assert newest == share.newest_run(base, "holehe", "a@example.com")
    assert newest.name.endswith(".meta.json")
    with pytest.raises(share.ShareError):
        share.runs_in_case(base, "nope")
    with pytest.raises(share.ShareError):
        share.newest_run(base, "sherlock", "janedoe")


def test_limits_are_checked_before_the_upload(monkeypatch):
    _, meta_path = _save()
    payload = share.build_payload([meta_path])
    with pytest.raises(share.ShareError, match="at most"):
        share.encode({**payload, "runs": payload["runs"] * 51})
    monkeypatch.setattr(share, "MAX_BYTES", 100)
    with pytest.raises(share.ShareError, match="MB"):
        share.encode(payload)


def test_upload_is_anonymous_and_remembers_the_delete_token(registry):
    _, meta_path = _save()
    made = share.upload(share.encode(share.build_payload([meta_path])))
    method, url, headers, body = registry.requests[0]
    assert (method, url) == ("POST", "https://api.otinstaller.com/v1/shares")
    assert "Authorization" not in headers
    assert headers["User-agent"].startswith("otlite/")
    assert body["runs"][0]["tool"] == "sherlock@0.16.2"
    share.remember(made)
    saved = share.load_shares()
    assert [s["id"] for s in saved] == ["A" * 22]
    assert saved[0]["delete_token"] == "secret-token"
    if sys.platform != "win32":
        assert oct(share.shares_file().stat().st_mode & 0o777) == "0o600"


def test_api_url_can_point_at_a_local_registry(registry, monkeypatch):
    monkeypatch.setenv("OTLITE_API_URL", "http://127.0.0.1:8787/v1/")
    _, meta_path = _save()
    share.upload(share.encode(share.build_payload([meta_path])))
    assert registry.requests[0][1] == "http://127.0.0.1:8787/v1/shares"


def test_registry_errors_and_no_network_become_share_errors(registry):
    _, meta_path = _save()
    body = share.encode(share.build_payload([meta_path]))
    registry.fail = _http_error(429, "too_many_requests", "at most 20 shares an hour")
    with pytest.raises(share.ShareError, match="at most 20 shares an hour") as caught:
        share.upload(body)
    assert caught.value.code == "too_many_requests"
    registry.fail = urllib.error.URLError("no route to host")
    with pytest.raises(share.ShareError, match="can't reach"):
        share.upload(body)


def test_expired_shares_are_forgotten():
    now = int(time.time() * 1000)
    share.remember(
        {"id": "old", "url": "u", "delete_token": "t", "created_at": 1, "expires_at": now - 1}
    )
    share.remember(
        {"id": "new", "url": "u", "delete_token": "t", "created_at": 2, "expires_at": now + 60_000}
    )
    assert [s["id"] for s in share.load_shares()] == ["new"]
    share.forget("new")
    assert share.load_shares() == []


def test_delete_sends_the_token_and_tolerates_a_gone_share(registry):
    assert share.delete("A" * 22, "secret-token") is True
    method, url, headers, body = registry.requests[0]
    assert (method, url, body) == (
        "DELETE",
        "https://api.otinstaller.com/v1/shares/" + "A" * 22,
        {"delete_token": "secret-token"},
    )
    registry.fail = _http_error(404, "share_not_found", "no such shared result")
    assert share.delete("A" * 22, "secret-token") is False


@pytest.fixture
def linux(monkeypatch):
    monkeypatch.setattr("otlite.cli._require_supported_platform", lambda: None)


def test_cli_dry_run_uploads_nothing(registry, linux):
    out, _ = _save(case="acme")
    result = runner.invoke(app, ["share", str(out), "--dry-run"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["runs"][0]["input"] == {"target": "johndoe"}
    assert registry.requests == []


def test_cli_needs_yes_without_a_terminal(registry, linux):
    out, _ = _save()
    result = runner.invoke(app, ["share", str(out)])
    assert result.exit_code == 2
    assert "--yes" in result.output
    assert registry.requests == []


def test_cli_asks_at_a_terminal(registry, linux, monkeypatch):
    monkeypatch.setattr("otlite.cli._stdin_is_terminal", lambda: True)
    out, _ = _save()
    result = runner.invoke(app, ["share", str(out)], input="n\n")
    assert "Share 1 run (sherlock) on johndoe for 24 hours?" in result.output
    assert registry.requests == []
    result = runner.invoke(app, ["share", str(out)], input="y\n")
    assert result.exit_code == 0, result.output
    assert "https://otinstaller.com/r/" + "A" * 22 in result.output


def test_cli_shares_a_case_and_lists_and_deletes(registry, linux):
    _save("sherlock", "johndoe", case="acme")
    _save("maigret", "johndoe", case="acme")
    result = runner.invoke(app, ["share", "--case", "acme", "--yes", "--json"])
    assert result.exit_code == 0, result.output
    assert len(registry.requests[0][3]["runs"]) == 2
    assert json.loads(result.output)["delete_token"] == "secret-token"

    listed = runner.invoke(app, ["shares", "--json"])
    assert listed.exit_code == 0, listed.output
    rows = json.loads(listed.output)["shares"]
    assert [r["id"] for r in rows] == ["A" * 22]
    assert "secret-token" not in listed.output

    gone = runner.invoke(app, ["shares", "rm", "https://otinstaller.com/r/" + "A" * 22])
    assert gone.exit_code == 0, gone.output
    assert registry.requests[-1][0] == "DELETE"
    assert share.load_shares() == []
    unknown = runner.invoke(app, ["shares", "rm", "B" * 22])
    assert unknown.exit_code == 2


def test_cli_without_runs_named_is_a_usage_error(registry, linux):
    result = runner.invoke(app, ["share", "--yes"])
    assert result.exit_code == 2
    assert os.environ.get("OTLITE_API_URL") is None
