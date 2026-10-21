"""Turn otlite's tool catalog (otlite/src/otlite/data/registry.yaml) into
community wrapper folders (otinstaller.yaml, README.md and, for Docker, a Dockerfile and the
release workflow) under seed/community/.

    python scripts/pm-catalog-to-wrappers.py            # writes seed/community/<name>/
    python scripts/pm-catalog-to-wrappers.py --dry-run  # only prints what it would do
    python scripts/pm-catalog-to-wrappers.py --offline  # no PyPI lookups: every pip tool becomes Docker

A pip tool whose pinned release has a pure-Python wheel on PyPI becomes a pipx wrapper pinned by
the wheel's SHA-256. Everything else (git installs, extra packages, Playwright browsers, no
wheel) becomes a Docker wrapper that builds the same pinned version. Existing folders are never
overwritten, so hand-tuned wrappers in seed/ win. Tools that can't be wrapped are listed with
the reason, and the run ends with a summary.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "otlite" / "src" / "otlite" / "data" / "registry.yaml"
SEED = ROOT / "seed"
DOCKER_WORKFLOW = ROOT / "spec" / "templates" / "github-docker.yml"
NAMESPACE = "osintverse-community"

# Same list the API checks before it accepts a community wrapper (api/src/imports.ts).
REDISTRIBUTABLE = re.compile(
    r"^(MIT|MIT-0|Apache-2\.0|BSD-[234]-Clause|0BSD|ISC|MPL-2\.0|(A|L)?GPL-[23]\.0(-only|-or-later)?"
    r"|LGPL-2\.1(-only|-or-later)?|Unlicense|CC0-1\.0|CC-BY(-SA)?-4\.0|EPL-2\.0|EUPL-1\.2|Zlib"
    r"|Artistic-2\.0|BSL-1\.0)$"
)

# seed/README.md: blackbird has no license; GHunt needs a Google login first. Outreach only.
OUTREACH_ONLY = {"blackbird", "ghunt"}

# What the catalog can't say, found by building each wrapper and running its test input.
OVERRIDES: dict[str, dict] = {
    # Prints nothing without at least one module flag; these are the ones that don't brute-force.
    "finalrecon": {"default_args": ["--headers", "--sslinfo", "--whois", "--dns", "--wayback"], "touches_target": True},
    "bbot": {"skip": "installs system packages with sudo when it runs, which ot's sandbox (no root) refuses"},
    # Without --stream the URLs go only to a file inside the container, which is lost. example.com
    # has so many archived URLs that a run takes over 15 minutes; osintverse.com has a few hundred.
    "paramspider": {"default_args": ["--stream"], "test_input": {"domain": "osintverse.com"}},
    # Both fail the same way on every input: their upstream services changed.
    "neutrosint": {"skip": "ProtonMail's API rejects its requests, so it never returns a result"},
    "zen": {"skip": "GitHub answers its requests with an HTML page, so it never returns a result"},
    # Queries the domain's own name servers and tries a zone transfer.
    "fierce": {"touches_target": True},
    # instaloader-profile was dropped from the seed for this reason.
    "instaloader": {"skip": "Instagram blocks anonymous requests from cloud servers, so its health check can't pass"},
    "edgar-tool": {"skip": "writes its results only to a file, not to stdout"},
    "instagram-location-search": {"skip": "drives Chrome through Selenium, which the wrapper image lacks"},
    "spiderfoot": {"skip": "a passive scan runs for more than an hour, past ot's longest timeout"},
    "mailaccess": {"skip": "writes into its own install folder at startup, which ot's read-only sandbox refuses"},
}

# Typed-input prefix -> (manifest input name, input type, sample value for test.input).
PREFIXES = {
    "u": ("username", "username", "github"),
    "e": ("email", "email", "example@example.com"),
    "d": ("domain", "domain", "example.com"),
    "url": ("url", "url", "https://example.com"),
    "p": ("phone", "phone", "+14155552671"),
    "q": ("query", "string", "example"),
    "geo": ("location", "string", "Paris"),
    "tg": ("telegram", "string", "telegram"),
    "lat": ("latitude", "string", "48.8584"),
    "lng": ("longitude", "string", "2.2945"),
}

CATEGORY_BY_ACCEPTS = {
    "username": "username",
    "email": "email",
    "phone": "phone",
    "domain": "domain-dns",
    "ip": "ip-network",
    "url": "utilities",
    "name": "people",
}
CATEGORY_BY_CAPABILITY = {
    "social-media": "social-media",
    "metadata-extraction": "documents-metadata",
    "breach-search": "breach-data",
    "corporate-research": "company",
    "financial-data": "company",
    "location-search": "images-geo",
    "archiving": "web-archive",
    "web-archiving": "web-archive",
}
PERSONAL = {"username", "email", "phone", "name"}
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class Skip(Exception):
    pass


def semver(raw: str | None) -> str | None:
    """Pad a dotted numeric version to three parts; None when it isn't one."""
    if not raw or not re.fullmatch(r"\d+(\.\d+){0,2}", raw):
        return None
    parts = [str(int(p)) for p in raw.split(".")] + ["0", "0"]
    version = ".".join(parts[:3])
    return version if SEMVER.match(version) else None


def version_of(tool: dict) -> str:
    install = tool["install"]
    if install["method"] == "pip":
        version = semver(install.get("version"))
        if version:
            return version
        raise Skip(f"pip version {install.get('version')!r} is not a plain dotted version")
    version = semver(str(tool.get("verified", {}).get("version", "")))
    if version:
        return version
    return f"0.0.0-git.{install['ref'][:7]}"


def inputs_and_args(tool: dict) -> tuple[list[dict], list[str], dict]:
    typed = tool.get("input_types") or {}
    if not typed:
        raise Skip("declares no typed inputs, so there is nothing to map onto manifest inputs")
    items = list(typed.items())
    if any(not flag.startswith("-") for _, flag in items):
        # Positionals and subcommands are alternatives, not combinable flags: keep the first.
        items = items[:1]
    # Coordinates only make sense together; other flag sets are alternatives.
    together = len(items) == 1 or {p for p, _ in items} == {"lat", "lng"}
    inputs, args, test = [], [], {}
    for prefix, flag in items:
        name, kind, sample = PREFIXES[prefix]
        inputs.append({"name": name, "type": kind, "required": together})
        if flag:
            args.extend(flag.split(" "))
        args.append("{" + name + "}")
        if together or not test:
            test[name] = sample
    return inputs, args, test


def categories(tool: dict) -> list[str]:
    found: list[str] = []
    for accepted in tool.get("accepts", []):
        found.append(CATEGORY_BY_ACCEPTS.get(accepted, "utilities"))
    for capability in tool.get("capabilities", []):
        if capability in CATEGORY_BY_CAPABILITY:
            found.append(CATEGORY_BY_CAPABILITY[capability])
    unique = list(dict.fromkeys(found))[:3]
    return unique or ["utilities"]


def tags(tool: dict) -> list[str]:
    words = tool.get("topics", []) + tool.get("capabilities", [])
    clean = [w for w in words if re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", w) and len(w) <= 32]
    return [w for w in dict.fromkeys(clean) if w != "dual-use"][:10]


def outputs(tool: dict) -> list[str]:
    accepts = set(tool.get("accepts", []))
    if accepts and accepts <= {"username", "email"}:
        return ["account"]
    if accepts and accepts <= {"domain"}:
        return ["subdomain"]
    return ["other"]


def summary(tool: dict) -> str:
    text = " ".join(tool["description"].split()).rstrip(".")
    if len(text) > 140:
        text = text[:137].rsplit(" ", 1)[0] + "..."
    return text


def pypi_wheel(package: str, version: str) -> tuple[str, str | None] | None:
    """(sha256, requires_python) of the release's pure-Python wheel, or None when it has none."""
    url = f"https://pypi.org/pypi/{package}/{version}/json"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as err:
        raise Skip(f"PyPI has no {package}=={version} ({err.code})") from err
    for file in data.get("urls", []):
        name = file["filename"]
        if file["packagetype"] == "bdist_wheel" and name.endswith("-none-any.whl") and "py3" in name:
            return file["digests"]["sha256"], file.get("requires_python") or None
    return None


def docker_plan(tool: dict) -> tuple[list[str], list[str]]:
    """Dockerfile lines and the command prefix that starts the tool inside the image."""
    name, install, entry = tool["name"], tool["install"], tool["entrypoint"]
    lines = ["FROM python:3.12-slim"]
    if install["method"] == "git":
        lines.append(
            "RUN apt-get update && apt-get install -y --no-install-recommends git "
            "&& rm -rf /var/lib/apt/lists/*"
        )
    lines.append("RUN useradd --uid 10001 --create-home app")
    if install["method"] == "pip":
        specs = [f"{install['package']}=={install['version']}", *install.get("extra_packages", [])]
        lines.append("RUN pip install --no-cache-dir " + " ".join(json.dumps(s) for s in specs))
        if install.get("playwright_browsers"):
            lines.append("RUN python -m playwright install --with-deps --only-shell chromium")
        return lines, [entry["command"]]

    repo, ref, src = install["url"].removesuffix(".git"), install["ref"], f"/opt/{name}"
    if install.get("as_package"):
        lines.append(f"RUN pip install --no-cache-dir git+{repo}@{ref}")
        if "command" in entry:
            return lines, [entry["command"]]
        module = entry["script"].removesuffix("/__main__.py").removesuffix(".py").replace("/", ".")
        return lines, ["python", "-m", module]
    lines.append(
        f"RUN git clone --quiet {repo}.git {src} && git -C {src} checkout --quiet {ref} "
        f"&& pip install --no-cache-dir -r {src}/{install['requirements']}"
    )
    return lines, ["python", f"{src}/{entry['script']}"]


def build(tool: dict, offline: bool) -> tuple[str, dict[str, str]]:
    """The runtime kind and the files of one wrapper folder."""
    name = tool["name"]
    if name in OUTREACH_ONLY:
        raise Skip("outreach only (see seed/README.md)")
    override = OVERRIDES.get(name, {})
    if "skip" in override:
        raise Skip(override["skip"])
    if tool.get("needs_config"):
        raise Skip("needs a login or config file first, which a wrapper can't provide")
    if tool.get("interactive") or tool.get("long_running"):
        raise Skip("prompts for input or runs until stopped; `ot run` has no terminal for that")
    license_id = tool.get("license") or ""
    if not REDISTRIBUTABLE.match(license_id):
        raise Skip(f"license {license_id or 'unknown'} does not allow a community wrapper")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,38}[a-z0-9]", name):
        raise Skip("name is not a valid registry slug")

    version = version_of(tool)
    inputs, args, test = inputs_and_args(tool)
    install = tool["install"]
    default_args = override.get("default_args", tool.get("default_args", []))

    wheel = None
    simple_pip = (
        install["method"] == "pip"
        and not install.get("extra_packages")
        and not install.get("playwright_browsers")
        and "command" in tool["entrypoint"]
    )
    if simple_pip and not offline:
        wheel = pypi_wheel(install["package"], install["version"])

    if wheel:
        kind, sha, requires = "pipx", wheel[0], wheel[1]
        command = [tool["entrypoint"]["command"], *default_args, *args]
        runtime = [
            "runtime:",
            "  kind: pipx",
            f"  package: {install['package']}",
            f"  package_version: {json.dumps(install['version'])}",
            "  index: pypi",
            *([f"  python: {json.dumps(requires)}"] if requires else []),
            f"  entrypoint: {tool['entrypoint']['command']}",
            f"  wheel_sha256: {json.dumps(sha)}",
        ]
        dockerfile = None
    else:
        kind = "docker"
        lines, start = docker_plan(tool)
        command = [*start, *default_args, *args]
        # ot runs the image read-only with only /tmp writable, so tools that write into their
        # working folder start there.
        lines += ["USER app", "WORKDIR /tmp", f"ENTRYPOINT {json.dumps(start)}"]
        dockerfile = "\n".join(lines) + "\n"
        runtime = [
            "runtime:",
            "  kind: docker",
            "  # Filled in by the release workflow with the pushed image's digest.",
            f"  image: ghcr.io/{NAMESPACE}/{name}@sha256:{'0' * 64}",
            "  platforms: [linux/amd64, linux/arm64]",
        ]
    runtime += [
        f"  command: {json.dumps(command)}",
        "  output_format: text",
        "  timeout_seconds: 900",
    ]

    keys = tool.get("api_keys") or {}
    secrets = [(k, True) for k in keys.get("required", [])]
    secrets += [(k, False) for k in keys.get("optional", [])]
    homepage = f"https://github.com/{tool['repo']}" if tool.get("repo") else None

    manifest = [
        "# OTInstaller manifest. Reference: https://otinstaller.com/docs/manifest",
        "# yaml-language-server: $schema=https://otinstaller.com/schema/v1.json",
        "# Converted from the package manager's catalog by scripts/pm-catalog-to-wrappers.py.",
        "schema: 1",
        f"name: {name}",
        f"namespace: {NAMESPACE}",
        f"version: {version}",
        f"summary: {json.dumps(summary(tool), ensure_ascii=False)}",
        "readme: README.md",
        f"license: {license_id}",
        *([f"homepage: {homepage}"] if homepage else []),
        f"categories: [{', '.join(categories(tool))}]",
        f"tags: [{', '.join(tags(tool))}]",
        "inputs:",
    ]
    for item in inputs:
        manifest += [
            f"  - name: {item['name']}",
            f"    type: {item['type']}",
            f"    required: {'true' if item['required'] else 'false'}",
        ]
    manifest.append("outputs:")
    manifest += [f"  - type: {o}" for o in outputs(tool)]
    if secrets:
        manifest.append("secrets:")
        for key, required in secrets:
            manifest += [f"  - name: {key}", f"    required: {'true' if required else 'false'}"]
    manifest += runtime
    manifest += [
        "network:",
        "  egress: true",
        "ethics:",
        f"  touches_target: {'true' if override.get('touches_target') else 'false'}",
        f"  auth_required: {'true' if keys.get('required') else 'false'}",
        "  collects_personal_data: "
        + ("true" if PERSONAL & set(tool.get("accepts", [])) else "false"),
        "test:",
        f"  input: {json.dumps(override.get('test_input', test))}",
    ]

    files = {"otinstaller.yaml": "\n".join(manifest) + "\n", "README.md": readme(tool, version, kind, inputs)}
    if dockerfile:
        files["Dockerfile"] = dockerfile
        files[".github/workflows/otinstaller-release.yml"] = DOCKER_WORKFLOW.read_text(encoding="utf-8")
    return kind, files


def readme(tool: dict, version: str, kind: str, inputs: list[dict]) -> str:
    name, repo = tool["name"], tool.get("repo")
    upstream = f"[github.com/{repo}](https://github.com/{repo})" if repo else tool["display_name"]
    how = (
        "It installs the upstream project's own release from PyPI, pinned by version and hash; "
        "nothing here is rebuilt."
        if kind == "pipx"
        else "The `Dockerfile` here builds the upstream release at a pinned version, and the "
        "`otinstaller release` workflow builds, signs and publishes the image."
    )
    first = inputs[0]["name"]
    return (
        f"# {name} (community package)\n\n"
        f"This repository packages {upstream} for the OTInstaller Registry as "
        f"`{NAMESPACE}/{name}`. The tool is the work of its authors, under the {tool['license']} "
        "license; this repository only holds the manifest and release workflow.\n\n"
        "Report problems with the tool upstream, and problems with the packaging here. If you "
        "maintain the upstream project and want to publish it yourself, open an issue or run "
        f"`ot claim {NAMESPACE}/{name}`: the package is transferred to you.\n\n"
        f"{how}\n\n"
        f"```\not run {NAMESPACE}/{name} --{first.replace('_', '-')} …\n```\n\n"
        f"Packaged version: {version}.\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--out", type=Path, default=SEED / "community")
    parser.add_argument("--offline", action="store_true", help="no PyPI lookups")
    parser.add_argument("--dry-run", action="store_true")
    opts = parser.parse_args()

    tools = yaml.safe_load(opts.catalog.read_text(encoding="utf-8"))["tools"]
    seeded = {p.name for d in ("community", "first-party") for p in (SEED / d).iterdir()}
    # A seed wrapper of the same upstream under another name (instaloader-profile) counts too.
    upstream: dict[str, set[str]] = {}
    for manifest in SEED.glob("*/*/otinstaller.yaml"):
        homepage = (yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}).get("homepage", "")
        if "github.com/" in homepage:
            upstream.setdefault(homepage.split("github.com/", 1)[1].lower(), set()).add(manifest.parent.name)
    written, kept, skipped = [], [], []
    for tool in tools:
        name = tool["name"]
        if name in seeded or (opts.out / name).exists():
            kept.append(name)
            continue
        if "skip" in OVERRIDES.get(name, {}):
            skipped.append((name, OVERRIDES[name]["skip"]))
            continue
        same = upstream.get(str(tool.get("repo", "")).lower(), set()) - {name}
        if same:
            kept.append(f"{name} (as {', '.join(sorted(same))})")
            continue
        try:
            kind, files = build(tool, opts.offline)
        except Skip as reason:
            skipped.append((name, str(reason)))
            continue
        written.append((name, kind))
        if opts.dry_run:
            continue
        for rel, text in files.items():
            path = opts.out / name / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)

    for name, kind in written:
        print(f"wrote   {name} ({kind})")
    for name in kept:
        print(f"kept    {name} (already in seed/)")
    for name, reason in skipped:
        print(f"skipped {name}: {reason}")
    print(f"\n{len(written)} written, {len(kept)} already seeded, {len(skipped)} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
