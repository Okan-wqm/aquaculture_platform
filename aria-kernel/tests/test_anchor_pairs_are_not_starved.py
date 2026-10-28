"""ARIA-MEDIUM-1087 — every unanimous true_positive pair gets its third seat, bounded per cycle.

The anchor arm is the only producer of the third judge that turns an agreeing
pair into ground truth. Its true_positive demand was the readiness shortfall,
``ANCHOR_PROMOTION_MIN_JUDGMENTS - len(anchor_group_keys(...))``, so a tool that
already held five anchors (they are false_positive anchors too: the demand
counts every verdict) got ``anchor_demand 0``. Measured at the branch base (main
tip 6c4ca84a1c):

  * a tool holding 5 false_positive anchors and one NEW unanimous true_positive
    pair: ``anchor_demand 0``, ``minted 0``; through the cycle phase
    ``arbiter_requests_minted 0``; the pair's consensus row is ``judge_count 2``,
    not ground truth, and promotion skips it ``not_ground_truth``;
  * ``anchor_candidate_groups`` spends the true_positive demand on false_positive
    CANDIDATES too (``remaining = max(remaining - 1, 0)`` sits outside the
    ``if verdict != "false_positive"``): with ``demand=1``, three false_positive
    pairs sorted before one true_positive pair return the three false_positive
    pairs only;
  * a pair whose arbiter is in flight is still returned and still spends a
    demand slot, so a bound counted over candidates head-of-line-blocks new
    pairs: seven pairs, bound 3, three phase runs mint ``(5, 5), (0, 5), (0, 5)``
    (minted this run, arbiters in total); two pairs never get an arbiter;
  * the policy key does not exist, so no operator value is read.

The repaired law: ``demand`` means "the most NEW true_positive pairs returned"; a
false_positive pair never spends it; a pair whose arbiter is already minted (or a
held group) spends nothing; a fingerprint that already has a committed finding is
not a candidate; the dispatcher's bound is the policy key
``anchor_tp_pairs_per_tool_per_cycle`` (default 5, a ceiling: the admission door
stays the real throttle) and its summary key is ``anchor_pair_bound``.

NEW API pinned by name (red at the base by assertion): the policy key, the
``minted`` keyword of ``anchor_candidate_groups``, the summary key
``anchor_pair_bound``. Pins GREEN at the base on purpose are marked where written.
"""
from __future__ import annotations

import inspect
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel import genesis_policy, judge_fanout, readiness
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.feedback_store import (
    ANCHOR_PROMOTION_MIN_JUDGMENTS,
    anchor_group_keys,
    append_jsonl,
    generate_ai_consensus,
    is_ground_truth_row,
    promotions_path,
    record_operator_feedback,
)
from aria_kernel.finding_promotion import promotion_row
from aria_kernel.genesis_policy import (
    JUDGMENT_PIPELINE_DEFAULTS,
    judgment_pipeline_policy,
    merge_with_override,
)
from aria_kernel.judge_fanout import (
    CONSENSUS_ARBITRATION_ROLE,
    anchor_candidate_groups,
    dispatch_arbiter_for_anchor_groups,
)
from aria_kernel.stability_reask import stability_candidates
from aria_kernel.tool_registry import ensure_tools_dir

from tests.test_judge_input_cites_the_line import FunnelStoreCase
from tests.test_promotion_funnel_e2e import TOOL_ID

KEY = "anchor_tp_pairs_per_tool_per_cycle"
TOOL = "tool-a"
A, C = "a" * 40, "c" * 40
EVIDENCE, ADVERSARIAL = "aria-evidence-judge", "aria-adversarial-judge"
_MODELS = {EVIDENCE: "claude-opus-5", ADVERSARIAL: "claude-opus-5"}


def _run_phase(funnel: Any, cycle_id: str) -> dict[str, Any]:
    return cycle_mod._phase_judgment_pipeline(
        cycle_mod.build_phase_context(cycle_id=cycle_id, workspace_root=funnel.workspace, base_dir=funnel.tools),
    )


def _with_bound(value: int) -> Any:
    """The cycle's policy accessor with the bound set: the operator's override."""
    real = genesis_policy.judgment_pipeline_policy

    def bounded(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {**real(*args, **kwargs), KEY: value}

    return patch("aria_kernel.genesis_policy.judgment_pipeline_policy", bounded)


class AnAnchorHoldingToolStillGetsItsTruePositivePairArbitrated(FunnelStoreCase):
    """D1 — THE discriminating test, end to end through the production phase."""

    def test_a_new_unanimous_true_positive_pair_is_arbitrated_and_promoted_beside_five_anchors(self) -> None:
        funnel = self.funnel(findings=6)
        requests = funnel.mint_judges()
        self.assertEqual(len(requests), 12)

        # F-1..F-5: both judges refute, so five false_positive pairs (the arm's
        # unconditional class), answered by their arbiters into five anchors.
        for request in requests:
            if request["finding_id"] != "F-6":
                funnel.answer(request, verdict="false_positive")
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)
        self.assertEqual(_run_phase(funnel, "cycle-fp")["arbiter_requests_minted"], 5)
        for arbiter in funnel.requests(role=CONSENSUS_ARBITRATION_ROLE):
            funnel.answer(arbiter, verdict="false_positive")
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)
        self.assertEqual(len(anchor_group_keys(tool_id=TOOL_ID, base_dir=funnel.tools)), 5, "setup: five anchors held")

        # Only now the NEW pair: F-6's judges agree true_positive.
        for request in requests:
            if request["finding_id"] == "F-6":
                funnel.answer(request, verdict="true_positive")
        pair = generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)["consensus"]
        self.assertEqual([(row["judge_count"], is_ground_truth_row(row)) for row in pair], [(2, False)])

        second = _run_phase(funnel, "cycle-tp")
        arbiters = [
            request for request in funnel.requests(role=CONSENSUS_ARBITRATION_ROLE)
            if request["finding_id"] == "F-6"
        ]
        with self.subTest("the pair gets its arbiter"):
            self.assertEqual(second["arbiter_requests_minted"], 1)
            self.assertEqual(len(arbiters), 1)

        for arbiter in arbiters:
            funnel.answer(arbiter, verdict="true_positive")
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)
        promotion = funnel.promote_findings()
        with self.subTest("the pair promotes and promotion skips none as not_ground_truth"):
            self.assertEqual(
                [skip for skip in promotion["skipped"] if skip.get("reason") == "not_ground_truth"], [],
            )
            self.assertEqual(promotion["promoted_count"], 1)


class _Ledger(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-m1087-")
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def pair(self, finding: str, verdict: str, *, sha: str | None = A, adversarial_sha: str | None = None,
             fingerprint: str | None = None) -> None:
        for judge_id in (EVIDENCE, ADVERSARIAL):
            seat_sha = adversarial_sha if (judge_id == ADVERSARIAL and adversarial_sha is not None) else sha
            record_operator_feedback(
                tool_id=TOOL,
                run_id=f"run-{finding}",
                finding_id=finding,
                verdict=verdict,
                severity="high",
                note=f"{judge_id} reading of {finding}",
                source_type="ai_judge",
                judge_id=judge_id,
                model=_MODELS[judge_id],
                confidence=0.95,
                evidence_refs=[f"src/{finding.lower()}.ts:10"],
                judgment_group_id=f"judge:{TOOL}:{finding}",
                finding_fingerprint=f"fp-{finding}" if fingerprint is None else fingerprint,
                target_sha=seat_sha,
                base_dir=self.tools,
            )

    def candidates(self, **kwargs: Any) -> list[str]:
        return [group["finding_id"] for group in anchor_candidate_groups(tool_id=TOOL, base_dir=self.tools, **kwargs)]

    def arbitrated(self) -> list[str]:
        return sorted(
            request["finding_id"]
            for request in list_agent_invocation_requests(base_dir=self.tools, role=CONSENSUS_ARBITRATION_ROLE)
        )


class TheSelectorNeverLetsAFalsePositivePairSpendTheBound(_Ledger):
    """D2 and D7."""

    def _fixture(self) -> None:
        for finding in ("F-1", "F-2", "F-3"):
            self.pair(finding, "false_positive")
        self.pair("F-9", "true_positive")

    def test_one_new_true_positive_pair_is_returned_next_to_three_false_positive_pairs(self) -> None:
        self._fixture()
        self.assertEqual(self.candidates(demand=1), ["F-1", "F-2", "F-3", "F-9"])

    def test_with_no_demand_the_true_positive_pair_costs_nothing_and_the_false_positive_pairs_stay(self) -> None:
        # GREEN at the base on purpose: the existing pins of test_jj1_anchor_consensus.
        self._fixture()
        self.assertEqual(self.candidates(demand=0), ["F-1", "F-2", "F-3"])

    def test_demand_bounds_the_new_true_positive_pairs(self) -> None:
        # GREEN at the base on purpose: ``demand`` keeps meaning a count of true_positive pairs.
        for finding in ("F-7", "F-8", "F-9"):
            self.pair(finding, "true_positive")
        self.assertEqual(self.candidates(demand=1), ["F-7"])
        self.assertEqual(self.candidates(demand=2), ["F-7", "F-8"])

    def test_a_pair_whose_arbiter_is_in_flight_is_returned_and_spends_nothing(self) -> None:
        for finding in ("F-8", "F-9"):
            self.pair(finding, "true_positive")
        [in_flight] = [
            group for group in anchor_candidate_groups(tool_id=TOOL, base_dir=self.tools, demand=5)
            if group["finding_id"] == "F-8"
        ]
        minted = frozenset({(in_flight["judgment_group_id"], in_flight["arbiter_inputs"]["digest"])})
        try:
            got = self.candidates(demand=1, minted=minted)
        except TypeError as refused:
            self.fail(f"J4: anchor_candidate_groups takes no `minted` set ({refused})")
        self.assertEqual(got, ["F-8", "F-9"], "the in-flight pair is named, and the one NEW slot still serves F-9")

    def test_a_held_group_spends_nothing(self) -> None:
        self.pair("F-7", "true_positive", sha=A, adversarial_sha=C)  # its seats judged two trees
        self.pair("F-8", "true_positive")
        self.assertEqual(self.candidates(demand=1), ["F-7", "F-8"], "the held pair is named, F-8 keeps the slot")

    def test_the_stability_lane_sees_the_true_positive_pair_through_its_own_entry_point(self) -> None:
        self._fixture()
        reasked = [
            candidate["finding_id"] for candidate in stability_candidates(tool_id=TOOL, base_dir=self.tools, demand=1)
        ]
        self.assertEqual(reasked, ["F-1", "F-2", "F-3", "F-9"])
        # GREEN at the base on purpose: without demand the lane returns the same false_positive pairs.
        self.assertEqual(
            [c["finding_id"] for c in stability_candidates(tool_id=TOOL, base_dir=self.tools, demand=0)],
            ["F-1", "F-2", "F-3"],
        )


class ABoundedNumberOfNewPairsIsArbitratedPerCycle(FunnelStoreCase):
    """D3 — the bound is per cycle, counts NEW mints (in flight spends nothing) and is read from policy."""

    def _seven_true_positive_pairs(self) -> Any:
        funnel = self.funnel(findings=7)
        for request in funnel.mint_judges():
            funnel.answer(request, verdict="true_positive")
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)
        return funnel

    def test_three_new_pairs_per_cycle_and_the_in_flight_ones_do_not_block_the_rest(self) -> None:
        funnel = self._seven_true_positive_pairs()
        observed = []
        with _with_bound(3):
            for cycle in (1, 2, 3):
                minted = _run_phase(funnel, f"cycle-{cycle}")["arbiter_requests_minted"]
                observed.append((minted, len(funnel.requests(role=CONSENSUS_ARBITRATION_ROLE))))
        self.assertEqual(observed, [(3, 3), (3, 6), (1, 7)])

    def test_a_bound_of_zero_mints_no_true_positive_pair_but_still_every_false_positive_pair(self) -> None:
        funnel = self.funnel(findings=2)
        for request in funnel.mint_judges():
            funnel.answer(request, verdict="true_positive" if request["finding_id"] == "F-1" else "false_positive")
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)
        with _with_bound(0):
            minted = _run_phase(funnel, "cycle-zero")["arbiter_requests_minted"]
        self.assertEqual(minted, 1)
        self.assertEqual(
            [request["finding_id"] for request in funnel.requests(role=CONSENSUS_ARBITRATION_ROLE)], ["F-2"],
        )


class TheDispatcherAppliesTheBoundItIsGiven(_Ledger):
    """5b — ``max_tp_pairs`` is the cycle's value (read from policy there); in flight spends nothing."""

    def _dispatch(self, cycle_id: str, **kwargs: Any) -> dict[str, Any]:
        try:
            return dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=self.tools, cycle_id=cycle_id, **kwargs)
        except TypeError as refused:
            self.fail(f"J4: dispatch_arbiter_for_anchor_groups takes no `max_tp_pairs` ({refused})")

    def test_two_new_pairs_per_dispatch_and_the_in_flight_ones_do_not_block_the_rest(self) -> None:
        for finding in ("F-6", "F-7", "F-8", "F-9"):
            self.pair(finding, "true_positive")
        first = self._dispatch("cyc-1", max_tp_pairs=2)
        second = self._dispatch("cyc-2", max_tp_pairs=2)
        third = self._dispatch("cyc-3", max_tp_pairs=2)
        self.assertEqual(
            [(first["minted_count"], first["anchor_pair_bound"]), (second["minted_count"], second["anchor_pair_bound"]),
             third["minted_count"]],
            [(2, 2), (2, 2), 0],
        )
        self.assertEqual(self.arbitrated(), ["F-6", "F-7", "F-8", "F-9"])

    def test_a_false_positive_pair_is_minted_beyond_the_bound(self) -> None:
        self.pair("F-1", "false_positive")
        self.pair("F-2", "false_positive")
        self.pair("F-9", "true_positive")
        result = self._dispatch("cyc-1", max_tp_pairs=0)
        self.assertEqual(result["minted_count"], 2)
        self.assertEqual(self.arbitrated(), ["F-1", "F-2"])


class AFingerprintWithACommittedFindingIsNotArbitratedAgain(_Ledger):
    """D4."""

    def _promote(self, fingerprint: str) -> None:
        append_jsonl(
            promotions_path(self.tools),
            promotion_row(
                finding_fingerprint=fingerprint, finding_id="F-9", tool_id=TOOL,
                judgment_group_id=f"judge:{TOOL}:F-9", consensus_run_id="run-F-9",
                request_ids=[], target_sha=A,
            ),
        )

    def test_a_promoted_pair_is_not_a_candidate_and_an_unpromoted_one_is(self) -> None:
        self.pair("F-8", "true_positive")
        self.pair("F-9", "true_positive")
        self._promote("fp-F-9")
        self.assertEqual(self.candidates(demand=5), ["F-8"])

    def test_the_dispatcher_mints_for_the_unpromoted_pair_only(self) -> None:
        self.pair("F-8", "true_positive")
        self.pair("F-9", "true_positive")
        self._promote("fp-F-9")
        result = dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual(result["minted_count"], 1)
        self.assertEqual(self.arbitrated(), ["F-8"])

    def test_a_pair_with_an_empty_fingerprint_is_not_excluded(self) -> None:
        # GREEN at the base on purpose: an empty fingerprint is nobody's "already promoted".
        self.pair("F-8", "true_positive", fingerprint="")
        self._promote("fp-F-9")
        self.assertEqual(self.candidates(demand=5), ["F-8"])


class TheBoundIsPolicyAndNotAConstant(unittest.TestCase):
    """D5 and D6."""

    def test_the_shipped_default_is_a_non_negative_int_and_the_accessor_returns_it(self) -> None:
        default = JUDGMENT_PIPELINE_DEFAULTS.get(KEY)
        self.assertIsNotNone(default, f"J4: JUDGMENT_PIPELINE_DEFAULTS has no {KEY!r}")
        self.assertIsInstance(default, int)
        self.assertNotIsInstance(default, bool)
        self.assertGreaterEqual(default, 0)
        self.assertEqual(default, 5, "ratified by the program lead: a ceiling equal to sample_size_per_tool")
        self.assertEqual(judgment_pipeline_policy()[KEY], default)

    def test_a_repo_override_reaches_the_accessor_the_cycle_reads(self) -> None:
        self.assertIn(KEY, JUDGMENT_PIPELINE_DEFAULTS, f"J4: {KEY!r} is not a known key, an override is dropped")
        merged = merge_with_override(
            {"judgment_pipeline": dict(JUDGMENT_PIPELINE_DEFAULTS)}, {"judgment_pipeline": {KEY: 2}},
        )
        self.assertEqual(merged["judgment_pipeline"][KEY], 2)
        with tempfile.TemporaryDirectory(prefix="aria-m1087-policy-") as repo:
            override = Path(repo) / genesis_policy.OVERRIDE_RELPATH
            override.parent.mkdir(parents=True)
            override.write_text(json.dumps({"judgment_pipeline": {KEY: 2}}), encoding="utf-8")
            self.assertEqual(judgment_pipeline_policy(repo)[KEY], 2)

    def test_the_arm_reports_the_bound_it_applied_not_a_demand(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-m1087-summary-") as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            summary = dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=tools, cycle_id="cyc-1")
        self.assertNotIn("anchor_demand", summary)
        self.assertEqual(summary.get("anchor_pair_bound"), judgment_pipeline_policy()[KEY])

    def test_the_fanout_no_longer_reads_the_readiness_constant(self) -> None:
        self.assertNotIn("ANCHOR_PROMOTION_MIN_JUDGMENTS", inspect.getsource(judge_fanout))

    def test_readiness_still_owns_the_constant_and_its_meaning(self) -> None:
        # GREEN at the base on purpose: the adapter-readiness gate (five judged
        # anchors before an adapter counts as judged) is not touched by this slice.
        self.assertEqual(ANCHOR_PROMOTION_MIN_JUDGMENTS, 5)
        self.assertIs(readiness.ANCHOR_PROMOTION_MIN_JUDGMENTS, ANCHOR_PROMOTION_MIN_JUDGMENTS)


if __name__ == "__main__":
    unittest.main()
