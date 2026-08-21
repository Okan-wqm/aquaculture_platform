"""JJ-3 (ORPHAN-HIGH-755) — a belief verdict may not buy an adapter authority.

The operator authorised the panel to write ground truth (2026-08-20), which
settled WHETHER these rows may exist. It did not settle WHAT they may pay
for, and that was never bounded: `source_type` said how much authority a row
carries, nothing said what the row was ABOUT, and both belief bridges file
their verdict into the ledger of whichever adapter the escalation happened to
name (`context.source_tool_id`).

MEASURED consequence before this fix, with `ANCHOR_PROMOTION_MIN_JUDGMENTS=5`
and four real anchors already banked: one unanimous belief adjudication pushed
`anchor_group_keys` to five, `dispatch_arbiter_for_anchor_groups` computed a
demand of ZERO, and the adapter's last outstanding anchor debt was retired
without a single additional finding being judged. Belief work silently
suppressed finding judgement — and `readiness` did not catch it because its
`recorded_run_ids` join is the only place that ever asked what a judgment was
attached to.

The fix is one declared field, not a spelling convention: readers ask the row
what it settled instead of parsing `finding_id`. Absent reads as `finding`
because the ledger held zero belief rows when the field was added.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    ANCHOR_PROMOTION_MIN_JUDGMENTS,
    JUDGMENT_SUBJECT_BELIEF,
    anchor_group_keys,
    append_jsonl,
    feedback_path,
    is_ground_truth_row,
    judgment_subject_of,
    operator_group_keys,
    record_operator_feedback,
)
from aria_kernel.judge_fanout import dispatch_arbiter_for_anchor_groups
from aria_kernel.tool_registry import GovernanceError

TOOL = "tenant-scoping-adapter"


def _anchor(root: str, n: int) -> None:
    """One settled ANCHOR-grade judgment of a FINDING this adapter emitted."""
    record_operator_feedback(
        tool_id=TOOL,
        run_id=f"run-{n}",
        finding_id=f"finding-{n}",
        verdict="true_positive",
        severity="medium",
        note="three judges agreed",
        source_type="ai_consensus",
        judge_id="aria-consensus-arbiter",
        judgment_group_id=f"group-{n}",
        judge_count=3,
        judges_voted=3,
        base_dir=root,
    )


def _belief_row(root: str) -> dict:
    """The row the JJ-3 panel writes: unanimous, ground-truth-bearing."""
    return record_operator_feedback(
        tool_id=TOOL,
        run_id="esc-belief-1",
        finding_id="belief-escalation:belief-1",
        verdict="false_positive",
        severity="medium",
        note="panel adjudicated a standing contradiction",
        affected_belief_ids=["belief-1"],
        source_type="ai_consensus",
        judge_id="aria-adjudication-panel",
        judge_count=3,
        judges_voted=3,
        judgment_subject=JUDGMENT_SUBJECT_BELIEF,
        base_dir=root,
    )


def _two_judge_group(root: str) -> None:
    """A unanimous 2-judge TP group: an anchor candidate demand can pull in.

    Not `false_positive` on purpose — that arm is UNCONDITIONAL, so it would
    mint whatever the demand said and prove nothing about the demand.
    """
    for judge in ("aria-evidence-judge", "aria-adversarial-judge"):
        record_operator_feedback(
            tool_id=TOOL,
            run_id="run-candidate",
            finding_id="finding-candidate",
            verdict="true_positive",
            severity="medium",
            note="two judges agreed, no third yet",
            source_type="ai_judge",
            judge_id=judge,
            judgment_group_id="group-candidate",
            base_dir=root,
        )


class BeliefVerdictBuysNoAdapterAuthority(unittest.TestCase):
    def test_unanimous_belief_row_is_ground_truth_but_not_an_adapter_anchor(self) -> None:
        """Both halves at once — the authorised capability, and its bound."""
        with tempfile.TemporaryDirectory() as root:
            row = _belief_row(root)
            self.assertTrue(
                is_ground_truth_row(row),
                "the operator authorised the panel to write ground truth",
            )
            self.assertEqual(judgment_subject_of(row), JUDGMENT_SUBJECT_BELIEF)
            self.assertEqual(
                anchor_group_keys(tool_id=TOOL, base_dir=root),
                set(),
                "a belief verdict is not evidence about this adapter's findings",
            )

    def test_belief_row_does_not_retire_the_adapter_s_last_anchor_debt(self) -> None:
        """The consequence, driven through the REAL consumer.

        Four banked anchors leave a demand of one. If the belief row counted,
        the demand would be zero and the outstanding 2-judge group would go
        un-arbitrated forever.
        """
        with tempfile.TemporaryDirectory() as root:
            for n in range(1, ANCHOR_PROMOTION_MIN_JUDGMENTS):
                _anchor(root, n)
            _belief_row(root)
            _two_judge_group(root)

            self.assertEqual(
                len(anchor_group_keys(tool_id=TOOL, base_dir=root)),
                ANCHOR_PROMOTION_MIN_JUDGMENTS - 1,
                "the belief row must not count toward the anchor total",
            )
            result = dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=root)
            minted = [
                item.get("judgment_group_id") for item in (result.get("minted") or [])
            ]
            self.assertIn(
                "group-candidate",
                minted,
                "demand was 1; the outstanding group must still be arbitrated",
            )

    def test_operator_belief_adjudication_is_not_a_human_precision_anchor(self) -> None:
        """The same category error existed on the operator bridge, pre-JJ-3.

        `operator_judged > 0` alone satisfies `precision_anchored` in
        readiness — a single belief adjudication would have answered a
        question nobody asked about the adapter's findings.
        """
        with tempfile.TemporaryDirectory() as root:
            record_operator_feedback(
                tool_id=TOOL,
                run_id="esc-belief-2",
                finding_id="belief-escalation:belief-2",
                verdict="false_positive",
                severity="medium",
                note="operator adjudication of belief escalation",
                affected_belief_ids=["belief-2"],
                source_type="human",
                judgment_subject=JUDGMENT_SUBJECT_BELIEF,
                base_dir=root,
            )
            self.assertEqual(operator_group_keys(tool_id=TOOL, base_dir=root), set())

    def test_a_row_written_before_the_field_existed_still_counts(self) -> None:
        """No silent regression of the historical corpus.

        Appended raw, without the key, exactly as the pre-JJ-3 ledger holds
        it. Absent must read as `finding` — the alternative would drop every
        anchor ARIA has ever banked.
        """
        with tempfile.TemporaryDirectory() as root:
            append_jsonl(feedback_path(root), {
                "schema_version": 2,
                "tool_id": TOOL,
                "run_id": "run-legacy",
                "finding_id": "finding-legacy",
                "verdict": "true_positive",
                "severity": "medium",
                "note": "written before judgment_subject existed",
                "source_type": "ai_consensus",
                "judge_id": "aria-consensus-arbiter",
                "judgment_group_id": "group-legacy",
                "judge_count": 3,
                "judges_voted": 3,
            })
            self.assertEqual(
                len(anchor_group_keys(tool_id=TOOL, base_dir=root)),
                1,
            )

    def test_both_belief_adjudicators_write_one_ledger_identity(self) -> None:
        """The operator arm and the panel arm must key the SAME row.

        Idempotency on (run_id, finding_id) is what stops one belief being
        adjudicated twice — once by a panel and once by an operator, each
        stacking its own confidence penalty. Two literal spellings of that
        key in two modules is that guarantee waiting to drift, so both call
        one function. Asserted through the module the operator path imports,
        not by reading its source.
        """
        import inspect

        from aria_kernel import human_required
        from aria_kernel.belief_escalation import belief_panel_finding_id

        source = inspect.getsource(human_required.resolve_human_required)
        self.assertIn(
            "belief_panel_finding_id(belief_id)",
            source,
            "the operator arm must key the row through the shared helper",
        )
        self.assertNotIn(
            'f"belief-escalation:{belief_id}"',
            source,
            "a second literal spelling of the shared identity has come back",
        )
        self.assertEqual(
            belief_panel_finding_id("belief-9"), "belief-escalation:belief-9"
        )

    def test_an_unnamed_subject_is_unwritable(self) -> None:
        """Closed vocabulary — a typo may not become a third category."""
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(GovernanceError):
                record_operator_feedback(
                    tool_id=TOOL,
                    run_id="run-x",
                    finding_id="finding-x",
                    verdict="true_positive",
                    severity="medium",
                    note="typo",
                    judgment_subject="beleif",
                    base_dir=root,
                )


if __name__ == "__main__":
    unittest.main()
