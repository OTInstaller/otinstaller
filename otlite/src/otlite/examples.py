"""Example commands for each tool, built from its typed inputs."""

from __future__ import annotations

from otlite.registry import Tool

# Values that are safe to try: reserved example domains and addresses, documentation numbers.
SAMPLE_VALUES = {
    "u": "johndoe",
    "e": "ada@example.com",
    "d": "example.com",
    "p": "+14155550100",
    "url": "https://example.com",
    "ip": "192.0.2.1",
    "q": "example",
    "tg": "durov",
    "geo": "51.5074,-0.1278",
    "lat": "51.5074",
    "lng": "-0.1278",
}
# The input a newcomer most likely has, first.
_PREFERENCE = ("u", "e", "d", "p", "url", "ip", "q", "tg", "geo")


def takes_typed_inputs(tool: Tool) -> bool:
    return bool(tool.input_types)


def example_command(tool: Tool) -> str:
    """A command that runs the tool on a sample value, or shows its own help when it takes none."""
    if not tool.input_types:
        return f"otlite run {tool.name} -- --help"
    prefixes = set(tool.input_types)
    if {"lat", "lng"} <= prefixes:
        chosen = ["lat", "lng"]
    else:
        chosen = [next((p for p in _PREFERENCE if p in prefixes), sorted(prefixes)[0])]
    values = " ".join(f"{p}:{SAMPLE_VALUES.get(p, 'example')}" for p in chosen)
    return f"otlite run {tool.name} -- {values}"
