"""One published report, with the numbers that were written and never read.

Two defects, one surface (FAZ 6):

1. Two writers, one filename — the daily-report lane committed an anchor
   STUB read from the ephemeral checkout's empty aria-tools, while the real
   reflection report accumulated unread in the durable store. The published
   PR carried three empty lines; the operator-facing report was never
   published anywhere.
2. Ledgers with zero readers — plan_016 counters had no scheduled caller,
   observability's dashboards.jsonl was written every cycle and read by
   nothing, mission events reached no operator surface, quarantine state was
   CLI-only, and FAZ 1's replay recall landed in the cycle row and stopped
   there.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel.report import emit_anchor_to_path
from aria_kernel.tool_registry import ensure_tools_dir

_REPORT_BODY = "\n".join([
    "# ARIA Daily Report 2026-08-10",
    "",
    "## Gate Activity",
    "",
    "- Total governance events: 42",
    "",
])


class AnchorComposesTheReflectionReportTest(unittest.TestCase):
    def _emit(self, tmp: str, *, with_report: bool):
        workspace = Path(tmp)
        tools = workspace / "store" / "aria-tools"
        ensure_tools_dir(tools)
        if with_report:
            report_dir = tools / "reports" / "daily"
            report_dir.mkdir(parents=True, exist_ok=True)
            (report_dir / "2026-08-10.md").write_text(
                _REPORT_BODY, encoding="utf-8"
            )
        output = workspace / "publish" / "2026-08-10.md"
        result = emit_anchor_to_path(
            date="2026-08-10",
            workspace_root=workspace,
            tools_root=tools,
            output_path=output,
        )
        return result, output

    def test_the_published_artifact_is_the_report_not_a_stub(self) -> None:
        with TemporaryDirectory() as tmp:
            result, output = self._emit(tmp, with_report=True)
            text = output.read_text(encoding="utf-8")

        self.assertEqual(result["report_body"], "reflection")
        # Frontmatter still opens the file — I-26 parses only that.
        self.assertTrue(text.startswith("---\n"))
        self.assertIn("chain_tip_ledger_hash", text)
        # Content-pin: the operator-facing body IS the reflection report.
        self.assertIn("## Gate Activity", text)
        self.assertIn("Total governance events: 42", text)
        self.assertNotIn("# ARIA Daily Anchor", text)

    def test_without_a_store_report_the_stub_still_renders(self) -> None:
        with TemporaryDirectory() as tmp:
            result, output = self._emit(tmp, with_report=False)
            text = output.read_text(encoding="utf-8")

        self.assertEqual(result["report_body"], "stub")
        self.assertIn("# ARIA Daily Anchor 2026-08-10", text)

    def test_an_existing_anchor_is_left_unchanged(self) -> None:
        with TemporaryDirectory() as tmp:
            _, output = self._emit(tmp, with_report=True)
            before = output.read_text(encoding="utf-8")

            workspace = Path(tmp)
            result = emit_anchor_to_path(
                date="2026-08-10",
                workspace_root=workspace,
                tools_root=workspace / "store" / "aria-tools",
                output_path=output,
            )

            self.assertEqual(result["status"], "already_anchored")
            self.assertEqual(output.read_text(encoding="utf-8"), before)


class ReportSectionsTest(unittest.TestCase):
    def test_plan016_counters_get_their_first_scheduled_caller(self) -> None:
        from aria_kernel.reflection import _render_plan016_section

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            lines = _render_plan016_section(root)

        self.assertIn("## Plan-016 Counters", lines)

    def test_observability_ledger_gets_its_first_reader(self) -> None:
        from aria_kernel.reflection import _render_observability_section

        dashboard = {
            "rolling_slo": {
                "slo_state": "breached", "window": 5,
                "duration_p50_ms": 100, "duration_p95_ms": 900,
            },
            "alerts": [{"alert_kind": "cycle_duration", "message": "p95 over budget"}],
        }
        with TemporaryDirectory() as tmp, \
             patch("aria_kernel.observability.list_observability_dashboards",
                   return_value=[dashboard]):
            lines = "\n".join(_render_observability_section(Path(tmp)))

        self.assertIn("SLO state: breached", lines)
        self.assertIn("cycle_duration: p95 over budget", lines)

    def test_missions_reach_the_operator_surface(self) -> None:
        from aria_kernel.mission import open_mission
        from aria_kernel.reflection import _render_mission_section

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            open_mission(
                source_kind="orphan_finding",
                source_id="ORPHAN-HIGH-618",
                repo_hash="deadbeef",
                title="environment contract",
                priority=2,
                base_dir=root,
            )
            lines = "\n".join(_render_mission_section(root))

        self.assertIn("## Missions", lines)
        self.assertIn("environment contract", lines)
        self.assertIn("[opened]", lines)

    def test_quarantine_state_reaches_the_report(self) -> None:
        from aria_kernel.reflection import _render_quarantine_section

        with TemporaryDirectory() as tmp, \
             patch("aria_kernel.tool_registry.list_tools",
                   return_value=[{"tool_id": "adapter-a",
                                  "quarantine_reason": "chain gap"}]):
            lines = "\n".join(_render_quarantine_section(Path(tmp)))

        self.assertIn("## Quarantined Tools", lines)
        self.assertIn("adapter-a: chain gap", lines)

    def test_replay_recall_surfaces_from_the_sealed_cycle_row(self) -> None:
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.reflection import _render_replay_recall_section

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            append_declared_jsonl(
                root / "cycles.jsonl",
                {
                    "cycle_id": "cyc-replay", "status": "completed",
                    "judge_replay": {"tools": [{
                        "tool_id": "adapter-a", "status": "replayed",
                        "recall": {"judged_judges": 4, "recall": 0.75},
                    }]},
                },
                expected_surface="cycles",
            )
            lines = "\n".join(_render_replay_recall_section(root))

        self.assertIn("## Judge Replay Recall", lines)
        self.assertIn("judged 4, recall 0.75", lines)

    def test_sections_are_silent_on_an_empty_store(self) -> None:
        # Silent, not broken: a brand-new store must not render scaffolding
        # that claims knowledge it does not have.
        from aria_kernel import reflection as refl

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            self.assertEqual(refl._render_observability_section(root), [])
            self.assertEqual(refl._render_mission_section(root), [])
            self.assertEqual(refl._render_quarantine_section(root), [])
            self.assertEqual(refl._render_replay_recall_section(root), [])


class LaneContractPinTest(unittest.TestCase):
    def test_generate_report_binds_the_store_first(self) -> None:
        from aria_kernel.workflow_contract_registry import (
            _RESTORE_STEP,
            workflow_job_contract,
        )

        contract = workflow_job_contract("aria-daily-report", "generate-report")

        self.assertEqual(contract.first_governed_mutation_step, _RESTORE_STEP)
        self.assertIn("github_git", contract.network_policy)
        self.assertTrue(
            any(".aria-state-store" in p.replace("\\", "")
                for p in contract.allowed_write_path_patterns)
        )


if __name__ == "__main__":
    unittest.main()
