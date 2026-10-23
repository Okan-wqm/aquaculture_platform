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
loopback read-only source, the named holds and the credential-free policy
are pinned in test_rw1_runtime_watchdog_feed.py.
"""
from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.aria_watchdog import (
    detect_http_5xx_share,
    detect_security_critical_events,
    parse_prometheus_text,
    run_watchdog_sweep,
)
from aria_kernel.finding import ORIGINATING_SKILL_ALLOWLIST, _validate_originating_skill
from aria_kernel.genesis_policy import POLICY_KEYS, WATCHDOG_PULL_DEFAULTS
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_METRICS_FIXTURE = """\
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api",status_code="200",service="farm-service"} 90
http_requests_total{method="GET",route="/api",status_code="500",service="farm-service"} 10
http_requests_total{method="GET",route="/x",status_code="200",service="tiny-service"} 3
http_requests_total{method="GET",route="/x",status_code="500",service="tiny-service"} 2
# TYPE security_events_total counter
security_events_total{severity="critical",type="auth_bypass_attempt"} 4
security_events_total{severity="low",type="rate_limited"} 120
"""


class ParserTests(unittest.TestCase):
    def test_parses_labeled_counters_and_skips_noise(self) -> None:
        samples = parse_prometheus_text(_METRICS_FIXTURE)
        self.assertIn(
            ("security_events_total", {"severity": "critical", "type": "auth_bypass_attempt"}, 4.0),
            samples,
        )
        self.assertTrue(all(len(s) == 3 for s in samples))


class DetectorTests(unittest.TestCase):
    def test_5xx_share_fires_only_above_threshold_and_volume(self) -> None:
        samples = parse_prometheus_text(_METRICS_FIXTURE)
        findings = detect_http_5xx_share(samples, threshold=0.05, min_requests=50)
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
        samples = parse_prometheus_text(_METRICS_FIXTURE)
        findings = detect_security_critical_events(samples)
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
            return_value=(_METRICS_FIXTURE, None),
        ):
            payload = self._sweep()
        self.assertEqual(payload["runtime"]["candidates"], 2)
        self.assertGreaterEqual(payload["candidates"], 2)


class PolicyPins(unittest.TestCase):
    def test_block_is_a_policy_key(self) -> None:
        self.assertIn("watchdog_pull", POLICY_KEYS)


if __name__ == "__main__":
    unittest.main()
