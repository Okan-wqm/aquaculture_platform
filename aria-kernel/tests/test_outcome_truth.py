"""WP-J D-1 — outcome truth: a judged defect's mechanical outcome becomes
feedback that scores the judges that judged it.

What this suite pins, one property per test:

  * a promoted true-positive consensus whose finding demonstrably ran red
    and then verified green under the SAME recipe, whose fix merged and
    was never self-reverted, mints ONE ``source_type="outcome"`` feedback
    row keyed ``(judgment_group_id, consensus_run_id)``;
  * the mint is refused by the closed source-type vocabulary before the
    widening lands (``feedback_store.record_operator_feedback`` :589) —
    the red run of the happy-path test IS that refusal;
  * the vocabulary stays closed afterwards: an arbitrary source type is
    still refused;
  * every unmet leg is a NAMED skip, never a silent zero: not reproduced,
    recipe mismatch, not merged, self-reverted, non-true-positive
    consensus, missing join keys;
  * the mint is idempotent per (judgment_group_id, consensus_run_id).
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.change_ledger import emit_change_planned
from aria_kernel.feedback_store import (
    FEEDBACK_SOURCE_TYPES,
    load_feedback,
    load_jsonl,
    promotions_path,
    record_operator_feedback,
)
from aria_kernel.finding import findings_dir
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

_FINDING_ID = "F-901"
_GROUP = "judge:tool-x:fp-abc"
_CONSENSUS_RUN = "run-42"


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat()


class OutcomeTruthBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-outcome-truth-"))
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        self.now = datetime(2026, 10, 19, 3, 0, tzinfo=timezone.utc)
        self._consensus()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- fixture builders: producers where they exist, declared rows where
    # ---- the producer is another lane's scope (the promotion was minted by
    # ---- finding_promotion.promote_consensus_findings through this exact
    # ---- row constructor).

    def _consensus(self, *, verdict: str = "true_positive") -> None:
        record_operator_feedback(
            tool_id="tool-x", run_id=_CONSENSUS_RUN, finding_id="af-1",
            verdict=verdict, severity="high", note="consensus",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            judgment_group_id=_GROUP, judge_count=3, judges_voted=3,
            observers=[
                {"judge_id": "j-evidence", "model": "claude-opus-5"},
                {"judge_id": "j-adversarial", "model": "glm-5.3"},
                {"judge_id": "aria-consensus-arbiter", "model": "fable"},
            ],
            finding_fingerprint="fp-abc", base_dir=self.tools,
        )

    def _promotion(self) -> None:
        from aria_kernel.feedback_store import append_jsonl

        append_jsonl(
            promotions_path(self.tools),
            {
                "schema_version": 1, "recorded_at": _iso(self.now),
                "finding_fingerprint": "fp-abc", "finding_id": _FINDING_ID,
                "tool_id": "tool-x", "judgment_group_id": _GROUP,
                "consensus_run_id": _CONSENSUS_RUN, "request_ids": [],
                "target_sha": None,
            },
        )

    def _finding_event(self, event: str, *, recipe: str | None = None, extra: dict | None = None) -> None:
        events = findings_dir(self.repo) / "finding-events.jsonl"
        events.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "schema_version": 1, "event": event,
            "event_id": f"finding:{_FINDING_ID}:{event}:{_iso(self.now)}",
            "finding_id": _FINDING_ID, "recorded_at": _iso(self.now),
        }
        if event == "finding_emitted":
            row["record"] = {
                "finding_id": _FINDING_ID, "claim_type": "correctness",
                "status": "OPEN", "severity": "HIGH",
                "claim_summary": "defect", "evidences": [{"ref": "apps/svc/a.ts:1"}],
            }
            row["ledger_hash"] = "deadbeef"
        else:
            row.update({"experiment_id": "exp-1", "validation_run_id": "vr-1"})
            if recipe is not None:
                row["recipe_ref"] = recipe
            if extra:
                row.update(extra)
        append_declared_fixture(events, row, expected_surface="repo_finding_events")

    def _red_then_green(self, *, mismatch: bool = False) -> None:
        self._finding_event("finding_emitted")
        self._finding_event("finding_reproduced", recipe="recipe://r1")
        self._finding_event(
            "finding_fix_verified", recipe="recipe://r2" if mismatch else "recipe://r1",
            extra={"commit_sha": "0" * 40},
        )

    def _chain_and_merge(self, *, pr_number: int = 4242) -> None:
        planned = emit_change_planned(
            plan_id="plan-1", finding_id=_FINDING_ID,
            intended_affected_files=["apps/svc/a.ts"],
            intended_validation_refs=["nx test"], architectural_tier=1,
            base_dir=self.tools,
        )
        path = self.tools / "pr-lifecycle.jsonl"
        append_declared_fixture(
            path,
            {"schema_version": 1, "recorded_at": _iso(self.now - timedelta(hours=2)),
             # The writer's binding event (pr_manager writes `opened`;
             # main's merge_record.PR_BINDING_EVENT binds a PR to a change
             # through that row alone — merge-delivery-1).
             "event": "opened", "pr_number": pr_number,
             "change_id": planned["change_id"]},
            expected_surface="pr_lifecycle",
        )
        append_declared_fixture(
            path,
            {"schema_version": 1, "recorded_at": _iso(self.now - timedelta(hours=1)),
             "event": "merged", "pr_number": pr_number, "change_id": None,
             "head_lineage": "delivered", "merge_sha": "9" * 40},
            expected_surface="pr_lifecycle",
        )

    def _self_revert(self, merge_sha: str) -> None:
        from aria_kernel.self_revert import DECISION_LANDED, self_reverts_path

        append_declared_fixture(
            self_reverts_path(self.tools),
            {"schema_version": 1, "recorded_at": _iso(self.now),
             "key": f"revert:{merge_sha}", "decision": DECISION_LANDED,
             "trigger": "post_merge_ci_red", "merge_sha": merge_sha,
             "pr_number": 4242, "terminal": True},
            expected_surface="enterprise_self_reverts",
        )

    def _mint(self) -> dict:
        from aria_kernel.outcome_truth import mint_outcome_truth

        return mint_outcome_truth(repo_root=self.repo, base_dir=self.tools)

    def _outcome_rows(self) -> list[dict]:
        return [r for r in load_feedback(base_dir=self.tools) if r.get("source_type") == "outcome"]


class MintTests(OutcomeTruthBase):
    def test_red_then_green_merged_not_reverted_mints_one_outcome_row(self) -> None:
        self._red_then_green()
        self._chain_and_merge()
        self._promotion()
        result = self._mint()
        self.assertEqual(result["minted_count"], 1, result.get("skipped"))
        rows = self._outcome_rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["verdict"], "true_positive")
        self.assertEqual(row["judgment_group_id"], _GROUP)
        self.assertEqual(row["run_id"], _CONSENSUS_RUN)
        self.assertEqual(row["finding_id"], "af-1")
        self.assertEqual(row["source_type"], "outcome")
        self.assertTrue(str(row["judge_id"] or "").strip())

    def test_outcome_source_type_is_in_the_closed_vocabulary(self) -> None:
        self.assertIn("outcome", FEEDBACK_SOURCE_TYPES)
        # The vocabulary stays CLOSED: an arbitrary source type is still
        # refused by the same gate that refused 'outcome' before widening.
        with self.assertRaises(GovernanceError) as caught:
            record_operator_feedback(
                tool_id="tool-x", run_id="r", finding_id="f",
                verdict="true_positive", severity="medium", note="n",
                source_type="bogus", judge_id="j", base_dir=self.tools,
            )
        self.assertIn("unknown feedback source_type", str(caught.exception))

    def test_idempotent_per_group_and_consensus_run(self) -> None:
        self._red_then_green()
        self._chain_and_merge()
        self._promotion()
        first = self._mint()
        second = self._mint()
        self.assertEqual(first["minted_count"], 1)
        self.assertEqual(second["minted_count"], 0)
        self.assertEqual(len(self._outcome_rows()), 1)
        self.assertEqual(
            [s["reason"] for s in second["skipped"]],
            ["already_minted"],
            second["skipped"],
        )


class LoudSkipTests(OutcomeTruthBase):
    def test_consensus_not_true_positive_is_skipped_by_name(self) -> None:
        self._consensus(verdict="false_positive")
        self._red_then_green()
        self._chain_and_merge()
        self._promotion()
        result = self._mint()
        self.assertEqual(result["minted_count"], 0)
        self.assertEqual(result["skipped"][0]["reason"], "consensus_not_true_positive")
        self.assertEqual(self._outcome_rows(), [])

    def test_not_reproduced_is_skipped_by_name(self) -> None:
        self._finding_event("finding_emitted")
        self._finding_event("finding_fix_verified", recipe="recipe://r1", extra={"commit_sha": "0" * 40})
        self._chain_and_merge()
        self._promotion()
        result = self._mint()
        self.assertEqual(result["skipped"][0]["reason"], "not_reproduced")

    def test_recipe_mismatch_is_skipped_by_name(self) -> None:
        self._red_then_green(mismatch=True)
        self._chain_and_merge()
        self._promotion()
        result = self._mint()
        self.assertEqual(result["skipped"][0]["reason"], "recipe_mismatch")

    def test_not_merged_is_skipped_by_name(self) -> None:
        self._red_then_green()
        self._promotion()
        result = self._mint()
        self.assertEqual(result["skipped"][0]["reason"], "not_merged")

    def test_self_reverted_is_skipped_by_name(self) -> None:
        self._red_then_green()
        self._chain_and_merge()
        self._self_revert("9" * 40)
        self._promotion()
        result = self._mint()
        self.assertEqual(result["skipped"][0]["reason"], "self_reverted")

    def test_promotion_without_join_keys_is_skipped_by_name(self) -> None:
        self._red_then_green()
        self._chain_and_merge()
        from aria_kernel.feedback_store import append_jsonl

        append_jsonl(
            promotions_path(self.tools),
            {"schema_version": 1, "recorded_at": _iso(self.now),
             "finding_fingerprint": "fp-x", "finding_id": _FINDING_ID,
             "tool_id": "tool-x", "judgment_group_id": "", "consensus_run_id": "",
             "request_ids": [], "target_sha": None},
        )
        result = self._mint()
        self.assertEqual(result["skipped"][0]["reason"], "promotion_missing_join_keys")

    def test_missing_consensus_row_is_skipped_by_name(self) -> None:
        self._red_then_green()
        self._chain_and_merge()
        self._promotion()
        # A promotion whose consensus row is absent from the ledger.
        from aria_kernel.feedback_store import rewrite_jsonl

        rewrite_jsonl(promotions_path(self.tools), [
            {**row, "consensus_run_id": "run-OTHER"} for row in load_jsonl(promotions_path(self.tools))
        ])
        result = self._mint()
        self.assertEqual(result["skipped"][0]["reason"], "consensus_row_missing")


if __name__ == "__main__":
    unittest.main()
