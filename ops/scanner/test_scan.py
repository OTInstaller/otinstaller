"""Unit tests for scan.py helpers. Run: python -m unittest discover ops/scanner"""
import hashlib
import io
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import health
import scan

# A public Fulcio certificate from a real keyless signature (dheerajydv19/ot-test-tool, released from main).
CERT_DER_B64 = "MIIHXTCCBuSgAwIBAgIUV48HbPlgKom1t8mNdS4pStwJhncwCgYIKoZIzj0EAwMwNzEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MR4wHAYDVQQDExVzaWdzdG9yZS1pbnRlcm1lZGlhdGUwHhcNMjYxMDIwMDgwNjE2WhcNMjYxMDIwMDgxNjE2WjAAMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9ROQI248iwIpJUYAI3NA8Om+OBJVQOCQpx5SJUdDEoee/xEip3Njqp8qtQ6NvJjtkmtd43+D7wUebeem29qooKOCBgMwggX/MA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAfBgNVHSMEGDAWgBTf0+nPViQRlvmo2OkoVaLGLhhkPzB0BgNVHREBAf8EajBohmZodHRwczovL2dpdGh1Yi5jb20vZGhlZXJhanlkdjE5L290LXRlc3QtdG9vbC8uZ2l0aHViL3dvcmtmbG93cy9vdGluc3RhbGxlci1yZWxlYXNlLnltbEByZWZzL2hlYWRzL21haW4wOQYKKwYBBAGDvzABAQQraHR0cHM6Ly90b2tlbi5hY3Rpb25zLmdpdGh1YnVzZXJjb250ZW50LmNvbTAfBgorBgEEAYO/MAECBBF3b3JrZmxvd19kaXNwYXRjaDA2BgorBgEEAYO/MAEDBCg5ZDJjNjliMWNkNmYxZWE1OWViNmM4ZjkzYzViZWQzNjg0NWIwM2FjMCEGCisGAQQBg78wAQQEE290aW5zdGFsbGVyIHJlbGVhc2UwJwYKKwYBBAGDvzABBQQZZGhlZXJhanlkdjE5L290LXRlc3QtdG9vbDAdBgorBgEEAYO/MAEGBA9yZWZzL2hlYWRzL21haW4wOwYKKwYBBAGDvzABCAQtDCtodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tMHYGCisGAQQBg78wAQkEaAxmaHR0cHM6Ly9naXRodWIuY29tL2RoZWVyYWp5ZHYxOS9vdC10ZXN0LXRvb2wvLmdpdGh1Yi93b3JrZmxvd3Mvb3RpbnN0YWxsZXItcmVsZWFzZS55bWxAcmVmcy9oZWFkcy9tYWluMDgGCisGAQQBg78wAQoEKgwoOWQyYzY5YjFjZDZmMWVhNTllYjZjOGY5M2M1YmVkMzY4NDViMDNhYzAdBgorBgEEAYO/MAELBA8MDWdpdGh1Yi1ob3N0ZWQwPAYKKwYBBAGDvzABDAQuDCxodHRwczovL2dpdGh1Yi5jb20vZGhlZXJhanlkdjE5L290LXRlc3QtdG9vbDA4BgorBgEEAYO/MAENBCoMKDlkMmM2OWIxY2Q2ZjFlYTU5ZWI2YzhmOTNjNWJlZDM2ODQ1YjAzYWMwHwYKKwYBBAGDvzABDgQRDA9yZWZzL2hlYWRzL21haW4wGgYKKwYBBAGDvzABDwQMDAoxNDI1OTg1NjAzMC8GCisGAQQBg78wARAEIQwfaHR0cHM6Ly9naXRodWIuY29tL2RoZWVyYWp5ZHYxOTAZBgorBgEEAYO/MAERBAsMCTEwNDI0NDIyNzB2BgorBgEEAYO/MAESBGgMZmh0dHBzOi8vZ2l0aHViLmNvbS9kaGVlcmFqeWR2MTkvb3QtdGVzdC10b29sLy5naXRodWIvd29ya2Zsb3dzL290aW5zdGFsbGVyLXJlbGVhc2UueW1sQHJlZnMvaGVhZHMvbWFpbjA4BgorBgEEAYO/MAETBCoMKDlkMmM2OWIxY2Q2ZjFlYTU5ZWI2YzhmOTNjNWJlZDM2ODQ1YjAzYWMwIQYKKwYBBAGDvzABFAQTDBF3b3JrZmxvd19kaXNwYXRjaDBgBgorBgEEAYO/MAEVBFIMUGh0dHBzOi8vZ2l0aHViLmNvbS9kaGVlcmFqeWR2MTkvb3QtdGVzdC10b29sL2FjdGlvbnMvcnVucy8zOTM5MDg3ODY5MS9hdHRlbXB0cy8xMBYGCisGAQQBg78wARYECAwGcHVibGljMFcGCisGAQQBg78wARgESQxHcmVwbzpkaGVlcmFqeWR2MTlAMTA0MjQ0MjI3L290LXRlc3QtdG9vbEAxNDI1OTg1NjAzOnJlZjpyZWZzL2hlYWRzL21haW4wgYoGCisGAQQB1nkCBAIEfAR6AHgAdgDdPTBqxscRMmMZHhyZZzcCokpeuN48rf+HinKALynujgAAAaFYWMtIAAAEAwBHMEUCIGkIQVzDSSDMw87jAxTsmdNHLoXQ8fnuym4Y1Ny9dNU7AiEAsJsiMHAJf2UF22yznLytq2W/G08qo6/IEO+4S51uGTkwCgYIKoZIzj0EAwMDZwAwZAIwOkfhmpOq0lqa8l9BCzcKiXUHmXgs2AblG/62iW//mV7AR+4ET7QIA9KBshs7luslAjA8sfrns6To7yyv1JfYYqJ5k/WjvVPfIRn0pXzJ6DlHcY42u0x4bl3Yh1rtHxFWweQ="
CERT_PEM = """-----BEGIN CERTIFICATE-----
MIIHXTCCBuSgAwIBAgIUV48HbPlgKom1t8mNdS4pStwJhncwCgYIKoZIzj0EAwMw
NzEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MR4wHAYDVQQDExVzaWdzdG9yZS1pbnRl
cm1lZGlhdGUwHhcNMjYxMDIwMDgwNjE2WhcNMjYxMDIwMDgxNjE2WjAAMFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAE9ROQI248iwIpJUYAI3NA8Om+OBJVQOCQpx5S
JUdDEoee/xEip3Njqp8qtQ6NvJjtkmtd43+D7wUebeem29qooKOCBgMwggX/MA4G
A1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAfBgNVHSMEGDAWgBTf
0+nPViQRlvmo2OkoVaLGLhhkPzB0BgNVHREBAf8EajBohmZodHRwczovL2dpdGh1
Yi5jb20vZGhlZXJhanlkdjE5L290LXRlc3QtdG9vbC8uZ2l0aHViL3dvcmtmbG93
cy9vdGluc3RhbGxlci1yZWxlYXNlLnltbEByZWZzL2hlYWRzL21haW4wOQYKKwYB
BAGDvzABAQQraHR0cHM6Ly90b2tlbi5hY3Rpb25zLmdpdGh1YnVzZXJjb250ZW50
LmNvbTAfBgorBgEEAYO/MAECBBF3b3JrZmxvd19kaXNwYXRjaDA2BgorBgEEAYO/
MAEDBCg5ZDJjNjliMWNkNmYxZWE1OWViNmM4ZjkzYzViZWQzNjg0NWIwM2FjMCEG
CisGAQQBg78wAQQEE290aW5zdGFsbGVyIHJlbGVhc2UwJwYKKwYBBAGDvzABBQQZ
ZGhlZXJhanlkdjE5L290LXRlc3QtdG9vbDAdBgorBgEEAYO/MAEGBA9yZWZzL2hl
YWRzL21haW4wOwYKKwYBBAGDvzABCAQtDCtodHRwczovL3Rva2VuLmFjdGlvbnMu
Z2l0aHVidXNlcmNvbnRlbnQuY29tMHYGCisGAQQBg78wAQkEaAxmaHR0cHM6Ly9n
aXRodWIuY29tL2RoZWVyYWp5ZHYxOS9vdC10ZXN0LXRvb2wvLmdpdGh1Yi93b3Jr
Zmxvd3Mvb3RpbnN0YWxsZXItcmVsZWFzZS55bWxAcmVmcy9oZWFkcy9tYWluMDgG
CisGAQQBg78wAQoEKgwoOWQyYzY5YjFjZDZmMWVhNTllYjZjOGY5M2M1YmVkMzY4
NDViMDNhYzAdBgorBgEEAYO/MAELBA8MDWdpdGh1Yi1ob3N0ZWQwPAYKKwYBBAGD
vzABDAQuDCxodHRwczovL2dpdGh1Yi5jb20vZGhlZXJhanlkdjE5L290LXRlc3Qt
dG9vbDA4BgorBgEEAYO/MAENBCoMKDlkMmM2OWIxY2Q2ZjFlYTU5ZWI2YzhmOTNj
NWJlZDM2ODQ1YjAzYWMwHwYKKwYBBAGDvzABDgQRDA9yZWZzL2hlYWRzL21haW4w
GgYKKwYBBAGDvzABDwQMDAoxNDI1OTg1NjAzMC8GCisGAQQBg78wARAEIQwfaHR0
cHM6Ly9naXRodWIuY29tL2RoZWVyYWp5ZHYxOTAZBgorBgEEAYO/MAERBAsMCTEw
NDI0NDIyNzB2BgorBgEEAYO/MAESBGgMZmh0dHBzOi8vZ2l0aHViLmNvbS9kaGVl
cmFqeWR2MTkvb3QtdGVzdC10b29sLy5naXRodWIvd29ya2Zsb3dzL290aW5zdGFs
bGVyLXJlbGVhc2UueW1sQHJlZnMvaGVhZHMvbWFpbjA4BgorBgEEAYO/MAETBCoM
KDlkMmM2OWIxY2Q2ZjFlYTU5ZWI2YzhmOTNjNWJlZDM2ODQ1YjAzYWMwIQYKKwYB
BAGDvzABFAQTDBF3b3JrZmxvd19kaXNwYXRjaDBgBgorBgEEAYO/MAEVBFIMUGh0
dHBzOi8vZ2l0aHViLmNvbS9kaGVlcmFqeWR2MTkvb3QtdGVzdC10b29sL2FjdGlv
bnMvcnVucy8zOTM5MDg3ODY5MS9hdHRlbXB0cy8xMBYGCisGAQQBg78wARYECAwG
cHVibGljMFcGCisGAQQBg78wARgESQxHcmVwbzpkaGVlcmFqeWR2MTlAMTA0MjQ0
MjI3L290LXRlc3QtdG9vbEAxNDI1OTg1NjAzOnJlZjpyZWZzL2hlYWRzL21haW4w
gYoGCisGAQQB1nkCBAIEfAR6AHgAdgDdPTBqxscRMmMZHhyZZzcCokpeuN48rf+H
inKALynujgAAAaFYWMtIAAAEAwBHMEUCIGkIQVzDSSDMw87jAxTsmdNHLoXQ8fnu
ym4Y1Ny9dNU7AiEAsJsiMHAJf2UF22yznLytq2W/G08qo6/IEO+4S51uGTkwCgYI
KoZIzj0EAwMDZwAwZAIwOkfhmpOq0lqa8l9BCzcKiXUHmXgs2AblG/62iW//mV7A
R+4ET7QIA9KBshs7luslAjA8sfrns6To7yyv1JfYYqJ5k/WjvVPfIRn0pXzJ6DlH
cY42u0x4bl3Yh1rtHxFWweQ=
-----END CERTIFICATE-----
"""
IDENTITY = "https://github.com/dheerajydv19/ot-test-tool/.github/workflows/otinstaller-release.yml@refs/heads/main"
ISSUER = "https://token.actions.githubusercontent.com"


class SignatureCertTest(unittest.TestCase):
    def check(self, sig):
        self.assertEqual(scan.cert_identity(scan.signature_cert_der(sig)), (IDENTITY, ISSUER))

    def test_cosign_v3_parsed_certificate(self):
        self.check({"Cert": {"Raw": CERT_DER_B64, "Subject": {}}})

    def test_cosign_v2_pem_certificate(self):
        self.check({"Cert": CERT_PEM})

    def test_bundle_certificate(self):
        self.check({"verificationMaterial": {"certificate": {"rawBytes": CERT_DER_B64}}})

    def test_no_certificate(self):
        self.assertIsNone(scan.signature_cert_der({"Cert": None}))


class AnySignerTest(unittest.TestCase):
    """Direct uploads: no expected signer, so any keyless signature counts and every verified identity is reported."""

    def fake_run(self, returncode, stdout):
        calls = []

        def run(cmd, timeout=600, check=False):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, returncode, stdout, "")
        return calls, run

    def test_reports_every_identity_cosign_verified(self):
        out = json.dumps([
            {"critical": {}, "optional": {"Subject": IDENTITY, "Issuer": ISSUER}},
            {"critical": {}, "optional": {"Subject": "alice@example.com", "Issuer": "https://github.com/login/oauth"}},
            {"critical": {}, "optional": {"Subject": IDENTITY, "Issuer": ISSUER}},
        ])
        calls, fake = self.fake_run(0, out)
        with mock.patch.object(scan, "run", fake):
            r = scan.check_image_signature("mirror.otinstaller.com/a/b@sha256:" + "0" * 64, None)
        self.assertEqual(r["status"], "pass")
        self.assertEqual((r["identity"], r["issuer"]), (IDENTITY, ISSUER))
        self.assertEqual([i["identity"] for i in r["identities"]], [IDENTITY, "alice@example.com"])
        self.assertIn("--certificate-oidc-issuer-regexp", calls[0])

    def test_unsigned_is_absent(self):
        _, fake = self.fake_run(1, "")
        with mock.patch.object(scan, "run", fake):
            self.assertEqual(scan.check_image_signature("x/y@sha256:" + "0" * 64, None), {"status": "absent"})

    def test_identities_from_one_document_per_line(self):
        out = json.dumps({"optional": {"Subject": "a@example.com", "Issuer": "https://accounts.google.com"}}) + "\n" + "not json\n"
        self.assertEqual(scan.verified_identities(out), [("a@example.com", "https://accounts.google.com")])

    def test_wheel_from_any_publisher_without_a_source_repository(self):
        prov = {"attestation_bundles": [{"publisher": {"kind": "GitHub", "repository": "Alice/Tool", "workflow": "release.yml"}}]}
        with mock.patch.object(scan, "http_json", lambda url: prov):
            r = scan.check_wheel_provenance("tool", "1.0.0", "tool-1.0.0-py3-none-any.whl", "")
            self.assertEqual(r["status"], "pass")
            self.assertEqual(r["identity"], "pypi:GitHub:alice/tool/release.yml")
            # With a source repository, someone else's provenance still fails.
            self.assertEqual(scan.check_wheel_provenance("tool", "1.0.0", "tool-1.0.0-py3-none-any.whl", "github.com/bob/tool")["status"], "fail")


class PipxImageTest(unittest.TestCase):
    """pipx tools are smoke-tested and health-checked in the image `ot` runs them in. The sandbox is read-only except
    /tmp, so the image starts there; otherwise a tool that writes into its working folder works in `ot` but fails the
    scan and the nightly health check."""

    def test_starts_in_tmp(self):
        workdirs = [line.split()[1] for line in scan.PYTHON_DOCKERFILE.splitlines() if line.startswith("WORKDIR ")]
        self.assertEqual(workdirs[-1:], ["/tmp"])

    def test_same_dockerfile_as_ot(self):
        install_go = Path(__file__).resolve().parents[2] / "cli" / "internal" / "runner" / "install.go"
        if not install_go.exists():
            self.skipTest("needs the ot source next to ops/ (registry-ops has only the scanner)")
        found = re.search(r"const pythonDockerfile = `([^`]*)`", install_go.read_text(encoding="utf-8"))
        self.assertIsNotNone(found, "pythonDockerfile is no longer a raw string constant in install.go")
        self.assertEqual(scan.PYTHON_DOCKERFILE, found.group(1))

    def test_smoke_test_and_health_check_run_in_it(self):
        wheel = b"not really a wheel"
        sha = hashlib.sha256(wheel).hexdigest()
        meta = {"urls": [{"packagetype": "bdist_wheel", "digests": {"sha256": sha}, "filename": "tool-1.0.0-py3-none-any.whl",
                          "url": "https://files.pythonhosted.org/tool-1.0.0-py3-none-any.whl"}]}
        rt = {"kind": "pipx", "package": "tool", "package_version": "1.0.0", "wheel_sha256": sha,
              "command": ["tool", "{domain}"], "output_format": "json"}
        dockerfiles, images = [], []

        def run(cmd, timeout=600, check=False):
            if cmd[:2] == ["docker", "build"]:
                dockerfiles.append(Path(cmd[-1], "Dockerfile").read_text())
            elif cmd[:2] == ["docker", "run"]:
                images.append(cmd[cmd.index("--entrypoint") + 2])
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with (mock.patch.object(scan, "run", run),
              mock.patch.object(scan, "http_json", lambda url: meta if url.endswith("/json") else None),
              mock.patch.object(scan.urllib.request, "urlopen", lambda url, timeout=None: io.BytesIO(wheel)),
              tempfile.TemporaryDirectory() as tmp):
            scanned = scan.scan_pipx({"ref": "ns/tool", "runtime": rt, "test_input": {"domain": "example.com"}}, Path(tmp))
            checked = health.check({"version_id": "v1", "ref": "ns/tool", "runtime": rt, "test_input": {"domain": "example.com"}})
        self.assertEqual(scanned["smoke"]["status"], "pass")
        self.assertEqual(checked["result"], "pass", checked["error_excerpt"])
        self.assertEqual(dockerfiles, [scan.PYTHON_DOCKERFILE] * 2)
        self.assertEqual(images, ["ot-scan/ns-tool:latest", "ot-health/ns-tool:latest"])


if __name__ == "__main__":
    unittest.main()


class SampleTest(unittest.TestCase):
    def test_json_envelope_keeps_a_few_entities(self):
        out = '{"entities": [' + ", ".join('{"type": "domain", "value": "d%d.example"}' % i for i in range(8)) + "]}"
        s = scan.sample_from_output(out, "json")
        self.assertEqual(s["entity_count"], 8)
        self.assertEqual(len(s["entities"]), scan.SAMPLE_MAX_ENTITIES)
        self.assertNotIn("stdout", s)

    def test_jsonl_lines_become_entities_and_junk_is_skipped(self):
        out = '{"type": "ip", "value": "192.0.2.1"}\nnot json\n{"type": "url", "value": "https://example.com"}\n'
        s = scan.sample_from_output(out, "jsonl")
        self.assertEqual([e["type"] for e in s["entities"]], ["ip", "url"])

    def test_text_and_unparseable_json_keep_a_slice_of_stdout(self):
        self.assertEqual(scan.sample_from_output("x" * 5000, "text")["stdout"], "x" * scan.SAMPLE_MAX_CHARS)
        s = scan.sample_from_output("{broken", "json")
        self.assertEqual(s["stdout"], "{broken")
        self.assertNotIn("entities", s)

    def test_oversized_entity_is_cut_down(self):
        out = '{"entities": [{"type": "document", "value": "r.pdf", "attrs": {"blob": "%s"}}]}' % ("y" * 900)
        e = scan.sample_from_output(out, "json")["entities"][0]
        self.assertEqual(e, {"type": "document", "value": "r.pdf"})
