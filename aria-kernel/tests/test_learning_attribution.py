"""ARIA-HIGH-370 — failures are attributed from their own evidence, and the
lesson reaches the next envelope of the role whose work failed.

THE DEFECT. Measured on the runner store 2026-10-06: 19 drafter failure
episodes, 18 recorded ``attributable=false`` (13 ``stalled``, 5
``convergence_envelope_dead``, plus one ``operator_withdrawn`` recorded
attributable), so ``recurring_failure_modes`` — and with it the #1773 lesson
reader — never had an input. Each dead envelope's cause sat one join away on
the agent-invocation ledgers: the challenger's output refused by the plan
validator (``PLAN_CONTENT_INVALID``), its result refused by the evidence law
(``agent_evidence_ref_malformed``), or the challenger refusing the request
(``AGENT_REFUSED:evidence``).

Pinned here, through the kernel's own writers (plan ledger, request mint,
claim, release) and its own reader (``observe_agent_performance``):

1. each evidence type attributes its failure, to the role and agent it names;
2. a harness failure (runtime/provider unavailable, a stall, an operator act,
   a lane-class rejection) is never attributed;
3. episodes recorded before attribution existed are re-judged once, by an
   appended row that supersedes them, and re-observing appends nothing;
4. a mode recurring for the challenger reaches the next CHALLENGER envelope
   as a data block, not the primary's; the plan's own lesson reaches both.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.agent_eval import list_performance_observations, observe_agent_performance
from aria_kernel.agent_invocations import claim_request, release_claim
from aria_kernel.convergent_planning_bridge import issue_challenger_envelope
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.must_satisfy import must_satisfy_item
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.plan_convergence import abandon_plan, force_plan_human_required, start_plan

from tests.test_implementation_lifecycle_continuity import converging_plan_content

HR_SURFACE = [{"paths": ["apps/hr-service/src/leave/**"]}]
KIND = "observed_plan_failure_mode"
INVALID = "plan_content_invalid_plan_content_absent_or_not_object"


class _Ledgers(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.workspace = Path(self.tmp.name) / "workspace"
        leave = self.workspace / "apps" / "hr-service" / "src" / "leave"
        leave.mkdir(parents=True)
        (leave / "leave.service.ts").write_text("export const leave = 1;\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def start(self, plan_id: str) -> None:
        body = converging_plan_content(plan_id, affected_surfaces=HR_SURFACE, finding_id="ORPHAN-HIGH-104")
        start_plan(plan_id=plan_id, initial_revision_id="rev-0", plan_content=body,
                   base_dir=self.tools, workspace_root=self.workspace)

    def challenger(self, plan_id: str) -> dict[str, Any]:
        return issue_challenger_envelope(
            plan_id=plan_id, round_number=1,
            must_satisfy=[must_satisfy_item(id="draft", description="write a competing plan")],
            evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["apps/**"], base_dir=self.tools,
            cycle_id="cyc-370",
        )

    def dead_challenger(self, plan_id: str, *, release: str | None = None,
                        rejected_codes: list[str] | None = None) -> None:
        """A plan whose challenger envelope died the way the executor records it."""
        self.start(plan_id)
        request = self.challenger(plan_id)
        claim = claim_request(request_id=request["request_id"], agent_id="executor:test", base_dir=self.tools)
        if rejected_codes is not None:
            append_declared_jsonl(
                self.tools / "agent-invocations" / "results.jsonl",
                {"schema_version": 1, "row_type": "result", "row_id": f"result:{claim['claim_id']}:rejected",
                 "request_id": request["request_id"], "claim_id": claim["claim_id"], "status": "rejected",
                 "rejection_codes": rejected_codes},
                expected_surface="agent_invocation_results",
            )
        else:
            release_claim(claim_id=claim["claim_id"], agent_id="executor:test", lease_token=claim["lease_token"],
                          reason=str(release), base_dir=self.tools)
        force_plan_human_required(plan_id=plan_id, round_number=1,
                                  reason_codes=["convergence_envelope_dead:challenger_plan"], base_dir=self.tools)

    def episodes(self) -> dict[str, dict[str, Any]]:
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-370")
        return {row["plan_id"]: row for row in list_performance_observations(base_dir=self.tools)}


class EachEvidenceTypeAttributesTests(_Ledgers):
    def test_a_result_the_evidence_law_refused_is_the_challengers(self) -> None:
        self.dead_challenger("plan-law", rejected_codes=["agent_evidence_ref_malformed", "agent_evidence_not_repo_verified"])
        row = self.episodes()["plan-law"]
        self.assertTrue(row["attributable"])
        self.assertEqual(row["failure_mode"], "agent_evidence_ref_malformed")
        self.assertEqual({k: row["attribution"][k] for k in ("role", "agent", "evidence_type")},
                         {"role": "challenger_plan", "agent": "aria-challenger-planner", "evidence_type": "evidence_law"})

    def test_an_output_the_plan_validator_refused_is_a_gate_refusal(self) -> None:
        self.dead_challenger("plan-gate", release="plan_content_invalid:plan_content:absent_or_not_object")
        row = self.episodes()["plan-gate"]
        self.assertEqual((row["attributable"], row["failure_mode"], row["attribution"]["evidence_type"]),
                         (True, INVALID, "gate_refusal"))

    def test_an_agent_refusing_the_request_is_the_plans_failure(self) -> None:
        self.dead_challenger("plan-refused", release="agent_refused:evidence")
        attribution = self.episodes()["plan-refused"]["attribution"]
        self.assertEqual((attribution["role"], attribution["evidence_type"], attribution["detail"]),
                         ("drafter", "agent_refusal", "refused_by=aria-challenger-planner"))

    def test_an_unresolved_cross_review_risk_is_a_cross_review_rejection(self) -> None:
        self.start("plan-cr")
        force_plan_human_required(plan_id="plan-cr", round_number=4,
                                  reason_codes=["max_rounds_reached", "unresolved_material_risk"], base_dir=self.tools)
        row = self.episodes()["plan-cr"]
        self.assertEqual((row["failure_mode"], row["attribution"]["evidence_type"]),
                         ("unresolved_material_risk", "cross_review_rejection"))

    def test_an_apply_gate_check_is_the_implementers(self) -> None:
        events = self.tools / "plans" / "events.jsonl"
        for kind, payload in (("implementation_requested", {"implementer_agent": "aria-implementer"}),
                              ("implementation_rejected", {"rejection_class": "forbidden_scope_violation"})):
            append_declared_jsonl(events, {
                "schema_version": 1, "event_id": f"impl:{kind}", "event_type": kind, "plan_id": "plan-impl",
                "recorded_at": "2026-10-07T00:00:00+00:00", "idempotency_key": f"sha256:{kind}", "payload": payload,
            }, expected_surface="plan_convergence_events")
        row = self.episodes()["plan-impl"]
        self.assertEqual((row["role"], row["attributable"], row["attribution"]["evidence_type"]),
                         ("implementer", True, "apply_gate"))


class HarnessFailuresAreNeverAttributedTests(_Ledgers):
    def test_runtime_provider_and_lease_releases_teach_nothing(self) -> None:
        for n, reason in enumerate(("native_runtime_execution_unavailable", "provider_quota_unavailable:claude",
                                    "lease_expired", "claude_cli_exit_1")):
            self.dead_challenger(f"plan-harness-{n}", release=reason)
        rows = self.episodes()
        self.assertEqual({rows[f"plan-harness-{n}"]["attributable"] for n in range(4)}, {False})
        self.assertEqual({rows[f"plan-harness-{n}"]["failure_mode"] for n in range(4)},
                         {"convergence_envelope_dead"})

    def test_a_stall_an_operator_act_and_a_lane_rejection_teach_nothing(self) -> None:
        self.start("plan-stalled")
        abandon_plan(plan_id="plan-stalled", reason="stalled: no plan event (> 72h at adoption)", base_dir=self.tools)
        self.start("plan-withdrawn")
        force_plan_human_required(plan_id="plan-withdrawn", round_number=1, reason_codes=["operator_withdrawn"],
                                  base_dir=self.tools)
        self.start("plan-partial")
        force_plan_human_required(plan_id="plan-partial", round_number=1,
                                  reason_codes=["max_rounds_reached", "partial_cross_review_coverage"],
                                  base_dir=self.tools)
        rows = self.episodes()
        self.assertEqual([rows[p]["attributable"] for p in ("plan-stalled", "plan-withdrawn", "plan-partial")],
                         [False, False, False])


class RecordedEpisodesAreRejudgedOnceTests(_Ledgers):
    def test_a_row_recorded_before_attribution_is_superseded_and_the_rejudgement_is_stable(self) -> None:
        self.dead_challenger("plan-old", release="plan_content_invalid:plan_content:absent_or_not_object")
        # The row the pre-attribution observer wrote for this episode (origin/main).
        legacy = [row for row in self._derive() if row["plan_id"] == "plan-old"][0]
        append_declared_jsonl(self.tools / "memory" / "procedural.jsonl",
                              {**legacy, "failure_mode": "convergence_envelope_dead", "attributable": False,
                               "attribution": None, "cycle_id": "cyc-old", "recorded_at": "2026-10-06T00:00:00+00:00"},
                              expected_surface="memory_procedural")

        first = observe_agent_performance(base_dir=self.tools, cycle_id="cyc-370")
        second = observe_agent_performance(base_dir=self.tools, cycle_id="cyc-371")

        self.assertEqual((first["appended"], second["appended"]), (1, 0))
        current = [row for row in list_performance_observations(base_dir=self.tools) if row["plan_id"] == "plan-old"]
        self.assertEqual(len(current), 1)
        self.assertEqual((current[0]["failure_mode"], current[0]["supersedes"], current[0]["lineage_id"]),
                         (INVALID, legacy["episode_id"], legacy["episode_id"]))

    def _derive(self) -> list[dict[str, Any]]:
        from aria_kernel import agent_eval

        return agent_eval._unrecorded_episodes(self.tools)


class TheLessonReachesTheRolesNextEnvelopeTests(_Ledgers):
    def lessons(self, row: dict[str, Any]) -> list[dict[str, Any]]:
        return [item for item in row["must_satisfy"] if item.get("kind") == KIND]

    def test_a_recurring_challenger_failure_reaches_the_next_challenger_envelope_as_data(self) -> None:
        for n in (1, 2, 3):
            self.dead_challenger(f"plan-old-{n}", release="plan_content_invalid:plan_content:absent_or_not_object")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-370")
        self.start("plan-now")

        found = self.lessons(self.challenger("plan-now"))

        self.assertEqual([(o["id"], o["failure_mode"], o["attributed_role"], o["episodes"]) for o in found],
                         [(f"observed_plan_failure:challenger_plan:{INVALID}", INVALID, "challenger_plan", 3)])
        self.assertEqual(found[0]["plan_ids"], ["plan-old-1", "plan-old-2", "plan-old-3"])
        self.assertNotIn("absent_or_not_object", found[0]["description"])  # data, never the kernel's text

    def test_the_challengers_lesson_is_not_the_primarys_and_the_plans_own_lesson_is_both(self) -> None:
        from aria_kernel.planner_lessons import planner_lesson_obligations

        for n in (1, 2, 3):
            self.dead_challenger(f"plan-inv-{n}", release="plan_content_invalid:plan_content:absent_or_not_object")
            self.dead_challenger(f"plan-ref-{n}", release="agent_refused:evidence")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-370")
        self.start("plan-now")

        def ids(role: str) -> list[str]:
            return [o["id"] for o in planner_lesson_obligations(base_dir=self.tools, plan_id="plan-now",
                                                                envelope_role=role)]

        self.assertEqual(ids("primary_plan"), ["observed_plan_failure:agent_refused_evidence"])
        self.assertEqual(sorted(ids("challenger_plan")),
                         ["observed_plan_failure:agent_refused_evidence",
                          f"observed_plan_failure:challenger_plan:{INVALID}"])
        self.assertEqual(json.dumps(ids("primary_plan")).count("challenger_plan"), 0)


if __name__ == "__main__":
    unittest.main()
