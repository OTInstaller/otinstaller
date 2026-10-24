import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import IndicatorTypes
from OTXv2 import InvalidAPIKey, NotFound

import otx_indicators

PULSE = {"id": "p1", "name": "Phishing kit", "tags": ["phishing"], "author": {"username": "someone"},
         "malware_families": [{"id": "x", "display_name": "Emotet"}], "references": ["https://example.org/1"]}
DOMAIN = {"type": "domain", "pulse_info": {"count": 1, "pulses": [PULSE], "related": {
    "other": {"malware_families": ["Emotet"], "adversary": [], "industries": ["Media"]}}}}
HOSTNAME = {"type": "hostname", "pulse_info": {"count": 4, "pulses": [PULSE, dict(PULSE, id="p2")]}}
IP = {"type": "IPv4", "reputation": 0, "asn": "AS15169 google llc", "country_name": "United States of America",
      "latitude": 37.751, "longitude": -97.822, "validation": [{"name": "Whitelisted IP"}],
      "pulse_info": {"count": 0, "pulses": []}}


class FakeOTX:
    def __init__(self, answers):
        self.answers, self.asked = answers, []

    def get_indicator_details_by_section(self, indicator_type, indicator, section="general"):
        self.asked.append(indicator_type.name)
        answer = self.answers.get(indicator_type.name)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            raise NotFound()
        return answer


class OTXIndicatorsTest(unittest.TestCase):
    def test_subdomain_asks_hostname_too(self):
        otx = FakeOTX({"domain": DOMAIN, "hostname": HOSTNAME})
        details = otx_indicators.lookup(otx, "domain", "www.example.com")
        self.assertEqual(otx.asked, ["domain", "hostname"])
        found = otx_indicators.entities("domain", "www.example.com", details)
        self.assertEqual(found[0]["attrs"]["pulses"], 4)
        self.assertEqual(found[0]["confidence"], "high")
        self.assertEqual([e["attrs"]["id"] for e in found[1:]], ["p1", "p2"])
        self.assertEqual(found[1]["attrs"]["malware_families"], ["Emotet"])

    def test_registered_domain_asks_once(self):
        otx = FakeOTX({"domain": DOMAIN})
        otx_indicators.lookup(otx, "domain", "example.com")
        self.assertEqual(otx.asked, ["domain"])

    def test_ip(self):
        found = otx_indicators.entities("ip", "8.8.8.8", [IP])
        self.assertEqual([e["type"] for e in found], ["ip", "organization", "location"])
        self.assertEqual(found[0]["confidence"], "low")
        self.assertEqual(found[0]["attrs"]["validation"], ["Whitelisted IP"])
        self.assertEqual(found[2]["value"], "United States of America")

    def test_hash_type_by_length(self):
        self.assertEqual(otx_indicators.indicator_types("hash", "a" * 40), [IndicatorTypes.FILE_HASH_SHA1])
        with self.assertRaises(ValueError):
            otx_indicators.indicator_types("hash", "abc")

    def test_bad_hash_exits_2(self):
        with redirect_stderr(io.StringIO()):
            self.assertEqual(otx_indicators.main(["--hash", "abc"]), 2)

    def test_unknown_indicator_prints_nothing(self):
        out = io.StringIO()
        with mock.patch.object(otx_indicators, "OTXv2", return_value=FakeOTX({})), redirect_stdout(out), \
                redirect_stderr(io.StringIO()):
            self.assertEqual(otx_indicators.main(["--url", "https://example.com/x"]), 0)
        self.assertEqual(json.loads(out.getvalue()), {"entities": []})

    def test_works_without_key(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(otx_indicators, "OTXv2", return_value=FakeOTX({"IPv4": IP})) as make, \
                redirect_stdout(io.StringIO()):
            self.assertEqual(otx_indicators.main(["--ip", "8.8.8.8"]), 0)
        self.assertIsNone(make.call_args.args[0])

    def test_refused_key_exits_1(self):
        with mock.patch.object(otx_indicators, "OTXv2", return_value=FakeOTX({"IPv4": InvalidAPIKey()})), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(otx_indicators.main(["--ip", "8.8.8.8"]), 1)
        self.assertIn("OTX_API_KEY", err.getvalue())


if __name__ == "__main__":
    unittest.main()
