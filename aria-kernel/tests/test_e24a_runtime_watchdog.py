"""E24-a (ORPHAN-711) — production telemetry joins the watchdog sweep.

The watchdog's eyes stopped at ARIA's own ledgers: a production service
answering half its requests with 5xx, or critical security events piling
up in the observability counters, was invisible to the nightly. The pull
detectors read the observability-service /metrics feed through the SAME
sweep, emit through the SAME dedup'd emitter (İ1), and disclose every
failure mode (disabled / unconfigured / unreachable) in the payload.

Deliberate-breakage pins:
- thresholds gate the 5xx detector (low-volume noise stays out);
- a runtime anomaly carries no finding origin, and the retired
  ``aria-watchdog:runtime_anomaly`` origin is refused by the mint (RW-1).

RW-1 superseded this file's source/credential/skip pins (the shared
observability key, the null default URL, the ``skipped`` shape): the
loopback read-only source, the named holds, the windowed increase and the
credential-free policy are pinned in test_rw1_runtime_watchdog_feed.py. The
samples here are what the one puller reads: Prometheus instant-query
answers, each series' increase over the policy window.
"""
from __future__ import annotations

import dataclasses
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.aria_watchdog import (
    SourceHold,
    detect_http_5xx_share,
    detect_security_critical_events,
    parse_instant_vector,
    run_watchdog_sweep,
)
from aria_kernel.finding import ORIGINATING_SKILL_ALLOWLIST, _validate_originating_skill
from aria_kernel.genesis_policy import POLICY_KEYS, WATCHDOG_PULL_DEFAULTS
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

def _answer(*series: tuple[dict[str, str], str]) -> bytes:
    """A Prometheus instant-query answer (the windowed increase per series)."""
    result = [{"metric": metric, "value": [1761240000.0, value]} for metric, value in series]
    return json.dumps({"status": "success", "data": {"resultType": "vector", "result": result}}).encode("utf-8")


_HTTP_ANSWER = _answer(
    ({"app": "farm-service", "status_code": "200"}, "90"),
    ({"app": "farm-service", "status_code": "500"}, "10"),
    ({"app": "tiny-service", "status_code": "200"}, "3"),
    ({"app": "tiny-service", "status_code": "500"}, "2"),
)
_SECURITY_ANSWER = _answer(
    ({"app": "observability-service", "severity": "critical", "type": "auth_bypass_attempt"}, "4"),
    ({"app": "observability-service", "severity": "low", "type": "rate_limited"}, "120"),
)
_WINDOW = WATCHDOG_PULL_DEFAULTS["window_seconds"]


def _samples() -> list:
    http = parse_instant_vector("http_requests_total", _HTTP_ANSWER)
    security = parse_instant_vector("security_events_total", _SECURITY_ANSWER)
    assert isinstance(http, list) and isinstance(security, list)
    return http + security


class ParserTests(unittest.TestCase):
    def test_reads_each_series_labels_and_value_under_its_family(self) -> None:
        samples = parse_instant_vector("security_events_total", _answer(
            ({"app": "observability-service", "severity": "critical", "type": 'a,b="c"'}, "4"),
        ))
        self.assertEqual(
            samples,
            [("security_events_total", {"app": "observability-service", "severity": "critical", "type": 'a,b="c"'}, 4.0)],
        )

    def test_an_answer_that_is_not_an_instant_vector_is_refused_whole(self) -> None:
        for label, body in (
            ("not json", b"<html></html>"),
            ("error status", b'{"status":"error","error":"bad_data"}'),
            ("matrix", b'{"status":"success","data":{"resultType":"matrix","result":[]}}'),
            ("value not a string", _answer().replace(b"[]", b'[{"metric":{},"value":[1,4]}]')),
            ("value not a number", _answer(({"app": "x"}, "four"))),
            ("value not finite", _answer(({"app": "x"}, "NaN"))),
        ):
            with self.subTest(answer=label):
                hold = parse_instant_vector("http_requests_total", body)
                self.assertIsInstance(hold, SourceHold)
                self.assertEqual(hold.name, "source_refused")


class DetectorTests(unittest.TestCase):
    def test_5xx_share_fires_only_above_threshold_and_volume(self) -> None:
        findings = detect_http_5xx_share(_samples(), threshold=0.05, min_requests=50, window_seconds=_WINDOW)
        self.assertEqual(len(findings), 1)
        finding = findings[0]
        self.assertEqual(finding.pattern, "runtime_http_5xx")
        self.assertIn("farm-service", finding.claim_summary)
        # RW-1 corrective R1: a runtime anomaly is a telemetry lead with no
        # finding origin — it never reaches emit_finding.
        self.assertNotIn("originating_skill", {f.name for f in dataclasses.fields(finding)})
        # tiny-service is 40% 5xx but at 5 requests — below min volume.
        self.assertFalse(any("tiny-service" in f.claim_summary for f in findings))

    def test_security_critical_fires_and_low_severity_does_not(self) -> None:
        findings = detect_security_critical_events(_samples(), window_seconds=_WINDOW)
        self.assertEqual(len(findings), 1)
        self.assertIn("auth_bypass_attempt", findings[0].claim_summary)

    def test_the_retired_runtime_origin_is_refused_by_the_mint(self) -> None:
        """RW-1 corrective R1: telemetry is a lead (runtime_signal_bridge), and a
        finding about it is minted by the repo-evidence path with its
        reproduction. An allowlisted watchdog runtime origin with no producer
        would let any emit_finding caller mint a watchdog-owned runtime
        finding past that proof gate."""
        self.assertNotIn("aria-watchdog:runtime_anomaly", ORIGINATING_SKILL_ALLOWLIST)
        with self.assertRaises(GovernanceError):
            _validate_originating_skill("aria-watchdog:runtime_anomaly")


class SweepWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-e24-")
        self.repo = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        # RW-1 corrective R7: no runtime source unless a test names one. The
        # tracked default is the host's loopback Prometheus.
        override = self.repo / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True)
        override.write_text(json.dumps({"watchdog_pull": {"observability_base_url": None}}), encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _sweep(self) -> dict:
        return run_watchdog_sweep(
            workspace_root=self.repo, tools_dir=self.tools, suppress_emission=True,
        )

    def test_reachable_feed_contributes_candidates(self) -> None:
        with patch(
            "aria_kernel.genesis_policy.watchdog_pull_policy",
            return_value={**WATCHDOG_PULL_DEFAULTS, "observability_base_url": "http://127.0.0.1:9090"},
        ), patch(
            "aria_kernel.aria_watchdog.pull_observability_metrics",
            return_value=(_samples(), None),
        ):
            payload = self._sweep()
        self.assertEqual(payload["runtime"]["candidates"], 2)
        self.assertGreaterEqual(payload["candidates"], 2)


class PolicyPins(unittest.TestCase):
    def test_block_is_a_policy_key(self) -> None:
        self.assertIn("watchdog_pull", POLICY_KEYS)


if __name__ == "__main__":
    unittest.main()
