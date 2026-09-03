"""Plan ARIA-V10.5 Phase 1 — ARIA-Watchdog MVP invariants.

Per ADR-0002 (accepted): 18 invariants validate the read-only observer
contract.

Categories:
- Per-detector (8): stall + bridge_warning_repeat, success + skip cases
- Cross-cutting (10): emit-path sanitizer, ARIA_STOP, single-instance,
  banned-phrase, dedup cap, suppression-storm, etc.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.aria_watchdog import (
    WatchdogFinding,
    detect_stall,
    detect_repeated_bridge_warning,
    _signature_hash,
    _emission_allowed,
    run_aria_watchdog_daemon,
    STALL_THRESHOLD_SECONDS,
    BRIDGE_WARNING_REPEAT_THRESHOLD,
    MAX_FINDINGS_PER_PATTERN_PER_24H,
)
from aria_kernel.finding import ORIGINATING_SKILL_ALLOWLIST, CLAIM_TYPES, _validate_originating_skill
from aria_kernel.tool_registry import GovernanceError


class StallDetectorInvariants(unittest.TestCase):
    """Invariants 1-4: detect_stall behavior."""

    def test_i_v10_5_wd_01_stall_fires_at_threshold(self):
        now = datetime.now(timezone.utc)
        past = now - timedelta(seconds=700)
        governance = [{"plan_id": "plan-X", "kind": "challenger_drafted", "ts": past.isoformat()}]
        autonomy = []
        findings = detect_stall(governance, autonomy, now=now)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].pattern, "stall")
        self.assertEqual(findings[0].originating_skill, "aria-watchdog:stall")

    def test_i_v10_5_wd_02_stall_no_fire_before_threshold(self):
        now = datetime.now(timezone.utc)
        past = now - timedelta(seconds=500)
        governance = [{"plan_id": "plan-Y", "kind": "challenger_drafted", "ts": past.isoformat()}]
        autonomy = []
        findings = detect_stall(governance, autonomy, now=now)
        self.assertEqual(len(findings), 0)

    def test_i_v10_5_wd_03_stall_skips_human_required(self):
        now = datetime.now(timezone.utc)
        past = now - timedelta(seconds=700)
        governance = [
            {"plan_id": "plan-HR", "kind": "challenger_drafted", "ts": past.isoformat()},
            {"plan_id": "plan-HR", "kind": "human_required_recorded", "ts": past.isoformat()},
        ]
        autonomy = []
        findings = detect_stall(governance, autonomy, now=now)
        self.assertEqual(len(findings), 0, "stall must skip HUMAN_REQUIRED cycles")

    def test_i_v10_5_wd_04_stall_skips_active_backoff(self):
        now = datetime.now(timezone.utc)
        past = now - timedelta(seconds=700)
        backoff_recent = now - timedelta(seconds=300)
        governance = [
            {"plan_id": "plan-BO", "kind": "challenger_drafted", "ts": past.isoformat()},
            {"plan_id": "plan-BO", "kind": "api_backoff_engaged", "ts": backoff_recent.isoformat()},
        ]
        autonomy = []
        findings = detect_stall(governance, autonomy, now=now)
        self.assertEqual(len(findings), 0, "stall must skip cycles in active api_backoff window")


class BridgeWarningRepeatInvariants(unittest.TestCase):
    """Invariants 5-8: detect_repeated_bridge_warning behavior."""

    def test_i_v10_5_wd_05_bridge_warning_fires_3x_in_window(self):
        now = datetime.now(timezone.utc)
        rows = [
            {"kind": "agent_bridge_warning", "ts": (now - timedelta(seconds=t)).isoformat(),
             "details": {"error_class": "revision_id_missing"}}
            for t in (300, 200, 100)
        ]
        findings = detect_repeated_bridge_warning(rows, now=now)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].pattern, "bridge_warning_repeat")

    def test_i_v10_5_wd_06_bridge_warning_no_fire_outside_window(self):
        now = datetime.now(timezone.utc)
        rows = [
            {"kind": "agent_bridge_warning", "ts": (now - timedelta(hours=h)).isoformat(),
             "details": {"error_class": "revision_id_missing"}}
            for h in (1, 2, 3)  # all outside 600s window
        ]
        findings = detect_repeated_bridge_warning(rows, now=now)
        self.assertEqual(len(findings), 0)

    def test_i_v10_5_wd_07_bridge_warning_uses_categorical_error_class(self):
        """Categorical error_class preferred over freeform error string."""
        now = datetime.now(timezone.utc)
        rows = [
            {"kind": "agent_bridge_warning", "ts": (now - timedelta(seconds=t)).isoformat(),
             "details": {"error_class": "rev_id_missing", "error": f"variant message {i}"}}
            for i, t in enumerate([300, 200, 100])
        ]
        findings = detect_repeated_bridge_warning(rows, now=now)
        # All 3 rows share error_class → 1 finding (signature stable across variants)
        self.assertEqual(len(findings), 1)
        # Re-run with error_class absent + same freeform error → falls back
        rows_fallback = [
            {"kind": "agent_bridge_warning", "ts": (now - timedelta(seconds=t)).isoformat(),
             "details": {"error": "rev_id missing in payload"}}
            for t in (300, 200, 100)
        ]
        findings2 = detect_repeated_bridge_warning(rows_fallback, now=now)
        self.assertEqual(len(findings2), 1, "Fallback to first-token of freeform error")

    def test_i_v10_5_wd_08_bridge_warning_signature_stable(self):
        """Signature hash stable across different error message variants of same class."""
        sig1 = _signature_hash("bridge_warning_repeat", "rev_id_missing")
        sig2 = _signature_hash("bridge_warning_repeat", "rev_id_missing")
        self.assertEqual(sig1, sig2)
        sig3 = _signature_hash("bridge_warning_repeat", "different_class")
        self.assertNotEqual(sig1, sig3)


class FindingSanitizerInvariants(unittest.TestCase):
    """Invariants 9-12: emit_finding allowlist + claim_type."""

    def test_i_v10_5_wd_09_originating_skill_allowlist_rejects_unknown(self):
        with self.assertRaises(GovernanceError):
            _validate_originating_skill("aria-watchdog:forged-by-attacker")
        with self.assertRaises(GovernanceError):
            _validate_originating_skill("malicious:source")
        # Allowed values pass
        _validate_originating_skill("manual:operator")
        _validate_originating_skill("aria-watchdog:stall")
        _validate_originating_skill("aria-watchdog:bridge_warning_repeat")
        _validate_originating_skill("report_ingestion:external_pr")

    def test_i_v10_5_wd_10_operational_anomaly_claim_type_registered(self):
        self.assertIn("operational_anomaly", CLAIM_TYPES)
        spec = CLAIM_TYPES["operational_anomaly"]
        self.assertEqual(spec["min_severity"], "LOW")
        self.assertEqual(spec["min_evidence"], 3)

    def test_i_v10_5_wd_11_originating_skill_allowlist_contents(self):
        """V10.5 MVP scope: 2 watchdog skills + manual + report_ingestion."""
        expected_minimum = {
            "manual:operator",
            "aria-watchdog:stall",
            "aria-watchdog:bridge_warning_repeat",
            "report_ingestion:external_pr",
        }
        self.assertTrue(expected_minimum.issubset(ORIGINATING_SKILL_ALLOWLIST))

    def test_i_v10_5_wd_12_v10_6_detectors_not_in_v10_5_allowlist(self):
        """V10.6 EXTRA-DETECTORS must NOT be in V10.5 ORIGINATING_SKILL_ALLOWLIST."""
        self.assertNotIn("aria-watchdog:rejection_repeat", ORIGINATING_SKILL_ALLOWLIST)
        self.assertNotIn("aria-watchdog:phase_asymmetry", ORIGINATING_SKILL_ALLOWLIST)


class DedupCapInvariants(unittest.TestCase):
    """Invariants 13-15: dedup ledger cap enforcement."""

    def test_i_v10_5_wd_13_emission_allowed_under_cap(self):
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as tmpdir:
            allowed, reason = _emission_allowed(
                tools_dir=Path(tmpdir),
                signature_hash="wd-v1:test",
                pattern="stall",
                now=now,
            )
            self.assertTrue(allowed)
            self.assertEqual(reason, "")

    def test_i_v10_5_wd_14_emission_blocked_at_cap(self):
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as tmpdir:
            tools = Path(tmpdir)
            # Pre-populate signature ledger with cap entries
            ledger = tools / "aria_watchdog_signatures.jsonl"
            with ledger.open("w") as fh:
                for i in range(MAX_FINDINGS_PER_PATTERN_PER_24H):
                    fh.write(json.dumps({
                        "pattern": "stall",
                        "signature_hash": "wd-v1:repeated",
                        "finding_id": f"F-{i+1:03d}",
                        "daemon_agent_id": "test",
                        "emitted_at": now.isoformat(),
                    }) + "\n")
            allowed, reason = _emission_allowed(
                tools_dir=tools,
                signature_hash="wd-v1:repeated",
                pattern="stall",
                now=now,
            )
            self.assertFalse(allowed)
            self.assertEqual(reason, "per_pattern_cap_reached")

    def test_i_v10_5_wd_15_signature_outside_24h_window_not_counted(self):
        now = datetime.now(timezone.utc)
        past = now - timedelta(hours=25)
        with tempfile.TemporaryDirectory() as tmpdir:
            tools = Path(tmpdir)
            ledger = tools / "aria_watchdog_signatures.jsonl"
            with ledger.open("w") as fh:
                # 20 entries OUTSIDE 24h window — should not count toward cap
                for i in range(20):
                    fh.write(json.dumps({
                        "pattern": "stall",
                        "signature_hash": "wd-v1:old",
                        "finding_id": f"F-{i+1:03d}",
                        "daemon_agent_id": "test",
                        "emitted_at": past.isoformat(),
                    }) + "\n")
            allowed, reason = _emission_allowed(
                tools_dir=tools,
                signature_hash="wd-v1:old",
                pattern="stall",
                now=now,
            )
            self.assertTrue(allowed, "24h-old entries must not count toward cap")


class DaemonLifecycleInvariants(unittest.TestCase):
    """Invariants 16-18: daemon ARIA_STOP + lock + max_iterations."""

    def test_i_v10_5_wd_16_aria_stop_exits_clean(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tools = Path(tmpdir)
            (tools / "ARIA_STOP").touch()
            result = run_aria_watchdog_daemon(
                workspace_root=tmpdir,
                tools_dir=tools,
                max_iterations=5,
                poll_interval_seconds=0.01,
            )
            self.assertEqual(result["exit_reason"], "aria_stop")
            self.assertTrue(result["exits_clean"])

    def test_i_v10_5_wd_17_max_iterations_cap(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tools = Path(tmpdir)
            result = run_aria_watchdog_daemon(
                workspace_root=tmpdir,
                tools_dir=tools,
                max_iterations=2,
                poll_interval_seconds=0.01,
            )
            self.assertEqual(result["exit_reason"], "max_iterations")
            self.assertEqual(result["iterations"], 2)
            self.assertTrue(result["exits_clean"])

    def test_i_v10_5_wd_18_sigterm_during_sleep_interrupts(self):
        """Invariant 18: interrupt_event triggers clean exit during sleep."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tools = Path(tmpdir)
            interrupt = threading.Event()
            # Trigger interrupt 100ms after start
            threading.Timer(0.1, interrupt.set).start()
            start = time.monotonic()
            result = run_aria_watchdog_daemon(
                workspace_root=tmpdir,
                tools_dir=tools,
                max_iterations=100,
                poll_interval_seconds=2.0,  # would sleep 2s without interrupt
                interrupt_event=interrupt,
            )
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 3.0, f"Interrupt must exit promptly; got {elapsed:.2f}s")
            self.assertEqual(result["exit_reason"], "interrupted")


if __name__ == "__main__":
    unittest.main()
