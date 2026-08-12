"""M9+M10/E8 — write-only ledgers get their first readers, honestly.

M9: memory/learning-events.jsonl had three writers (belief/convention
recording, goldset promotion, pr-tracking merge outcomes) and ZERO readers —
the never-forgetting system kept a journal nothing consumed. M10: the SLO
alert renderer read fields the producer never writes (alert_kind/message vs
the real reason/slo_state/observed), so every alert rendered as "None: ",
and observability/alerts.jsonl itself had no consumer at all.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.reflection import (
    _render_learning_events_section,
    _render_observability_section,
)
from aria_kernel.tool_registry import ensure_tools_dir


class LearningEventsSectionTests(unittest.TestCase):
    def test_journal_rows_render_by_type(self) -> None:
        # The REAL producer (private on purpose — its callers are the memory
        # recording paths); the test exercises the writer-reader pair.
        from aria_kernel.memory import _record_learning_event

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            for event_type in ("belief_recorded", "belief_recorded", "goldset_promoted"):
                _record_learning_event(
                    root,
                    cycle_id="cyc-m9",
                    event_type=event_type,
                    target_type="belief",
                    target_id="B-1",
                    repo_state_id=None,
                    base_commit_sha=None,
                    evidence_hashes=[],
                )
            lines = "\n".join(_render_learning_events_section(root))
        self.assertIn("## Learning Events", lines)
        self.assertIn("belief_recorded×2", lines)
        self.assertIn("goldset_promoted×1", lines)
        self.assertIn("Most recent: goldset_promoted", lines)

    def test_empty_journal_renders_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertEqual(_render_learning_events_section(root), [])


class AlertRenderTests(unittest.TestCase):
    def _dashboard_with_alert(self, root: Path) -> None:
        from aria_kernel.ledger import append_jsonl

        append_jsonl(
            root / "observability" / "dashboards.jsonl",
            {
                "cycle_id": "cyc-m10",
                "rolling_slo": {"slo_state": "warning", "window": 5},
                # The REAL alert shape _record_alerts writes.
                "alerts": [
                    {
                        "reason": "cycle_duration_slo",
                        "slo_state": "warning",
                        "observed": 700000,
                    }
                ],
            },
        )

    def test_alert_renders_its_real_fields_not_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._dashboard_with_alert(root)
            lines = "\n".join(_render_observability_section(root))
        # Deliberate-break: pre-M10 this rendered "None: " because the
        # renderer read alert_kind/message, fields no producer writes.
        self.assertIn("cycle_duration_slo", lines)
        self.assertIn("[warning]", lines)
        self.assertNotIn("None:", lines)

    def test_alert_history_reads_the_ledger(self) -> None:
        from aria_kernel.ledger import append_jsonl
        from aria_kernel.observability import alerts_path

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._dashboard_with_alert(root)
            for _ in range(3):
                append_jsonl(
                    alerts_path(root),
                    {"reason": "artifact_count_cliff", "slo_state": "degraded", "observed": 0},
                )
            lines = "\n".join(_render_observability_section(root))
        self.assertIn("Alert history (last 3 rows): artifact_count_cliff×3", lines)


if __name__ == "__main__":
    unittest.main()
