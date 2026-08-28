"""E21-c (ORPHAN-693) — the experiment↔finding bridge.

Deliberate-breakage battery for the event pair that turns an executed
experiment into finding truth:

  * ``finding_reproduced``    — matched RED run on a BOUND experiment
                                 → certainty CONFIRMED (first producer)
  * ``finding_fix_verified``  — SAME recipe re-runs matched GREEN
                                 → status RESOLVED + closes_in_commit
  * ``finding_status_changed`` — operator transitions through the closed
                                 STATUS_TRANSITIONS map
  * replay REFUSES unknown event types (silent skip = data loss)
  * İ2: certainty vocabulary shrank to its producers (CONFIRMED, OBSERVED)
  * memory leg: a reproduced finding becomes a belief through memory.py
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.experiment import (
    observations_path,
    register_experiment,
    register_recipe,
)
from aria_kernel.finding import (
    CERTAINTIES,
    emit_finding,
    list_findings,
    list_fix_verified_bindings,
    record_finding_fix_verification,
    record_finding_reproduction,
    record_finding_status_change,
    show_finding,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths


def _seed_repo() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-bridge-test-"))
    for i in range(1, 4):
        path = tmp / "apps" / "farm-service" / "src" / f"module{i}.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"line {n}" for n in range(1, 45)) + "\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.email", "aria-test@example.com"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=tmp, check=True)
    subprocess.run(["git", "add", "apps"], cwd=tmp, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=tmp, check=True)
    paths = workspace_paths(tmp, tmp / "workspaces")
    ensure_workspace(paths)
    ensure_tools_dir(tmp / "aria-tools")
    return tmp


def _evidence(n: int = 2) -> list[dict[str, object]]:
    return [
        {"ref": f"apps/farm-service/src/module{i}.ts:10", "summary": f"evidence {i}"}
        for i in range(1, n + 1)
    ]


class ExperimentFindingBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        self.finding = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type="duplication",
            claim_summary="Two modules duplicate the same tenant-scope helper",
            severity="LOW",
            evidences=_evidence(3),
            facts=["module1 defines scopeTenant", "module2 defines scopeTenant", "module3 defines scopeTenant"],
            scope_files=["apps/farm-service/src/module1.ts", "apps/farm-service/src/module2.ts"],
        )
        self.fid = self.finding["finding_id"]
        register_recipe(
            recipe_id="repro-recipe",
            command="npx nx test farm-service",
            timeout_ms=60000,
            deterministic=True,
            base_dir=self.tools,
        )
        register_experiment(
            experiment_id="exp-problem",
            hypothesis=f"{self.fid} reproduces as a red run",
            recipe_ref="repro-recipe",
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            finding_ref=self.fid,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _observe(
        self,
        *,
        run_id: str,
        matched: bool = True,
        run_status: str = "failed",
        experiment_id: str = "exp-problem",
        cycle_id: str | None = None,
    ) -> dict[str, object]:
        # Shaped exactly like run_experiment's observation row; appending
        # through the declared surface keeps the hash-chain honest without
        # executing a real command in a unit test.
        return append_declared_jsonl(
            observations_path(self.tools),
            {
                "schema_version": 1,
                "recorded_at": "2026-08-16T00:00:00Z",
                "cycle_id": cycle_id,
                "experiment_id": experiment_id,
                "recipe_ref": "repro-recipe",
                "hypothesis": "h",
                "change_id": "change-1",
                "commit_sha": "a" * 40,
                "runner_identity": "test-runner",
                "validation_run_id": run_id,
                "validation_plan_ref": "sha256:test",
                "comparator": "status_equals",
                "expected": "failed",
                "observed": run_status,
                "matched": matched,
                "run_status": run_status,
            },
            expected_surface="experiment_observations",
        )

    # --- reproduction ---

    def test_reproduction_confirms_certainty(self) -> None:
        self._observe(run_id="run-red-1")
        event = record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        self.assertEqual(event["event"], "finding_reproduced")
        doc = show_finding(self.repo, self.fid)
        self.assertEqual(doc["certainty"], "CONFIRMED")
        self.assertEqual(doc["reproduction"]["validation_run_id"], "run-red-1")
        self.assertEqual(doc["reproduction"]["recipe_ref"], "repro-recipe")
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("finding_reproduced", governance)

    def test_reproduction_refuses_unmatched_observation(self) -> None:
        self._observe(run_id="run-x", matched=False)
        with self.assertRaisesRegex(GovernanceError, "unmatched"):
            record_finding_reproduction(
                self.repo, finding_id=self.fid, validation_run_id="run-x",
                base_dir=self.tools,
            )

    def test_reproduction_refuses_green_run(self) -> None:
        self._observe(run_id="run-green", run_status="ok")
        with self.assertRaisesRegex(GovernanceError, "requires_red_run"):
            record_finding_reproduction(
                self.repo, finding_id=self.fid, validation_run_id="run-green",
                base_dir=self.tools,
            )

    def test_reproduction_refuses_timeout_as_red(self) -> None:
        self._observe(run_id="run-timeout", run_status="timeout")
        with self.assertRaisesRegex(GovernanceError, "requires_red_run"):
            record_finding_reproduction(
                self.repo, finding_id=self.fid, validation_run_id="run-timeout",
                base_dir=self.tools,
            )

    def test_reproduction_refuses_unbound_experiment(self) -> None:
        register_experiment(
            experiment_id="exp-unbound",
            hypothesis="an experiment about nothing in particular",
            recipe_ref="repro-recipe",
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            base_dir=self.tools,
        )
        self._observe(run_id="run-unbound", experiment_id="exp-unbound")
        with self.assertRaisesRegex(GovernanceError, "not_bound"):
            record_finding_reproduction(
                self.repo, finding_id=self.fid, validation_run_id="run-unbound",
                base_dir=self.tools,
            )

    def test_reproduction_refuses_missing_observation(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "observation_missing"):
            record_finding_reproduction(
                self.repo, finding_id=self.fid, validation_run_id="run-none",
                base_dir=self.tools,
            )

    # --- fix verification ---

    def test_fix_verification_requires_prior_reproduction(self) -> None:
        self._observe(run_id="run-green-1", run_status="ok")
        with self.assertRaisesRegex(GovernanceError, "requires_reproduction"):
            record_finding_fix_verification(
                self.repo, finding_id=self.fid, validation_run_id="run-green-1",
                base_dir=self.tools,
            )

    def test_fix_verification_resolves_finding(self) -> None:
        self._observe(run_id="run-red-1")
        record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        self._observe(run_id="run-green-1", run_status="ok")
        event = record_finding_fix_verification(
            self.repo, finding_id=self.fid, validation_run_id="run-green-1",
            base_dir=self.tools,
        )
        self.assertEqual(event["event"], "finding_fix_verified")
        doc = show_finding(self.repo, self.fid)
        self.assertEqual(doc["status"], "RESOLVED")
        self.assertEqual(doc["closes_in_commit"], "a" * 40)
        self.assertEqual(doc["fix_verification"]["validation_run_id"], "run-green-1")
        rows = list_findings(self.repo)
        self.assertEqual(rows[0]["status"], "RESOLVED")
        bindings = list_fix_verified_bindings(self.repo)
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["finding_id"], self.fid)
        self.assertEqual(bindings[0]["recipe_ref"], "repro-recipe")

    def test_fix_verification_refuses_red_run(self) -> None:
        self._observe(run_id="run-red-1")
        record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        self._observe(run_id="run-red-2")
        with self.assertRaisesRegex(GovernanceError, "requires_green_run"):
            record_finding_fix_verification(
                self.repo, finding_id=self.fid, validation_run_id="run-red-2",
                base_dir=self.tools,
            )

    def test_fix_verification_refuses_different_recipe(self) -> None:
        self._observe(run_id="run-red-1")
        record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        register_recipe(
            recipe_id="other-recipe",
            command="npx nx test backend-common",
            timeout_ms=60000,
            deterministic=True,
            base_dir=self.tools,
        )
        register_experiment(
            experiment_id="exp-other",
            hypothesis="a different recipe goes green",
            recipe_ref="other-recipe",
            observation_contract={"comparator": "status_equals", "expected": "ok"},
            finding_ref=self.fid,
            base_dir=self.tools,
        )
        append_declared_jsonl(
            observations_path(self.tools),
            {
                "schema_version": 1,
                "recorded_at": "2026-08-16T00:00:00Z",
                "cycle_id": None,
                "experiment_id": "exp-other",
                "recipe_ref": "other-recipe",
                "hypothesis": "h",
                "change_id": "change-1",
                "commit_sha": "b" * 40,
                "runner_identity": "test-runner",
                "validation_run_id": "run-other-green",
                "validation_plan_ref": "sha256:test",
                "comparator": "status_equals",
                "expected": "ok",
                "observed": "ok",
                "matched": True,
                "run_status": "ok",
            },
            expected_surface="experiment_observations",
        )
        with self.assertRaisesRegex(GovernanceError, "recipe_mismatch"):
            record_finding_fix_verification(
                self.repo, finding_id=self.fid, validation_run_id="run-other-green",
                base_dir=self.tools,
            )

    def test_reproduction_refused_after_resolution(self) -> None:
        self._observe(run_id="run-red-1")
        record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        self._observe(run_id="run-green-1", run_status="ok")
        record_finding_fix_verification(
            self.repo, finding_id=self.fid, validation_run_id="run-green-1",
            base_dir=self.tools,
        )
        self._observe(run_id="run-red-again")
        with self.assertRaisesRegex(GovernanceError, "REGRESSION"):
            record_finding_reproduction(
                self.repo, finding_id=self.fid, validation_run_id="run-red-again",
                base_dir=self.tools,
            )

    # --- status transitions ---

    def test_status_transition_open_to_in_progress(self) -> None:
        record_finding_status_change(
            self.repo, finding_id=self.fid, to_status="IN_PROGRESS",
            reason="assigned to the farm hardening train", actor="operator:okan",
            base_dir=self.tools,
        )
        self.assertEqual(show_finding(self.repo, self.fid)["status"], "IN_PROGRESS")

    def test_status_transition_open_to_resolved_rejected(self) -> None:
        # RESOLVED is reachable by hand only from IN_PROGRESS; from OPEN the
        # honest paths are fix-verification or working the finding first.
        with self.assertRaisesRegex(GovernanceError, "transition_invalid"):
            record_finding_status_change(
                self.repo, finding_id=self.fid, to_status="RESOLVED",
                reason="closing directly", actor="operator:okan",
                base_dir=self.tools,
            )

    def test_status_terminal_after_fix_verification(self) -> None:
        self._observe(run_id="run-red-1")
        record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        self._observe(run_id="run-green-1", run_status="ok")
        record_finding_fix_verification(
            self.repo, finding_id=self.fid, validation_run_id="run-green-1",
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "transition_invalid"):
            record_finding_status_change(
                self.repo, finding_id=self.fid, to_status="OPEN",
                reason="trying to reopen a resolved finding", actor="operator:okan",
                base_dir=self.tools,
            )

    def test_status_reason_banned_phrase_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "banned phrase"):
            record_finding_status_change(
                self.repo, finding_id=self.fid, to_status="SUPPRESSED",
                reason="suppressing for now", actor="operator:okan",
                base_dir=self.tools,
            )

    # --- replay honesty ---

    def test_replay_refuses_unknown_event_type(self) -> None:
        events = self.repo / "aria-findings" / "finding-events.jsonl"
        append_declared_jsonl(
            events,
            {
                "schema_version": 1,
                "event": "finding_teleported",
                "event_id": f"finding:{self.fid}:teleported",
                "finding_id": self.fid,
            },
            expected_surface="repo_finding_events",
        )
        with self.assertRaisesRegex(GovernanceError, "event type unknown"):
            list_findings(self.repo)

    # --- İ2: the certainty vocabulary matches its producers ---

    def test_certainty_vocabulary_is_producer_backed(self) -> None:
        self.assertEqual(CERTAINTIES, ("CONFIRMED", "OBSERVED"))
        with self.assertRaisesRegex(GovernanceError, "invalid certainty"):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="duplication",
                claim_summary="A suspected duplication with no reproduction",
                severity="LOW",
                certainty="SUSPECTED",
                evidences=_evidence(3),
                facts=["fact one", "fact two", "fact three"],
                scope_files=["apps/farm-service/src/module1.ts"],
            )

    # --- memory leg ---

    def test_reproduced_finding_feeds_belief_system(self) -> None:
        from aria_kernel.memory import _record_experiment_reproduction_beliefs

        self._observe(run_id="run-red-1", cycle_id="cycle-42")
        record_finding_reproduction(
            self.repo, finding_id=self.fid, validation_run_id="run-red-1",
            base_dir=self.tools,
        )
        written = _record_experiment_reproduction_beliefs(
            self.tools, "cycle-42", workspace_root=self.repo, base_dir=self.tools,
        )
        self.assertEqual(written, 1)
        beliefs = [
            json.loads(line)
            for line in (self.tools / "memory" / "beliefs.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        target = [b for b in beliefs if b.get("belief_id") == f"finding-reproduced-{self.fid.lower()}"]
        self.assertEqual(len(target), 1)
        self.assertIn("reproduces deterministically", target[0]["claim"])
        self.assertGreaterEqual(float(target[0]["confidence"]), 0.7)

    def test_memory_leg_ignores_other_cycles_and_green_runs(self) -> None:
        from aria_kernel.memory import _record_experiment_reproduction_beliefs

        self._observe(run_id="run-red-1", cycle_id="cycle-1")
        self._observe(run_id="run-green-1", run_status="ok", cycle_id="cycle-2")
        written = _record_experiment_reproduction_beliefs(
            self.tools, "cycle-2", workspace_root=self.repo, base_dir=self.tools,
        )
        self.assertEqual(written, 0)


if __name__ == "__main__":
    unittest.main()
