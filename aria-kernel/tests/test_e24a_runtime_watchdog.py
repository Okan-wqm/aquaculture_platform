"""E24-a (ORPHAN-711) — production telemetry joins the watchdog sweep.

The watchdog's eyes stopped at ARIA's own ledgers: a production service
answering half its requests with 5xx, or critical security events piling
up in the observability counters, was invisible to the nightly. The pull
detectors read the observability-service /metrics feed through the SAME
sweep, emit through the SAME dedup'd emitter (İ1), and disclose every
failure mode (disabled / unconfigured / unreachable) in the payload.

Deliberate-breakage pins:
- the API key never enters policy or ledgers (only its env-var NAME);
- an unreachable endpoint is a disclosed skip, never a dead night;
- thresholds gate the 5xx detector (low-volume noise stays out);
- the new originating skill is allowlisted with its producer.
"""
from __future__ import annotations

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
from aria_kernel.finding import ORIGINATING_SKILL_ALLOWLIST
from aria_kernel.genesis_policy import (
    POLICY_KEYS,
    WATCHDOG_PULL_DEFAULTS,
    watchdog_pull_policy,
)
from aria_kernel.tool_registry import ensure_tools_dir

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
        self.assertEqual(finding.originating_skill, "aria-watchdog:runtime_anomaly")
        # tiny-service is 40% 5xx but at 5 requests — below min volume.
        self.assertFalse(any("tiny-service" in f.claim_summary for f in findings))

    def test_security_critical_fires_and_low_severity_does_not(self) -> None:
        samples = parse_prometheus_text(_METRICS_FIXTURE)
        findings = detect_security_critical_events(samples)
        self.assertEqual(len(findings), 1)
        self.assertIn("auth_bypass_attempt", findings[0].claim_summary)

    def test_originating_skill_is_allowlisted_with_its_producer(self) -> None:
        self.assertIn("aria-watchdog:runtime_anomaly", ORIGINATING_SKILL_ALLOWLIST)


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

    def test_unconfigured_source_is_a_disclosed_skip(self) -> None:
        payload = self._sweep()
        self.assertEqual(payload["runtime"], {"skipped": "source_unconfigured"})

    def test_unreachable_source_is_a_disclosed_skip_not_a_dead_night(self) -> None:
        with patch(
            "aria_kernel.genesis_policy.watchdog_pull_policy",
            return_value={**WATCHDOG_PULL_DEFAULTS, "observability_base_url": "http://127.0.0.1:1"},
        ):
            payload = self._sweep()
        self.assertEqual(payload["runtime"]["skipped"], "source_unreachable")
        self.assertIn("error", payload["runtime"])

    def test_reachable_feed_contributes_candidates(self) -> None:
        with patch(
            "aria_kernel.genesis_policy.watchdog_pull_policy",
            return_value={**WATCHDOG_PULL_DEFAULTS, "observability_base_url": "http://example.invalid"},
        ), patch(
            "aria_kernel.aria_watchdog.pull_observability_metrics",
            return_value=(_METRICS_FIXTURE, None),
        ):
            payload = self._sweep()
        self.assertEqual(payload["runtime"]["candidates"], 2)
        self.assertGreaterEqual(payload["candidates"], 2)


class PolicyPins(unittest.TestCase):
    def test_block_is_mergeable_and_key_never_lives_in_policy(self) -> None:
        self.assertIn("watchdog_pull", POLICY_KEYS)
        block = watchdog_pull_policy()
        self.assertIsNone(block["observability_base_url"])
        self.assertEqual(block["api_key_env"], "ARIA_OBSERVABILITY_API_KEY")
        # Only the env-var NAME is configuration — no field may carry a
        # secret value.
        self.assertFalse(any("key" in k and "env" not in k for k in block))


if __name__ == "__main__":
    unittest.main()
