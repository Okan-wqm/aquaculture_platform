"""ARIA-HIGH-245 — a mission carries the evidence its opening contract names.

THE MEASURED DEFECT. `open_mission` took no evidence refs. Every producer
derived its contract from evidence it held — the service seeder from
``finding:<id>`` / ``pressure:<id>`` / ``changed_path:<path>``, task adoption
from the candidate's own ``evidence_refs``, the gateway from the issue — and
none recorded it on the row. A mission gained refs only through
`mission_reconcile` (``pr:N``, ``branch:X``), after planning. The drain
therefore consumed every selected mission ``next_cycle_queue_item_unevidenced``:
on the live store (origin/aria/state 8e39b2eeb, 2026-10-16) 36 of the 50 such
governance rows name ONE mission, ``m-94d4bea861b82506`` (the auth-service
hardening mission, priority 0), which the scheduler re-selected every cycle,
so the slot never reached any other mission either. All 189 open missions on
that store fold to ``evidence_refs: []``.

THE RULE, ONE OWNER PER HALF.

* The producer resolves its source to citable refs and `open_mission` records
  them on the ``opened`` row (and, on a re-open of a mission that holds none,
  on an ``evidence`` row — the heal the contract already has). A ref the agent
  law cannot accept the shape of is refused at the mint, by name.
* `mission_dispatch.drain_can_plan` says whether the drain could plan a
  mission at all; the scheduler skips one it could not, by name, so an
  unevidenced mission (a legacy row, an issue mission) can no longer hold the
  slot and be consumed unevidenced every cycle.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel import mission as mission_module
from aria_kernel.impact_graph import project_map
from aria_kernel.ledger import append_declared_jsonl, load_jsonl
from aria_kernel.mission import (
    MISSION_SCHEMA,
    adopt_task_candidates,
    events_path,
    fold_mission,
    mission_id_for,
    open_mission,
    transition_mission,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding, ensure_tools_dir, utc_now
from tests._helpers.mint_patch import patched_mint

REPO_HASH = "rh-1"
_CONTRACT = {
    "next_action": "Harden auth-service against finding F-1",
    "wake_condition": {"kind": "evidence", "key": "finding:F-1"},
}


def _legacy_mission(root: Path, project: str, *, with_contract: bool) -> str:
    """A service mission as the live store holds every one: opened with no refs."""
    mission_id = mission_id_for("service_hardening", project, REPO_HASH)
    key = mission_module._idempotency_key(mission_id, "genesis", "", "opened")
    row = {
        "schema_version": 1,
        "schema": MISSION_SCHEMA,
        "event_id": f"legacy-{project}",
        "recorded_at": utc_now(),
        "event": "opened",
        "mission_id": mission_id,
        "idempotency_key": key,
        "source_kind": "service_hardening",
        "source_id": project,
        "repo_hash": REPO_HASH,
        "title": f"Harden {project}",
        "capability": "service_hardening",
        "priority": 0,
        "target_project": project,
    }
    if with_contract:
        row.update(_CONTRACT)
    append_declared_jsonl(events_path(root), row, expected_surface="mission_events")
    return mission_id


class OpenMissionRecordsEvidenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.root)

    def _open(self, **overrides):
        kwargs = dict(
            source_kind="service_hardening", source_id="auth-service", repo_hash=REPO_HASH,
            title="Harden auth-service", target_project="auth-service", base_dir=self.root,
            evidence_refs=["apps/auth-service/src/token.service.ts"], **_CONTRACT,
        )
        kwargs.update(overrides)
        return open_mission(**kwargs)

    def test_the_opened_row_carries_the_evidence_its_contract_names(self) -> None:
        opened = self._open()

        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.root)
        self.assertEqual(state["evidence_refs"], ["apps/auth-service/src/token.service.ts"])
        self.assertEqual(opened["event"]["evidence_refs"], ["apps/auth-service/src/token.service.ts"])

    def test_every_producer_has_to_state_its_evidence(self) -> None:
        # Required, not defaulted: a producer that forgets is a TypeError at its
        # own call, not a silent unplannable row three hops downstream.
        kwargs = dict(
            source_kind="service_hardening", source_id="auth-service", repo_hash=REPO_HASH,
            title="Harden auth-service", base_dir=self.root, **_CONTRACT,
        )
        with self.assertRaises(TypeError):
            open_mission(**kwargs)

    def test_a_ref_no_agent_can_cite_is_refused_at_the_mint(self) -> None:
        # `branch:<name>` is what mission_reconcile records; as evidence it is
        # outside the agent law's `path[:line]` grammar, so every answer citing
        # it would be refused `agent_evidence_ref_malformed` (ARIA-HIGH-384).
        with self.assertRaisesRegex(GovernanceError, "mission_evidence_not_agent_citable"):
            self._open(evidence_refs=["apps/auth-service/src/token.service.ts", "branch:fix/x"])
        self.assertFalse(events_path(self.root).exists() and load_jsonl(events_path(self.root)))

    def test_a_reopen_heals_a_mission_that_holds_no_evidence(self) -> None:
        mission_id = _legacy_mission(self.root, "auth-service", with_contract=True)
        self.assertEqual(fold_mission(mission_id=mission_id, base_dir=self.root)["evidence_refs"], [])

        healed = self._open()
        again = self._open(evidence_refs=["apps/auth-service/src/app.module.ts"])

        self.assertTrue(healed["idempotent"])
        self.assertTrue(healed["evidence_healed"])
        # The first sighting's evidence stands; a later one never overwrites it.
        self.assertFalse(again["evidence_healed"])
        self.assertEqual(
            fold_mission(mission_id=mission_id, base_dir=self.root)["evidence_refs"],
            ["apps/auth-service/src/token.service.ts"],
        )
        # The contract the mission already had is untouched by the evidence heal.
        self.assertEqual(
            fold_mission(mission_id=mission_id, base_dir=self.root)["next_action"],
            _CONTRACT["next_action"],
        )

    def test_a_terminal_mission_is_never_healed(self) -> None:
        mission_id = _legacy_mission(self.root, "auth-service", with_contract=True)
        transition_mission(
            mission_id=mission_id, to_state="SUPERSEDED", reason_code="test", step_id="s1",
            base_dir=self.root,
        )

        result = self._open()

        self.assertFalse(result["evidence_healed"])
        self.assertEqual(result["evidence_heal_declined"], "terminal")
        self.assertEqual(fold_mission(mission_id=mission_id, base_dir=self.root)["evidence_refs"], [])


class SchedulerSkipsUnplannableMissionsTest(unittest.TestCase):
    def test_a_mission_the_drain_could_not_plan_never_takes_the_slot(self) -> None:
        from aria_kernel.mission_scheduler import SELECTED, SKIP_UNEVIDENCED, select_next_mission

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            legacy = _legacy_mission(root, "auth-service", with_contract=True)
            plannable = open_mission(
                source_kind="service_hardening", source_id="farm-service", repo_hash=REPO_HASH,
                title="Harden farm-service", next_action="Harden farm-service against finding F-2",
                wake_condition={"kind": "evidence", "key": "finding:F-2"}, priority=5,
                evidence_refs=["apps/farm-service/src/pond.service.ts"], base_dir=root,
            )
            decision = select_next_mission(base_dir=root)

        self.assertEqual(decision.outcome, SELECTED)
        self.assertEqual(decision.selected["mission_id"], plannable["mission_id"])
        self.assertIn((legacy, SKIP_UNEVIDENCED), [(s.mission_id, s.reason) for s in decision.skipped])

    def test_a_kernel_contract_mission_needs_no_evidence_to_be_planned(self) -> None:
        # The self-change contract asks its answer to establish the evidence
        # (`details.evidence_paths`), so the drain plans it with none.
        from aria_kernel.mission_dispatch import drain_can_plan
        from aria_kernel.self_improvement import SELF_CHANGE_NEXT_ACTION

        self.assertTrue(drain_can_plan({"next_action": SELF_CHANGE_NEXT_ACTION, "evidence_refs": []}))
        self.assertFalse(drain_can_plan({"next_action": "triage_github_issue", "evidence_refs": []}))
        self.assertFalse(drain_can_plan({"next_action": "x", "evidence_refs": ["branch:fix/y"]}))
        self.assertTrue(drain_can_plan({"next_action": "x", "evidence_refs": ["apps/a/b.ts:3"]}))


class ProducersRecordTheirEvidenceTest(unittest.TestCase):
    def _seed(self, exam: dict, changed_paths: list[str], *, findings: dict[str, list[str]] | None = None):
        from aria_kernel.feedback_store import record_findings_for_run

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            for project in cycle_mod.SERVICE_HARDENING_CORE:
                Path(tmp, "apps", project).mkdir(parents=True, exist_ok=True)
            # The mint attributes each finding over the store's map (SE-1
            # round 2): the store declares the workspace it mints for.
            ensure_tools_binding(root, workspace_root=Path(tmp))
            if findings:
                record_findings_for_run(
                    {
                        "tool_id": "auditor", "run_id": "run-1",
                        "emitted_findings": [
                            {"id": fid, "severity": "high", "message": "m", "path": paths[0]}
                            for fid, paths in findings.items()
                        ],
                    },
                    project_roots=project_map(base_dir=root), base_dir=root,
                )
            ctx = cycle_mod.build_phase_context(
                cycle_id="cyc-245", workspace_root=Path(tmp), base_dir=root,
            )
            ctx.results["service_examination"] = exam
            ctx.results["cycle_diff"] = {"changed_paths": changed_paths}
            with patch.object(cycle_mod, "repo_hash", return_value=REPO_HASH):
                result = cycle_mod._phase_service_mission_seed(ctx)
            missions = {
                s["project"]: fold_mission(mission_id=s["mission_id"], base_dir=root)
                for s in result["seeded"]
            }
        return result, missions

    def test_a_changed_path_contract_records_the_path(self) -> None:
        _result, missions = self._seed(
            {"examination_order": [{"project": "auth-service", "changed_files": 1}]},
            ["apps/auth-service/src/app.module.ts"],
        )

        self.assertEqual(missions["auth-service"]["evidence_refs"], ["apps/auth-service/src/app.module.ts"])

    def test_a_pressure_contract_records_the_pressures_own_evidence_in_the_service(self) -> None:
        exam = {
            "examination_order": [{"project": "sensor-service", "changed_files": 0}],
            "per_service_pressures": [{
                "service": "sensor-service", "layer": 2,
                "pressures": [{
                    "pressure_id": "p-77",
                    "evidence": ["apps/sensor-service/src/reading.ts:4", "apps/farm-service/src/pond.ts"],
                }],
            }],
        }
        result, missions = self._seed(exam, [])

        self.assertEqual(
            next(s for s in result["seeded"] if s["project"] == "sensor-service")["contract_source"],
            "scoped_pressure",
        )
        self.assertEqual(missions["sensor-service"]["evidence_refs"], ["apps/sensor-service/src/reading.ts:4"])

    def test_a_pressure_with_no_citable_evidence_names_no_contract(self) -> None:
        # The pipeline_stalled shape (ARIA-HIGH-384): a ledger ref, which no
        # agent can cite. The service has nothing else, so it is refused by
        # name instead of minted unplannable.
        exam = {
            "examination_order": [{"project": "sensor-service", "changed_files": 0}],
            "per_service_pressures": [{
                "service": "sensor-service", "layer": 2,
                "pressures": [{
                    "pressure_id": "p-78",
                    "evidence": ["knowledge-graph/pressure-source-effectiveness.jsonl:own_pr_ci"],
                }],
            }],
        }
        result, missions = self._seed(exam, [])

        self.assertNotIn("sensor-service", missions)
        self.assertIn("sensor-service", {row["project"] for row in result["refused"]})

    def test_a_finding_contract_records_the_findings_cited_paths(self) -> None:
        result, missions = self._seed(
            {}, [], findings={"F-auth-1": ["apps/auth-service/src/token.service.ts"]},
        )

        self.assertEqual(result["seeded"][0]["contract_source"], "open_finding")
        self.assertEqual(missions["auth-service"]["evidence_refs"], ["apps/auth-service/src/token.service.ts"])

    def test_adoption_records_the_candidates_citable_evidence_and_refuses_without_any(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            candidates = {
                "tasks": [
                    {"source": "finding", "source_id": "F-9", "title": "t", "next_action": "fix apps/x/y.ts",
                     "evidence_refs": ["apps/x/y.ts:3", "pr-12:abc"]},
                    {"source": "pressure", "source_id": "p-1", "title": "t", "next_action": "look at the funnel",
                     "evidence_refs": ["knowledge-graph/pressure-source-effectiveness.jsonl:f_finding"]},
                ],
                "blocked": [],
            }
            with patch.object(mission_module, "generate_task_candidates", return_value=candidates):
                report = adopt_task_candidates(cycle_id="cyc-1", repo_hash=REPO_HASH, base_dir=root)
            adopted = fold_mission(mission_id=mission_id_for("finding", "F-9", REPO_HASH), base_dir=root)
            refusals = [
                row["details"] for row in load_jsonl(root / "governance.jsonl")
                if row.get("kind") == "mission_candidate_refused"
            ]

        self.assertEqual(report["adopted"], 1)
        self.assertEqual(adopted["evidence_refs"], ["apps/x/y.ts:3"])
        self.assertEqual([(r["source_id"], r["reason"]) for r in refusals], [("p-1", "no_citable_evidence")])


class TheMissionLineReachesThePlannerTest(unittest.TestCase):
    def test_a_seeded_mission_is_minted_with_its_evidence_not_consumed_unevidenced(self) -> None:
        """The finding's observable, end to end: seed -> select -> drain."""
        from aria_kernel import autonomy_orchestrator as ao

        from tests._helpers.git_fixtures import commit_files, make_local_git_repo

        with TemporaryDirectory() as tmp:
            workspace = make_local_git_repo(Path(tmp), name="repo")
            commit_files(workspace, {"apps/auth-service/src/app.module.ts": "line\n" * 4})
            for project in cycle_mod.SERVICE_HARDENING_CORE:
                (workspace / "apps" / project).mkdir(parents=True, exist_ok=True)
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            ctx = cycle_mod.build_phase_context(cycle_id="cyc-e2e", workspace_root=workspace, base_dir=root)
            ctx.results["service_examination"] = {
                "examination_order": [{"project": "auth-service", "changed_files": 1}],
            }
            ctx.results["cycle_diff"] = {"changed_paths": ["apps/auth-service/src/app.module.ts"]}
            with patch.object(cycle_mod, "repo_hash", return_value=REPO_HASH):
                cycle_mod._phase_service_mission_seed(ctx)
            selection = cycle_mod._phase_mission_selection(ctx)

            captured: dict = {}
            governance: list = []

            def fake_create(**kw):
                captured.update(kw)
                return {"request_id": "AIR-x"}

            def record_governance(_base_dir, kind, details, **_kwargs):
                governance.append(kind)

            with patch.object(ao, "_find_projected_queue_request", return_value=None), \
                 patched_mint(fake_create), \
                 patch("aria_kernel.tool_registry.append_tools_governance", side_effect=record_governance):
                ao._drain_next_cycle_queue(base_dir=root, daemon_agent_id="t", limit=1, workspace_root=workspace)

        self.assertTrue(selection["queue_item_id"])
        self.assertNotIn("next_cycle_queue_item_unevidenced", governance)
        self.assertEqual(captured.get("evidence_refs"), ["apps/auth-service/src/app.module.ts"])
        self.assertEqual(captured.get("pressure_event_id"), f"mission:{selection['selected_mission']}")


if __name__ == "__main__":
    unittest.main()
