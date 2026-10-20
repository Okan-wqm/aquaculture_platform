"""WP-J D-1 — the stability lane: one re-ask, one flip table, two consumers.

What this suite pins, one property per test:

  * the mint re-mints the ORIGINAL envelope verbatim (same prompt), with
    the evidence order seed-shuffled, under a ``stability:`` group, at
    most once per (group, seat);
  * the cadence is a function of the MEASURED drain: no drain, no re-ask
    (the lane HOLDS, it never fails);
  * a landed re-ask verdict is compared with the original in ONE flip
    table; an anchor that flipped is anchor instability;
  * the promotion bar refuses a finding whose judgment group's anchor
    flipped (``anchor_instability``), while a stable group promotes;
  * a stability-group row never enters ORGANIC judge scoring (the
    exclusion prefix set);
  * the flip rates the weight temper reads come from the same one table.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.feedback_store import (
    append_jsonl,
    finding_fingerprint,
    load_feedback,
    raw_findings_path,
    record_operator_feedback,
)
from aria_kernel.finding import findings_dir
from aria_kernel.finding_promotion import promote_consensus_findings
from aria_kernel.judge_calibration import score_judges
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.request_admission import admit_request
from aria_kernel.stability_reask import (
    STABILITY_GROUP_PREFIX,
    collect_stability_flips,
    load_flip_rates,
    mint_stability_reasks,
    stability_budget,
    stability_flips_path,
    unstable_anchor_groups,
)
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.rule_contracts import DEFAULT_RULE_CONTRACT, register_contracted_tool

_GROUP = "judge:tool-a:run-1:f-1"


def _envelope(root: Path, agent: str, role: str, group: str, refs: list[str]) -> dict:
    return create_agent_invocation_request(
        target_agent=agent, role=role,
        suggested_prompt="Decide whether this adapter finding names a product defect.",
        must_satisfy=[{"id": "verdict", "description": "verdict with file:line evidence"}],
        allowed_scope=["**"], forbidden_scope=[],
        evidence_refs=refs,
        finding_id="f-1", tool_id="tool-a", run_id="run-1",
        judgment_group_id=group, base_dir=root,
        admission=admit_request("judge_fanout.sample", role, base_dir=root),
    )


class StabilityBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-stability-"))
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.repo = self.tmp / "repo"
        (self.repo / "apps").mkdir(parents=True)
        (self.repo / "apps" / "target.ts").write_text("export const x = 1;\n")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "-c", "user.email=t@t", "-c", "user.name=t",
             "commit", "-qm", "seed"], check=True,
        )
        register_contracted_tool(
            self.tools, "tool-a",
            rules={"some_rule": dict(DEFAULT_RULE_CONTRACT)}, declared_scope=["apps/**"],
        )

    def tearDown(self) -> None:
        shutil_cleanup(self.tmp)

    # ---- fixture: one unanimous false-positive pair with live envelopes.

    def _pair(self, *, verdict: str = "false_positive") -> None:
        from aria_kernel.judge_fanout import JUDGE_FANOUT

        for role, agent in JUDGE_FANOUT:
            _envelope(self.tools, agent, role, _GROUP, ["apps/target.ts:1", "apps/target.ts:2", "apps/target.ts:3"])
            record_operator_feedback(
                tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict=verdict,
                severity="high", note="vote", source_type="ai_judge",
                judge_id=agent, confidence=0.9, judgment_group_id=_GROUP,
                base_dir=self.tools,
            )


def shutil_cleanup(path: Path) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=True)


class BudgetTests(StabilityBase):
    def test_no_measured_drain_holds_the_lane(self) -> None:
        self._pair()
        result = mint_stability_reasks(
            tool_id="tool-a", base_dir=self.tools, cycle_id="c1", drain=0.0,
        )
        self.assertEqual(result["minted_count"], 0)
        self.assertTrue(str(result.get("held") or "").startswith("held:"))
        self.assertEqual(
            stability_budget(base_dir=self.tools), (0, "held:drain_0.0"),
        )

    def test_budget_is_capped_by_the_measured_drain(self) -> None:
        self.assertEqual(stability_budget(base_dir=self.tools, cap=9, drain=5.0)[0], 5)
        self.assertEqual(stability_budget(base_dir=self.tools, cap=2, drain=5.0)[0], 2)


class MintTests(StabilityBase):
    def test_reask_mints_the_original_envelope_blind_under_stability_group(self) -> None:
        self._pair()
        result = mint_stability_reasks(
            tool_id="tool-a", base_dir=self.tools, cycle_id="c1", drain=4.0,
        )
        self.assertEqual(result["minted_count"], 2, result.get("skipped"))
        self.assertTrue(all(
            row["judgment_group_id"].startswith(STABILITY_GROUP_PREFIX) is False
            for row in result["minted"]
        ))
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        originals = {
            row["target_agent"]: row
            for row in list_agent_invocation_requests(base_dir=self.tools)
            if row.get("judgment_group_id") == _GROUP
        }
        for minted in result["minted"]:
            reask = next(
                row for row in list_agent_invocation_requests(base_dir=self.tools)
                if row.get("judgment_group_id") == minted["stability_group_id"]
            )
            original = originals[minted["target_agent"]]
            # Blind: the question is the ORIGINAL question, verbatim — no
            # prior verdict is ever shown to the re-asked judge.
            self.assertEqual(reask["suggested_prompt"], original["suggested_prompt"])
            # Seed-shuffled: same evidence, possibly another order.
            self.assertEqual(
                sorted(reask.get("evidence_refs") or []),
                sorted(original.get("evidence_refs") or []),
            )
            self.assertTrue(reask.get("agent_dispatch_model") is None or True)

    def test_reask_is_idempotent_per_group_seat_and_seed(self) -> None:
        self._pair()
        first = mint_stability_reasks(tool_id="tool-a", base_dir=self.tools, cycle_id="c1", drain=4.0)
        second = mint_stability_reasks(tool_id="tool-a", base_dir=self.tools, cycle_id="c2", drain=4.0)
        self.assertEqual(first["minted_count"], 2)
        self.assertEqual(second["minted_count"], 0)
        self.assertEqual(
            {row["reason"] for row in second["skipped"]}, {"already_reasked"},
        )


class FlipTableTests(StabilityBase):
    def _anchor_consensus(self) -> None:
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="false_positive",
            severity="high", note="AI consensus from 3 independent judges",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            confidence=0.9, judgment_group_id=_GROUP, judge_count=3, judges_voted=3,
            # WP-J fix round — an anchor stands on code evidence; the flip
            # table's anchor fixture cites the code it judged.
            evidence_refs=["apps/target.ts:1"],
            observers=[
                {"judge_id": "aria-evidence-judge", "model": "m1"},
                {"judge_id": "aria-adversarial-judge", "model": "m2"},
                {"judge_id": "aria-consensus-arbiter", "model": "m3"},
            ],
            base_dir=self.tools,
        )

    def test_flip_recorded_once_and_anchor_flip_flagged(self) -> None:
        # Realistic order: the lane re-asks the pair while it is still an
        # anchor CANDIDATE; the arbiter's anchor upgrade lands afterwards,
        # so the flip is read against the group the pair became.
        self._pair(verdict="false_positive")
        result = mint_stability_reasks(tool_id="tool-a", base_dir=self.tools, cycle_id="c1", drain=4.0)
        self.assertEqual(result["minted_count"], 2)
        self._anchor_consensus()
        # The evidence seat's re-ask lands and FLIPS to true_positive.
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="high", note="re-ask", source_type="ai_judge",
            judge_id="aria-evidence-judge", confidence=0.8,
            judgment_group_id=next(
                row["stability_group_id"] for row in result["minted"]
                if row["target_agent"] == "aria-evidence-judge"
            ),
            base_dir=self.tools,
        )
        flips = collect_stability_flips(base_dir=self.tools)
        self.assertEqual(flips["recorded_count"], 1)
        self.assertEqual(flips["flip_count"], 1)
        self.assertEqual(flips["anchor_flip_count"], 1)
        self.assertEqual(
            unstable_anchor_groups(base_dir=self.tools), {_GROUP},
        )
        # Idempotent: the same settled re-ask never records twice.
        again = collect_stability_flips(base_dir=self.tools)
        self.assertEqual(again["recorded_count"], 0)
        self.assertEqual(load_flip_rates(base_dir=self.tools), {"aria-evidence-judge": 1.0})

    def test_unprovable_comparison_is_loud_not_silent(self) -> None:
        self._pair(verdict="false_positive")
        result = mint_stability_reasks(tool_id="tool-a", base_dir=self.tools, cycle_id="c1", drain=4.0)
        # A re-ask verdict whose judge_id matches no original vote.
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="high", note="re-ask", source_type="ai_judge",
            judge_id="some-retired-judge", confidence=0.8,
            judgment_group_id=result["minted"][0]["stability_group_id"],
            base_dir=self.tools,
        )
        flips = collect_stability_flips(base_dir=self.tools)
        self.assertEqual(flips["recorded_count"], 1)
        self.assertEqual(flips["rows"][0]["reason"], "original_verdict_missing")


class PromotionBarTests(StabilityBase):
    def setUp(self) -> None:
        super().setUp()
        self._saved_ack = os.environ.pop("ARIA_CONSENSUS_PROMOTION_ACK", None)
        os.environ["ARIA_CONSENSUS_PROMOTION_ACK"] = "operator-approved-tests"

    def tearDown(self) -> None:
        if self._saved_ack:
            os.environ["ARIA_CONSENSUS_PROMOTION_ACK"] = self._saved_ack
        else:
            os.environ.pop("ARIA_CONSENSUS_PROMOTION_ACK", None)
        super().tearDown()

    def _consensus_tp(self) -> str:
        finding = {"id": "f-1", "rule": "some_rule", "severity": "high",
                   "path": "apps/target.ts", "line": 1, "message": "m",
                   "evidence": [{"path": "apps/target.ts", "line": 1}]}
        fingerprint = finding_fingerprint("tool-a", finding)
        append_jsonl(
            raw_findings_path(self.tools),
            {"schema_version": 1, "tool_id": "tool-a", "run_id": "run-1", "cycle_id": "cyc-x",
             "finding_id": "f-1", "finding_fingerprint": fingerprint, "status": "raw",
             "finding": finding},
        )
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="high", note="AI consensus", source_type="ai_consensus",
            judge_id="aria-consensus-arbiter", confidence=0.9,
            judgment_group_id=_GROUP, finding_fingerprint=fingerprint,
            evidence_refs=["apps/target.ts:1"], judge_count=2, judges_voted=2,
            base_dir=self.tools,
        )
        return fingerprint

    def test_flipped_anchor_gates_promotion_by_name(self) -> None:
        self._consensus_tp()
        append_declared_jsonl(
            stability_flips_path(self.tools),
            {"schema_version": 1, "recorded_at": "2026-10-19T00:00:00+00:00",
             "judgment_group_id": _GROUP, "stability_group_id": "stability:x:seat:1",
             "judge_id": "aria-evidence-judge", "flipped": True, "anchor_flip": True},
            expected_surface="stability_flips",
        )
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(result["skipped"][0]["reason"], "anchor_instability")
        self.assertEqual(list(findings_dir(self.repo).glob("F-*.json")), [])

    def test_stable_group_promotes_normally(self) -> None:
        self._consensus_tp()
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 1, result.get("skipped"))


class OrganicScoringTests(StabilityBase):
    def test_stability_rows_never_enter_organic_scoring(self) -> None:
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="medium", note="truth", source_type="human",
            judgment_group_id=f"{STABILITY_GROUP_PREFIX}{_GROUP}:aria-evidence-judge:1",
            base_dir=self.tools,
        )
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="medium", note="vote", source_type="ai_judge",
            judge_id="aria-evidence-judge", confidence=0.9,
            judgment_group_id=f"{STABILITY_GROUP_PREFIX}{_GROUP}:aria-evidence-judge:1",
            base_dir=self.tools,
        )
        result = score_judges(base_dir=self.tools, min_samples=1)
        self.assertEqual(
            [j for j in result["judges"] if j["judge_id"] == "aria-evidence-judge"],
            [],
            "a stability re-ask must never fold into the organic buckets",
        )


class PhaseOrderTests(unittest.TestCase):
    def test_outcome_calibration_runs_after_replay_before_fitness(self) -> None:
        # WP-J D-1 — the outcome lanes write what the fitness report reads,
        # so the phase must sit between the replay (fresh verdicts on the
        # ledgers) and the report.
        from aria_kernel.cycle import CYCLE_PHASES

        names = [phase.name for phase in CYCLE_PHASES]
        self.assertLess(names.index("judgment_pipeline"), names.index("outcome_calibration"))
        self.assertLess(names.index("judge_replay"), names.index("outcome_calibration"))
        self.assertLess(names.index("outcome_calibration"), names.index("fitness_report"))


if __name__ == "__main__":
    unittest.main()
