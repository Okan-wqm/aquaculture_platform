"""A closed decision must be re-openable, and re-opening must be provable.

Every convergence gate in this kernel judges a plan on its way in. Once it
reaches CONVERGED nothing asks again, so two planners with a shared blind spot
produce a decision that is fast, agreed, wrong, and permanent. This suite pins
the phase that asks afterwards.

Three properties carry the weight, and each of them is a failure mode this
programme has actually shipped:

* the sample is DETERMINISTIC — a self-audit whose scope changes between runs
  cannot itself be audited;
* the phase is IDEMPOTENT against the invocation ledger rather than against a
  private "already asked" file — a second source of truth for a fact the first
  one holds is a divergence waiting to happen;
* the minted role is DISPATCHABLE — a `verification` envelope no executor can
  claim would be a writer with no reader, which is the exact defect class the
  E9 change set exists to close.

ARIA-HIGH-204 adds the fourth, the one the finding names: the answer is READ.
A phase that asks and never loads the answer back spends judge budget on
questions that cannot matter, so the fold suite pins that every accepted
verdict reaches the outcome ledger, that an overturn escalates, that a
re-fold appends nothing, that an unreadable verdict is recorded as unparsed
rather than dropped, and that an unanswered envelope is left to its executor.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.agent_surface import (
    DISPATCHABLE_ROLES,
    REQUEST_ROLES,
    allowed_targets_for_role,
)
from aria_kernel.human_required import list_human_required
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.decision_questioning import (
    CLOSED_DECISION_STATES,
    OUTCOMES_SURFACE,
    QUESTIONING_ROLE,
    already_questioned,
    closed_decisions,
    fold_questioning_results,
    open_decision_questioning,
    sample_decisions,
)
from aria_kernel.plan_convergence import (
    content_hash,
    evaluate_plan,
    plan_status,
    record_critique,
    request_critics,
    start_plan,
)

REVIEWER = "farm-expert"


class _QuestioningFixture(unittest.TestCase):
    """Shared fixture: a workspace, a tools dir, and the REAL convergence gate.

    The convergence is driven through `start_plan` → `request_critics` →
    `record_critique` → `evaluate_plan` rather than a hand-written terminal
    row, so the fold tests read answers to decisions the pipeline actually
    made — the same discipline the mint tests above are built on.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        (agents / f"{REVIEWER}.md").write_text(
            f"---\nname: {REVIEWER}\ndescription: Farm reviewer.\n---\n\nOwns `apps/farm-service/**`.\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # ---------------------------------------------------------------- helpers

    def _plan(self, title: str) -> dict:
        return {
            "schema_version": 1,
            "title": title,
            "summary": "Decision questioning fixture.",
            "key_changes": ["add ledger"],
            "evidence_refs": ["docs/aria/SPEC.md"],
            # The plan contract admits the canonical suite and requires the
            # tier claim of every body that converges through the real gate.
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/decision_questioning.py"]}],
            "architectural_tier": 2,
        }

    def _converge(self, plan_id: str) -> None:
        """Drive one plan through the real gate to CONVERGED.

        Deliberately not a hand-written ledger row: a fixture that fabricates
        the terminal state would keep passing after the reducer stopped
        producing it, and the phase would be pinned against a decision shape
        the pipeline no longer makes.
        """
        start_plan(
            plan_id=plan_id,
            initial_revision_id="rev-0",
            plan_content=self._plan(f"Plan {plan_id}"),
            base_dir=self.tools_dir,
        )
        state = plan_status(plan_id=plan_id, base_dir=self.tools_dir)
        latest = state["latest_revision"]
        request_critics(
            plan_id=plan_id,
            request={
                "round_number": 1,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    {
                        "task_id": f"task-{plan_id}",
                        "task_packet_hash": content_hash(
                            {"task_id": f"task-{plan_id}", "reviewer": REVIEWER}
                        ),
                        "target_agent": REVIEWER,
                        "target_revision_id": latest["revision_id"],
                        "target_plan_content_hash": latest["content_hash"],
                        "sla_deadline": (
                            datetime.now(timezone.utc) + timedelta(minutes=60)
                        ).isoformat().replace("+00:00", "Z"),
                    }
                ],
            },
            base_dir=self.tools_dir,
        )
        current = plan_status(plan_id=plan_id, base_dir=self.tools_dir)
        task = next(iter(current["rounds"][1]["tasks"].values()))
        record_critique(
            plan_id=plan_id,
            critique={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"],
                "reviewer": REVIEWER,
                "risks": [],
                "critique_content_hash": content_hash({"reviewer": REVIEWER, "risks": []}),
            },
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        evaluate_plan(plan_id=plan_id, round_number=1, base_dir=self.tools_dir)
        self.assertIn(
            plan_status(plan_id=plan_id, base_dir=self.tools_dir)["state"],
            CLOSED_DECISION_STATES,
        )

    # -------------------------------------------- questioning-answer helpers

    def _mint_question(self, plan_id: str) -> str:
        """Mint the plan's verification envelope and return its request id."""
        result = open_decision_questioning(base_dir=self.tools_dir)
        self.assertIn(plan_id, result["questioned"])
        requests = list_agent_invocation_requests(
            base_dir=self.tools_dir, convergence_id=plan_id, role=QUESTIONING_ROLE
        )
        self.assertEqual(len(requests), 1)
        return str(requests[0]["request_id"])

    def _envelope(
        self,
        request_id: str,
        plan_id: str,
        *,
        details: dict | None = None,
        rationale: str | None = None,
    ) -> dict:
        """The sealed response envelope, as the executor bridge persists it."""
        payload = {
            "$schema": "aria/agent-response/v1",
            "request_id": request_id,
            "claim_id": f"claim-{request_id}",
            "agent_id": "ci-executor:fixture",
            "role": QUESTIONING_ROLE,
            "status": "accepted",
            "satisfaction_matrix": [
                {"id": f"question-decision-{plan_id}", "verdict": "satisfied"}
            ],
        }
        if details is not None:
            payload["details"] = details
        if rationale is not None:
            payload["rationale"] = rationale
        return payload

    def _answer(self, request_id: str, payload: dict) -> None:
        """The accepted result row + its output artifact, as production writes them."""
        output = self.tools_dir / "agent-invocations" / "outputs" / f"{request_id}.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload), encoding="utf-8")
        append_declared_jsonl(
            self.tools_dir / "agent-invocations" / "results.jsonl",
            {
                "schema_version": 1,
                "row_type": "result",
                "row_id": f"result:claim-{request_id}",
                "claim_id": f"claim-{request_id}",
                "invocation_id": f"claim-{request_id}",
                "request_id": request_id,
                "agent_id": "ci-executor:fixture",
                "role": QUESTIONING_ROLE,
                "status": "accepted",
                "output_path": output.relative_to(self.tools_dir).as_posix(),
            },
            expected_surface="agent_invocation_results",
        )

    def _outcomes(self) -> list[dict]:
        return load_declared_jsonl(
            self.tools_dir / "decision-questioning" / "outcomes.jsonl",
            expected_surface=OUTCOMES_SURFACE,
        )

    def _governance_kinds(self) -> list[str]:
        return [
            str(row.get("kind"))
            for row in load_declared_jsonl(
                self.tools_dir / "governance.jsonl",
                expected_surface="tools_governance",
            )
        ]

    def _fold(self) -> dict:
        return fold_questioning_results(base_dir=self.tools_dir)


class DecisionQuestioningTests(_QuestioningFixture):
    # ------------------------------------------------------------------ tests

    def test_the_role_this_phase_mints_can_actually_be_claimed(self) -> None:
        # THE POINT OF THE WHOLE CHANGE. `verification` sat in REQUEST_ROLES
        # for a long time with no minter; adding a minter without adding the
        # dispatch pairing would replace a dead role with an unclaimable
        # envelope — the same defect wearing the opposite mask.
        self.assertIn(QUESTIONING_ROLE, REQUEST_ROLES)
        self.assertIn(QUESTIONING_ROLE, DISPATCHABLE_ROLES)
        self.assertEqual(allowed_targets_for_role(QUESTIONING_ROLE), ("aria-adversarial-judge",))

    def test_an_empty_ledger_questions_nothing_and_does_not_raise(self) -> None:
        # A phase that raises on an early cycle is a phase every caller
        # special-cases, and special cases are where phases get skipped.
        result = open_decision_questioning(base_dir=self.tools_dir)
        self.assertEqual(result["questioned"], [])
        self.assertEqual(result["request_ids"], [])

    def test_only_decisions_the_pipeline_acted_on_are_questioned(self) -> None:
        # An in-flight plan is still being judged by the gates that own it.
        start_plan(
            plan_id="plan-open",
            initial_revision_id="rev-0",
            plan_content=self._plan("Plan open"),
            base_dir=self.tools_dir,
        )
        self._converge("plan-closed")
        self.assertEqual(
            [row["plan_id"] for row in closed_decisions(base_dir=self.tools_dir)],
            ["plan-closed"],
        )

    def test_a_questioned_decision_gets_a_verification_envelope(self) -> None:
        self._converge("plan-closed")
        result = open_decision_questioning(base_dir=self.tools_dir)
        self.assertEqual(result["questioned"], ["plan-closed"])
        requests = list_agent_invocation_requests(
            base_dir=self.tools_dir, convergence_id="plan-closed", role=QUESTIONING_ROLE
        )
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["target_agent"], "aria-adversarial-judge")
        prompt = requests[0]["suggested_prompt"]
        # The prompt must refuse the cheap answer. An adversary told only to
        # "review" re-runs the convergence gate that already passed.
        self.assertIn("shared blind spot", prompt)
        self.assertIn("insufficient_evidence", prompt)

    def test_the_same_decision_is_never_questioned_twice(self) -> None:
        self._converge("plan-closed")
        first = open_decision_questioning(base_dir=self.tools_dir)
        second = open_decision_questioning(base_dir=self.tools_dir)
        self.assertEqual(first["questioned"], ["plan-closed"])
        self.assertEqual(second["questioned"], [])
        self.assertTrue(already_questioned("plan-closed", base_dir=self.tools_dir))
        self.assertEqual(
            len(
                list_agent_invocation_requests(
                    base_dir=self.tools_dir, convergence_id="plan-closed", role=QUESTIONING_ROLE
                )
            ),
            1,
        )

    def test_the_sample_is_deterministic_and_bounded(self) -> None:
        decisions = [
            {"plan_id": "a", "state": "CONVERGED", "decided_at": "2026-08-01T00:00:00Z"},
            {"plan_id": "b", "state": "CONVERGED", "decided_at": "2026-08-02T00:00:00Z"},
            {"plan_id": "c", "state": "CONVERGED", "decided_at": "2026-08-03T00:00:00Z"},
        ]
        self.assertEqual(
            [row["plan_id"] for row in sample_decisions(decisions, sample_size=2)], ["b", "c"]
        )
        self.assertEqual(
            sample_decisions(decisions, sample_size=2), sample_decisions(decisions, sample_size=2)
        )
        self.assertEqual(sample_decisions(decisions, sample_size=0), [])

    def test_sample_size_bounds_how_much_judge_budget_one_cycle_can_spend(self) -> None:
        # Unbounded self-questioning is how a meta-layer eats the cycle it
        # was supposed to improve.
        for plan_id in ("plan-1", "plan-2", "plan-3"):
            self._converge(plan_id)
        result = open_decision_questioning(base_dir=self.tools_dir, sample_size=1)
        self.assertEqual(len(result["questioned"]), 1)
        self.assertEqual(result["unquestioned_decisions_seen"], 3)


class AnOverturnedAnswerEscalates(_QuestioningFixture):
    """ARIA-HIGH-204 — the one verdict with an effect gets its effect."""

    def test_overturned_writes_an_outcome_row_and_a_human_required_record(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                details={
                    "questioning": {
                        "verdict": "overturned",
                        "rationale": "evidence_ref docs/aria/SPEC.md no longer resolves.",
                        "attacks_attempted": [
                            "shared blind spot", "the evidence", "the outcome",
                        ],
                    }
                },
            ),
        )

        summary = self._fold()

        self.assertEqual(summary["outcomes_written"], 1)
        self.assertEqual(summary["verdicts"]["overturned"], ["plan-closed"])
        self.assertEqual(summary["escalated"], ["plan-closed"])

        rows = self._outcomes()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["$schema"], "aria/decision-questioning-outcome/v1")
        self.assertEqual(row["plan_id"], "plan-closed")
        self.assertEqual(row["request_id"], request_id)
        self.assertEqual(row["result_row_id"], f"result:claim-{request_id}")
        self.assertEqual(row["verdict"], "overturned")
        self.assertEqual(
            row["attacks_attempted"],
            ["shared blind spot", "the evidence", "the outcome"],
        )

        # The escalation, keyed by the questioning envelope: an operator, not
        # a panel, reopens the decision (the context kind is unadmitted).
        records = list_human_required(base_dir=self.tools_dir)
        self.assertEqual([r["request_id"] for r in records], [request_id])
        record = records[0]
        self.assertEqual(record["severity"], "MEDIUM")
        self.assertTrue(
            record["reason"].startswith("decision_questioning_overturned:plan-closed"),
            msg=f"unexpected reason: {record['reason']!r}",
        )
        self.assertEqual(record["context"]["kind"], "decision_questioning")
        self.assertEqual(record["context"]["plan_id"], "plan-closed")

        # Both halves are on the audit chain: the fold and the escalation.
        kinds = self._governance_kinds()
        self.assertIn("decision_questioning_folded", kinds)
        self.assertIn("human_required_recorded", kinds)

    def test_a_second_fold_appends_nothing_and_re_escalates_nothing(self) -> None:
        # Idempotency is the result row, not the wall clock: a re-fold of the
        # same accepted answer is a no-op on the ledger and on the escalation
        # surface alike.
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                details={"questioning": {"verdict": "overturned"}},
            ),
        )
        first = self._fold()
        self.assertEqual(first["outcomes_written"], 1)

        second = self._fold()

        self.assertEqual(second["outcomes_written"], 0)
        self.assertEqual(second["escalated"], [])
        self.assertEqual(len(self._outcomes()), 1)
        # record_human_required is idempotent on the file: still one record.
        self.assertEqual(
            [r["request_id"] for r in list_human_required(base_dir=self.tools_dir)],
            [request_id],
        )


class AnUpheldAnswerIsRecordedWithoutEscalation(_QuestioningFixture):
    def test_upheld_writes_an_outcome_row_and_no_human_required(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                details={"questioning": {"verdict": "upheld"}},
            ),
        )

        summary = self._fold()

        self.assertEqual(summary["outcomes_written"], 1)
        self.assertEqual(summary["verdicts"]["upheld"], ["plan-closed"])
        self.assertEqual(summary["escalated"], [])
        rows = self._outcomes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["verdict"], "upheld")
        self.assertIn("decision_questioning_folded", self._governance_kinds())
        # The decision survived re-review: nobody needs to look at it.
        self.assertEqual(list_human_required(base_dir=self.tools_dir), [])

    def test_insufficient_evidence_is_recorded_without_escalation(self) -> None:
        # "Cannot tell" is an honest answer the contract asks for, not a
        # defect: it is folded like any other verdict and escalates nothing.
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                details={"questioning": {"verdict": "insufficient_evidence"}},
            ),
        )

        summary = self._fold()

        self.assertEqual(summary["verdicts"]["insufficient_evidence"], ["plan-closed"])
        self.assertEqual(summary["escalated"], [])
        self.assertEqual(
            [row["verdict"] for row in self._outcomes()], ["insufficient_evidence"],
        )
        self.assertEqual(list_human_required(base_dir=self.tools_dir), [])


class AnUnreadableVerdictIsRecordedNotDropped(_QuestioningFixture):
    """The silent-skip ban: an answer that cannot be parsed is still an answer."""

    def test_a_verdict_outside_the_closed_set_is_recorded_as_unparsed(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                details={"questioning": {"verdict": "maybe"}},
                rationale="cannot establish either way",
            ),
        )

        summary = self._fold()

        self.assertEqual(summary["verdicts"]["unparsed"], ["plan-closed"])
        rows = self._outcomes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["verdict"], "unparsed")
        self.assertTrue(
            str(rows[0].get("unparsed_reason") or ""),
            msg="an unparsed verdict must carry why it could not be read",
        )
        # Its own event name, so unparsed answers are countable as a class.
        self.assertIn("decision_questioning_verdict_unparsed", self._governance_kinds())
        self.assertNotIn("decision_questioning_folded", self._governance_kinds())
        # Unreadable is not overturned: no escalation.
        self.assertEqual(list_human_required(base_dir=self.tools_dir), [])

    def test_a_missing_output_artifact_is_unparsed_not_skipped(self) -> None:
        # The accepted row points at an artifact that is not there. Dropping
        # the row would hide a delivery integrity fault; recording it makes
        # the fold honest about what it could not read.
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        append_declared_jsonl(
            self.tools_dir / "agent-invocations" / "results.jsonl",
            {
                "schema_version": 1,
                "row_type": "result",
                "row_id": f"result:claim-{request_id}",
                "claim_id": f"claim-{request_id}",
                "request_id": request_id,
                "agent_id": "ci-executor:fixture",
                "role": QUESTIONING_ROLE,
                "status": "accepted",
                "output_path": "agent-invocations/outputs/gone.json",
            },
            expected_surface="agent_invocation_results",
        )

        summary = self._fold()

        self.assertEqual(summary["verdicts"]["unparsed"], ["plan-closed"])
        rows = self._outcomes()
        self.assertEqual(rows[0]["unparsed_reason"], "output_artifact_missing")


class AnUnansweredEnvelopeIsLeftToItsExecutor(_QuestioningFixture):
    def test_a_request_with_no_accepted_result_folds_nothing_and_raises_nothing(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        # No result row: the envelope is still owed an answer.

        summary = self._fold()

        self.assertEqual(summary["unanswered"], [request_id])
        self.assertEqual(summary["outcomes_written"], 0)
        self.assertEqual(summary["verdicts"]["upheld"], [])
        self.assertEqual(self._outcomes(), [])
        self.assertNotIn("decision_questioning_folded", self._governance_kinds())


class AVerificationEnvelopeFromAnotherLaneIsNotFolded(_QuestioningFixture):
    def test_a_foreign_verification_result_never_reaches_the_outcome_ledger(self) -> None:
        # The role is shared vocabulary; the questioning mint_satisfy prefix
        # is the lane's identity. A future sibling producer of
        # `verification` envelopes gets its own reader — its answers must not
        # be folded as decision-questioning outcomes (or escalate on their
        # behalf).
        from aria_kernel.agent_invocations import create_agent_invocation_request
        from aria_kernel.request_admission import admit_request

        self._converge("plan-closed")
        foreign = create_agent_invocation_request(
            target_agent="aria-adversarial-judge",
            role=QUESTIONING_ROLE,
            suggested_prompt="some other lane's verification question",
            must_satisfy=[{
                "id": "verify-something-else",
                "description": "a different lane's obligation",
            }],
            allowed_scope=["docs/**"],
            base_dir=self.tools_dir,
            admission=admit_request(
                "operator_cli.request", QUESTIONING_ROLE, base_dir=self.tools_dir,
            ),
        )
        self._answer(
            str(foreign["request_id"]),
            self._envelope(
                str(foreign["request_id"]),
                "plan-closed",
                details={"questioning": {"verdict": "overturned"}},
            ),
        )

        summary = self._fold()

        self.assertEqual(summary["requests_seen"], 0)
        self.assertEqual(summary["outcomes_written"], 0)
        self.assertEqual(self._outcomes(), [])
        self.assertEqual(list_human_required(base_dir=self.tools_dir), [])


class VerdictExtractionOrder(_QuestioningFixture):
    """WHERE the verdict is read from, strongest location first."""

    def test_the_declared_questioning_block_beats_prose(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                details={"questioning": {"verdict": "upheld"}},
                # Prose that names a different verdict: the declared field
                # is the contract; a scanner must not outvote it.
                rationale="the claim that the decision was overturned does not hold",
            ),
        )
        self._fold()
        self.assertEqual([row["verdict"] for row in self._outcomes()], ["upheld"])

    def test_details_verdict_is_the_second_location(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id, "plan-closed",
                details={"verdict": "insufficient_evidence"},
            ),
        )
        self._fold()
        self.assertEqual(
            [row["verdict"] for row in self._outcomes()], ["insufficient_evidence"],
        )

    def test_one_closed_set_token_in_the_prose_is_read(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                rationale=(
                    "verdict=overturned: evidence_ref docs/aria/SPEC.md no "
                    "longer resolves, so the decision rests on a tree that "
                    "no longer exists"
                ),
            ),
        )
        self._fold()
        self.assertEqual([row["verdict"] for row in self._outcomes()], ["overturned"])

    def test_two_verdict_tokens_is_unparsed_not_the_scanners_pick(self) -> None:
        self._converge("plan-closed")
        request_id = self._mint_question("plan-closed")
        self._answer(
            request_id,
            self._envelope(
                request_id,
                "plan-closed",
                rationale="not overturned, and I cannot honestly say upheld",
            ),
        )
        self._fold()
        rows = self._outcomes()
        self.assertEqual(rows[0]["verdict"], "unparsed")
        self.assertTrue(
            str(rows[0]["unparsed_reason"]).startswith("verdict_tokens_ambiguous"),
        )


class DecisionQuestioningIsACyclePhaseTest(unittest.TestCase):
    """The minter must be REACHED, not merely written.

    E9's own invariant hunts mechanisms with no production caller. A
    self-questioning organ that only tests ever call would be that defect
    wearing the fix's name, so the roster membership is pinned here: delete
    the phase and this test says so.
    """

    def _phase(self):
        from aria_kernel.cycle import CYCLE_PHASES

        matches = [phase for phase in CYCLE_PHASES if phase.name == "decision_questioning"]
        self.assertEqual(len(matches), 1, "decision_questioning must appear exactly once")
        return matches[0]

    def test_the_minter_is_registered_as_a_cycle_phase(self) -> None:
        from aria_kernel.cycle import WRITES_PERMITTED

        phase = self._phase()
        self.assertEqual(phase.stage, "post_tool")
        # Minting a request is an action: it must not run in the burn-in lane,
        # whose whole claim is that it took none.
        self.assertEqual(phase.modes, frozenset({"standard"}))
        self.assertIs(phase.precondition, WRITES_PERMITTED)
        # A crash here asked no question; it must not fail the night.
        self.assertEqual(phase.on_error, "record_and_continue")

    def test_the_phase_runner_calls_the_real_minter(self) -> None:
        from datetime import datetime as _datetime

        from aria_kernel.cycle import PhaseContext
        from aria_kernel.workspace import workspace_paths

        phase = self._phase()
        with tempfile.TemporaryDirectory() as workspace:
            repo_root = Path(workspace)
            tools_dir = ensure_tools_dir(str(repo_root / "tools"))
            context = PhaseContext(
                cycle_id="cycle-decision-questioning",
                workspace_root=repo_root,
                base_dir=tools_dir,
                workspace=workspace_paths(repo_root, repo_root / "workspace"),
                plan_id=None,
                shadow_only=False,
                defer_reflection=False,
                snapshot_mode="none",
                profile="observe",
                cycle_started_at=_datetime.now(timezone.utc),
                started_monotonic=0.0,
                results={},
                outcomes={},
            )
            result = phase.runner(context)
        # No closed decisions in a fresh tree: the contract is a summary,
        # not an exception — a phase that raises on an empty ledger is a
        # phase every early cycle has to special-case.
        self.assertEqual(result["$schema"], "aria/decision-questioning/v1")
        self.assertEqual(result["questioned"], [])

    def test_the_phase_folds_what_previous_cycles_answered(self) -> None:
        """ARIA-HIGH-204 — the phase must not stop at asking.

        The minter has a production caller; the fold is its reader twin, and
        a fold only reachable from tests would be the finding again. Pinned
        by invocation (the RC-7 lesson): patch where the phase looks the
        names up, run the real runner, and require the fold to run AFTER the
        mint — folding first would read an answer the same phase had not yet
        had the chance to ask for.
        """
        from datetime import datetime as _datetime

        from aria_kernel.cycle import PhaseContext
        from aria_kernel.workspace import workspace_paths

        calls: list[str] = []
        open_summary = {
            "$schema": "aria/decision-questioning/v1",
            "schema_version": 1,
            "unquestioned_decisions_seen": 0,
            "questioned": [],
            "request_ids": [],
            "request_admission_throttled": None,
            "target_agent": "aria-adversarial-judge",
            "sample_size": 2,
        }
        fold_summary = {
            "$schema": "aria/decision-questioning-fold/v1",
            "schema_version": 1,
            "cycle_id": None,
            "requests_seen": 0,
            "outcomes_written": 0,
            "unanswered": [],
            "verdicts": {},
            "escalated": [],
        }

        def _record_open(**_kwargs):
            calls.append("open")
            return dict(open_summary)

        def _record_fold(**_kwargs):
            calls.append("fold")
            return dict(fold_summary)

        phase = self._phase()
        with tempfile.TemporaryDirectory() as workspace:
            repo_root = Path(workspace)
            tools_dir = ensure_tools_dir(str(repo_root / "tools"))
            context = PhaseContext(
                cycle_id="cycle-decision-questioning-fold",
                workspace_root=repo_root,
                base_dir=tools_dir,
                workspace=workspace_paths(repo_root, repo_root / "workspace"),
                plan_id=None,
                shadow_only=False,
                defer_reflection=False,
                snapshot_mode="none",
                profile="observe",
                cycle_started_at=_datetime.now(timezone.utc),
                started_monotonic=0.0,
                results={},
                outcomes={},
            )
            with patch(
                "aria_kernel.decision_questioning.open_decision_questioning",
                side_effect=_record_open,
            ), patch(
                "aria_kernel.decision_questioning.fold_questioning_results",
                side_effect=_record_fold,
            ):
                result = phase.runner(context)

        self.assertEqual(calls, ["open", "fold"])
        # The fold summary rides the phase outcome, so the cycle state a
        # report reads carries the answers' fate, not just the asks.
        self.assertEqual(result["fold"]["$schema"], "aria/decision-questioning-fold/v1")


if __name__ == "__main__":
    unittest.main()
