"""What `otlite start` installs: starter packs (the bundled playbooks) and tools.

otinstaller.com/otlite/start builds the same command, so its flags here and on that page
change together.
"""

from __future__ import annotations

import importlib.resources
import shlex
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from otlite.registry import Tool, find_tool, suggest_names


@dataclass
class Pack:
    name: str
    description: str
    tools: list[str]


@dataclass
class Choices:
    playbooks: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    keys: bool = False


def bundled_packs() -> list[Pack]:
    """The playbooks shipped with otlite.

    ./playbooks is never offered: it can come with any downloaded folder.
    """
    folder = Path(str(importlib.resources.files("otlite") / "data" / "playbooks"))
    packs = []
    for pf in sorted(folder.glob("*.yaml")):
        data = yaml.safe_load(pf.read_text()) or {}
        packs.append(
            Pack(
                name=data.get("name", pf.stem),
                description=data.get("description", ""),
                tools=list(data.get("tools", [])),
            )
        )
    return packs


def split_names(values: list[str] | None) -> list[str]:
    """Names from repeated or comma-separated options, in order and without duplicates."""
    names: list[str] = []
    for value in values or []:
        for name in value.split(","):
            name = name.strip()
            if name and name not in names:
                names.append(name)
    return names


def check(choices: Choices, tools: list[Tool], packs: list[Pack]) -> list[str]:
    """Problems with the choices as error messages; empty when there are none."""
    errors = []
    pack_names = [p.name for p in packs]
    for name in choices.playbooks:
        if name not in pack_names:
            errors.append(f"unknown starter pack '{name}'; the packs are {', '.join(pack_names)}")
    for name in choices.tools:
        if find_tool(tools, name) is None:
            msg = f"unknown tool '{name}'"
            suggestions = suggest_names(tools, name)
            if suggestions:
                msg += f"; did you mean: {', '.join(suggestions)}?"
            errors.append(msg)
    return errors


def to_install(choices: Choices, packs: list[Pack]) -> list[str]:
    """Every tool the choices name: the packs' tools first, then the others."""
    by_name = {p.name: p for p in packs}
    names: list[str] = []
    for pack in choices.playbooks:
        names.extend(by_name[pack].tools if pack in by_name else [])
    names.extend(choices.tools)
    return list(dict.fromkeys(names))


def fold(
    selected: list[str], chosen_packs: list[str], packs: list[Pack], installed: set[str]
) -> Choices:
    """Turn a selection back into flags.

    A pack stays when all its tools are picked or already installed, so the flags never
    install a tool that was unticked; the other picked tools are named on their own.
    """
    have = set(selected) | installed
    kept = [p for p in packs if p.name in chosen_packs and all(t in have for t in p.tools)]
    covered = {t for p in kept for t in p.tools}
    return Choices(
        playbooks=[p.name for p in kept],
        tools=[t for t in dict.fromkeys(selected) if t not in covered],
    )


def command_line(choices: Choices, yes: bool = False) -> str:
    words = ["otlite", "start"]
    if choices.playbooks:
        words += ["--playbooks", ",".join(choices.playbooks)]
    if choices.tools:
        words += ["--tools", ",".join(choices.tools)]
    if choices.keys:
        words.append("--keys")
    if yes:
        words.append("--yes")
    return shlex.join(words)


def keys_to_set(
    names: list[str], tools: list[Tool], env: dict[str, str]
) -> list[tuple[str, bool, list[str]]]:
    """Keys the named tools declare that env lacks, required ones first.

    Each is (key, required by any of them, the tools that use it).
    """
    found: dict[str, tuple[bool, list[str]]] = {}
    for name in names:
        tool = find_tool(tools, name)
        if tool is None:
            continue
        for key, required in [(k, True) for k in tool.api_keys.required] + [
            (k, False) for k in tool.api_keys.optional
        ]:
            if key in env:
                continue
            was_required, used_by = found.get(key, (False, []))
            found[key] = (was_required or required, [*used_by, tool.name])
    return sorted(
        ((key, required, used_by) for key, (required, used_by) in found.items()),
        key=lambda k: (not k[1], k[0]),
    )


_SAMPLES = {
    "domain": "example.com",
    "username": "johndoe",
    "email": "jane@example.com",
    "phone": "+14155550100",
    "url": "https://example.com",
}


def sample_target(pack: str) -> str:
    """A target to show with `otlite playbook <pack>`, by the kind of target in the pack's name."""
    for kind, sample in _SAMPLES.items():
        if kind in pack:
            return sample
    return "example.com"
