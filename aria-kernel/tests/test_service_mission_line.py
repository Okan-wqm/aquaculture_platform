"""The charter's per-service hardening program finally has a producer.

Everything this wires existed and was severed: `cycle_service_examination`
computed per-service targeting nobody consumed (and ran AFTER mission
ingest); `SERVICE_MAP.json` inventoried every service for no reader;
`select_next_mission` had one caller, the operator CLI; the
coverage-gap → mission path was structurally unreachable because gap
detection runs after ingest and ingest filtered to the current cycle id;
and a mission could not even NAME a service except inside free text.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.mission import fold_mission, open_mission
from aria_kernel.mission_scheduler import SOURCE_RANK
from aria_kernel.tool_registry import ensure_tools_dir


def _context(base: str, exam: dict | None = None):
    ctx = cycle_mod.build_phase_context(
        cycle_id="cyc-svc",
        workspace_root=Path(base),
        base_dir=Path(base) / "aria-tools",
    )
    if exam is not None:
        ctx.results["service_examination"] = exam
    return ctx


class PhaseOrderTest(unittest.TestCase):
    def test_examination_and_seed_run_before_ingest_selection_after(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]
        sub = [n for n in names if n in (
            "pressure", "service_examination", "service_mission_seed",
            "mission_ingest", "mission_selection",
        )]
        self.assertEqual(sub, [
            "pressure", "service_examination", "service_mission_seed",
            "mission_ingest", "mission_selection",
        ])


class ServiceMissionSeedTest(unittest.TestCase):
    def _seed(self, exam: dict):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            ctx = _context(tmp, exam)
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            missions = {
                s["project"]: fold_mission(mission_id=s["mission_id"], base_dir=root)
                for s in result["seeded"]
            }
            return result, missions

    def test_core_services_are_seeded_even_on_a_quiet_night(self) -> None:
        result, missions = self._seed({})

        for core in cycle_mod.SERVICE_HARDENING_CORE:
            self.assertIn(core, missions)
            self.assertEqual(missions[core]["source_kind"], "service_hardening")

    def test_evidence_backed_services_join_the_core(self) -> None:
        exam = {
            "examination_order": [
                {"project": "messaging-service", "changed_files": 3},
                {"project": "untouched-lib", "changed_files": 0},
            ],
            "per_service_pressures": {},
        }
        result, missions = self._seed(exam)

        self.assertIn("messaging-service", missions)
        self.assertNotIn("untouched-lib", missions)

    def test_missions_carry_a_queryable_target_project(self) -> None:
        _, missions = self._seed({})
        row = missions["auth-service"]

        self.assertEqual(row["target_project"], "auth-service")

    def test_reseeding_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                first = cycle_mod._phase_service_mission_seed(_context(tmp, {}))
                second = cycle_mod._phase_service_mission_seed(_context(tmp, {}))

        self.assertTrue(all(not s["idempotent"] for s in first["seeded"]))
        self.assertTrue(all(s["idempotent"] for s in second["seeded"]))


class SchedulerIntegrationTest(unittest.TestCase):
    def test_service_hardening_is_a_ranked_source(self) -> None:
        self.assertIn("service_hardening", SOURCE_RANK)
        self.assertGreater(SOURCE_RANK["service_hardening"], SOURCE_RANK["finding"])

    def test_selection_hands_the_winner_to_the_queue(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            opened = open_mission(
                source_kind="service_hardening", source_id="auth-service",
                repo_hash="rh-1", title="Harden auth-service",
                target_project="auth-service", base_dir=root,
            )
            ctx = _context(tmp)
            result = cycle_mod._phase_mission_selection(ctx)

        self.assertEqual(result["selected_mission"], opened["mission_id"])
        self.assertEqual(result["selected_project"], "auth-service")
        self.assertTrue(result["queue_item_id"], "the winner must reach the queue")

    def test_an_empty_ledger_selects_nothing_and_queues_nothing(self) -> None:
        with TemporaryDirectory() as tmp:
            ensure_tools_dir(Path(tmp) / "aria-tools")
            result = cycle_mod._phase_mission_selection(_context(tmp))

        self.assertIsNone(result["selected_mission"])
        self.assertIsNone(result["queue_item_id"])


class CoverageGapPathTest(unittest.TestCase):
    def test_ingest_no_longer_filters_the_latest_gap_batch_by_cycle_id(self) -> None:
        # The structural-unreachability fix: gap detection runs AFTER ingest,
        # so at ingest time the newest batch always carries the previous
        # cycle's id and the old equality filter dropped it, every cycle.
        import ast
        import inspect
        import textwrap

        from aria_kernel import task as task_mod

        src = textwrap.dedent(inspect.getsource(task_mod.generate_task_candidates))
        self.assertNotIn('gap.get("cycle_id") == cycle_id', src)
        self.assertIn("latest_capability_gaps", src)


class DrainResolvesMissionMarkersTest(unittest.TestCase):
    def test_a_mission_item_mints_with_the_missions_evidence(self) -> None:
        from aria_kernel import autonomy_orchestrator as ao

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            opened = open_mission(
                source_kind="service_hardening", source_id="auth-service",
                repo_hash="rh-1", title="Harden auth-service",
                target_project="auth-service", base_dir=root,
            )
            captured: dict = {}

            def fake_create(**kw):
                captured.update(kw)
                return {"request_id": "AIR-x"}

            item = {
                "queue_item_id": "qi-m1",
                "pressure_id": f"mission:{opened['mission_id']}",
                "source_cycle_id": "cyc-svc",
                "recommended_action": "advance the mission",
                "candidate_tools": [],
            }
            with patch.object(ao, "read_pending", return_value=[item]), \
                 patch.object(ao, "mark_consumed"), \
                 patch.object(ao, "_find_projected_queue_request", return_value=None), \
                 patch("aria_kernel.agent_invocations.create_agent_invocation_request", fake_create), \
                 patch("aria_kernel.tool_registry.append_tools_governance"):
                ao._drain_next_cycle_queue(
                    base_dir=root, daemon_agent_id="t", limit=1, workspace_root=root,
                )

        # The mission has no accumulated evidence yet, so the fallback marker
        # applies — the important pin is that the MARKER never leaks into the
        # evidence channel as if it were a path.
        self.assertEqual(captured.get("evidence_refs"), ["qi-m1"])
        self.assertEqual(captured.get("pressure_event_id"), f"mission:{opened['mission_id']}")


if __name__ == "__main__":
    unittest.main()
