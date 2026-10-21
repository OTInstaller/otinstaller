"""Unit tests for scan.py helpers. Run: python -m unittest discover ops/scanner"""
import unittest

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
