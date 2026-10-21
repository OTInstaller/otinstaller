"""Unit tests for backup.py. Run: python -m unittest discover ops/scanner (git must be on PATH)."""
import hashlib
import http.server
import io
import json
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

import backup


def git(*args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**backup.GIT_ENV, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"})


def sample_repo(root: Path) -> Path:
    """A repository with two branches and a release tag, like a package's source."""
    repo = root / "source"
    repo.mkdir()
    git("init", "--quiet", "-b", "main", cwd=repo)
    (repo / "otinstaller.yaml").write_text("name: demo\n")
    git("add", ".", cwd=repo)
    git("commit", "--quiet", "-m", "first", cwd=repo)
    git("tag", "v1.0.0", cwd=repo)
    git("checkout", "--quiet", "-b", "dev", cwd=repo)
    (repo / "dev.txt").write_text("work in progress\n")
    git("add", ".", cwd=repo)
    git("commit", "--quiet", "-m", "dev", cwd=repo)
    return repo


class ImageTests(unittest.TestCase):
    def test_sizes_count_every_platform_once(self):
        manifests = {
            "ghcr.io/o/t@sha256:index": {"mediaType": "application/vnd.oci.image.index.v1+json",
                                         "manifests": [{"digest": "sha256:amd"}, {"digest": "sha256:arm"}]},
            "ghcr.io/o/t@sha256:amd": {"config": {"digest": "sha256:c1", "size": 10}, "layers": [{"digest": "sha256:shared", "size": 100}, {"digest": "sha256:a", "size": 5}]},
            "ghcr.io/o/t@sha256:arm": {"config": {"digest": "sha256:c2", "size": 10}, "layers": [{"digest": "sha256:shared", "size": 100}, {"digest": "sha256:b", "size": 7}]},
        }
        total, blobs = backup.image_contents("ghcr.io/o/t@sha256:index", fetch=manifests.__getitem__)
        self.assertEqual(total, 132)
        self.assertEqual(set(blobs), {"sha256:c1", "sha256:c2", "sha256:shared", "sha256:a", "sha256:b"})

    def test_plain_http_only_for_loopback(self):
        self.assertEqual(backup.registry_base("localhost:8788"), "http://localhost:8788")
        self.assertEqual(backup.registry_base("127.0.0.1:5000"), "http://127.0.0.1:5000")
        self.assertEqual(backup.registry_base("mirror.otinstaller.com"), "https://mirror.otinstaller.com")


class FakeRegistry(http.server.BaseHTTPRequestHandler):
    """Just enough of the OCI upload API to check the chunked uploader."""
    chunks: list = []
    finished: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.send_response(202)
        self.send_header("Location", "/v2/ns/tool/blobs/uploads/u1")
        self.end_headers()

    def do_PATCH(self):
        n = int(self.headers["Content-Length"])
        FakeRegistry.chunks.append((self.headers["Content-Range"], self.rfile.read(n)))
        self.send_response(202)
        self.send_header("Location", "/v2/ns/tool/blobs/uploads/u1?state=2")
        self.end_headers()

    def do_PUT(self):
        FakeRegistry.finished.append((self.path, self.headers.get("Authorization")))
        self.send_response(201)
        self.end_headers()


class ChunkedUploadTests(unittest.TestCase):
    def test_pushes_fixed_size_chunks_then_the_digest(self):
        srv = http.server.HTTPServer(("127.0.0.1", 0), FakeRegistry)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            data = bytes(range(256)) * 40  # 10240 bytes
            digest = "sha256:" + hashlib.sha256(data).hexdigest()
            backup.push_blob_chunked(f"127.0.0.1:{srv.server_port}/ns/tool", digest, io.BytesIO(data), "tok", chunk=4096)
        finally:
            srv.shutdown()
        self.assertEqual([r for r, _ in FakeRegistry.chunks], ["0-4095", "4096-8191", "8192-10239"])
        self.assertEqual(b"".join(c for _, c in FakeRegistry.chunks), data)
        path, auth = FakeRegistry.finished[0]
        self.assertEqual(path, f"/v2/ns/tool/blobs/uploads/u1?state=2&digest={digest.replace(':', '%3A')}")
        self.assertEqual(auth, "Bearer tok")


class GitTests(unittest.TestCase):
    def test_bundle_restores_into_an_empty_repository(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src = sample_repo(root)
            work = root / "work"
            work.mkdir()
            status, bundle, size = backup.make_bundle(src.as_uri(), work, 500 * 1024 * 1024)
            self.assertEqual(status, "stored")
            self.assertGreater(size, 0)
            heads = backup.bundle_heads(bundle)
            self.assertEqual(sorted(h.split()[1] for h in heads), ["refs/heads/dev", "refs/heads/main", "refs/tags/v1.0.0"])
            out = backup.restore_bundle(bundle, root)
            self.assertEqual(out, {"check": "bundle", "result": "pass", "refs": 3})

    def test_bundles_over_the_limit_are_not_uploaded(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src = sample_repo(root)
            uploads = []
            orig = backup.upload
            backup.upload = lambda url, path, opener=None: uploads.append(url)
            try:
                out = backup.backup_git({"clone_url": src.as_uri(), "upload_url": "https://r2/x", "max_bytes": 10})
            finally:
                backup.upload = orig
            self.assertEqual(out["status"], "too_large")
            self.assertEqual(uploads, [])

    def test_git_backup_uploads_the_bundle_with_its_hash(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src = sample_repo(root)
            uploaded = {}
            orig = backup.upload

            def fake_upload(url, path, opener=None):
                uploaded["sha"] = hashlib.sha256(path.read_bytes()).hexdigest()
            backup.upload = fake_upload
            try:
                out = backup.backup_git({"clone_url": src.as_uri(), "upload_url": "https://r2/x", "max_bytes": 500 * 1024 * 1024})
            finally:
                backup.upload = orig
            self.assertEqual(out["status"], "stored")
            self.assertEqual(out["refs_count"], 3)
            self.assertEqual(out["sha256"], uploaded["sha"])


class JobTests(unittest.TestCase):
    def test_every_item_is_reported_even_when_one_fails(self):
        reports = []

        def boom(item, work):
            raise RuntimeError("crane copy failed: denied")
        handlers = {"image": boom, "git": lambda item, work: {"status": "stored", "size_bytes": 5}}
        job = {"ref": "ns/t", "complete_url": "https://api/v1/internal/backups/r1", "token": "tok",
               "items": [{"id": "a", "kind": "image"}, {"id": "b", "kind": "git"}]}
        backup.run_job(job, handlers=handlers, report=lambda url, token, body: reports.append((url, token, body)) or {})
        url, token, body = reports[0]
        self.assertEqual((url, token), ("https://api/v1/internal/backups/r1", "tok"))
        self.assertEqual(body["items"], [{"id": "a", "status": "failed", "detail": "crane copy failed: denied"}, {"id": "b", "status": "stored", "size_bytes": 5}])

    def test_drill_restores_the_bundle_and_reports(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src = sample_repo(root)
            work = root / "w"
            work.mkdir()
            _, bundle, _ = backup.make_bundle(src.as_uri(), work, 500 * 1024 * 1024)
            reports = []
            code = backup.drill({"callback_url": "https://api/v1/internal/drills/d1", "token": "t",
                                 "bundle": {"url": bundle.as_uri(), "sha256": backup.sha256_file(bundle)}},
                                report=lambda url, token, body: reports.append(body))
            self.assertEqual(code, 0)
            self.assertEqual(reports[0]["result"], "pass")
            # A bundle that does not match its recorded hash fails the drill.
            code = backup.drill({"callback_url": "u", "token": "t", "bundle": {"url": bundle.as_uri(), "sha256": "0" * 64}},
                                report=lambda url, token, body: reports.append(body))
            self.assertEqual(code, 1)
            self.assertEqual(reports[1]["result"], "fail")


if __name__ == "__main__":
    unittest.main()
