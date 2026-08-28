"""X3 (ORPHAN-700) — phase payloads become persistent, visible fact.

  * a phase that RAN leaves a digest even when every count is zero
  * a phase that never ran leaves NO digest — zero-vs-absent, recorded
  * v1 rows (no digests) stay serveable to every reader
  * the report says "ran EMPTY" instead of silence
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.observability import record_cycle_metrics
from aria_kernel.tool_registry import ensure_tools_dir


class MetricsV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-x3-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _rows(self):
        path = self.tools / "observability" / "cycle-metrics.jsonl"
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def test_digests_promote_row_to_v2(self) -> None:
        record_cycle_metrics(
            cycle_id="cyc-x3-1",
            phase_durations_ms={"cycle": 1000},
            artifact_count=1, status="ok",
            phase_digests={"experiment_night": {"planned_problem": 0, "reproduced": 0}},
            base_dir=self.tools,
        )
        row = self._rows()[-1]
        self.assertEqual(row["schema_version"], 2)
        self.assertEqual(row["phase_digests"]["experiment_night"]["planned_problem"], 0)

    def test_no_digests_stays_v1(self) -> None:
        record_cycle_metrics(
            cycle_id="cyc-x3-2",
            phase_durations_ms={"cycle": 1000},
            artifact_count=1, status="ok",
            base_dir=self.tools,
        )
        row = self._rows()[-1]
        self.assertEqual(row["schema_version"], 1)
        self.assertNotIn("phase_digests", row)

    def test_v1_rows_stay_serveable_to_readers(self) -> None:
        from aria_kernel.observability import generate_observability_dashboard

        record_cycle_metrics(
            cycle_id="cyc-x3-3",
            phase_durations_ms={"cycle": 500},
            artifact_count=1, status="ok",
            base_dir=self.tools,
        )
        dashboard = generate_observability_dashboard(cycle_id="cyc-x3-3", base_dir=self.tools)
        self.assertIsInstance(dashboard, dict)


class DigestExtractionTests(unittest.TestCase):
    def test_ran_empty_yields_zero_digest_never_none(self) -> None:
        from aria_kernel.cycle import _phase_digest_of

        digest = _phase_digest_of(
            {"planned_problem": [], "reproduced": [], "errors": []},
            ("planned_problem", "reproduced", "errors"),
        )
        self.assertEqual(digest, {"planned_problem": 0, "reproduced": 0, "errors": 0})

    def test_never_ran_yields_none(self) -> None:
        from aria_kernel.cycle import _phase_digest_of

        self.assertIsNone(_phase_digest_of(None, ("planned_problem",)))
        self.assertIsNone(_phase_digest_of("phase crashed", ("planned_problem",)))


class ReportSectionTests(unittest.TestCase):
    def test_ran_empty_is_loud(self) -> None:
        from aria_kernel.reflection import _render_experiment_night_section

        lines = _render_experiment_night_section({
            "phase_digest_summary": {
                "digests": {"experiment_night": {
                    "planned_problem": 0, "planned_regression": 0,
                    "unresolvable_bindings": 2, "errors": 0,
                }},
            },
        })
        text = "\n".join(lines)
        self.assertIn("ran EMPTY", text)
        self.assertIn("unresolvable bindings: 2", text)

    def test_no_digest_is_silent(self) -> None:
        from aria_kernel.reflection import (
            _render_experiment_night_section,
            _render_watchdog_section,
        )

        self.assertEqual(_render_experiment_night_section({}), [])
        self.assertEqual(_render_watchdog_section({}), [])

    def test_active_night_renders_counts(self) -> None:
        from aria_kernel.reflection import _render_experiment_night_section

        lines = _render_experiment_night_section({
            "phase_digest_summary": {
                "digests": {"experiment_night": {
                    "planned_problem": 2, "planned_regression": 1,
                    "reproduced": 1, "refuted": 1, "regressions": 0,
                    "still_fixed": 1, "skipped_problem": 0,
                    "skipped_regression": 0, "errors": 0,
                }},
            },
        })
        text = "\n".join(lines)
        self.assertIn("problem runs planned: 2", text)
        self.assertIn("reproduced: 1 | refuted: 1", text)


if __name__ == "__main__":
    unittest.main()
