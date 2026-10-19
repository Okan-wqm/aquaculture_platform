"""ARIA-LOW-586 — a reflection section absorbs only its reader's declared faults, and names them.

CONFIRMED at 62c9864ae: ten sites in reflection.py sat in ``except
Exception`` — ``_compute_dataflow_health`` (the cycles history and every
watched series), ``_render_observability_section`` (dashboards and the alert
history), and the learning-events, missions, quarantine, rule-health,
duel-ratings and own-PR-CI sections. A corrupt ledger and a defect in the
section's reader both read as a daily report WITHOUT that section; an
unreadable watched series even read as a SIGNAL STARVED alarm once the
history window was full (its values fell back to ``[]``, and ``all([])`` is
true).

These pins hold, per site, on a real store:
* a corrupt ledger (or a registry that is not JSON) renders
  ``- unreadable: <class>`` under the section's own heading;
* a ``TypeError`` from the reader is a kernel defect and raises;
* an unreadable watched series is named, never starved;
* reflection.py has no ``except Exception`` / ``except BaseException`` /
  bare ``except`` left (the AST pin below), so the class cannot come back.

LOW-514's ``_render_plan016_section`` pins live in
test_single_report_dashboard.py.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import reflection as refl
from aria_kernel.tool_registry import ensure_tools_dir

_CORRUPT = "not json\n"
_DASHBOARD = {
    "rolling_slo": {"slo_state": "ok", "window": 5, "duration_p50_ms": 1, "duration_p95_ms": 2},
    "alerts": [],
}


def _corrupt(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(_CORRUPT)


def _unreadable(heading: str, fault: str) -> list[str]:
    return [heading, "", f"- unreadable: {fault}", ""]


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.root = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()


class EachSectionNamesItsUnreadableLedger(_Store):
    """A corrupt ledger renders `- unreadable: <class>` under its heading."""

    def test_learning_events(self) -> None:
        _corrupt(self.root / "memory" / "learning-events.jsonl")
        self.assertEqual(refl._render_learning_events_section(self.root),
                         _unreadable("## Learning Events", "LedgerIntegrityError"))

    def test_missions(self) -> None:
        _corrupt(self.root / "missions" / "mission-events.jsonl")
        self.assertEqual(refl._render_mission_section(self.root), _unreadable("## Missions", "LedgerIntegrityError"))

    def test_quarantined_tools(self) -> None:
        from aria_kernel.tool_registry import registry_path

        registry_path(self.root).write_text("{not json", encoding="utf-8")
        self.assertEqual(refl._render_quarantine_section(self.root), _unreadable("## Quarantined Tools", "JSONDecodeError"))

    def test_rule_health(self) -> None:
        from aria_kernel.feedback_store import feedback_path

        _corrupt(feedback_path(self.root))
        self.assertEqual(refl._render_rule_health_section(self.root), _unreadable("## Rule Health", "LedgerIntegrityError"))

    def test_duel_ratings(self) -> None:
        _corrupt(self.root / "knowledge-graph" / "duel-ratings.jsonl")
        self.assertEqual(refl._render_duel_ratings_section(self.root), _unreadable("## Duel Ratings", "LedgerIntegrityError"))

    def test_own_pr_ci(self) -> None:
        from aria_kernel.own_pr_ci import bridge_path

        _corrupt(bridge_path(self.root))
        self.assertEqual(refl._render_own_pr_ci_section(self.root), _unreadable("## Own PR CI", "LedgerIntegrityError"))

    def test_observability_dashboards(self) -> None:
        _corrupt(self.root / "observability" / "dashboards.jsonl")
        self.assertEqual(refl._render_observability_section(self.root), _unreadable("## SLO / Alerts", "LedgerIntegrityError"))

    def test_observability_alert_history(self) -> None:
        from aria_kernel.observability import alerts_path

        _corrupt(alerts_path(self.root))
        with patch("aria_kernel.observability.list_observability_dashboards", return_value=[_DASHBOARD]):
            lines = refl._render_observability_section(self.root)
        self.assertIn("- Alert history: unreadable: LedgerIntegrityError", lines)
        self.assertIn("- SLO state: ok (window 5, p50 1ms, p95 2ms)", lines, "the readable half still renders")


class AReaderDefectRaises(_Store):
    """A TypeError is a kernel defect, not a ledger nobody could open."""

    READERS = (
        ("_render_learning_events_section", "aria_kernel.ledger.load_declared_jsonl"),
        ("_render_mission_section", "aria_kernel.ledger.load_declared_jsonl"),
        ("_render_quarantine_section", "aria_kernel.tool_registry.list_tools"),
        ("_render_rule_health_section", "aria_kernel.rule_health.rule_stats"),
        ("_render_duel_ratings_section", "aria_kernel.genesis_superiority.duel_observations"),
        ("_render_own_pr_ci_section", "aria_kernel.own_pr_ci.load_open_own_pr_reds"),
        ("_render_observability_section", "aria_kernel.observability.list_observability_dashboards"),
    )

    def test_every_section_reader_defect_propagates(self) -> None:
        # The mission section reads only an existing ledger; give it one.
        (self.root / "missions").mkdir(parents=True, exist_ok=True)
        (self.root / "missions" / "mission-events.jsonl").write_text("", encoding="utf-8")
        for section, reader in self.READERS:
            with self.subTest(section=section), patch(reader, side_effect=TypeError("defect")), \
                    self.assertRaises(TypeError):
                getattr(refl, section)(self.root)

    def test_an_alert_history_reader_defect_propagates(self) -> None:
        with patch("aria_kernel.observability.list_observability_dashboards", return_value=[_DASHBOARD]), \
                patch.object(refl, "load_jsonl_verified", side_effect=TypeError("defect")), \
                self.assertRaises(TypeError):
            refl._render_observability_section(self.root)


class TheDataflowSentinelNamesWhatItCouldNotRead(_Store):
    def _full_history(self) -> None:
        from aria_kernel.ledger import append_declared_jsonl

        for index in range(refl.SIGNAL_WINDOW_CYCLES):
            append_declared_jsonl(self.root / "cycles.jsonl", {"cycle_id": f"c{index}", "event": "completed",
                                                                "status": "completed"}, expected_surface="cycles")

    def test_an_unreadable_series_is_named_and_never_starved(self) -> None:
        self._full_history()
        with patch.object(refl, "_judged_judges_series", side_effect=OSError("disk")):
            health = refl._compute_dataflow_health(self.root)

        self.assertEqual(health["unreadable"], {"judged_judges": "OSError"})
        self.assertNotIn("judged_judges", health["starved"], "a series nobody could read is not a zero series")
        self.assertEqual(health["signals"]["judged_judges"]["unreadable"], "OSError")
        self.assertIn("labelled_tool_count", health["starved"], "the other series are still judged")
        rendered = refl._render_dataflow_health_section({"dataflow_health": health})
        self.assertIn("- unreadable: `judged_judges`: OSError", rendered)

    def test_an_unreadable_cycle_history_is_named_and_alarms_nothing(self) -> None:
        self._full_history()
        _corrupt(self.root / "cycles.jsonl")
        health = refl._compute_dataflow_health(self.root)

        self.assertEqual(health["unreadable"], {"cycles": "LedgerIntegrityError"})
        self.assertEqual(health["starved"], [])
        self.assertEqual(refl._render_dataflow_health_section({"dataflow_health": health}),
                         ["", "## Signal starvation", "", "- unreadable: `cycles`: LedgerIntegrityError"])

    def test_a_series_defect_raises(self) -> None:
        for series in ("_judged_judges_series", "_labelled_tool_series", "_synced_tool_series"):
            with self.subTest(series=series), patch.object(refl, series, side_effect=TypeError("defect")), \
                    self.assertRaises(TypeError):
                refl._compute_dataflow_health(self.root)

    def test_a_cycle_history_defect_raises(self) -> None:
        with patch("aria_kernel.ledger.load_declared_jsonl", side_effect=TypeError("defect")), self.assertRaises(TypeError):
            refl._compute_dataflow_health(self.root)

    def test_a_readable_store_names_nothing(self) -> None:
        self.assertEqual(refl._compute_dataflow_health(self.root)["unreadable"], {})


class NoBroadHandlerIsLeft(unittest.TestCase):
    def test_reflection_has_no_except_exception(self) -> None:
        """Make it detectable: the class this finding closes cannot be re-added."""
        source = Path(refl.__file__).read_text(encoding="utf-8")
        broad = {"Exception", "BaseException"}
        offenders = []
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, ast.ExceptHandler):
                continue
            names = node.type.elts if isinstance(node.type, ast.Tuple) else [node.type]
            if node.type is None or any(isinstance(name, ast.Name) and name.id in broad for name in names):
                offenders.append(node.lineno)
        self.assertEqual(offenders, [], "reflection.py: absorb a reader's declared *_reader_faults(), name it, raise the rest")


if __name__ == "__main__":
    unittest.main()
