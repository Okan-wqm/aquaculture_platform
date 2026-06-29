"""Plan ARIA-V3.3 Phase 3.2 — reflection ordering invariants.

Closes F-010-D2-POSTMORTEM. The 2026-05-16 autonomous-loop audit
disproved V3.2 §2b's "shadow tree" theory: the operator-visible
"Total governance events: 4" in ``aria-tools/reports/daily/<date>.md``
was NOT path resolution. It was timing — ``run_reflection`` ran
MID-cycle inside ``run_enterprise_cycle`` (cycle.py:397), BEFORE the
autonomy orchestrator's planner+bridge+worker+auto_merge dispatch
daemons emitted their ~25+ governance events. The daily report
captured the pre-drainer snapshot.

V3.3 §2b closes the class via a backward-compatible kwarg contract:

  * ``run_enterprise_cycle`` gains ``defer_reflection: bool = False``.
    Default preserves direct CLI callers (``aria-kernel cycle run``)
    on the inline reflection path.
  * The autonomy orchestrator passes ``defer_reflection=True`` and
    invokes ``run_reflection`` itself AFTER its drainer phases
    complete. The daily report's count now covers the full cycle.

Three invariant cases (I-V3.3-05..07):

  * I-V3.3-05 — orchestrator's reflection_recorded event lands AFTER
    planner+worker drainer events in governance.jsonl.
  * I-V3.3-06 — daily report's "Total governance events" equals the
    actual governance.jsonl row count after the orchestrator drains
    planner+bridge+worker+auto_merge.
  * I-V3.3-07 — direct ``run_enterprise_cycle(defer_reflection=True)``
    returns ``state["reflection"] is None`` and emits no daily report.
"""

from __future__ import annotations

import inspect
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _seed_minimal_cycle_state(tools_root: Path, cycle_id: str) -> None:
    """V3.3 §2b — seed the bare-minimum cycle state that
    ``run_reflection`` requires (memory, auto-merge-decisions,
    discovery COMPLETION_PROOF). Empty ledgers are valid; the
    invariants do not need real cycle data — they pin reflection
    ORDERING.
    """
    (tools_root / "memory").mkdir(parents=True, exist_ok=True)
    (tools_root / "memory" / "beliefs.jsonl").touch()
    (tools_root / "auto-merge-decisions.jsonl").touch()
    discovery_dir = tools_root / "discovery" / cycle_id
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / "COMPLETION_PROOF.json").write_text(
        json.dumps({
            "schema_version": 1,
            "cycle_id": cycle_id,
            "complete": True,
            "file_counts": {
                "allowed": 0, "fated": 0, "generated": 0,
                "git_tracked": 0, "unknown": 0, "working_tree": 0,
            },
            "tracked_file_count": 0,
            "fated_file_count": 0,
            "unknown_count": 0,
            "missing_fates": [],
            "snapshot_hash": "sha256:" + ("0" * 64),
            "base_commit_sha": "0" * 40,
            "snapshot_mode": "committed",
            "dirty_snapshot": False,
            "dirty_path_count": 0,
        }),
        encoding="utf-8",
    )


def _seeding_cycle_runner_factory(
    emit_kind: str | None = None,
    emit_count: int = 0,
):
    """V3.3 §2b — build a fake cycle_runner that seeds reflection
    inputs AND optionally emits governance events to simulate the
    real cycle's row-emission pattern.
    """
    def _runner(*, workspace_root, cycle_id, base_dir, defer_reflection=False, **_kwargs):
        from aria_kernel.tool_registry import (
            append_tools_governance,
            ensure_tools_dir,
        )
        root = ensure_tools_dir(base_dir)
        _seed_minimal_cycle_state(root, cycle_id)
        if emit_kind is not None:
            for i in range(emit_count):
                append_tools_governance(
                    root,
                    emit_kind,
                    {"cycle_id": cycle_id, "sequence": i},
                )
        return {
            "schema_version": 2,
            "cycle_id": cycle_id,
            "status": "completed",
            "reflection": None,
        }
    return _runner


def _emitting_drainer_factory(
    emit_kind: str,
    emit_count: int,
):
    """V3.3 §2b — build a fake drainer (planner/worker) that emits
    ``emit_count`` governance events of ``emit_kind`` each cycle.
    Used by I-V3.3-05/06 to simulate the pre-V3.3 defect surface
    where these drainers emitted events AFTER reflection had
    already captured its snapshot.
    """
    def _drainer(**kwargs):
        from aria_kernel.tool_registry import append_tools_governance
        base_dir = kwargs.get("base_dir")
        for i in range(emit_count):
            append_tools_governance(
                base_dir,
                emit_kind,
                {"sequence": i, "drainer": emit_kind},
            )
        return {
            "iterations": 1,
            "claims_dispatched": emit_count,
            "assignments_dispatched": emit_count,
            "merges_completed": 0,
            "retries_attempted": 0,
            "exit_reason": "max_iterations",
            "exits_clean": True,
        }
    return _drainer


class _FakeAutoMergeRunner:
    profile = "standard"

    def __call__(self, *, base_dir, workspace_root):
        return {
            "schema_version": 1,
            "status": "skipped",
            "merges_completed": 0,
            "candidates_evaluated": 0,
            "profile": self.profile,
        }


class _FakeGitHubAdapter:
    pass


class PhaseV3_3ReflectionOrdering(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v3_3-reflection-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard",
            operator_approval_ref="v3_3-test",
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_orchestrator(
        self,
        *,
        cycle_runner,
        planner_drainer,
        worker_drainer,
    ) -> dict:
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        # Plan ARIA-V5 R-A9 (v2) — V3.3 invariant tests must supply
        # convergence_runner + review_runner since V5.1+V5.2 make
        # both REQUIRED. Happy-path fakes return verdicts that allow
        # worker + auto_merge to fire and the V3.3 reflection-
        # ordering assertions to hold (governance row ordering
        # between drainer rows and reflection_recorded events).
        def _v5_fake_convergence_runner(**kwargs):
            return {
                "plan_id": kwargs.get("plan_id", "plan-test"),
                "converged_plan": {},
                "rounds_count": 1,
                "arbiter_verdict": "converged",
                "unsatisfied_items": [],
                "request_ids": [],
                "transcript_path": "",
                "resumed_from_persistence": False,
                "convergence_id": kwargs.get("plan_id", "plan-test"),
            }
        def _v5_fake_review_runner(**kwargs):
            return {
                "plan_id": kwargs.get("plan_id", "plan-test"),
                "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", ""),
                "review_verdict": "no_gaps",
                "rounds_count": 1,
                "gaps_found": [],
                "request_ids": [],
                "convergence_id": kwargs.get("convergence_id", kwargs.get("plan_id", "plan-test")),
            }
        def _v6_fake_specialist_review_runner(**kwargs):
            return {
                "cycle_id": kwargs.get("cycle_id", "cycle-test"),
                "specialists_dispatched": [],
                "specialists_timed_out": [],
                "consolidated_verdict": "consolidated_no_gaps",
                "findings_by_specialist": {},
                "request_ids": [],
                "rounds_count": 1,
                "token_cost_estimate": 0,
                "profile": kwargs.get("profile", "standard"),
            }
        def _v7_fake_plan_synthesizer(**kwargs):
            cycle_id = kwargs.get("cycle_id", "cycle-test")
            return {
                "schema_version": 1,
                "title": f"Fake cycle {cycle_id}",
                "summary": "R-A9 V7 fixture",
                "affected_surfaces": ["fixture.py"],
                "key_changes": [{"id": "c1", "description": "x", "paths": ["fixture.py"]}],
                "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
                "evidence_refs": ["fixture.py:1:line"],
            }
        def _v7_fake_skill_genesis_drainer(**kwargs):
            return {
                "cycle_id": kwargs.get("cycle_id", "cycle-test"),
                "requests_scanned": 0, "requests_dispatched": 0,
                "requests_skipped_corpus_missing": 0,
                "requests_skipped_evidence_insufficient": 0,
                "requests_skipped_already_terminal": 0,
                "requests_skipped_token_budget": 0,
                "requests_skipped_non_convergent": 0,
                "authoring_results": [], "tokens_spent_this_cycle": 0,
                "aggregate_verdict": "no_requests",
            }
        return run_autonomy_orchestrator(
            base_dir=self.base,
            workspace_root=str(self.tmp),
            max_cycles=1,
            max_iterations_per_phase=3,
            cycle_runner=cycle_runner,
            planner_drainer=planner_drainer,
            worker_drainer=worker_drainer,
            bridge_drainer=lambda **kw: {
                "status": "ok", "iterations": 0, "pending_after": 0,
            },
            auto_merge_runner=_FakeAutoMergeRunner(),
            github_adapter=_FakeGitHubAdapter(),
            convergence_runner=_v5_fake_convergence_runner,
            review_runner=_v5_fake_review_runner,
            specialist_review_runner=_v6_fake_specialist_review_runner,
            plan_synthesizer=_v7_fake_plan_synthesizer,
            skill_genesis_drainer=_v7_fake_skill_genesis_drainer,
            # Plan ARIA-V3.1-E — REQUIRED profile kwarg; standard
            # for V3.3 reflection-ordering tests.
            profile="standard",
        )

    def _read_governance(self) -> list[dict]:
        gov = self.base / "governance.jsonl"
        if not gov.exists():
            return []
        return [
            json.loads(line)
            for line in gov.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _read_reflections(self) -> list[dict]:
        rfn = self.base / "reflections.jsonl"
        if not rfn.exists():
            return []
        return [
            json.loads(line)
            for line in rfn.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    # I-V3.3-05 — reflection observes the drainer-emitted rows.
    # Pre-V3.3 reflection ran MID-cycle, BEFORE planner+worker drainers
    # emitted their events; reflection's gate_activity.by_kind missed
    # them entirely. Post-V3.3 the orchestrator invokes reflection
    # AFTER its drainer phases, so by_kind contains the drainer-
    # emitted counts.
    def test_i_v3_3_05_reflection_observes_drainer_events(self) -> None:
        result = self._run_orchestrator(
            cycle_runner=_seeding_cycle_runner_factory(),
            planner_drainer=_emitting_drainer_factory(
                "planner_drainer_test_event", 5,
            ),
            worker_drainer=_emitting_drainer_factory(
                "worker_drainer_test_event", 7,
            ),
        )
        self.assertEqual(result["cycles_completed"], 1)
        reflections = self._read_reflections()
        self.assertGreaterEqual(
            len(reflections), 1,
            msg=(
                "V3.3 §2b — orchestrator MUST write a reflection row "
                "(via run_reflection's append to reflections.jsonl) "
                "after its drainer phases complete."
            ),
        )
        last_reflection = reflections[-1]
        by_kind = (
            last_reflection.get("gate_activity", {}).get("by_kind", {})
        )
        self.assertEqual(
            by_kind.get("planner_drainer_test_event"), 5,
            msg=(
                f"V3.3 §2b F-010-D2-POSTMORTEM — reflection MUST "
                f"observe all 5 planner_drainer_test_event rows "
                f"(proof reflection ran AFTER planner drainer). "
                f"Pre-V3.3 reflection ran BEFORE planner drainer and "
                f"this count would be 0. Got: {by_kind!r}"
            ),
        )
        self.assertEqual(
            by_kind.get("worker_drainer_test_event"), 7,
            msg=(
                f"V3.3 §2b F-010-D2-POSTMORTEM — reflection MUST "
                f"observe all 7 worker_drainer_test_event rows "
                f"(proof reflection ran AFTER worker drainer). "
                f"Pre-V3.3 reflection ran BEFORE worker drainer and "
                f"this count would be 0. Got: {by_kind!r}"
            ),
        )

    # I-V3.3-06 — daily report's "Total governance events" equals
    # the governance.jsonl row count at reflection time (modulo the
    # 1-row reflection_recorded append-after-read gap if any).
    def test_i_v3_3_06_daily_report_total_matches_governance_count(
        self,
    ) -> None:
        self._run_orchestrator(
            cycle_runner=_seeding_cycle_runner_factory(),
            planner_drainer=_emitting_drainer_factory(
                "planner_drainer_test_event", 4,
            ),
            worker_drainer=_emitting_drainer_factory(
                "worker_drainer_test_event", 6,
            ),
        )
        reflections = self._read_reflections()
        self.assertGreaterEqual(len(reflections), 1)
        last_reflection = reflections[-1]
        recorded_at = last_reflection.get("recorded_at")
        self.assertIsNotNone(
            recorded_at,
            msg="reflection row MUST carry recorded_at for daily-report lookup",
        )
        day = str(recorded_at)[:10]
        report_path = self.base / "reports" / "daily" / f"{day}.md"
        self.assertTrue(
            report_path.exists(),
            msg=(
                f"V3.3 §2b — daily report MUST exist at {report_path} "
                f"after orchestrator post-drain reflection."
            ),
        )
        report_text = report_path.read_text(encoding="utf-8")
        # Daily report uses markdown list syntax: `- Total governance events: <N>`.
        total_line = next(
            (
                line for line in report_text.splitlines()
                if line.lstrip("- ").startswith("Total governance events:")
            ),
            None,
        )
        self.assertIsNotNone(
            total_line,
            msg=(
                f"V3.3 §2b — daily report MUST render a 'Total "
                f"governance events:' line. Report: {report_text!r}"
            ),
        )
        reported_total = int(total_line.rsplit(":", 1)[1].strip())
        # Reflection's gate_activity.total_events is the count it
        # observed in governance.jsonl AT REFLECTION TIME. Post-V3.3
        # this MUST include all drainer-emitted rows (4 planner + 6
        # worker = 10 minimum). Pre-V3.3 the count was the pre-
        # drainer snapshot (~0 or just the bootstrap row).
        self.assertGreaterEqual(
            reported_total, 10,
            msg=(
                f"V3.3 §2b F-010-D2-POSTMORTEM — daily report's "
                f"Total governance events ({reported_total}) MUST "
                f"include the 4 planner + 6 worker drainer rows. "
                f"Pre-V3.3 reflection ran BEFORE drainers and this "
                f"count was ~0 even though governance.jsonl had ~10 "
                f"drainer-emitted rows by cycle end."
            ),
        )
        # Daily report total equals reflection's snapshot of
        # governance.jsonl row count — these MUST agree.
        reflection_total = (
            last_reflection.get("gate_activity", {}).get("total_events", 0)
        )
        self.assertEqual(
            reported_total, reflection_total,
            msg=(
                f"V3.3 §2b — daily report's reported total "
                f"({reported_total}) MUST equal reflection's "
                f"gate_activity.total_events ({reflection_total}); "
                f"label-vs-data semantics, no drift."
            ),
        )

    # I-V3.3-07 — defer_reflection=True returns reflection=None.
    def test_i_v3_3_07_defer_reflection_returns_none(self) -> None:
        from aria_kernel.cycle import run_enterprise_cycle

        # Kwarg contract: defer_reflection exists + defaults to False.
        sig = inspect.signature(run_enterprise_cycle)
        self.assertIn(
            "defer_reflection", sig.parameters,
            msg=(
                "V3.3 §2b — run_enterprise_cycle MUST accept "
                "defer_reflection kwarg so the orchestrator can opt "
                "into post-drain reflection invocation."
            ),
        )
        self.assertEqual(
            sig.parameters["defer_reflection"].default, False,
            msg=(
                "V3.3 §2b — defer_reflection MUST default to False "
                "so direct CLI callers preserve the legacy inline-"
                "reflection contract."
            ),
        )

        # Behavioral verification: a direct cycle call with
        # defer_reflection=True returns state with reflection=None
        # AND emits no daily report. We invoke the cycle on a fully-
        # seeded tools_root + minimal workspace (init a git repo so
        # the cycle's git_head_sha lookup succeeds).
        import os
        import subprocess
        workspace = self.tmp / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["GIT_AUTHOR_NAME"] = "test"
        env["GIT_AUTHOR_EMAIL"] = "test@example.com"
        env["GIT_COMMITTER_NAME"] = "test"
        env["GIT_COMMITTER_EMAIL"] = "test@example.com"
        for argv in (
            ["git", "init", "-q", "-b", "main"],
            ["git", "config", "user.email", "test@example.com"],
            ["git", "config", "user.name", "test"],
        ):
            subprocess.run(argv, cwd=workspace, env=env, check=True)
        (workspace / "nx.json").write_text(
            '{"version": 2}\n', encoding="utf-8",
        )
        subprocess.run(
            ["git", "add", "."], cwd=workspace, env=env, check=True,
        )
        subprocess.run(
            ["git", "commit", "-q", "-m", "init"],
            cwd=workspace, env=env, check=True,
        )

        cycle_id = "cycle-v3_3-07"
        # Build a fresh tools root for this case.
        case_tools = self.tmp / "case_07_tools"
        case_tools.mkdir(parents=True, exist_ok=True)
        from aria_kernel.runtime_profile import set_profile
        set_profile(
            "standard",
            operator_approval_ref="v3_3-07",
            base_dir=case_tools,
        )

        state = run_enterprise_cycle(
            workspace_root=str(workspace),
            cycle_id=cycle_id,
            base_dir=case_tools,
            defer_reflection=True,
        )
        self.assertIsNone(
            state.get("reflection"),
            msg=(
                "V3.3 §2b — defer_reflection=True MUST cause "
                "state['reflection'] to be None; orchestrator owns "
                "post-drain reflection invocation."
            ),
        )
        # V3.3 §2b — no daily report should be written when
        # defer_reflection=True; the orchestrator owns post-drain
        # reflection invocation and the daily-report emission.
        reports_dir = case_tools / "reports" / "daily"
        if reports_dir.exists():
            md_files = list(reports_dir.glob("*.md"))
            self.assertEqual(
                md_files, [],
                msg=(
                    f"V3.3 §2b — defer_reflection=True MUST NOT write "
                    f"a daily report (orchestrator owns that). Found: "
                    f"{md_files!r}"
                ),
            )


if __name__ == "__main__":
    unittest.main()
