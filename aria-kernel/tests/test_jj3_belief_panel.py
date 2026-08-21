"""JJ-3 (ORPHAN-HIGH-755) — belief escalations stop requiring a human.

MEASURED before the fix: `escalation_adjudicability` had no
`belief_escalation` kind, and an unadmitted kind is irreducible BY
CONSTRUCTION there, so every standing contradiction minted by
`belief_escalation.escalate_stuck_contradictions` parked in the operator
queue while the Y7/Y8 panel beside it adjudicated lease deaths, genesis
candidates and tool promotions.

No new panel was written. The kind is admitted to the EXISTING panel
vocabulary; the existing `sweep_human_required_adjudications` phase opens and
folds it; the resolve arm calls an executor shaped exactly like the promotion
and genesis ones, and that executor re-derives the panel decision through the
SHARED `resolve_panel_adjudication_proof`.

THE BOUNDARY THESE TESTS EXIST FOR: `source_type="human"` is what judge
calibration and false-positive suppression score against. A panel row written
as human would be the judge fleet grading itself. Two independent mechanisms
keep it impossible — `resolve_human_required` refuses `verdict=` from a panel
resolver, and the executor has no `source_type` parameter at all — and both
are pinned below.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import human_required_adjudication as hra
from aria_kernel.belief_escalation import (
    BELIEF_ESCALATION_KIND,
    BELIEF_PANEL_SOURCE_TYPE,
    escalate_stuck_contradictions,
    execute_belief_panel_correction,
)
from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    is_ground_truth_row,
    load_feedback,
)
from aria_kernel.human_required import (
    OUTCOME_REFUSED,
    OUTCOME_RESOLVED,
    RESOLVED_BY_AGENT_PANEL,
    list_human_required,
    record_human_required,
    resolve_human_required,
)
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.memory import _feedback_adjustment, _record_contradiction
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_PANEL_AGENTS = ("judge-a", "judge-b", "judge-c")


def _stuck_belief(root: Path, belief_id: str) -> str:
    """Drive the REAL producer: three cycles of the same open contradiction."""
    for cycle_id in ("cyc-1", "cyc-2", "cyc-3"):
        _record_contradiction(
            root,
            cycle_id=cycle_id,
            belief_id=belief_id,
            reason="withdrawn belief candidate re-emitted by adapter",
            source_tool_id="adapter-x",
        )
    escalate_stuck_contradictions(cycle_id="cyc-3", base_dir=root)
    return f"HR-belief-{belief_id}"


def _read_record(root: Path, request_id: str) -> dict[str, Any]:
    return json.loads(
        (root / "human-required" / f"{request_id}.json").read_text(encoding="utf-8"),
    )


def _answer_panel(
    root: Path,
    escalation_id: str,
    verdict_value: str,
    *,
    dissent: int = 0,
) -> None:
    """Submit one opinion per member of the panel ALREADY open on this
    escalation — whoever opened it (a direct `open_adjudication` or the
    production sweep), read back off the adjudications ledger."""
    rows = [
        row
        for row in load_declared_jsonl(
            hra._adjudications_path(root),
            expected_surface="human_required_adjudications",
        )
        if row.get("escalation_request_id") == escalation_id
    ]
    request_ids = list(rows[-1]["request_ids"])
    invocations = root / "agent-invocations"
    invocations.mkdir(parents=True, exist_ok=True)
    for index, (rid, agent) in enumerate(zip(request_ids, _PANEL_AGENTS)):
        # `dissent` members vote the OPPOSITE way, so a split panel is a real
        # split and not a fixture flag.
        member_verdict = verdict_value
        if index >= len(request_ids) - dissent:
            member_verdict = (
                hra.REFUSE_VERDICT
                if verdict_value == hra.RESOLVE_VERDICT
                else hra.RESOLVE_VERDICT
            )
        output = invocations / f"{rid}.opinion.json"
        output.write_text(
            json.dumps({"verdict": member_verdict, "rationale": agent}),
            encoding="utf-8",
        )
        append_declared_jsonl(
            invocations / "claims.jsonl",
            {"request_id": rid, "claim_id": f"claim-{rid}", "agent_id": agent},
            expected_surface="agent_invocation_claims",
        )
        append_declared_jsonl(
            invocations / "results.jsonl",
            {
                "request_id": rid, "role": hra.ADJUDICATION_ROLE,
                "status": "accepted", "agent_id": agent,
                "output_path": output.as_posix(),
                "output_hash": "sha256:" + "0" * 64,
            },
            expected_surface="agent_invocation_results",
        )


def _drive_real_panel(
    root: Path,
    escalation_id: str,
    verdict_value: str,
    *,
    dissent: int = 0,
) -> hra.PanelVerdict:
    """Run the ACTUAL three-agent panel to a quorum and fold it.

    Deliberately not a hand-built resolved record (the JJ-2 lesson): a
    fixture that writes its own record chooses the fields, and never chooses
    the ones that would have failed.
    """
    hra.open_adjudication(
        escalation_request_id=escalation_id,
        record=_read_record(root, escalation_id),
        base_dir=root,
    )
    _answer_panel(root, escalation_id, verdict_value, dissent=dissent)
    return hra.adjudicate_human_required(
        escalation_request_id=escalation_id, base_dir=root,
    )


class BeliefEscalationIsAdmittedWithAnIdentity(unittest.TestCase):
    """PIN: an identity-less belief escalation still goes to a human."""

    def test_a_belief_escalation_naming_its_belief_is_adjudicable(self) -> None:
        verdict = hra.escalation_adjudicability(
            {"context": {"kind": BELIEF_ESCALATION_KIND, "belief_id": "B-1"}},
        )
        self.assertTrue(verdict.adjudicable, verdict.reason)

    def test_a_belief_escalation_without_a_belief_id_stays_with_the_operator(self) -> None:
        for context in (
            {"kind": BELIEF_ESCALATION_KIND},
            {"kind": BELIEF_ESCALATION_KIND, "belief_id": ""},
            {"kind": BELIEF_ESCALATION_KIND, "belief_id": "   "},
        ):
            with self.subTest(context=context):
                verdict = hra.escalation_adjudicability({"context": context})
                self.assertFalse(verdict.adjudicable)
                self.assertEqual(verdict.reason, "belief_escalation_missing:belief_id")

    def test_an_identity_less_escalation_cannot_even_open_a_panel(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-jj3-id-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            record_human_required(
                request_id="HR-belief-anonymous", severity="medium",
                reason="a contradiction whose belief nobody wrote down",
                context={"kind": BELIEF_ESCALATION_KIND, "belief_id": ""},
                base_dir=root,
            )
            with self.assertRaisesRegex(
                GovernanceError, "belief_escalation_missing:belief_id",
            ):
                hra.open_adjudication(
                    escalation_request_id="HR-belief-anonymous",
                    record=_read_record(root, "HR-belief-anonymous"),
                    base_dir=root,
                )
            # And the sweep leaves it in the human queue, open.
            swept = hra.sweep_human_required_adjudications(base_dir=root)
            self.assertEqual(swept["opened"], [])
            self.assertIn(
                "belief_escalation_missing:belief_id",
                [row["reason"] for row in swept["skipped"]],
            )
            self.assertEqual(
                _read_record(root, "HR-belief-anonymous")["status"], "open",
            )


class PanelResolveWritesTheCorrection(unittest.TestCase):
    """The whole chain, end to end, with the real producer and real panel."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj3-")
        self.addCleanup(self._tmp.cleanup)
        self.root = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def test_resolve_quorum_moves_belief_confidence_as_ai_consensus(self) -> None:
        escalation_id = _stuck_belief(self.root, "B-stuck")
        # Pre-adjudication baseline: nothing has moved this belief.
        self.assertEqual(_feedback_adjustment(self.root, "B-stuck"), 0.0)

        verdict = _drive_real_panel(self.root, escalation_id, hra.RESOLVE_VERDICT)

        self.assertEqual(verdict.outcome, OUTCOME_RESOLVED)
        record = _read_record(self.root, escalation_id)
        self.assertEqual(record["status"], "resolved")
        self.assertEqual(record["resolved_by"], RESOLVED_BY_AGENT_PANEL)
        self.assertEqual(record["panel_outcome"], OUTCOME_RESOLVED)

        rows = load_feedback(base_dir=self.root)
        self.assertEqual(len(rows), 1, rows)
        row = rows[0]
        self.assertEqual(row["source_type"], "ai_consensus")
        self.assertEqual(row["affected_belief_ids"], ["B-stuck"])
        self.assertEqual(row["verdict"], "false_positive")
        self.assertEqual(row["run_id"], escalation_id)
        self.assertEqual(row["finding_id"], "belief-escalation:B-stuck")
        self.assertEqual(row["tool_id"], "adapter-x")
        # judge_count 3 / judges_voted 3: three independent principals
        # agreed and none dissented, which is what makes this row an ANCHOR.
        self.assertEqual(row["judge_count"], hra.DEFAULT_PANEL_SIZE)
        self.assertEqual(row["judge_count"], 3)
        self.assertEqual(row["judges_voted"], 3)
        self.assertTrue(is_ground_truth_row(row))

        # The loop closes: the correction reaches belief confidence.
        self.assertEqual(_feedback_adjustment(self.root, "B-stuck"), -0.1)

    def test_the_panel_row_is_never_a_human_row(self) -> None:
        """CRITICAL — ground truth must not be polluted."""
        escalation_id = _stuck_belief(self.root, "B-ground-truth")
        _drive_real_panel(self.root, escalation_id, hra.RESOLVE_VERDICT)
        rows = load_feedback(base_dir=self.root)
        self.assertTrue(rows)
        for row in rows:
            self.assertNotEqual(row.get("source_type"), "human")
            self.assertEqual(row.get("source_type"), BELIEF_PANEL_SOURCE_TYPE)
            self.assertEqual(row.get("judge_id"), "aria-adjudication-panel")

    def test_a_panel_cannot_supply_a_ground_truth_verdict_at_all(self) -> None:
        """The second, independent guard: the `verdict=` parameter is the ONLY
        other door into a `source_type="human"` row, and it is barred for any
        non-operator resolver. Pinned here because the belief lane is now the
        loudest caller of that door's neighbour."""
        escalation_id = _stuck_belief(self.root, "B-guard")
        with self.assertRaisesRegex(
            GovernanceError, "agent_panel_cannot_supply_ground_truth_verdict",
        ):
            resolve_human_required(
                request_id=escalation_id,
                resolution_note="a panel trying to write human ground truth",
                resolved_by=RESOLVED_BY_AGENT_PANEL,
                panel_outcome=OUTCOME_RESOLVED,
                verdict="false_positive",
                base_dir=self.root,
            )
        self.assertEqual(_read_record(self.root, escalation_id)["status"], "open")
        self.assertEqual(load_feedback(base_dir=self.root), [])

    def test_the_executor_has_no_source_type_door(self) -> None:
        """Tier 1 over Tier 3: "human" is not refused at runtime, it is
        unreachable — the writer takes no source_type argument."""
        import inspect

        params = inspect.signature(execute_belief_panel_correction).parameters
        self.assertNotIn("source_type", params)
        self.assertNotIn("verdict", params)

    def test_a_split_panel_corrects_the_belief_but_is_not_ground_truth(self) -> None:
        """A 2-1 resolve still clears the escalation, and the row says so
        honestly: agreement 2, attendance 3 — below the anchor bar, so it can
        move one belief and settle nothing else."""
        escalation_id = _stuck_belief(self.root, "B-split")
        verdict = _drive_real_panel(
            self.root, escalation_id, hra.RESOLVE_VERDICT, dissent=1,
        )
        self.assertEqual(verdict.outcome, OUTCOME_RESOLVED)
        row = load_feedback(base_dir=self.root)[0]
        self.assertEqual(row["judge_count"], 2)
        self.assertEqual(row["judges_voted"], 3)
        self.assertLess(row["judge_count"], ANCHOR_MIN_JUDGE_COUNT)
        self.assertFalse(is_ground_truth_row(row))
        self.assertEqual(_feedback_adjustment(self.root, "B-split"), -0.1)

    def test_a_refuse_quorum_hands_the_belief_back_to_a_human(self) -> None:
        """A refusal settles nothing here — the contradiction is still open
        and `record_human_required` is idempotent on the record FILE, so a
        closed record would silence that belief forever. It stays open,
        CRITICAL, and writes no correction."""
        escalation_id = _stuck_belief(self.root, "B-refused")
        verdict = _drive_real_panel(self.root, escalation_id, hra.REFUSE_VERDICT)
        self.assertEqual(verdict.outcome, OUTCOME_REFUSED)
        record = _read_record(self.root, escalation_id)
        self.assertEqual(record["status"], "open")
        self.assertEqual(record["severity"], "CRITICAL")
        self.assertEqual(
            record["panel_disposition"], hra.DISPOSITION_ESCALATE_OPERATOR,
        )
        self.assertEqual(load_feedback(base_dir=self.root), [])
        self.assertEqual(_feedback_adjustment(self.root, "B-refused"), 0.0)
        self.assertIn(BELIEF_ESCALATION_KIND, hra.REFUSE_HANDS_TO_OPERATOR_KINDS)

    def test_a_re_fold_does_not_stack_a_second_correction(self) -> None:
        escalation_id = _stuck_belief(self.root, "B-idempotent")
        _drive_real_panel(self.root, escalation_id, hra.RESOLVE_VERDICT)
        hra.adjudicate_human_required(
            escalation_request_id=escalation_id, base_dir=self.root,
        )
        self.assertEqual(len(load_feedback(base_dir=self.root)), 1)
        self.assertEqual(_feedback_adjustment(self.root, "B-idempotent"), -0.1)

    def test_a_hand_built_record_corrects_nothing(self) -> None:
        """The JJ-2 lesson, applied before it could be re-learned: the
        executor re-derives the panel decision from the record FILE through
        the shared resolver, so a caller's dict proves nothing."""
        with self.assertRaisesRegex(GovernanceError, "belief_panel_adjudication_not_found"):
            execute_belief_panel_correction(
                escalation_id="HR-belief-never-adjudicated",
                record={
                    "context": {"kind": BELIEF_ESCALATION_KIND, "belief_id": "B-forged"},
                },
                judge_count=3, judges_voted=3, base_dir=self.root,
            )
        self.assertEqual(load_feedback(base_dir=self.root), [])

    def test_a_refused_panel_ref_cannot_be_replayed_as_an_approval(self) -> None:
        escalation_id = _stuck_belief(self.root, "B-replay")
        _drive_real_panel(self.root, escalation_id, hra.REFUSE_VERDICT)
        with self.assertRaisesRegex(GovernanceError, "belief_panel_adjudication"):
            execute_belief_panel_correction(
                escalation_id=escalation_id,
                record=_read_record(self.root, escalation_id),
                judge_count=3, judges_voted=3, base_dir=self.root,
            )
        self.assertEqual(load_feedback(base_dir=self.root), [])


class HumanQueueShrinksByExactlyTheRoutedKinds(unittest.TestCase):
    """PIN: the human-required queue shrinks by the routed kinds and NOTHING
    else. Measured as the residue the panel sweep declines to touch."""

    def test_only_identity_bearing_belief_escalations_leave_the_queue(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-jj3-queue-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            queue = {
                "HR-belief-routed": {
                    "kind": BELIEF_ESCALATION_KIND, "belief_id": "B-routed",
                },
                "HR-belief-anonymous": {"kind": BELIEF_ESCALATION_KIND},
                "HR-profile": {"kind": "profile_transition"},
                "HR-credential": {"kind": "credential_mint"},
                "HR-unknown": {"kind": "a_brand_new_escalation_source"},
            }
            for request_id, context in queue.items():
                record_human_required(
                    request_id=request_id, severity="medium",
                    reason=f"queue member {request_id}",
                    context=context, base_dir=root,
                )
            swept = hra.sweep_human_required_adjudications(base_dir=root)
            residue = {row["request_id"] for row in swept["skipped"]}
            self.assertEqual(
                residue,
                {"HR-belief-anonymous", "HR-profile", "HR-credential", "HR-unknown"},
            )
            self.assertEqual(swept["opened"], ["HR-belief-routed"])
            # The irreducible class is untouched by this change: each is
            # still refused for its OWN reason, not by accident.
            reasons = {row["request_id"]: row["reason"] for row in swept["skipped"]}
            self.assertEqual(
                reasons["HR-profile"], "irreducible_context_kind:profile_transition",
            )
            self.assertEqual(
                reasons["HR-unknown"],
                "context_kind_not_admitted:a_brand_new_escalation_source",
            )

    def test_the_open_queue_itself_shrinks_by_exactly_the_routed_record(self) -> None:
        """The literal measurement: `list_human_required` (the open queue a
        person reads) before and after the production sweep runs the belief
        lane end to end. Everything else is still waiting for a human."""
        with tempfile.TemporaryDirectory(prefix="aria-jj3-shrink-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            escalation_id = _stuck_belief(root, "B-routed")
            for request_id, context in (
                ("HR-belief-anonymous", {"kind": BELIEF_ESCALATION_KIND}),
                ("HR-profile", {"kind": "profile_transition"}),
                ("HR-unknown", {"kind": "a_brand_new_escalation_source"}),
            ):
                record_human_required(
                    request_id=request_id, severity="medium",
                    reason=f"queue member {request_id}",
                    context=context, base_dir=root,
                )
            before = {row["request_id"] for row in list_human_required(base_dir=root)}
            self.assertIn(escalation_id, before)

            # The production caller, twice: open the panels, then fold them.
            hra.sweep_human_required_adjudications(base_dir=root)
            _answer_panel(root, escalation_id, hra.RESOLVE_VERDICT)
            hra.sweep_human_required_adjudications(base_dir=root)

            after = {row["request_id"] for row in list_human_required(base_dir=root)}
            self.assertEqual(before - after, {escalation_id})
            self.assertEqual(
                after, {"HR-belief-anonymous", "HR-profile", "HR-unknown"},
            )


class CycleWiringPin(unittest.TestCase):
    """No new panel and no new phase: the belief lane rides the sweep that
    already opens and folds every other adjudicable kind. Behavioural — the
    sweep is RUN over a real belief escalation and observed opening a panel
    for it."""

    def test_the_existing_sweep_opens_and_folds_the_belief_lane(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-jj3-wire-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            escalation_id = _stuck_belief(root, "B-swept")
            opened = hra.sweep_human_required_adjudications(base_dir=root)
            self.assertEqual(opened["opened"], [escalation_id])
            # Second pass FOLDS the same panel instead of minting another —
            # the property that makes it safe every cycle.
            folded = hra.sweep_human_required_adjudications(base_dir=root)
            self.assertEqual(folded["opened"], [])
            self.assertEqual(folded["folded"], [escalation_id])

    def test_no_belief_specific_phase_was_added(self) -> None:
        from aria_kernel import cycle

        phase_names = [phase.name for phase in cycle.CYCLE_PHASES]
        self.assertIn("human_required_adjudication", phase_names)
        self.assertEqual([n for n in phase_names if "belief_panel" in n], [])


if __name__ == "__main__":
    unittest.main()
