"""ARIA-HIGH-260 — the aging F_FINDING source carries ADR-0003's loop guards.

Pre-fix the source (priority 3) turned one of ARIA's own findings into a
grounded plan unattended whenever no higher source converted, and admission
and conversion judged grounding only. ADR-0003 names the guards a source that
plans ARIA's own findings needs: an originating-skill self-loop guard
(prerequisite 3), a per-24h cap (4) and cycle detection (5). These pins drive
the production provider (``V9PressureSourceProvider``) over the shared
operator-request fixture and seed only the ledgers the kernel already writes:
plan events, ``synthesis_bound`` bindings, self-reverts and finding events.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import finding_grounding as fg
from aria_kernel.cycle_phases.plan_source import V9PressureSourceProvider
from aria_kernel.finding import EXTERNAL_ORIGINATING_SKILLS, ORIGINATING_SKILL_ALLOWLIST, findings_dir
from aria_kernel.genesis_policy import OVERRIDE_RELPATH
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.operator_feedback_ingestion import bind_plan_synthesis
from aria_kernel.plan_convergence import content_hash
from aria_kernel.self_revert import SELF_REVERTS_RELPATH, SELF_REVERTS_SURFACE
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.operator_requests import GROUNDED_FILE, OperatorRequestFixture

_ENTITY_FILE = "apps/hr-service/src/leave/leave.entity.ts"
_OTHER_FILE = "apps/farm-service/src/batch/batch.service.ts"
_ARIA_FILE = "aria-kernel/pyproject.toml"


def _ago(**delta: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(**delta)).replace(microsecond=0).isoformat()


class _LoopFixture(unittest.TestCase):
    def setUp(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Hermetic: only the F_FINDING and operator sources answer here.
        for name in ("scan_failing_ci", "scan_orphan_findings", "scan_github_issue_missions",
                     "synthesize_plan_content_from_cycle"):
            stub = mock.patch(f"aria_kernel.plan_synthesizer.{name}",
                              return_value=None if name.startswith("synthesize") else [])
            stub.start()
            self.addCleanup(stub.stop)
        self.fx = self.fresh_store()
        self._age = 0

    def fresh_store(self) -> OperatorRequestFixture:
        """A new checkout + tools store: the ledgers are append-only, so a second window needs one."""
        tmp = tempfile.TemporaryDirectory(prefix="aria-loop-guards-")
        self.addCleanup(tmp.cleanup)
        fixture = OperatorRequestFixture(Path(tmp.name))
        fixture.commit_files({_OTHER_FILE: "export const batch = 1;\n", _ARIA_FILE: "[project]\n"})
        return fixture

    # -- seeding the existing ledgers -------------------------------------------------
    def finding(self, finding_id: str, path: str, *, origin: str = "manual:operator",
                created: str | None = None) -> None:
        """Seed an OPEN finding. ``rank_candidate_sources`` orders F candidates by
        ascending age, so each seed is stamped older than the one before it and the
        provider meets them in seeding order."""
        body: dict[str, Any] = {"originating_skill": origin, "created_at": created or _ago(days=30)}
        self.fx.seed_finding(finding_id, refs=[f"{path}:3"], body=body)
        self._age += 1
        stamp = 2_000_000 - self._age
        os.utime(findings_dir(self.fx.repo) / f"{finding_id}.json", (stamp, stamp))

    def plan(self, plan_id: str, finding_id: str, *, started: str, source: str = "f_finding",
             surfaces: tuple[str, ...] = (GROUNDED_FILE,)) -> None:
        content = {"schema_version": 2, "title": plan_id, "summary": plan_id, "finding_id": finding_id,
                   "affected_surfaces": list(surfaces), "key_changes": [], "validation_commands": [],
                   "evidence_refs": []}
        bind_plan_synthesis(base_dir=self.fx.tools, cycle_id=f"cyc-{plan_id}", plan_content=content,
                            candidate={"source_type": source, "candidate_id": f"cand-{plan_id}"})
        self.plan_event(plan_id, "plan_started", started,
                        {"plan_content": content, "content_hash": content_hash(content)})

    def plan_event(self, plan_id: str, event_type: str, at: str, payload: dict[str, Any]) -> None:
        append_declared_fixture(self.fx.tools / "plans" / "events.jsonl", {
            "schema_version": 1, "event_id": f"{plan_id}:{event_type}", "event_type": event_type,
            "plan_id": plan_id, "recorded_at": at, "idempotency_key": f"{plan_id}:{event_type}",
            "payload": payload,
        }, expected_surface="plan_convergence_events")

    def merged(self, plan_id: str, at: str, merge_sha: str) -> None:
        self.plan_event(plan_id, "implementation_merged", at,
                        {"merge_sha": merge_sha, "merged_at": at, "idempotency_key_hash": "sha256:" + "0" * 64})

    def reverted(self, merge_sha: str, at: str, decision: str = "revert_opened") -> None:
        append_declared_fixture(self.fx.tools.joinpath(*SELF_REVERTS_RELPATH), {
            "schema_version": 1, "recorded_at": at, "cycle_id": "cyc-revert", "key": f"revert:{merge_sha}",
            "decision": decision, "trigger": "post_merge_ci_red", "pr_number": 7, "merge_sha": merge_sha,
        }, expected_surface=SELF_REVERTS_SURFACE)

    def policy(self, block: Any) -> None:
        path = self.fx.repo / OVERRIDE_RELPATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"f_finding_loop_guards": block}), encoding="utf-8")

    # -- reading what the provider did --------------------------------------------------
    def synthesize(self, cycle_id: str):
        return V9PressureSourceProvider().synthesize(
            cycle_id=cycle_id, workspace_root=self.fx.repo, base_dir=self.fx.tools, profile="standard",
        )

    def skips(self, cycle_id: str | None = None) -> list[tuple[str, str]]:
        rows = load_declared_jsonl(self.fx.tools / "governance.jsonl", expected_surface="tools_governance")
        return [(row["details"]["candidate_id"], row["details"].get("reason")) for row in rows
                if row["kind"] == "plan_candidate_conversion_skipped"
                and (cycle_id is None or row["details"]["cycle_id"] == cycle_id)]

    def skip_detail(self, candidate_id: str) -> dict[str, Any]:
        rows = load_declared_jsonl(self.fx.tools / "governance.jsonl", expected_surface="tools_governance")
        return next(row["details"] for row in rows if row["kind"] == "plan_candidate_conversion_skipped"
                    and row["details"]["candidate_id"] == candidate_id)

    def selected(self, envelope) -> tuple[str, str] | None:
        if envelope is None:
            return None
        return envelope.metadata["_pressure_source_type"], envelope.metadata["_candidate_id"]


class SelfLoopGuardTests(_LoopFixture):
    """ADR-0003 prerequisite 3 — the originating-skill self-loop guard."""

    def test_an_aria_finding_whose_plan_would_modify_aria_itself_is_refused(self) -> None:
        self.finding("F-020", _ARIA_FILE, origin="ai_consensus:judgment_pipeline")
        self.assertIsNone(self.synthesize("cyc-self"))
        self.assertEqual(self.skips("cyc-self"), [("F-020", fg.SELF_LOOP_ORIGIN_SURFACE)])
        detail = self.skip_detail("F-020")["loop_guard"]
        self.assertEqual(detail, {"originating_skill": "ai_consensus:judgment_pipeline", "surfaces": [_ARIA_FILE]})

    def test_a_finding_on_a_surface_aria_merged_a_change_to_is_refused(self) -> None:
        self.plan("plan-old", "F-005", started=_ago(days=10))
        self.merged("plan-old", _ago(days=9), "a" * 40)
        self.finding("F-021", GROUNDED_FILE, created=_ago(days=1))
        self.assertIsNone(self.synthesize("cyc-own"))
        self.assertEqual(self.skips("cyc-own"), [("F-021", fg.SELF_LOOP_OWN_CHANGE)])
        self.assertEqual(self.skip_detail("F-021")["loop_guard"], {"plan_id": "plan-old", "surfaces": [GROUNDED_FILE]})

    def test_a_watchdog_finding_after_a_watchdog_closure_is_refused(self) -> None:
        self.finding("F-030", _OTHER_FILE, origin="aria-watchdog:runtime_anomaly")
        self.fx.set_status("F-030", "RESOLVED")
        self.finding("F-031", GROUNDED_FILE, origin="aria-watchdog:runtime_anomaly")
        self.assertIsNone(self.synthesize("cyc-wd"))
        self.assertEqual(self.skips("cyc-wd"),
                         [("F-030", fg.FINDING_NOT_OPEN), ("F-031", fg.SELF_LOOP_WATCHDOG_RECENT)])

    def test_external_origins_are_exactly_the_operator_and_the_review_registry(self) -> None:
        # Widening this set lets ARIA's own findings plan ARIA's own paths unattended:
        # it is an ADR-0003 amendment, never a code edit alone (amendment 2026-10-02).
        self.assertEqual(EXTERNAL_ORIGINATING_SKILLS, {"manual:operator", "report_ingestion:external_pr"})
        self.assertLessEqual(EXTERNAL_ORIGINATING_SKILLS, ORIGINATING_SKILL_ALLOWLIST)


class DailyCapTests(_LoopFixture):
    """ADR-0003 prerequisite 4 — at most N F_FINDING plans start per rolling 24h."""

    def test_a_second_plan_within_24h_is_refused_and_one_after_24h_is_allowed(self) -> None:
        self.plan("plan-f", "F-040", started=_ago(hours=23), surfaces=(_OTHER_FILE,))
        # An operator-bound plan never counts against the unattended source.
        self.plan("plan-op", "F-041", started=_ago(hours=1), source="operator_feedback", surfaces=(_OTHER_FILE,))
        self.finding("F-042", GROUNDED_FILE)
        self.assertIsNone(self.synthesize("cyc-cap"))
        self.assertEqual(self.skips("cyc-cap"), [("F-042", fg.GLOBAL_CAP_EXCEEDED)])
        self.assertEqual(self.skip_detail("F-042")["loop_guard"], {"plans_started_24h": ["plan-f"], "limit": 1})
        # The same history one hour later in its life: the earlier plan is out of the window.
        self.fx = self.fresh_store()
        self.plan("plan-f", "F-040", started=_ago(hours=25), surfaces=(_OTHER_FILE,))
        self.finding("F-042", GROUNDED_FILE)
        self.assertEqual(self.selected(self.synthesize("cyc-after")), ("f_finding", "F-042"))
        self.assertEqual(self.skips("cyc-after"), [])

    def test_only_plans_started_inside_the_window_count(self) -> None:
        self.plan("plan-f", "F-040", started=_ago(hours=25), surfaces=(_OTHER_FILE,))
        self.finding("F-044", _ENTITY_FILE)
        self.plan("plan-h", "F-045", started=_ago(hours=2), surfaces=(_OTHER_FILE,))
        self.finding("F-046", GROUNDED_FILE)
        # One plan inside the window: the cap of 1 refuses both candidates.
        self.assertIsNone(self.synthesize("cyc-window"))
        self.assertEqual(self.skips("cyc-window"),
                         [("F-044", fg.GLOBAL_CAP_EXCEEDED), ("F-046", fg.GLOBAL_CAP_EXCEEDED)])
        self.assertEqual(self.skip_detail("F-044")["loop_guard"]["plans_started_24h"], ["plan-h"])

    def test_the_cap_is_the_policy_value_not_a_literal(self) -> None:
        self.policy({"max_plans_per_24h": 2})
        self.plan("plan-f", "F-040", started=_ago(hours=3), surfaces=(_OTHER_FILE,))
        self.finding("F-047", GROUNDED_FILE)
        self.assertEqual(self.selected(self.synthesize("cyc-two")), ("f_finding", "F-047"))
        self.plan("plan-g", "F-048", started=_ago(hours=1), surfaces=(_OTHER_FILE,))
        self.assertIsNone(self.synthesize("cyc-three"))
        self.assertEqual(self.skips("cyc-three"), [("F-047", fg.GLOBAL_CAP_EXCEEDED)])

    def test_an_invalid_policy_refuses_every_f_candidate_by_name(self) -> None:
        self.policy({"max_plans_per_24h": "many"})
        self.finding("F-049", GROUNDED_FILE)
        self.assertIsNone(self.synthesize("cyc-policy"))
        self.assertEqual(self.skips("cyc-policy"), [("F-049", fg.LOOP_HISTORY_UNAVAILABLE)])
        self.assertEqual(self.skip_detail("F-049")["loop_guard"], {"fault": "loop_policy_invalid"})


class CycleDetectionTests(_LoopFixture):
    """ADR-0003 prerequisite 5 — a subject whose plan went wrong is not re-planned."""

    def test_a_reverted_subject_is_quarantined_until_an_operator_plan_for_it_merges(self) -> None:
        self.finding("F-007", GROUNDED_FILE)
        self.plan("plan-r", "F-007", started=_ago(days=12))
        self.merged("plan-r", _ago(days=11), "b" * 40)
        self.reverted("b" * 40, _ago(days=10))
        # Past the 7-day cool-off, the revert still holds the subject.
        self.assertIsNone(self.synthesize("cyc-q1"))
        self.assertEqual(self.skips("cyc-q1"), [("F-007", fg.SUBJECT_QUARANTINED)])
        self.assertEqual(self.skip_detail("F-007")["loop_guard"]["plan_id"], "plan-r")
        # The operator names the finding: the request converts at priority 0
        # and the orchestrator starts its plan.
        self.fx.record(finding_id="F-007", request_id="OP-lift")
        envelope = self.synthesize("cyc-q2")
        self.assertEqual(self.selected(envelope), ("operator_feedback", "OP-lift"))
        self.plan_event("plan-op", "plan_started", _ago(minutes=2),
                        {"plan_content": envelope.content, "content_hash": content_hash(envelope.content)})
        # A started operator plan can still be abandoned: the subject stays held.
        self.assertIsNone(self.synthesize("cyc-q3"))
        self.assertEqual(self.skips("cyc-q3"), [("F-007", fg.SUBJECT_QUARANTINED)])
        # The operator's resolution is on main; the aging source may plan the subject again.
        self.merged("plan-op", _ago(minutes=1), "e" * 40)
        self.assertEqual(self.selected(self.synthesize("cyc-q4")), ("f_finding", "F-007"))

    def test_a_failed_plan_cools_its_subject_off_for_seven_days(self) -> None:
        self.finding("F-070", GROUNDED_FILE)
        self.finding("F-071", _ENTITY_FILE)
        self.plan("plan-a", "F-070", started=_ago(days=3))
        self.plan_event("plan-a", "implementation_rejected", _ago(days=2),
                        {"rejection_class": "ci_check_red", "rejected_at": _ago(days=2)})
        self.plan("plan-b", "F-071", started=_ago(days=9), surfaces=(_ENTITY_FILE,))
        self.plan_event("plan-b", "plan_abandoned", _ago(days=8),
                        {"reason": "x", "abandoned_from_state": "OPEN"})
        self.assertEqual(self.selected(self.synthesize("cyc-cool")), ("f_finding", "F-071"))
        self.assertEqual(self.skips("cyc-cool"), [("F-070", fg.SUBJECT_COOL_OFF)])
        self.assertEqual(self.skip_detail("F-070")["loop_guard"]["cause"], "plan_failed")

    def test_a_new_finding_on_what_the_plan_changed_cools_the_subject_off(self) -> None:
        self.finding("F-080", GROUNDED_FILE)
        self.plan("plan-m", "F-080", started=_ago(days=4))
        self.merged("plan-m", _ago(days=3), "c" * 40)
        self.finding("F-081", GROUNDED_FILE, created=_ago(days=1))
        self.assertIsNone(self.synthesize("cyc-new"))
        self.assertEqual(self.skips("cyc-new"),
                         [("F-080", fg.SUBJECT_COOL_OFF), ("F-081", fg.SELF_LOOP_OWN_CHANGE)])
        detail = self.skip_detail("F-080")["loop_guard"]
        self.assertEqual((detail["cause"], detail["finding"]), ("new_finding_on_subject", "F-081"))

    def test_three_watchdog_resolutions_in_a_row_stop_the_source_this_cycle(self) -> None:
        for number in (50, 51, 52):
            self.finding(f"F-0{number}", _OTHER_FILE, origin="aria-watchdog:stall")
            self.fx.set_status(f"F-0{number}", "RESOLVED")
        self.finding("F-053", GROUNDED_FILE)
        self.assertIsNone(self.synthesize("cyc-streak"))
        self.assertEqual(self.skips("cyc-streak")[-1], ("F-053", fg.WATCHDOG_RESOLUTION_STREAK))
        self.assertEqual({reason for _id, reason in self.skips("cyc-streak")[:-1]}, {fg.FINDING_NOT_OPEN})


class ScopeTests(_LoopFixture):
    def test_an_unrelated_f_finding_still_converts(self) -> None:
        self.finding("F-090", GROUNDED_FILE)
        self.plan("plan-x", "F-090", started=_ago(days=3))
        self.plan_event("plan-x", "plan_abandoned", _ago(days=2), {"reason": "x", "abandoned_from_state": "OPEN"})
        self.finding("F-091", _OTHER_FILE)
        envelope = self.synthesize("cyc-unrelated")
        self.assertEqual(self.selected(envelope), ("f_finding", "F-091"))
        self.assertEqual(envelope.content["affected_surfaces"], [_OTHER_FILE])
        self.assertEqual(self.skips("cyc-unrelated"), [("F-090", fg.SUBJECT_COOL_OFF)])

    def test_operator_requests_bypass_all_three_guards(self) -> None:
        self.finding("F-007", _ARIA_FILE, origin="ai_consensus:judgment_pipeline")
        self.plan("plan-r", "F-007", started=_ago(days=5), surfaces=(_ARIA_FILE,))
        self.merged("plan-r", _ago(days=4), "d" * 40)
        self.reverted("d" * 40, _ago(days=3))
        self.plan("plan-cap", "F-099", started=_ago(hours=1), surfaces=(_OTHER_FILE,))
        context = fg.load_grounding_context(self.fx.repo, tools_root=self.fx.tools)
        aging = fg.admit_candidate({"source_type": "f_finding", "candidate_id": "F-007"}, context)
        self.assertEqual(aging.reason, fg.GLOBAL_CAP_EXCEEDED)
        self.fx.record(finding_id="F-007", request_id="OP-bypass")
        envelope = self.synthesize("cyc-bypass")
        self.assertEqual(self.selected(envelope), ("operator_feedback", "OP-bypass"))
        self.assertEqual(envelope.content["finding_id"], "F-007")
        self.assertEqual(self.skips("cyc-bypass"), [])
        # Each guard alone would have refused the aging source.
        no_cap = fg.LoopHistory(context.loop_history.now, tuple(p for p in context.loop_history.plans
                                                                 if p.plan_id != "plan-cap"),
                                context.loop_history.reverted_at, (), 1, timedelta(days=7))
        quarantined = fg.judge_loop_guards(fg.GroundingContext(
            context.repo_root, context.anchor, context.findings, None, no_cap), fg.admit_finding(context, "F-007"))
        self.assertEqual(quarantined.reason, fg.SUBJECT_QUARANTINED)
        clean = fg.LoopHistory(context.loop_history.now, (), {}, (), 1, timedelta(days=7))
        self_loop = fg.judge_loop_guards(fg.GroundingContext(
            context.repo_root, context.anchor, context.findings, None, clean), fg.admit_finding(context, "F-007"))
        self.assertEqual(self_loop.reason, fg.SELF_LOOP_ORIGIN_SURFACE)

    def test_a_context_without_loop_history_refuses_the_aging_source(self) -> None:
        self.finding("F-060", GROUNDED_FILE)
        bare = fg.admit_candidate({"source_type": "f_finding", "candidate_id": "F-060"},
                                  fg.load_grounding_context(self.fx.repo))
        self.assertEqual((bare.reason, bare.loop_guard),
                         (fg.LOOP_HISTORY_UNAVAILABLE, {"fault": "tools_root_not_given"}))
        self.assertFalse(bare.affected_surfaces)


class RecordedOncePerCycleTests(_LoopFixture):
    def test_each_refusal_is_one_skip_event_per_candidate_per_cycle(self) -> None:
        self.plan("plan-f", "F-040", started=_ago(hours=2), surfaces=(_OTHER_FILE,))
        self.finding("F-061", GROUNDED_FILE)
        self.finding("F-062", _ENTITY_FILE)
        self.synthesize("cyc-one")
        self.assertEqual(self.skips("cyc-one"),
                         [("F-061", fg.GLOBAL_CAP_EXCEEDED), ("F-062", fg.GLOBAL_CAP_EXCEEDED)])
        self.synthesize("cyc-two")
        self.assertEqual(self.skips("cyc-two"),
                         [("F-061", fg.GLOBAL_CAP_EXCEEDED), ("F-062", fg.GLOBAL_CAP_EXCEEDED)])
        self.assertEqual(len(self.skips()), 4)
        rows = load_declared_jsonl(self.fx.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertFalse([row for row in rows if row["kind"] == "plan_candidate_source_selected"])


if __name__ == "__main__":
    unittest.main()
