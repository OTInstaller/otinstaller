#!/usr/bin/env python3
"""OTInstaller Registry scanner.

Runs in the registry-ops GitHub Actions workflow (or locally in ops/scanner's Docker image).
Reads the scan request the registry dispatched, checks the artifact, and posts results back:

  signature        cosign (Docker images) or PyPI provenance (wheels)
  vulnerabilities  Trivy, with counts by severity and how many have fixes
  secrets          Trivy secret scanning
  malware          GuardDog source-code heuristics (Python wheels)
  sbom             Trivy CycloneDX package count
  smoke            the manifest's test input, in ot's sandbox: offline unless the manifest declares network egress

After a passing verdict the registry answers the callback with a backup job (signed upload URLs); this script
then copies the image to the mirror, or uploads the wheel, and uploads a git bundle (see backup.py). The same
request file can also hold a backup job ("otinstaller-backup") or a restore drill ("otinstaller-drill").

Usage: scan.py request.json [--post]   (without --post the results are printed)
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import backup

SCANNER_VERSION = "0.1.0"
SMOKE_TIMEOUT = 120
# What the tool page shows as "what you get back": a few real entities from the smoke test, or a slice of its
# stdout when the output is not an entity list.
SAMPLE_MAX_ENTITIES = 5
SAMPLE_MAX_CHARS = 2000
PARAMETER_TYPES = {"string", "integer", "boolean", "enum"}

# GuardDog rules that look at code behaviour. Its metadata rules (empty description, single
# maintainer, ...) say nothing about malice, so they are not counted.
GUARDDOG_CODE_RULES = [
    "code-execution", "cmd-overwrite", "download-executable", "exec-base64", "exfiltrate-sensitive-data",
    "obfuscation", "silent-process-execution", "steganography", "dll-hijacking", "clipboard-access",
]


def log(msg: str) -> None:
    print(f"[scan] {msg}", file=sys.stderr, flush=True)


def run(cmd: list[str], timeout: int = 600, check: bool = False) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd[:6]) + (" ..." if len(cmd) > 6 else ""))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=check)


def http_json(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "otinstaller-scanner"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


# ---------- signatures ----------

def cert_identity(der: bytes) -> tuple[str | None, str | None]:
    """Subject alternative name and OIDC issuer of a Fulcio certificate."""
    from cryptography import x509
    cert = x509.load_der_x509_certificate(der)
    identity = None
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        names = san.get_values_for_type(x509.UniformResourceIdentifier) + san.get_values_for_type(x509.RFC822Name)
        identity = names[0] if names else None
    except x509.ExtensionNotFound:
        pass
    issuer = None
    for oid, der_string in (("1.3.6.1.4.1.57264.1.8", True), ("1.3.6.1.4.1.57264.1.1", False)):
        try:
            raw = cert.extensions.get_extension_for_oid(x509.ObjectIdentifier(oid)).value.value
            # 1.8 holds a DER UTF8String (tag, length, bytes); the legacy 1.1 holds raw bytes.
            issuer = raw[2:].decode() if der_string else raw.decode()
            break
        except x509.ExtensionNotFound:
            continue
    return identity, issuer


def signature_cert_der(sig: dict) -> bytes | None:
    """The signing certificate (DER) from one line of `cosign download signature` output."""
    raw = (sig.get("verificationMaterial", {}).get("certificate", {}) or {}).get("rawBytes")
    if raw:
        return base64.b64decode(raw)
    cert = sig.get("Cert")
    if isinstance(cert, dict) and cert.get("Raw"):
        # cosign v3 prints the parsed certificate; "Raw" is its base64 DER.
        return base64.b64decode(cert["Raw"])
    if isinstance(cert, str) and cert:
        return base64.b64decode("".join(l for l in cert.splitlines() if "CERTIFICATE" not in l))
    return None


def signer_identities(image: str) -> list[tuple[str, str]]:
    """Identities of every signature attached to an image, read from the signing certificates."""
    out = run(["cosign", "download", "signature", image])
    found = []
    for line in out.stdout.splitlines():
        try:
            sig = json.loads(line)
        except json.JSONDecodeError:
            continue
        der = signature_cert_der(sig)
        if der is None:
            continue
        ident, iss = cert_identity(der)
        if ident:
            found.append((ident, iss or ""))
    return found


def verified_identities(verify_stdout: str) -> list[tuple[str, str]]:
    """(identity, issuer) of each signature `cosign verify` verified, from its JSON output (one array, or one
    document per line). Keyless signatures carry the certificate's subject and issuer under "optional"."""
    docs = []
    try:
        docs = [json.loads(verify_stdout or "[]")]
    except json.JSONDecodeError:
        for line in verify_stdout.splitlines():
            try:
                docs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    found = []
    for doc in docs:
        for item in doc if isinstance(doc, list) else [doc]:
            opt = (item or {}).get("optional") or {}
            subject = opt.get("Subject") or opt.get("subject")
            if subject:
                found.append((subject, opt.get("Issuer") or opt.get("issuer") or ""))
    return list(dict.fromkeys(found))


def check_any_signature(image: str) -> dict:
    """A direct upload has no repository whose CI must have signed it: any keyless signature counts, and every
    identity that verified is reported, so the registry can hold the package to its first signer."""
    loose = run(["cosign", "verify", "--output", "json", "--certificate-identity-regexp", ".*", "--certificate-oidc-issuer-regexp", ".*", image])
    if loose.returncode != 0:
        return {"status": "absent"}
    ids = verified_identities(loose.stdout) or list(dict.fromkeys(signer_identities(image)))
    if not ids:
        return {"status": "pass", "identity": None, "issuer": None, "identities": [], "detail": "verified, but the certificate identity could not be read"}
    return {"status": "pass", "identity": ids[0][0], "issuer": ids[0][1], "identities": [{"identity": i, "issuer": s} for i, s in ids[:20]]}


def check_image_signature(image: str, expected: dict | None) -> dict:
    if expected is None:
        return check_any_signature(image)
    strict = run(["cosign", "verify", "--output", "json", "--certificate-identity-regexp", expected["identityRegexp"],
                  "--certificate-oidc-issuer", expected["issuer"], image])
    if strict.returncode == 0:
        pattern = re.compile(expected["identityRegexp"])
        for ident, iss in verified_identities(strict.stdout) or signer_identities(image):
            if pattern.search(ident):
                return {"status": "pass", "identity": ident, "issuer": iss or expected["issuer"]}
        return {"status": "pass", "identity": None, "issuer": expected["issuer"], "detail": "verified, but the certificate identity could not be read"}
    loose = run(["cosign", "verify", "--certificate-identity-regexp", ".*", "--certificate-oidc-issuer-regexp", ".*", image])
    if loose.returncode == 0:
        others = ", ".join(sorted({i for i, _ in signer_identities(image)})) or "an unexpected identity"
        return {"status": "fail", "detail": f"signed by {others}, not by the source repository's CI"}
    return {"status": "absent"}


def check_wheel_provenance(pkg: str, version: str, filename: str, source_repo: str, upstream_repo: str = "") -> dict:
    """PyPI attestations (PEP 740): the wheel must have been published from the source repository, or for a
    community wrapper from the upstream project it packages. With neither (a direct upload) any publisher counts,
    and all of them are reported for the registry to hold the package to its first."""
    prov = http_json(f"https://pypi.org/integrity/{pkg}/{version}/{filename}/provenance")
    if not prov:
        return {"status": "absent"}
    wanted = [re.sub(r"^(github|gitlab)\.com/", "", r).lower() for r in (source_repo, upstream_repo) if r]
    want = " or ".join(wanted)
    seen, ids = [], []
    for bundle in prov.get("attestation_bundles", []):
        pub = bundle.get("publisher", {})
        repo = (pub.get("repository") or "").lower()
        seen.append(f"{pub.get('kind', '?')}:{repo}")
        ident = f"pypi:{pub.get('kind', 'GitHub')}:{repo}/{pub.get('workflow', '')}"
        if repo in wanted:
            return {"status": "pass", "identity": ident, "issuer": "https://pypi.org"}
        if repo and ident not in ids:
            ids.append(ident)
    if not wanted and ids:
        return {"status": "pass", "identity": ids[0], "issuer": "https://pypi.org", "identities": [{"identity": i, "issuer": "https://pypi.org"} for i in ids[:20]]}
    return {"status": "fail", "detail": f"published by {', '.join(seen) or 'an unknown publisher'}, not {want or 'a known repository'}"}


# ---------- Trivy ----------

def trivy(target_args: list[str]) -> tuple[dict, dict, int]:
    """Vulnerability counts, secret count and SBOM package count."""
    vuln = run(["trivy", *target_args[:1], "--quiet", "--format", "json", "--scanners", "vuln,secret", *target_args[1:]], timeout=1200)
    if vuln.returncode != 0:
        raise RuntimeError(f"trivy failed: {vuln.stderr[-500:]}")
    report = json.loads(vuln.stdout or "{}")
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "fixable_critical": 0, "fixable_high": 0}
    secrets = []
    for res in report.get("Results") or []:
        for v in res.get("Vulnerabilities") or []:
            sev = (v.get("Severity") or "").lower()
            if sev in counts:
                counts[sev] += 1
                if sev in ("critical", "high") and v.get("FixedVersion"):
                    counts[f"fixable_{sev}"] += 1
        for s in res.get("Secrets") or []:
            secrets.append({"rule": s.get("RuleID"), "target": res.get("Target"), "line": s.get("StartLine")})
    sbom = run(["trivy", *target_args[:1], "--quiet", "--format", "cyclonedx", *target_args[1:]], timeout=1200)
    packages = len(json.loads(sbom.stdout or "{}").get("components") or []) if sbom.returncode == 0 else 0
    return counts, {"count": len(secrets), "findings": secrets[:20]}, packages


# ---------- smoke test ----------

def smoke_command(runtime: dict, test_input: dict | None) -> list[str] | None:
    if test_input is None:
        return None
    out = []
    for arg in runtime["command"]:
        names = re.findall(r"\{([^{}]*)\}", arg)
        if any(n not in test_input for n in names):
            if arg == "{" + names[0] + "}" and out and out[-1].startswith("-"):
                out.pop()
            continue
        out.append(re.sub(r"\{([^{}]*)\}", lambda m: str(test_input[m.group(1)]), arg))
    return out


def sample_from_output(stdout: str, output_format: str) -> dict:
    """A trimmed record of what the test input produced, for the tool page's sample. json and jsonl outputs keep
    their first few entities; csv and text keep the start of stdout. Nothing here comes from a user's run: the
    input is the manifest's own test input and the container had no secrets."""
    sample: dict = {"output_format": output_format}
    entities: list = []
    if output_format == "json":
        try:
            doc = json.loads(stdout)
            if isinstance(doc, dict) and isinstance(doc.get("entities"), list):
                entities = doc["entities"]
            elif isinstance(doc, list):
                entities = doc
        except ValueError:
            pass
    elif output_format == "jsonl":
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                doc = json.loads(line)
            except ValueError:
                continue
            if isinstance(doc, dict):
                entities.append(doc)
    entities = [e for e in entities if isinstance(e, dict) and "type" in e and "value" in e]
    if entities:
        kept = []
        for e in entities[:SAMPLE_MAX_ENTITIES]:
            text = json.dumps(e)
            kept.append(e if len(text) <= 500 else {"type": e["type"], "value": str(e["value"])[:200]})
        sample["entities"] = kept
        sample["entity_count"] = len(entities)
    else:
        sample["stdout"] = stdout[:SAMPLE_MAX_CHARS]
    return sample


def smoke(image: str, runtime: dict, test_input: dict | None, egress: bool, expect_exit_code: int = 0) -> dict:
    """Runs the test input in the same sandbox ot uses. Tools that declare network egress keep the
    network (the scan runner is disposable and the container gets no secrets); others run offline.
    The run passes when it exits with the manifest's test.expect_exit_code (0 unless it says otherwise)."""
    cmd = smoke_command(runtime, test_input)
    if not cmd:
        return {"status": "skipped"}
    started = time.time()
    network = "bridge" if egress else "none"
    args = ["docker", "run", "--rm", "--network", network, "--read-only", "--tmpfs", "/tmp:rw,size=256m",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g",
            "--user", "65534:65534", "-e", "HOME=/tmp", "--entrypoint", cmd[0], image, *cmd[1:]]
    try:
        r = run(args, timeout=SMOKE_TIMEOUT)
        code, output, stdout = r.returncode, (r.stdout + r.stderr), r.stdout
    except subprocess.TimeoutExpired:
        code, output, stdout = 124, "timed out", ""
    status = "pass" if code == expect_exit_code else "fail"
    result = {"status": status, "exit_code": code, "network": network, "duration_ms": int((time.time() - started) * 1000), "output_excerpt": output[-1000:]}
    if status == "pass" and stdout.strip():
        result["sample"] = sample_from_output(stdout, runtime.get("output_format") or "json")
    return result


# ---------- per runtime ----------

def scan_docker(req: dict) -> dict:
    rt = req["runtime"]
    image = rt["image"]
    pulled = run(["docker", "pull", image], timeout=1200)
    if pulled.returncode != 0:
        raise RuntimeError(f"cannot pull {image}: {pulled.stderr[-300:]}")
    # No expected signer: a direct upload, which any keyless signer may sign (the registry pins the first).
    signature = check_image_signature(image, req.get("expected_signer"))
    vulns, secrets, packages = trivy(["image", image])
    return {
        "signature": signature,
        "vulnerabilities": vulns,
        "secrets": secrets,
        # Images are not run through GuardDog; their contents are covered by Trivy and the smoke test.
        "malware": {"count": 0, "findings": [], "note": "not applicable to images"},
        "smoke": smoke(image, rt, req.get("test_input"), bool(req.get("network_egress")), int(req.get("expect_exit_code") or 0)),
        "sbom": {"packages": packages},
    }


# The image `ot` runs a pipx tool in (pythonDockerfile in cli/internal/runner/install.go; test_scan.py keeps the two
# equal), so the smoke test and the health check run it as users do. The sandbox is read-only except /tmp, so it
# starts there: a tool that writes into its working folder (reports, caches) works in `ot` and must pass here too.
PYTHON_DOCKERFILE = """FROM python:3.12-slim
RUN useradd --uid 10001 --create-home ot
COPY *.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl
USER ot
WORKDIR /tmp
"""


def scan_pipx(req: dict, work: Path) -> dict:
    rt = req["runtime"]
    meta = http_json(f"https://pypi.org/pypi/{rt['package']}/{rt['package_version']}/json")
    if not meta:
        raise RuntimeError(f"{rt['package']} {rt['package_version']} is not on PyPI")
    wheel = next((u for u in meta["urls"] if u["packagetype"] == "bdist_wheel" and u["digests"]["sha256"] == rt["wheel_sha256"]), None)
    if not wheel:
        return {**empty_results(), "signature": {"status": "fail", "detail": "no wheel matches the manifest's sha256"}}
    path = work / wheel["filename"]
    with urllib.request.urlopen(wheel["url"], timeout=300) as r:
        data = r.read()
    if hashlib.sha256(data).hexdigest() != rt["wheel_sha256"]:
        return {**empty_results(), "signature": {"status": "fail", "detail": "downloaded wheel does not match its sha256"}}
    path.write_bytes(data)

    signature = check_wheel_provenance(rt["package"], rt["package_version"], wheel["filename"], req.get("source_repo", ""),
                                       req.get("upstream_repo", ""))

    # Install the wheel into an image (dependencies included) so Trivy scans what users would run.
    (work / "Dockerfile").write_text(PYTHON_DOCKERFILE)
    tag = f"ot-scan/{re.sub(r'[^a-z0-9]+', '-', req['ref'].lower())}:latest"
    built = run(["docker", "build", "-q", "-t", tag, str(work)], timeout=1200)
    if built.returncode != 0:
        raise RuntimeError(f"building the wheel image failed: {built.stderr[-500:]}")
    # Only the Python packages: the wrapper's base image is ours, not the author's.
    vulns, secrets, packages = trivy(["image", "--pkg-types", "library", tag])

    malware = {"count": 0, "findings": []}
    if shutil.which("guarddog"):
        rules = [arg for r in GUARDDOG_CODE_RULES for arg in ("--rules", r)]
        g = run(["guarddog", "pypi", "scan", str(path), "--output-format", "json", *rules], timeout=900)
        try:
            out = json.loads(g.stdout or "{}")
            for rule, hits in (out.get("results") or {}).items():
                if hits:
                    malware["findings"].append({"rule": rule, "detail": hits if isinstance(hits, str) else hits[:5]})
            malware["count"] = len(malware["findings"])
        except json.JSONDecodeError:
            malware["note"] = "guarddog output could not be read"
    else:
        malware["note"] = "guarddog not installed"
    return {
        "signature": signature,
        "vulnerabilities": vulns,
        "secrets": secrets,
        "malware": malware,
        "smoke": smoke(tag, rt, req.get("test_input"), bool(req.get("network_egress")), int(req.get("expect_exit_code") or 0)),
        "sbom": {"packages": packages},
    }


def empty_results() -> dict:
    return {
        "signature": {"status": "absent"},
        "vulnerabilities": None,
        "secrets": {"count": 0},
        "malware": {"count": 0},
        "smoke": {"status": "skipped"},
    }


def scan(req: dict, work: Path | None = None) -> dict:
    if req.get("kind") == "guide" or not req.get("runtime"):
        # Guides are checked by the registry (links, personal data), not by this scanner.
        return {**empty_results(), "scanner_version": SCANNER_VERSION}
    with tempfile.TemporaryDirectory() as tmp:
        if req["runtime"]["kind"] == "docker":
            results = scan_docker(req)
        else:
            results = scan_pipx(req, work or Path(tmp))
    results["scanner_version"] = SCANNER_VERSION
    return results


def post(req: dict, results: dict) -> dict:
    """Posts the results; the registry's answer carries a backup job when the version was published."""
    body = json.dumps(results).encode()
    r = urllib.request.Request(req["callback_url"], data=body, method="POST", headers={
        "Authorization": f"Bearer {req['callback_token']}", "Content-Type": "application/json", "User-Agent": "otinstaller-scanner",
    })
    with urllib.request.urlopen(r, timeout=60) as resp:
        text = resp.read().decode()
        log(f"registry answered {resp.status}: {text[:300]}")
    try:
        return json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    payload = json.loads(Path(sys.argv[1]).read_text())
    # The admin "back up now" endpoint answers {"status": ..., "job": <payload>}; accept that file as it is.
    payload = payload.get("job") or payload
    if "backup" in payload:
        return backup.run_backup_request(payload["backup"])
    if "drill" in payload:
        return backup.drill(payload["drill"])
    req = payload.get("scan", payload)  # accept the whole client_payload too
    log(f"scanning {req['ref']}")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        results = scan(req, work)
        summary = {k: (v.get("status", v.get("count", v)) if isinstance(v, dict) else v) for k, v in results.items()}
        log(f"summary: {json.dumps(summary)}")
        if "--post" not in sys.argv:
            print(json.dumps(results, indent=2))
            return 0
        answer = post(req, results)
        if answer.get("backup"):
            # Backups never change the verdict; a failed one is reported to the registry and retried weekly.
            backup.run_job(answer["backup"], work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
