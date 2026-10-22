"""The result envelope written next to every run."""

import json

from otlite.results import RunMeta, build_envelope, envelope_path_for, list_runs, write_meta


def _meta(**over):
    base = dict(
        command=["sherlock", "johndoe"],
        tool="sherlock",
        tool_version="0.16.2",
        target="johndoe",
        case=None,
        started_at="2026-10-22T10:00:00+00:00",
        ended_at="2026-10-22T10:00:04.100000+00:00",
        duration_seconds=4.1,
        exit_code=0,
        status="complete",
        output_path="sherlock/johndoe/20261022-100000_sherlock_johndoe_ab12cd34.txt",
        sha256="0" * 64,
        bytes=120,
    )
    base.update(over)
    return RunMeta(**base)


def test_envelope_shape():
    env = build_envelope(
        _meta(), "[+] GitHub: https://github.com/johndoe\nmail ada@example.com\n", False
    )
    assert env["envelope"] == 1
    assert env["tool"] == "sherlock@0.16.2"
    assert env["runtime"] == "otlite"
    assert env["input"] == {"target": "johndoe"}
    assert env["duration_ms"] == 4100
    assert {"type": "url", "value": "https://github.com/johndoe", "source": "text"} in env[
        "entities"
    ]
    assert {"type": "email", "value": "ada@example.com", "source": "text"} in env["entities"]
    assert env["warnings"] == []
    assert env["output"]["path"].endswith(".txt")


def test_tool_output_in_otlite_shape_is_kept():
    text = json.dumps({"entities": [{"type": "account", "value": "github.com/johndoe"}]})
    assert build_envelope(_meta(), text, False)["entities"] == [
        {"type": "account", "value": "github.com/johndoe"}
    ]


def test_truncation_is_a_warning():
    assert build_envelope(_meta(), "", True)["warnings"]


def test_write_meta_writes_the_envelope_and_results_lists_it(tmp_path):
    folder = tmp_path / "sherlock" / "johndoe"
    folder.mkdir(parents=True)
    out = folder / "20261022-100000_sherlock_johndoe_ab12cd34.txt"
    out.write_text("found https://example.com/johndoe\n")
    meta_path = out.with_suffix(".meta.json")
    write_meta(_meta(), meta_path)
    env_path = envelope_path_for(meta_path)
    assert env_path.name == "20261022-100000_sherlock_johndoe_ab12cd34.envelope.json"
    env = json.loads(env_path.read_text())
    assert {"type": "url", "value": "https://example.com/johndoe", "source": "text"} in env[
        "entities"
    ]
    run = list_runs(tmp_path)[0]
    assert (
        run["envelope_path"]
        == "sherlock/johndoe/20261022-100000_sherlock_johndoe_ab12cd34.envelope.json"
    )


def test_envelope_files_are_not_mistaken_for_runs(tmp_path):
    folder = tmp_path / "t" / "x"
    folder.mkdir(parents=True)
    out = folder / "20261022-100000_t_x_00000000.txt"
    out.write_text("")
    write_meta(_meta(tool="t", target="x"), out.with_suffix(".meta.json"))
    assert len(list_runs(tmp_path)) == 1
