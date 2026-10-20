"""Source and artifact backups for the OTInstaller Registry, run by scan.py in the registry-ops workflow.

A backup job comes from the registry (with a scan callback's answer, or as an "otinstaller-backup" event) and
lists what to copy, each with a limit:

  image  crane copy <source> <mirror>/<ns>/<name>@<digest> (same digest), then its signatures and attestations
         (cosign copy, and the sha256-<hex>[.sig|.att|.sbom] tags with crane). Layers over 90 MB are pushed to the
         mirror in 50 MB chunks first, because a Worker takes at most 100 MB per request.
  wheel  the verified wheel, PUT to a short-lived signed URL
  git    git clone --mirror, then git bundle create --branches --tags, PUT to a signed URL

Then it reports to the job's complete_url with the job's single-use token. A restore drill ("otinstaller-drill")
restores a bundle into an empty repository and pulls a mirrored image by digest, verifying its signature.

Pushing to the mirror needs MIRROR_PUSH_TOKEN (and `crane auth login <mirror> -u scanner -p "$MIRROR_PUSH_TOKEN"`
for crane and cosign).
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
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CHUNK = 50 * 1024 * 1024
LARGE_BLOB = 90 * 1024 * 1024
INDEX_TYPES = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}


def log(msg: str) -> None:
    print(f"[backup] {msg}", file=sys.stderr, flush=True)


def run(cmd: list[str], timeout: int = 1800, env: dict | None = None) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd[:6]) + (" ..." if len(cmd) > 6 else ""))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# ---------- images ----------

def split_ref(ref: str) -> tuple[str, str]:
    """Repository and digest of an image reference pinned by digest."""
    repo, _, digest = ref.partition("@")
    return repo, digest


def crane_manifest(ref: str) -> dict:
    r = run(["crane", "manifest", ref], timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"crane manifest {ref} failed: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout)


def image_contents(source: str, fetch=crane_manifest) -> tuple[int, dict[str, int]]:
    """Total size of an image (every platform: configs and layers) and its blobs by digest."""
    repo, _ = split_ref(source)
    top = fetch(source)
    manifests = [top]
    if top.get("mediaType") in INDEX_TYPES or "manifests" in top:
        manifests = [fetch(f"{repo}@{m['digest']}") for m in top.get("manifests", [])]
    blobs: dict[str, int] = {}
    for m in manifests:
        for d in [m.get("config"), *(m.get("layers") or [])]:
            if d and d.get("digest"):
                blobs[d["digest"]] = int(d.get("size") or 0)
    return sum(blobs.values()), blobs


def registry_base(host: str) -> str:
    """Like go-containerregistry: plain HTTP for localhost and loopback addresses, HTTPS otherwise."""
    bare = host.split(":")[0]
    return f"http://{host}" if bare in ("localhost", "127.0.0.1", "::1") or bare.endswith(".localhost") else f"https://{host}"


def push_token(host: str, secret: str, opener=urllib.request.urlopen) -> str:
    req = urllib.request.Request(f"{registry_base(host)}/token", headers={"Authorization": "Basic " + base64.b64encode(f"scanner:{secret}".encode()).decode()})
    with opener(req, timeout=60) as r:
        return json.load(r)["token"]


def push_blob_chunked(target: str, digest: str, stream, token: str, chunk: int = CHUNK, opener=urllib.request.urlopen) -> None:
    """Pushes one blob to the mirror in fixed-size chunks (OCI chunked upload) from a binary stream."""
    host, _, repo = target.partition("/")
    base = registry_base(host)
    auth = {"Authorization": f"Bearer {token}"}
    with opener(urllib.request.Request(f"{base}/v2/{repo}/blobs/uploads/", method="POST", data=b"", headers=auth), timeout=60) as r:
        location = urllib.parse.urljoin(base, r.headers["Location"])
    offset = 0
    while True:
        data = stream.read(chunk)
        if not data:
            break
        headers = {**auth, "Content-Type": "application/octet-stream", "Content-Range": f"{offset}-{offset + len(data) - 1}", "Content-Length": str(len(data))}
        with opener(urllib.request.Request(location, method="PATCH", data=data, headers=headers), timeout=600) as r:
            location = urllib.parse.urljoin(base, r.headers["Location"])
        offset += len(data)
    sep = "&" if "?" in location else "?"
    with opener(urllib.request.Request(f"{location}{sep}digest={urllib.parse.quote(digest)}", method="PUT", data=b"", headers={**auth, "Content-Length": "0"}), timeout=600) as r:
        if r.status != 201:
            raise RuntimeError(f"finishing the upload of {digest} answered {r.status}")


def blob_exists(target: str, digest: str, token: str) -> bool:
    host, _, repo = target.partition("/")
    req = urllib.request.Request(f"{registry_base(host)}/v2/{repo}/blobs/{digest}", method="HEAD", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60):
            return True
    except urllib.error.HTTPError:
        return False


def copy_signature_tags(source_repo: str, digest: str, target: str) -> list[str]:
    """Copies cosign's tag-schema signatures, attestations and SBOMs (and the OCI referrers fallback tag)."""
    hexd = digest.split(":", 1)[1]
    copied = []
    for suffix in (".sig", ".att", ".sbom", ""):
        tag = f"sha256-{hexd}{suffix}"
        if run(["crane", "digest", f"{source_repo}:{tag}"], timeout=120).returncode != 0:
            continue
        r = run(["crane", "copy", f"{source_repo}:{tag}", f"{target}:{tag}"], timeout=1800)
        if r.returncode != 0:
            raise RuntimeError(f"copying {tag} failed: {r.stderr.strip()[-300:]}")
        copied.append(tag)
    return copied


def mirror_image(item: dict) -> dict:
    source, target, digest = item["source"], item["target"], item["digest"]
    size, blobs = image_contents(source)
    if size > item["max_bytes"]:
        return {"status": "too_large", "size_bytes": size, "detail": f"{size} bytes across all platforms"}
    secret = os.environ.get("MIRROR_PUSH_TOKEN", "")
    source_repo, _ = split_ref(source)
    big = [d for d, s in blobs.items() if s > LARGE_BLOB]
    if big:
        if not secret:
            raise RuntimeError("MIRROR_PUSH_TOKEN is needed to push layers over 90 MB")
        token = push_token(target.split("/")[0], secret)
        for d in big:
            if blob_exists(target, d, token):
                continue
            log(f"pushing {d} ({blobs[d]} bytes) in chunks")
            proc = subprocess.Popen(["crane", "blob", f"{source_repo}@{d}"], stdout=subprocess.PIPE)
            try:
                push_blob_chunked(target, d, proc.stdout, token)
            finally:
                proc.stdout.close()
                proc.wait(timeout=600)
    r = run(["crane", "copy", source, f"{target}@{digest}"])
    if r.returncode != 0:
        raise RuntimeError(f"crane copy failed: {r.stderr.strip()[-300:]}")
    notes = []
    if shutil.which("cosign"):
        c = run(["cosign", "copy", "--force", source, target])
        if c.returncode != 0:
            notes.append(f"cosign copy: {c.stderr.strip()[-200:]}")
    tags = copy_signature_tags(source_repo, digest, target)
    got = run(["crane", "digest", f"{target}@{digest}"], timeout=120)
    if got.returncode != 0 or got.stdout.strip() != digest:
        raise RuntimeError(f"the mirror does not serve {digest}: {got.stderr.strip()[-200:]}")
    return {"status": "stored", "size_bytes": size, "detail": "; ".join([f"copied {', '.join(tags) or 'no signature tags'}", *notes])}


# ---------- uploads ----------

def upload(url: str, path: Path, opener=urllib.request.urlopen) -> None:
    size = path.stat().st_size
    with open(path, "rb") as f:
        req = urllib.request.Request(url, data=f, method="PUT", headers={"Content-Type": "application/octet-stream", "Content-Length": str(size)})
        with opener(req, timeout=3600) as r:
            if r.status not in (200, 201, 204):
                raise RuntimeError(f"upload answered {r.status}")


def find_wheel(item: dict, work: Path | None) -> Path:
    """The verified wheel from this scan, or the one on PyPI with the manifest's hash."""
    if work:
        for p in work.glob("*.whl"):
            if sha256_file(p) == item["sha256"]:
                return p
    with urllib.request.urlopen(f"https://pypi.org/pypi/{item['package']}/{item['version']}/json", timeout=60) as r:
        meta = json.load(r)
    url = next((u for u in meta["urls"] if u["packagetype"] == "bdist_wheel" and u["digests"]["sha256"] == item["sha256"]), None)
    if not url:
        raise RuntimeError("no wheel on PyPI matches the manifest's sha256")
    dest = Path(tempfile.mkdtemp(prefix="ot-wheel-")) / url["filename"]
    with urllib.request.urlopen(url["url"], timeout=600) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    if sha256_file(dest) != item["sha256"]:
        raise RuntimeError("the downloaded wheel does not match its sha256")
    return dest


def backup_wheel(item: dict, work: Path | None) -> dict:
    wheel = find_wheel(item, work)
    size = wheel.stat().st_size
    if size > item["max_bytes"]:
        return {"status": "too_large", "size_bytes": size}
    upload(item["upload_url"], wheel)
    return {"status": "stored", "size_bytes": size, "sha256": item["sha256"], "filename": wheel.name}


def dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


GIT_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}


def bundle_heads(bundle: Path) -> list[str]:
    r = run(["git", "bundle", "list-heads", str(bundle)], timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"git bundle list-heads failed: {r.stderr.strip()[-300:]}")
    return [line for line in r.stdout.splitlines() if line.strip()]


def make_bundle(clone_url: str, tmp: Path, max_bytes: int) -> tuple[str, Path | None, int]:
    """Mirror-clones a repository and bundles its branches and tags. ("too_large", None, size) when over the limit."""
    mirror = tmp / "mirror.git"
    r = run(["git", "clone", "--mirror", "--quiet", clone_url, str(mirror)], timeout=3600, env=GIT_ENV)
    if r.returncode != 0:
        raise RuntimeError(f"git clone failed: {r.stderr.strip()[-300:]}")
    if dir_size(mirror) > max_bytes * 2:
        # Far over the limit already; a bundle would not get under it.
        return "too_large", None, dir_size(mirror)
    bundle = tmp / "repo.bundle"
    # Branches and tags only: hosts' own refs (refs/pull/*, refs/merge-requests/*) cannot be pushed back.
    r = run(["git", "-C", str(mirror), "bundle", "create", str(bundle), "--branches", "--tags"], timeout=3600, env=GIT_ENV)
    if r.returncode != 0:
        raise RuntimeError(f"git bundle create failed: {r.stderr.strip()[-300:]}")
    size = bundle.stat().st_size
    if size > max_bytes:
        return "too_large", None, size
    v = run(["git", "-C", str(mirror), "bundle", "verify", str(bundle)], timeout=1800, env=GIT_ENV)
    if v.returncode != 0:
        raise RuntimeError(f"git bundle verify failed: {v.stderr.strip()[-300:]}")
    return "stored", bundle, size


def backup_git(item: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="ot-git-") as d:
        status, bundle, size = make_bundle(item["clone_url"], Path(d), item["max_bytes"])
        if status == "too_large":
            return {"status": "too_large", "size_bytes": size}
        refs = len(bundle_heads(bundle))
        sha = sha256_file(bundle)
        upload(item["upload_url"], bundle)
        return {"status": "stored", "size_bytes": size, "sha256": sha, "refs_count": refs}


# ---------- jobs ----------

def post_json(url: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "otinstaller-scanner",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


HANDLERS = {"image": lambda item, work: mirror_image(item), "wheel": backup_wheel, "git": lambda item, work: backup_git(item)}


def run_job(job: dict, work: Path | None = None, handlers: dict | None = None, report=post_json) -> list[dict]:
    """Backs up every item of one job (a failure in one does not stop the others) and reports to the registry."""
    handlers = handlers or HANDLERS
    results = []
    for item in job.get("items", []):
        try:
            out = handlers[item["kind"]](item, work)
        except Exception as e:  # noqa: BLE001 - every failure is reported, none stops the job
            out = {"status": "failed", "detail": str(e)[:500]}
        log(f"{job.get('ref', '?')} {item['kind']}: {out['status']} {out.get('detail', '')}")
        results.append({"id": item["id"], **out})
    answer = report(job["complete_url"], job["token"], {"items": results})
    log(f"registry answered: {json.dumps(answer)[:300]}")
    return results


def run_backup_request(req: dict, work: Path | None = None) -> int:
    jobs = req.get("jobs", [])
    failed = 0
    for job in jobs:
        try:
            results = run_job(job, work)
            failed += sum(1 for r in results if r["status"] == "failed")
        except Exception as e:  # noqa: BLE001
            log(f"job {job.get('run_id')} could not report: {e}")
            failed += 1
    return 1 if failed else 0


# ---------- restore drill ----------

def restore_bundle(bundle: Path, tmp: Path) -> dict:
    """What an owner does: clone the bundle and push everything into an empty repository; then compare refs."""
    heads = bundle_heads(bundle)
    empty = tmp / "empty.git"
    work = tmp / "restore.git"
    steps = [
        ["git", "init", "--bare", "--quiet", str(empty)],
        ["git", "clone", "--mirror", "--quiet", str(bundle), str(work)],
        ["git", "-C", str(work), "push", "--mirror", "--quiet", empty.as_uri()],
        ["git", "-C", str(empty), "fsck", "--full", "--no-progress"],
    ]
    for cmd in steps:
        r = run(cmd, timeout=3600, env=GIT_ENV)
        if r.returncode != 0:
            return {"check": "bundle", "result": "fail", "detail": f"{' '.join(cmd[:4])}: {r.stderr.strip()[-300:]}"}
    pushed = run(["git", "ls-remote", empty.as_uri()], timeout=600, env=GIT_ENV).stdout.splitlines()
    want = {tuple(h.split()) for h in heads if " refs/" in h}
    got = {tuple(h.split("\t")) for h in pushed}
    missing = sorted(r for _, r in want if r not in {ref for _, ref in got})
    if missing:
        return {"check": "bundle", "result": "fail", "detail": f"refs missing after the restore: {', '.join(missing[:10])}"}
    return {"check": "bundle", "result": "pass", "refs": len(want)}


def pull_image(image: dict) -> dict:
    ref = image["ref"]
    _, digest = split_ref(ref)
    r = run(["crane", "digest", ref], timeout=300)
    if r.returncode != 0 or r.stdout.strip() != digest:
        return {"check": "image", "result": "fail", "detail": f"crane digest {ref}: {r.stderr.strip()[-300:] or r.stdout.strip()}"}
    if shutil.which("docker"):
        p = run(["docker", "pull", ref], timeout=1800)
        if p.returncode != 0:
            return {"check": "image", "result": "fail", "detail": f"docker pull: {p.stderr.strip()[-300:]}"}
    if image.get("signer_identity"):
        v = run(["cosign", "verify", "--certificate-identity", image["signer_identity"], "--certificate-oidc-issuer", image["signer_issuer"], ref], timeout=600)
        if v.returncode != 0:
            return {"check": "image", "result": "fail", "detail": f"cosign verify: {v.stderr.strip()[-300:]}"}
    return {"check": "image", "result": "pass", "signature": "verified" if image.get("signer_identity") else "unsigned"}


def drill(req: dict, report=post_json) -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="ot-drill-") as d:
        tmp = Path(d)
        b = req.get("bundle")
        if b:
            try:
                path = tmp / "drill.bundle"
                with urllib.request.urlopen(b["url"], timeout=3600) as r, open(path, "wb") as f:
                    shutil.copyfileobj(r, f)
                if b.get("sha256") and sha256_file(path) != b["sha256"]:
                    checks.append({"check": "bundle", "result": "fail", "detail": "the downloaded bundle does not match its recorded sha256"})
                else:
                    checks.append(restore_bundle(path, tmp))
            except Exception as e:  # noqa: BLE001
                checks.append({"check": "bundle", "result": "fail", "detail": str(e)[:300]})
        if req.get("image"):
            try:
                checks.append(pull_image(req["image"]))
            except Exception as e:  # noqa: BLE001
                checks.append({"check": "image", "result": "fail", "detail": str(e)[:300]})
    ok = bool(checks) and all(c["result"] == "pass" for c in checks)
    detail = "; ".join(f"{c['check']}: {c['result']}{' (' + c['detail'] + ')' if c.get('detail') else ''}" for c in checks)
    log(f"drill {'passed' if ok else 'FAILED'}: {detail}")
    report(req["callback_url"], req["token"], {"result": "pass" if ok else "fail", "detail": detail, "checks": checks})
    return 0 if ok else 1
