"""E14-b (ORPHAN-697) — the mechanism-without-caller decisions, pinned.

Three verdicts, each İ2-final:
  * fitness — the reader-rich writer gains a nightly producer (phase pin)
  * architecture — option-sets + evidence packs ride the service
    threshold event; the ADR draft stays a deliberate CLI act
  * executor/codegen — the superseded apply-lane twin is GONE, and this
    test is the deliberate-breakage pin that keeps it gone
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path


class DismantledLaneTests(unittest.TestCase):
    def test_executor_and_codegen_modules_are_gone(self) -> None:
        for name in ("aria_kernel.executor", "aria_kernel.codegen"):
            with self.assertRaises(ModuleNotFoundError):
                __import__(name)

    def test_no_executor_or_codegen_surfaces_remain(self) -> None:
        from aria_kernel.state_manifest import iter_surfaces

        names = {surface.name for surface in iter_surfaces()}
        leftovers = {n for n in names if n.startswith("executor_") or n.startswith("codegen_")}
        self.assertEqual(leftovers, set())


class FitnessPhaseTests(unittest.TestCase):
    def test_fitness_report_phase_registered(self) -> None:
        from aria_kernel.cycle import CYCLE_PHASES

        phases = {p.name: p for p in CYCLE_PHASES}
        self.assertIn("fitness_report", phases)
        self.assertEqual(phases["fitness_report"].on_error, "record_and_continue")


class ArchitectureProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.tool_registry import ensure_tools_dir

        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed(self, count: int) -> None:
        from aria_kernel.feedback_store import record_findings_for_run

        for index in range(count):
            record_findings_for_run(
                {
                    "tool_id": "tenant-scoping-adapter",
                    "run_id": f"run-arch-{index}",
                    "emitted_findings": [
                        {
                            "id": f"arch-{index}",
                            "rule": "missing-tenant-guard",
                            "path": f"apps/farm-service/src/mod{index}.ts",
                            "message": f"finding arch-{index}",
                        }
                    ],
                },
                base_dir=self.tools,
            )

    def test_threshold_crossing_also_mints_architecture_evidence(self) -> None:
        from aria_kernel.architecture import (
            list_architecture_evidence_packs,
            list_architecture_option_sets,
        )
        from aria_kernel.service_agent_targeting import propose_service_auditor_requests

        self._seed(3)
        payload = propose_service_auditor_requests(
            cycle_id="cyc-e14b", base_dir=self.tools, repo_root=self.repo,
            threshold=3,
        )
        self.assertEqual(payload.get("item_failures", []), [])
        evidence = payload["architecture_evidence"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["service"], "farm-service")
        option_sets = list_architecture_option_sets(base_dir=self.tools)
        packs = list_architecture_evidence_packs(base_dir=self.tools)
        self.assertEqual(option_sets[-1]["technology"], "service:farm-service")
        self.assertEqual(packs[-1]["technology"], "service:farm-service")
        # No ADR files in docs/adr cited -> the pack is HONESTLY blocked on
        # authoritative refs; the ADR draft cannot be minted from thin air.
        self.assertEqual(packs[-1]["status"], "blocked")

    def test_below_threshold_mints_nothing(self) -> None:
        from aria_kernel.architecture import list_architecture_option_sets
        from aria_kernel.service_agent_targeting import propose_service_auditor_requests

        self._seed(2)
        payload = propose_service_auditor_requests(
            cycle_id="cyc-e14b-2", base_dir=self.tools, repo_root=self.repo,
            threshold=5,
        )
        self.assertEqual(payload["architecture_evidence"], [])
        self.assertEqual(list_architecture_option_sets(base_dir=self.tools), [])


if __name__ == "__main__":
    unittest.main()
