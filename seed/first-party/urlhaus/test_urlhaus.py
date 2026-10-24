import io
import json
import os
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import urlhaus

SHA = "12" * 32
URL_DOC = {
    "query_status": "ok", "id": "105821", "urlhaus_reference": "https://urlhaus.abuse.ch/url/105821/",
    "url": "http://malware.example/bins/x.arm7", "url_status": "online", "host": "malware.example",
    "date_added": "2026-10-01 09:00:00 UTC", "last_online": None, "threat": "malware_download",
    "blacklists": {"spamhaus_dbl": "not listed", "surbl": "not listed"}, "reporter": "someone", "larted": "true",
    "takedown_time_seconds": None, "tags": ["elf", "mirai"],
    "payloads": [{"firstseen": "2026-10-01", "filename": "x.arm7", "file_type": "elf", "response_size": "61234",
                  "response_md5": "ab" * 16, "response_sha256": SHA, "signature": "Mirai",
                  "virustotal": {"result": "40 / 64", "percent": "62.50", "link": "https://www.virustotal.com/x"}},
                 {"firstseen": "2026-10-02", "response_sha256": None}],
}
HOST_DOC = {
    "query_status": "ok", "urlhaus_reference": "https://urlhaus.abuse.ch/host/malware.example/",
    "host": "malware.example", "firstseen": "2026-09-30 10:00:00 UTC", "url_count": "2",
    "blacklists": {"spamhaus_dbl": "abused_legit_malware", "surbl": "listed"},
    "urls": [{"id": "1", "urlhaus_reference": "https://urlhaus.abuse.ch/url/1/", "url": "http://malware.example/a",
              "url_status": "online", "date_added": "2026-09-30 10:00:00 UTC", "threat": "malware_download",
              "reporter": "someone", "larted": "false", "takedown_time_seconds": None, "tags": None},
             {"id": "2", "url": "http://malware.example/b", "url_status": "offline", "tags": ["exe"]}],
}
PAYLOAD_DOC = {
    "query_status": "ok", "md5_hash": "ab" * 16, "sha256_hash": SHA, "file_type": "exe", "file_size": "1024",
    "signature": "AgentTesla", "firstseen": "2026-10-01 09:00:00", "lastseen": None, "url_count": "1",
    "virustotal": None, "imphash": None, "ssdeep": "3:x:y", "tlsh": None,
    "urls": [{"url_id": "9", "url": "http://malware.example/c.exe", "url_status": "offline",
              "urlhaus_reference": "https://urlhaus.abuse.ch/url/9/", "filename": "c.exe",
              "firstseen": "2026-10-01", "lastseen": None}],
}


def response(body):
    resp = mock.MagicMock()
    resp.__enter__.return_value.read.return_value = json.dumps(body).encode()
    return resp


def run(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=True), redirect_stdout(out), redirect_stderr(err):
        code = urlhaus.main(argv)
    return code, out.getvalue(), err.getvalue()


class URLhausTest(unittest.TestCase):
    def test_url_entities(self):
        found = urlhaus.entities("url", URL_DOC["url"], URL_DOC)
        self.assertEqual([e["type"] for e in found], ["url", "document"])
        self.assertEqual(found[0]["attrs"]["status"], "online")
        self.assertEqual(found[0]["attrs"]["tags"], ["elf", "mirai"])
        self.assertEqual(found[0]["attrs"]["payloads"], 2)
        self.assertEqual(found[1]["value"], SHA)
        self.assertEqual(found[1]["attrs"]["signature"], "Mirai")
        self.assertEqual(found[1]["attrs"]["virustotal"], "40 / 64")

    def test_host_entities(self):
        found = urlhaus.entities("domain", "malware.example", HOST_DOC)
        self.assertEqual([(e["type"], e["value"]) for e in found],
                         [("domain", "malware.example"), ("url", "http://malware.example/a"),
                          ("url", "http://malware.example/b")])
        self.assertEqual(found[0]["attrs"]["online"], 1)
        self.assertEqual(found[1]["attrs"]["tags"], [])

    def test_payload_entities(self):
        found = urlhaus.entities("hash", "ab" * 16, PAYLOAD_DOC)
        self.assertEqual([(e["type"], e["value"]) for e in found],
                         [("document", SHA), ("url", "http://malware.example/c.exe")])
        self.assertEqual(found[0]["attrs"]["signature"], "AgentTesla")
        self.assertIsNone(found[0]["attrs"]["virustotal"])

    def test_requests(self):
        self.assertEqual(urlhaus.request("domain", "example.com"), ("host", {"host": "example.com"}))
        self.assertEqual(urlhaus.request("hash", "ab" * 16), ("payload", {"md5_hash": "ab" * 16}))
        self.assertEqual(urlhaus.request("hash", SHA), ("payload", {"sha256_hash": SHA}))
        with self.assertRaises(ValueError):
            urlhaus.request("hash", "a" * 40)

    def test_missing_key_exits_3(self):
        code, out, err = run(["--domain", "example.com"])
        self.assertEqual((code, out), (3, ""))
        self.assertIn("ABUSECH_AUTH_KEY", err)

    def test_sha1_exits_2(self):
        code, _, err = run(["--hash", "A" * 40], {"ABUSECH_AUTH_KEY": "k"})
        self.assertEqual(code, 2)
        self.assertIn("MD5 or SHA-256", err)

    def test_posts_the_host_with_the_key_in_a_header(self):
        with mock.patch("urllib.request.urlopen", return_value=response(HOST_DOC)) as urlopen:
            code, out, _ = run(["--domain", "Malware.Example."], {"ABUSECH_AUTH_KEY": "secret-key"})
        self.assertEqual(code, 0)
        req = urlopen.call_args[0][0]
        self.assertEqual(req.full_url, urlhaus.API + "host/")
        self.assertEqual(urllib.parse.parse_qs(req.data.decode()), {"host": ["malware.example"]})
        self.assertEqual(req.get_header("Auth-key"), "secret-key")
        self.assertEqual(json.loads(out)["entities"][0]["value"], "malware.example")

    def test_no_results(self):
        with mock.patch("urllib.request.urlopen", return_value=response({"query_status": "no_results"})):
            code, out, err = run(["--ip", "8.8.8.8"], {"ABUSECH_AUTH_KEY": "k"})
        self.assertEqual((code, json.loads(out)), (0, {"entities": []}))
        self.assertIn("no record of 8.8.8.8", err)

    def test_invalid_url_exits_2(self):
        with mock.patch("urllib.request.urlopen", return_value=response({"query_status": "invalid_url"})):
            code, _, err = run(["--url", "nope"], {"ABUSECH_AUTH_KEY": "k"})
        self.assertEqual(code, 2)
        self.assertIn("not a valid URL", err)

    def test_refused_key_exits_1(self):
        error = urllib.error.HTTPError(urlhaus.API, 401, "Unauthorized", {}, io.BytesIO(b'{"error": "Unauthorized"}'))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            code, _, err = run(["--domain", "example.com"], {"ABUSECH_AUTH_KEY": "bad"})
        self.assertEqual(code, 1)
        self.assertIn("refused the key", err)

    def test_needs_exactly_one_target(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stop:
            urlhaus.main(["--domain", "example.com", "--ip", "8.8.8.8"])
        self.assertEqual(stop.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
