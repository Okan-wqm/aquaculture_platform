"""E12-c (ORPHAN-677) — the watchdog joins the nightly body; the
"avoid this" half of learned knowledge reaches the judge.

M13: both detectors existed behind a daemon loop nothing ran in
production — reflexes with no spinal cord. M15: `record_anti_pattern` +
`lookup_pattern` had zero callers — an operator-signed avoid-rule would
never be read back at judgment time (and kernel auto-write is FORBIDDEN
by arb HIGH-008, so the producer had to be a human-gated CLI verb, not
a consensus hook).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import ensure_tools_dir, utc_now


class WatchdogSweepTests(unittest.TestCase):
    def test_one_sweep_runs_and_reports_counts(self) -> None:
        from aria_kernel.aria_watchdog import run_watchdog_sweep

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            result = run_watchdog_sweep(
                workspace_root=Path(tmp), tools_dir=root
            )
        self.assertEqual(result["candidates"], 0)
        self.assertEqual(result["emitted"], 0)

    def test_cycle_phase_is_registered(self) -> None:
        # Deliberate-break for the original defect: no cycle phase ran
        # the detectors. The roster entry IS the spinal cord.
        from aria_kernel.cycle import CYCLE_PHASES

        names = [phase.name for phase in CYCLE_PHASES]
        self.assertIn("watchdog_sweep", names)
        phase = next(p for p in CYCLE_PHASES if p.name == "watchdog_sweep")
        self.assertEqual(phase.on_error, "record_and_continue")


class AntiPatternTests(unittest.TestCase):
    def setUp(self) -> None:
        # ARIA-AUDIT-015: anti-pattern signatures are resolvable operator
        # references; fixtures provision the acknowledgment variable the
        # ack-env grammar resolves.
        import os as _os

        _os.environ.setdefault("ARIA_TEST_KG_SIGNATURE", "operator-test-signature")

    def _mint(self, workspace: Path, pattern_id: str, ref: str) -> None:
        from aria_kernel.knowledge_graph import Pattern, record_anti_pattern

        record_anti_pattern(
            Pattern(
                pattern_id=pattern_id,
                pattern_type="anti_pattern",
                confidence=1.0,
                evidence_refs=(ref,),
                discovered_by_cycle_id="cycle-677",
                observed_at=utc_now(),
            ),
            workspace_root=workspace,
            reason_class="architecture_class",
            operator_signature="ack-env:ARIA_TEST_KG_SIGNATURE",
        )

    def test_signed_mint_reaches_the_reader_and_the_envelope(self) -> None:
        from aria_kernel.knowledge_graph import anti_patterns_for_paths

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            ensure_tools_dir(workspace / "aria-tools")
            self._mint(workspace, "anti_2026_08_14_001", "apps/farm-service/src/batch/x.ts")
            rows = anti_patterns_for_paths(
                workspace_root=workspace,
                paths=["apps/farm-service/src/batch/x.ts:12"],
            )
        self.assertEqual([r["pattern_id"] for r in rows], ["anti_2026_08_14_001"])

    def test_unrelated_paths_see_nothing(self) -> None:
        from aria_kernel.knowledge_graph import anti_patterns_for_paths

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            ensure_tools_dir(workspace / "aria-tools")
            self._mint(workspace, "anti_x", "apps/farm-service/src/batch/x.ts")
            rows = anti_patterns_for_paths(
                workspace_root=workspace,
                paths=["apps/auth-service/src/login.ts"],
            )
        self.assertEqual(rows, [])

    def test_renderer_labels_the_rule_avoid_not_verdict(self) -> None:
        from aria_kernel.agent_invocations import _render_established_knowledge

        text = _render_established_knowledge(
            {
                "beliefs": [],
                "conventions": [],
                "anti_patterns": [
                    {
                        "pattern_id": "anti_x",
                        "reason_class": "architecture_class",
                        "evidence_refs": ["apps/farm-service/src/x.ts"],
                    }
                ],
            }
        )
        self.assertIn("AVOID `anti_x`", text)
        self.assertIn("not evidence", text)

    def test_unsigned_mint_stays_forbidden(self) -> None:
        # The arb HIGH-008 rule survives this change: no signature, no row.
        from aria_kernel.knowledge_graph import (
            KnowledgeGraphSignatureMissing,
            Pattern,
            record_anti_pattern,
        )

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            ensure_tools_dir(workspace / "aria-tools")
            with self.assertRaises(KnowledgeGraphSignatureMissing):
                record_anti_pattern(
                    Pattern(
                        pattern_id="anti_forged",
                        pattern_type="anti_pattern",
                        confidence=1.0,
                        evidence_refs=("apps/x.ts",),
                        discovered_by_cycle_id="c",
                        observed_at=utc_now(),
                    ),
                    workspace_root=workspace,
                    reason_class="architecture_class",
                    operator_signature="",
                )


if __name__ == "__main__":
    unittest.main()
