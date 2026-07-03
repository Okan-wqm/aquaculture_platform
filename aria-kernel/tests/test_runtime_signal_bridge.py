"""Plan 029 §D5 — runtime-signal bridge.

A runtime signal (Sentry/incident/telemetry) enters as an explicitly UNVERIFIED
lead, never as repo evidence, and run_pressure turns each open signal into
pressure that points ARIA at the referenced area — without corrupting the
evidence-trust foundation.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.pressure import run_pressure
from aria_kernel.runtime_signal_bridge import (
    RUNTIME_TRUST_GRADE,
    ingest_runtime_signal,
    load_open_runtime_signals,
    resolve_runtime_signal,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class RuntimeSignalBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _ingest(self) -> dict:
        return ingest_runtime_signal(
            source="sentry", service="farm-service",
            summary="NPE in batch harvest on null pond",
            code_refs=["apps/farm-service/src/harvest/harvest.service.ts:88"],
            severity="high", base_dir=self.tools,
        )

    def test_ingest_marks_unverified_lead(self) -> None:
        rec = self._ingest()
        self.assertEqual(rec["trust_grade"], RUNTIME_TRUST_GRADE)
        self.assertEqual(rec["status"], "open")
        self.assertEqual(rec["source"], "sentry")

    def test_ingest_is_idempotent(self) -> None:
        a = self._ingest()
        b = self._ingest()
        self.assertEqual(a["signal_id"], b["signal_id"])
        self.assertEqual(len(load_open_runtime_signals(base_dir=self.tools)), 1)

    def test_bad_source_and_empty_refs_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            ingest_runtime_signal(source="twitter", service="x", summary="y",
                                  code_refs=["a:1"], base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            ingest_runtime_signal(source="sentry", service="x", summary="y",
                                  code_refs=[], base_dir=self.tools)

    def test_open_signal_becomes_unverified_pressure(self) -> None:
        rec = self._ingest()
        pressure = run_pressure(cycle_id="c1", base_dir=self.tools)
        runtime_pressures = [p for p in pressure["pressures"] if p["source"] == "runtime_signal"]
        self.assertEqual(len(runtime_pressures), 1)
        p = runtime_pressures[0]
        self.assertIn("apps/farm-service/src/harvest/harvest.service.ts:88", p["evidence"])
        self.assertIn("UNVERIFIED", p["recommended_action"])
        self.assertEqual(p["type"], "UNKNOWN")

    def test_resolved_signal_stops_pressure(self) -> None:
        rec = self._ingest()
        resolve_runtime_signal(signal_id=rec["signal_id"], resolution_note="fixed in PR-42",
                               base_dir=self.tools)
        self.assertEqual(load_open_runtime_signals(base_dir=self.tools), [])
        pressure = run_pressure(cycle_id="c1", base_dir=self.tools)
        self.assertEqual([p for p in pressure["pressures"] if p["source"] == "runtime_signal"], [])


if __name__ == "__main__":
    unittest.main()
