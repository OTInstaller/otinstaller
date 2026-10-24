"""llms.txt is read by programs: no control characters, closed fences, JSON that parses."""

import json
import re
from pathlib import Path

LLMS = Path(__file__).parent.parent / "llms.txt"


def test_no_control_characters():
    text = LLMS.read_text(encoding="utf-8")
    assert not re.search(r"[\x00-\x08\x0b-\x1f\x7f]", text)


def test_code_fences_are_balanced():
    fences = [
        line for line in LLMS.read_text(encoding="utf-8").splitlines() if line.startswith("```")
    ]
    assert len(fences) % 2 == 0
    assert all(f == "```" for f in fences[1::2])


def test_json_examples_parse():
    text = LLMS.read_text(encoding="utf-8")
    blocks = re.findall(r"^```json\n(.*?)^```", text, re.MULTILINE | re.DOTALL)
    assert blocks
    for block in blocks:
        for line in block.splitlines():
            if line.strip() and not line.startswith("//"):
                json.loads(line)


def test_tool_count_matches_the_catalog():
    from otlite.registry import default_registry_path, load_registry

    count = len(load_registry(default_registry_path()))
    assert f"## Available Tools ({count})" in LLMS.read_text(encoding="utf-8")
