"""ARIA-HIGH-1084 — the arbiter is minted at the tree its pair judged.

The anchor upgrade is the whole path to ground truth: two judges agree at
tree A, a third (the arbiter) is minted by a LATER cycle, and the closing set of
three is graded as one set. The consumer (``feedback_store.generate_ai_consensus``)
refuses an anchor-grade closing set whose seats judged different trees
(``target_sha_mixed``, J5). At the branch base (main tip 6c4ca84a1c) the
producer hands the arbiter the cycle's HEAD instead of the pair's tree
(``cycle.py`` target_sha = workspace HEAD, both arm calls), and main advances 8
to 16 first-parent commits a day, so the pair is almost always judged at a
different tree than the arbiter is minted at. Measured through the production
phase on the production-shaped fixture (a pair judged at A, HEAD moved to B):

    5 arbiters minted at B, consensus_count 0, uncertainties ['target_sha_mixed'],
    0 ground-truth rows, 5 promotion skips ``not_ground_truth``.

Nothing re-asks such a group afterwards (the anchor arm drops it at
``len(by_judge) >= ANCHOR_MIN_JUDGE_COUNT``, the split arm at ``key in settled``),
and the split arm has the same defect.

The repaired law these pins state:

  * the arbiter request's ``target_sha`` is the tree its seats judged, whatever
    HEAD has become; no caller can hand the mint another tree (C8);
  * seats of different trees (or a named seat beside an unnamed one) are HELD by
    name, disclosed once per claim on the governance ledger, and spend no
    admission and no mint (C4);
  * a pair that names no sha at all is not mixed: minted with no sha, exactly
    what the consumer admits (C5);
  * the arbiter's bound inputs include each seat's tree, so an envelope minted
    over the old digest shape is refused as ``arbiter_inputs_stale`` at answer
    time and its group is offered again once (C6);
  * the producer asks the consumer's predicate, ``feedback_store.tree_is_mixed``,
    and never re-derives it (C7).

NEW API pinned by name (red at the base by assertion, the module attribute is
absent): ``feedback_store.tree_is_mixed``, ``judge_fanout.ARBITER_HOLD_SEATS_MIXED_TREE``,
``judge_fanout.ARBITER_TREE_HOLD_KIND``, the group keys ``target_sha`` and ``hold``.
Pins GREEN at the base on purpose are marked where they are written.
"""
from __future__ import annotations

import inspect
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from aria_kernel import cycle as cycle_mod
from aria_kernel import feedback_store, judge_fanout
from aria_kernel.agent_invocations import create_agent_invocation_request, list_agent_invocation_requests
from aria_kernel.bridge_exceptions import BridgeContractRefused
from aria_kernel.feedback_store import (
    generate_ai_consensus,
    is_ground_truth_row,
    load_feedback,
    record_operator_feedback,
)
from aria_kernel.judge_fanout import (
    ARBITER_SUBJECT_FINDING,
    CONSENSUS_ARBITER_AGENT,
    CONSENSUS_ARBITRATION_ROLE,
    _mint_arbiter,
    anchor_candidate_groups,
    arbiter_inputs,
    arbitration_groups,
    dispatch_arbiter_for_anchor_groups,
    dispatch_arbiter_for_belief,
    dispatch_arbiter_for_split_verdicts,
    dispatch_judges_for_sample,
    dispatch_rebuttal_for_dissent,
    require_current_arbiter_inputs,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import disclosure_fingerprint, ensure_tools_dir

from tests._helpers.git_fixtures import commit_files, make_local_git_repo
from tests._helpers.rule_contracts import register_contracted_tool
from tests.test_judge_input_cites_the_line import FunnelStoreCase
from tests.test_promotion_funnel_e2e import TOOL_ID

TOOL = "tool-a"
A, B, C = "a" * 40, "b" * 40, "c" * 40
EVIDENCE, ADVERSARIAL, ARBITER = "aria-evidence-judge", "aria-adversarial-judge", CONSENSUS_ARBITER_AGENT
HOLD = "arbiter_hold_seats_judged_different_trees"
HOLD_KIND = "judge_arbiter_tree_hold"
_MODELS = {EVIDENCE: "claude-opus-5", ADVERSARIAL: "claude-opus-5", ARBITER: "fable"}


def _group(finding: str = "F-1") -> str:
    return f"judge:{TOOL}:{finding}"


def _hold_entry(finding: str = "F-1") -> dict[str, str]:
    return {"judgment_group_id": _group(finding), "target_agent": CONSENSUS_ARBITER_AGENT, "reason": HOLD}


class _Ledger(unittest.TestCase):
    """A bare tools store and the judge rows the bridge would have written."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h1084-")
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def seat(
        self,
        judge_id: str,
        *,
        verdict: str = "true_positive",
        finding: str = "F-1",
        target_sha: str | None = None,
        request_ids: list[str] | None = None,
        tools: Path | None = None,
    ) -> None:
        record_operator_feedback(
            tool_id=TOOL,
            run_id=f"run-{finding}",
            finding_id=finding,
            verdict=verdict,
            severity="high",
            note=f"{judge_id} independent reading of {finding}",
            source_type="ai_judge",
            judge_id=judge_id,
            model=_MODELS[judge_id],
            confidence=0.95,
            evidence_refs=[f"src/{finding.lower()}.ts:10"],
            judgment_group_id=_group(finding),
            finding_fingerprint=f"fp-{finding}",
            target_sha=target_sha,
            request_ids=request_ids,
            base_dir=tools or self.tools,
        )

    def pair(self, *, evidence_sha: str | None, adversarial_sha: str | None, finding: str = "F-1",
             verdicts: tuple[str, str] = ("true_positive", "true_positive")) -> None:
        self.seat(EVIDENCE, verdict=verdicts[0], finding=finding, target_sha=evidence_sha)
        self.seat(ADVERSARIAL, verdict=verdicts[1], finding=finding, target_sha=adversarial_sha)

    def arbiters(self) -> list[dict[str, Any]]:
        return list_agent_invocation_requests(base_dir=self.tools, role=CONSENSUS_ARBITRATION_ROLE)

    def holds(self) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        rows = load_declared_jsonl(path, expected_surface="tools_governance")
        return [row for row in rows if row.get("kind") == HOLD_KIND]


class TheArbiterIsMintedAtTheTreeThePairJudged(FunnelStoreCase):
    """C1 — THE discriminating test, end to end through the production phase."""

    def test_a_pair_judged_at_a_is_arbitrated_promoted_and_anchored_at_a_after_head_moved(self) -> None:
        funnel = self.funnel(findings=5)
        funnel.judge_pair()
        tree_a = funnel.head
        tree_b = commit_files(funnel.workspace, {"docs/moved.md": "main moved\n"})
        self.assertNotEqual(tree_a, tree_b)

        context = cycle_mod.build_phase_context(
            cycle_id="cycle-arb", workspace_root=funnel.workspace, base_dir=funnel.tools,
        )
        result = cycle_mod._phase_judgment_pipeline(context)
        self.assertEqual(result["arbiter_requests_minted"], 5)
        arbiters = funnel.requests(role=CONSENSUS_ARBITRATION_ROLE)
        with self.subTest("every arbiter request names the tree its pair judged"):
            self.assertEqual(sorted(request["target_sha"] for request in arbiters), [tree_a] * 5)

        for request in arbiters:
            funnel.answer(request)
        settled = generate_ai_consensus(tool_id=TOOL_ID, base_dir=funnel.tools)
        with self.subTest("the answered groups settle at anchor grade with no mixed-tree uncertainty"):
            self.assertEqual(settled["consensus_count"], 5)
            self.assertEqual([item["reason"] for item in settled["uncertainties"]], [])

        consensus = [
            row for row in load_feedback(tool_id=TOOL_ID, base_dir=funnel.tools)
            if row.get("source_type") == "ai_consensus"
        ]
        anchors = [row for row in consensus if is_ground_truth_row(row)]
        with self.subTest("five ground-truth rows, each at the pair's tree"):
            self.assertEqual(len(anchors), 5)
            self.assertEqual({row.get("target_sha") for row in anchors}, {tree_a})

        promotion = funnel.promote_findings()
        with self.subTest("promotion promotes all five and skips none as not_ground_truth"):
            self.assertEqual(
                [skip for skip in promotion["skipped"] if skip.get("reason") == "not_ground_truth"], [],
            )
            self.assertEqual(promotion["promoted_count"], 5)


class ThePhaseMintsAtThePairsTreeWhateverHeadHasBecome(unittest.TestCase):
    """C2 and C5 — the replaced pin of ``test_role_hygiene_e14`` and its near-misses.

    The workspace is a real git repository, so the cycle resolves a real HEAD
    (never equal to the fabricated tree the rows name) and nothing patches the
    resolver."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h1084-phase-")
        self.addCleanup(self._tmp.cleanup)
        self.workspace = make_local_git_repo(Path(self._tmp.name), name="workspace")
        self.tools = self.workspace / ".aria-state-store" / "tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(self.tools, TOOL)
        self.head = commit_files(self.workspace, {"docs/head.md": "head\n"})

    def _vote(self, judge_id: str, verdict: str, target_sha: str | None) -> None:
        record_operator_feedback(
            tool_id=TOOL, run_id="run-F-1", finding_id="F-1", verdict=verdict, severity="high",
            note=f"{judge_id} verdict", source_type="ai_judge", judge_id=judge_id,
            confidence=0.9, evidence_refs=["aria-kernel/aria_kernel/judge_fanout.py:3"],
            judgment_group_id=_group(), target_sha=target_sha, base_dir=self.tools,
        )

    def _run_phase(self) -> dict[str, Any]:
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-arb", workspace_root=self.workspace, base_dir=self.tools,
        )
        return cycle_mod._phase_judgment_pipeline(context)

    def _arbiter_shas(self) -> list[str | None]:
        return [
            request.get("target_sha")
            for request in list_agent_invocation_requests(base_dir=self.tools, role=CONSENSUS_ARBITRATION_ROLE)
        ]

    def test_a_split_pair_recorded_at_a_is_arbitrated_at_a_not_at_head(self) -> None:
        self._vote(EVIDENCE, "true_positive", A)
        self._vote(ADVERSARIAL, "false_positive", A)
        self.assertEqual(self._run_phase()["arbiter_requests_minted"], 1)
        self.assertEqual(self._arbiter_shas(), [A])

    def test_an_agreeing_pair_recorded_at_a_is_arbitrated_at_a_not_at_head(self) -> None:
        self._vote(EVIDENCE, "false_positive", A)
        self._vote(ADVERSARIAL, "false_positive", A)
        self.assertEqual(self._run_phase()["arbiter_requests_minted"], 1)
        self.assertEqual(self._arbiter_shas(), [A])

    def test_a_pair_that_names_no_sha_is_minted_with_none_not_with_head(self) -> None:
        # The deliberate change of the pin ``== "f" * 40`` in test_role_hygiene_e14
        # (a pair recorded without any sha was anchored to the cycle's HEAD):
        # an unnamed pair is not mixed, and the consumer admits it unnamed.
        self._vote(EVIDENCE, "true_positive", None)
        self._vote(ADVERSARIAL, "false_positive", None)
        self.assertEqual(self._run_phase()["arbiter_requests_minted"], 1)
        self.assertEqual(self._arbiter_shas(), [None])
        self.assertNotIn(self.head, self._arbiter_shas())

    def test_a_pair_at_the_tree_head_still_is_arbitrated_at_that_tree(self) -> None:
        # GREEN at the base on purpose (C5): with HEAD equal to the pair's tree
        # the two answers coincide.
        self._vote(EVIDENCE, "true_positive", self.head)
        self._vote(ADVERSARIAL, "false_positive", self.head)
        self.assertEqual(self._run_phase()["arbiter_requests_minted"], 1)
        self.assertEqual(self._arbiter_shas(), [self.head])


class EachArmMintsAtTheTreeItsSeatsJudged(_Ledger):
    """C3 — both arms, called without any sha (the call is valid at the base)."""

    def test_the_split_arm_mints_at_the_seats_tree(self) -> None:
        self.pair(evidence_sha=A, adversarial_sha=A, verdicts=("true_positive", "false_positive"))
        result = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual(result["minted_count"], 1)
        self.assertEqual([request["target_sha"] for request in self.arbiters()], [A])

    def test_the_anchor_arm_mints_at_the_seats_tree(self) -> None:
        self.pair(evidence_sha=A, adversarial_sha=A)
        result = dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual(result["minted_count"], 1)
        self.assertEqual([request["target_sha"] for request in self.arbiters()], [A])

    def test_a_pair_that_names_no_sha_is_minted_with_no_sha(self) -> None:
        # GREEN at the base on purpose (C5): every existing fixture, the
        # acceptance harness's scenario 2 and ``AnchorMintTests`` mint unnamed.
        self.pair(evidence_sha=None, adversarial_sha=None)
        self.assertEqual(dispatch_arbiter_for_anchor_groups(
            tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")["minted_count"], 1)
        self.assertEqual([request["target_sha"] for request in self.arbiters()], [None])

    def test_the_groups_carry_the_tree_and_no_hold(self) -> None:
        self.pair(evidence_sha=A, adversarial_sha=A, finding="F-1")
        self.pair(evidence_sha=A, adversarial_sha=A, finding="F-2", verdicts=("true_positive", "false_positive"))
        [split] = arbitration_groups(tool_id=TOOL, base_dir=self.tools)
        [anchor] = anchor_candidate_groups(tool_id=TOOL, base_dir=self.tools, demand=1)
        for name, group in (("split", split), ("anchor", anchor)):
            with self.subTest(name):
                self.assertEqual(group.get("target_sha"), A)
                self.assertIn("hold", group)
                self.assertIsNone(group["hold"])


class SeatsOfDifferentTreesAreHeldByName(_Ledger):
    """C4 — kills mint-at-HEAD and mint-at-either: the arbiter's tree must be one the seats share."""

    def test_the_hold_vocabulary_is_named(self) -> None:
        self.assertEqual(getattr(judge_fanout, "ARBITER_HOLD_SEATS_MIXED_TREE", None), HOLD)
        self.assertEqual(getattr(judge_fanout, "ARBITER_TREE_HOLD_KIND", None), HOLD_KIND)

    def test_the_groups_say_so(self) -> None:
        self.pair(evidence_sha=A, adversarial_sha=C, finding="F-1")
        self.pair(evidence_sha=A, adversarial_sha=C, finding="F-2", verdicts=("true_positive", "false_positive"))
        [anchor] = anchor_candidate_groups(tool_id=TOOL, base_dir=self.tools, demand=1)
        [split] = arbitration_groups(tool_id=TOOL, base_dir=self.tools)
        for name, group in (("anchor", anchor), ("split", split)):
            with self.subTest(name):
                self.assertIsNone(group.get("target_sha"))
                self.assertEqual(group.get("hold"), HOLD)

    def test_the_arbiters_own_row_is_not_a_seat_of_the_tree(self) -> None:
        # The arbiter is what is being re-asked, as in the bound inputs: a row of
        # its own, judged at another tree, neither holds the group nor moves its tree.
        self.pair(evidence_sha=A, adversarial_sha=A, verdicts=("true_positive", "false_positive"))
        self.seat(ARBITER, verdict="true_positive", target_sha=C)
        [group] = arbitration_groups(tool_id=TOOL, base_dir=self.tools)
        self.assertEqual(group.get("target_sha"), A)
        self.assertIsNone(group.get("hold"))

    def _assert_held_once_per_claim(self, dispatch: Any, *, verdicts: tuple[str, str],
                                    evidence_sha: str | None, adversarial_sha: str | None) -> None:
        self.pair(evidence_sha=evidence_sha, adversarial_sha=adversarial_sha, verdicts=verdicts)
        first = dispatch(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual(first["minted_count"], 0)
        self.assertEqual(self.arbiters(), [], "a held group mints no arbiter")
        self.assertIn(_hold_entry(), first["skipped"])
        claim = {"tool_id": TOOL, "reason": HOLD, "held_count": 1, "judgment_group_ids": [_group()]}
        self.assertEqual(
            [row["details"] for row in self.holds()],
            [{**claim, "disclosure_fingerprint": disclosure_fingerprint(HOLD_KIND, claim)}],
        )

        again = dispatch(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual(again["minted_count"], 0)
        self.assertIn(_hold_entry(), again["skipped"], "the per-decision skip is named every call")
        self.assertEqual(len(self.holds()), 1, "the standing fact is disclosed once per claim")

        self.pair(evidence_sha=evidence_sha, adversarial_sha=adversarial_sha, finding="F-2", verdicts=verdicts)
        dispatch(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-3")
        rows = self.holds()
        self.assertEqual(len(rows), 2, "a changed claim is a new fact")
        self.assertEqual(rows[1]["details"]["held_count"], 2)
        self.assertEqual(rows[1]["details"]["judgment_group_ids"], [_group("F-1"), _group("F-2")])
        self.assertEqual(self.arbiters(), [])

    def test_the_anchor_arm_holds_a_pair_judged_at_two_trees(self) -> None:
        self._assert_held_once_per_claim(
            dispatch_arbiter_for_anchor_groups, verdicts=("true_positive", "true_positive"),
            evidence_sha=A, adversarial_sha=C,
        )

    def test_the_anchor_arm_holds_a_named_seat_beside_an_unnamed_one(self) -> None:
        # The consumer's own law: ``""`` counts as a member, so an unnamed seat
        # beside a named one IS a mixed set.
        self._assert_held_once_per_claim(
            dispatch_arbiter_for_anchor_groups, verdicts=("true_positive", "true_positive"),
            evidence_sha=A, adversarial_sha=None,
        )

    def test_the_split_arm_holds_a_disagreeing_pair_judged_at_two_trees(self) -> None:
        self._assert_held_once_per_claim(
            dispatch_arbiter_for_split_verdicts, verdicts=("true_positive", "false_positive"),
            evidence_sha=A, adversarial_sha=C,
        )

    def test_a_held_group_spends_no_admission(self) -> None:
        self.pair(evidence_sha=A, adversarial_sha=C)
        with patch.object(judge_fanout, "admit_request", wraps=judge_fanout.admit_request) as door:
            dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual([call.args[0] for call in door.call_args_list], [], "the arbiter door was asked for a held group")


class TheArbitersBoundInputsIncludeTheTree(_Ledger):
    """C6 — a group is re-offered when the tree its seats judged differs from the one an arbiter was minted over."""

    def _split_store(self, name: str, sha: str) -> Path:
        tools = Path(self._tmp.name) / name
        ensure_tools_dir(tools)
        self.seat(EVIDENCE, verdict="true_positive", target_sha=sha, request_ids=["AIR-1"], tools=tools)
        self.seat(ADVERSARIAL, verdict="false_positive", target_sha=sha, request_ids=["AIR-2"], tools=tools)
        return tools

    def _digest(self, tools: Path) -> str:
        [group] = arbitration_groups(tool_id=TOOL, base_dir=tools)
        return group["arbiter_inputs"]["digest"]

    def test_seats_that_differ_only_in_their_tree_have_different_digests(self) -> None:
        at_a, at_b = self._split_store("tools-a", A), self._split_store("tools-b", B)
        self.assertNotEqual(self._digest(at_a), self._digest(at_b))

    def test_the_same_seats_at_the_same_tree_have_one_digest(self) -> None:
        # GREEN at the base on purpose: the digest is a function of the seats,
        # so the difference above is the tree and nothing else.
        self.assertEqual(self._digest(self._split_store("tools-a1", A)), self._digest(self._split_store("tools-a2", A)))

    def _old_shape_arbiter(self, group: dict[str, Any]) -> dict[str, Any]:
        """An arbiter minted before the binding named the tree: facts of {judge_id, verdict, request_ids} only."""
        rows = {
            row["judge_id"]: row for row in load_feedback(tool_id=TOOL, base_dir=self.tools)
            if row.get("source_type") == "ai_judge" and row.get("judge_id") != ARBITER
        }
        old_facts = [
            {
                "judge_id": judge_id,
                "verdict": str(row.get("verdict") or ""),
                "request_ids": sorted({str(r) for r in row.get("request_ids") or [] if str(r).strip()}),
            }
            for judge_id, row in sorted(rows.items())
        ]
        return create_agent_invocation_request(
            target_agent=CONSENSUS_ARBITER_AGENT,
            role=CONSENSUS_ARBITRATION_ROLE,
            suggested_prompt="Two independent judges disagree about this adapter finding. Arbitrate.",
            must_satisfy=[{"id": "consensus", "description": "Aggregate the supplied judge verdicts"}],
            allowed_scope=["**"],
            finding_id=group["finding_id"],
            tool_id=TOOL,
            run_id=group["run_id"],
            judgment_group_id=group["judgment_group_id"],
            cycle_id="cyc-old",
            target_sha=A,
            base_dir=self.tools,
            admission=admit_request(
                "judge_fanout.arbitration", CONSENSUS_ARBITRATION_ROLE, base_dir=self.tools, cycle_id="cyc-old",
            ),
            arbiter_inputs=arbiter_inputs(ARBITER_SUBJECT_FINDING, old_facts),
        )

    def test_an_envelope_bound_to_the_old_shape_is_refused_stale_and_the_group_is_offered_again(self) -> None:
        self.seat(EVIDENCE, verdict="true_positive", target_sha=A, request_ids=["AIR-1"])
        self.seat(ADVERSARIAL, verdict="false_positive", target_sha=A, request_ids=["AIR-2"])
        [group] = arbitration_groups(tool_id=TOOL, base_dir=self.tools)
        old = self._old_shape_arbiter(group)
        self.assertNotEqual(old["arbiter_inputs"]["digest"], group["arbiter_inputs"]["digest"])

        with self.assertRaises(BridgeContractRefused) as refused:
            require_current_arbiter_inputs(old, base_dir=self.tools)
        self.assertIn("arbiter_inputs_stale", str(refused.exception))

        result = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-new")
        self.assertEqual(result["minted_count"], 1, result["skipped"])
        fresh = [r for r in self.arbiters() if r["request_id"] != old["request_id"]]
        self.assertEqual([request["target_sha"] for request in fresh], [A])
        require_current_arbiter_inputs(fresh[0], base_dir=self.tools)  # the re-offer is current, so it answers

    def test_an_envelope_minted_over_the_current_shape_is_current(self) -> None:
        # GREEN at the base on purpose: the binding's existing law is intact.
        self.seat(EVIDENCE, verdict="true_positive", target_sha=A)
        self.seat(ADVERSARIAL, verdict="false_positive", target_sha=A)
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        [request] = self.arbiters()
        self.assertEqual(require_current_arbiter_inputs(request, base_dir=self.tools), ARBITER_SUBJECT_FINDING)
        again = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual((again["minted_count"], [s["reason"] for s in again["skipped"]]), (0, ["already_dispatched"]))


class TheProducerAsksTheConsumersPredicate(_Ledger):
    """C7 — one mixed-tree law: patch the OWNER and both arms follow it."""

    def setUp(self) -> None:
        super().setUp()
        self.assertTrue(
            hasattr(feedback_store, "tree_is_mixed"),
            "J4: feedback_store.tree_is_mixed (the one mixed-tree predicate) does not exist",
        )

    def _anchor_grade_single_tree_set(self) -> dict[str, Any]:
        for judge_id in (EVIDENCE, ADVERSARIAL, ARBITER):
            self.seat(judge_id, target_sha=A)
        return generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)

    def test_the_owner_states_the_law_of_the_closing_set(self) -> None:
        # Today's law, moved: ``""`` is a member, so an unnamed row beside a named one IS mixed and an
        # all-unnamed set is not (ARIA-MEDIUM-881 will change the law in this one function).
        law = feedback_store.tree_is_mixed
        self.assertTrue(law([{"target_sha": A}, {"target_sha": C}]))
        self.assertFalse(law([{"target_sha": A}, {"target_sha": A}]))
        self.assertFalse(law([{"target_sha": ""}, {}]), "an all-unnamed set is not mixed")
        self.assertTrue(law([{"target_sha": A}, {}]), "an unnamed row beside a named one is")

    def test_the_owner_reads_the_commits_and_the_one_common_tree(self) -> None:
        # The renamed public spellings (item 3): the producer asks the owner for the tree it mints at.
        rows = [{"target_sha": A}, {"target_sha": A}]
        self.assertEqual(feedback_store.target_shas(rows), {A})
        self.assertEqual(feedback_store.common_target_sha(rows), A)
        self.assertIsNone(feedback_store.common_target_sha([{"target_sha": A}, {"target_sha": C}]))
        self.assertIsNone(feedback_store.common_target_sha([{}, {"target_sha": ""}]))

    def test_a_predicate_that_says_mixed_refuses_a_single_tree_set_and_holds_a_single_tree_pair(self) -> None:
        with patch("aria_kernel.feedback_store.tree_is_mixed", return_value=True):
            settled = self._anchor_grade_single_tree_set()
        self.assertIn("target_sha_mixed", [item["reason"] for item in settled["uncertainties"]])

        pair_tools = Path(self._tmp.name) / "pair"
        ensure_tools_dir(pair_tools)
        self.seat(EVIDENCE, finding="F-2", target_sha=A, tools=pair_tools)
        self.seat(ADVERSARIAL, finding="F-2", target_sha=A, tools=pair_tools)
        with patch("aria_kernel.feedback_store.tree_is_mixed", return_value=True):
            held = dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=pair_tools, cycle_id="cyc-1")
        self.assertEqual(held["minted_count"], 0)
        self.assertIn(_hold_entry("F-2"), held["skipped"])

    def test_a_predicate_that_says_not_mixed_admits_a_two_tree_set_and_mints_for_a_two_tree_pair(self) -> None:
        for judge_id, sha in ((EVIDENCE, A), (ADVERSARIAL, A), (ARBITER, C)):
            self.seat(judge_id, target_sha=sha)
        with patch("aria_kernel.feedback_store.tree_is_mixed", return_value=False):
            settled = generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)
        self.assertNotIn("target_sha_mixed", [item["reason"] for item in settled["uncertainties"]])
        self.assertEqual(settled["consensus_count"], 1)

        pair_tools = Path(self._tmp.name) / "pair"
        ensure_tools_dir(pair_tools)
        self.seat(EVIDENCE, finding="F-2", target_sha=A, tools=pair_tools)
        self.seat(ADVERSARIAL, finding="F-2", target_sha=C, tools=pair_tools)
        with patch("aria_kernel.feedback_store.tree_is_mixed", return_value=False):
            minted = dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=pair_tools, cycle_id="cyc-1")
        self.assertEqual(minted["minted_count"], 1)


class NoCallerCanHandTheMintAnotherTree(_Ledger):
    """C8 — the parameter does not exist, and the cycle does not pass one."""

    def test_no_arm_and_not_the_mint_takes_a_target_sha(self) -> None:
        for function in (dispatch_arbiter_for_split_verdicts, dispatch_arbiter_for_anchor_groups, _mint_arbiter):
            with self.subTest(function.__name__):
                self.assertNotIn("target_sha", inspect.signature(function).parameters)

    def test_the_cycle_phase_passes_neither_arm_a_tree(self) -> None:
        workspace = make_local_git_repo(Path(self._tmp.name), name="workspace")
        tools = workspace / ".aria-state-store" / "tools"
        ensure_tools_dir(tools)
        register_contracted_tool(tools, TOOL)
        quiet = {"schema_version": 1, "minted_count": 0, "minted": [], "skipped": []}
        with patch.object(judge_fanout, "dispatch_arbiter_for_split_verdicts", MagicMock(return_value=quiet)) as split, \
                patch.object(judge_fanout, "dispatch_arbiter_for_anchor_groups", MagicMock(return_value=quiet)) as anchor:
            cycle_mod._phase_judgment_pipeline(cycle_mod.build_phase_context(
                cycle_id="cyc-spy", workspace_root=workspace, base_dir=tools,
            ))
        for name, spy in (("split", split), ("anchor", anchor)):
            with self.subTest(name):
                self.assertEqual(spy.call_count, 1)
                self.assertNotIn("target_sha", spy.call_args.kwargs)


class TheOtherArbiterLanesAreUnchanged(_Ledger):
    """C9 — GREEN at the base on purpose: the belief arm mints with no sha, as before.

    (``MixedTargetShaAnchorTests`` in test_jj1_anchor_consensus is the
    consumer's law and stays untouched.)"""

    def test_the_belief_arm_mints_with_no_sha(self) -> None:
        dispatch_arbiter_for_belief(
            belief_id="B-1",
            contradiction={"source_tool_id": TOOL, "reason": "the scanner contradicted the belief"},
            open_cycles=3,
            cycle_id="cyc-1",
            base_dir=self.tools,
        )
        [request] = self.arbiters()
        self.assertEqual(request["judgment_group_id"], "belief:B-1")
        self.assertIsNone(request["target_sha"])


class TheRebuttalArmMintsAtTheRequestsOwnTree(_Ledger):
    """R17 of the conformance audit - GREEN at the base on purpose: the rebuttal arm keeps the dissenter's own tree.

    A settled group with a dissent re-mints the DISSENTER's seat once, "in the same
    judgment group, under the same role it originally held" (``dispatch_rebuttal_for_dissent``):
    its tree is the one the seat's own request named (``request.get("target_sha")``),
    the precedent the arbiter arms now follow for their seats. The audit's mutant m34
    (the rebuttal minted with ``target_sha=None``) survived every test, so a rebuttal
    could lose the tree its dissenter judged and be graded against another. Driven
    through the production mints, so the dissenter's request really carries its tree.
    """

    WEIGHTS = {EVIDENCE: 0.9, ADVERSARIAL: 0.9, ARBITER: 0.9}

    def _rebuttals(self) -> list[dict[str, Any]]:
        return [
            row for row in list_agent_invocation_requests(base_dir=self.tools)
            if judge_fanout.REBUTTAL_MARKER in str(row.get("suggested_prompt") or "")
        ]

    def _settle_over(self, *, dissenter: str, dissenter_request_id: str, finding: str = "F-1") -> None:
        """Two weighted seats settle one verdict; ``dissenter`` voted the other way, recorded with the request it answered."""
        verdicts = {EVIDENCE: "false_positive", ADVERSARIAL: "false_positive", ARBITER: "false_positive"}
        verdicts[dissenter] = "true_positive"
        for judge_id, verdict in verdicts.items():
            self.seat(judge_id, verdict=verdict, finding=finding, target_sha=A,
                      request_ids=[dissenter_request_id] if judge_id == dissenter else None)
        settled = generate_ai_consensus(tool_id=TOOL, base_dir=self.tools, judge_weights=self.WEIGHTS)
        [row] = settled["consensus"]
        self.assertEqual((row["verdict"], row["judge_count"], row["judges_voted"]), ("false_positive", 2, 3))

    def test_a_dissenting_arbiter_is_re_asked_at_the_tree_its_own_request_named(self) -> None:
        self.seat(EVIDENCE, verdict="false_positive", target_sha=A)
        self.seat(ADVERSARIAL, verdict="false_positive", target_sha=A)
        dispatch_arbiter_for_anchor_groups(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        [arbiter] = self.arbiters()
        self.assertEqual(arbiter["target_sha"], A, "the arbiter was minted at the pair's tree (C3)")
        self._settle_over(dissenter=ARBITER, dissenter_request_id=arbiter["request_id"])

        minted = dispatch_rebuttal_for_dissent(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual(minted["minted_count"], 1, minted["skipped"])
        [rebuttal] = self._rebuttals()
        self.assertEqual(rebuttal["target_agent"], ARBITER)
        self.assertEqual(rebuttal["target_sha"], A)

    def test_a_dissenting_judge_seat_is_re_asked_at_the_tree_its_own_request_named(self) -> None:
        register_contracted_tool(self.tools, TOOL)
        item = {
            "tool_id": TOOL, "run_id": "run-F-1", "cycle_id": "c1", "finding_id": "F-1", "rule": "rule-a",
            "severity": "high", "path": "src/f-1.ts", "message": "suspicious", "evidence": ["src/f-1.ts:10"],
            "finding_fingerprint": "fp-F-1",
        }
        fanout = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [item]}, base_dir=self.tools, target_sha=A)
        by_agent = {row["target_agent"]: row["request_id"] for row in fanout["minted"]}
        requests = {row["request_id"]: row for row in list_agent_invocation_requests(base_dir=self.tools)}
        self.assertEqual(requests[by_agent[EVIDENCE]]["target_sha"], A, "the seat was minted at its tree")
        self._settle_over(dissenter=EVIDENCE, dissenter_request_id=by_agent[EVIDENCE])

        minted = dispatch_rebuttal_for_dissent(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual(minted["minted_count"], 1, minted["skipped"])
        [rebuttal] = self._rebuttals()
        self.assertEqual(rebuttal["target_agent"], EVIDENCE)
        self.assertEqual(rebuttal["target_sha"], A)


class TheHoldDisclosureNamesAtMostTheFirstTwentyGroupsSorted(_Ledger):
    """R20 of the conformance audit - GREEN at the base on purpose: the disclosed id list is capped at 20, sorted.

    The hold is disclosed once per claim on the governance ledger, a standing fact
    about the ledger and not about one cycle (``_disclose_tree_holds``). Its claim
    carries ``held_count`` (all the groups held) and ``judgment_group_ids`` (at most the
    first twenty, sorted), so a ledger with hundreds of mixed groups discloses one
    bounded row, not one of unbounded size. The audit's mutant m31 (the cap 200)
    survived: the existing tests hold one or two groups. Here 25 groups are held and
    the arm meets them in the REVERSE of their name order (the arm walks
    ``(run_id, finding_id, group_id)``; the run ids descend as the findings ascend), so
    the first twenty met are not the first twenty by name and both the cap and the
    sort are pinned.
    """

    HELD = 25
    DISCLOSED = 20

    def _hold_groups(self, verdicts: tuple[str, str]) -> list[str]:
        groups = []
        for index in range(1, self.HELD + 1):
            finding = f"F-{index:02d}"
            run_id = f"run-{self.HELD + 1 - index:02d}"
            for judge_id, verdict, sha in ((EVIDENCE, verdicts[0], A), (ADVERSARIAL, verdicts[1], C)):
                record_operator_feedback(
                    tool_id=TOOL, run_id=run_id, finding_id=finding, verdict=verdict, severity="high",
                    note=f"{judge_id} independent reading of {finding}", source_type="ai_judge", judge_id=judge_id,
                    model=_MODELS[judge_id], confidence=0.95, evidence_refs=[f"src/{finding.lower()}.ts:10"],
                    judgment_group_id=_group(finding), finding_fingerprint=f"fp-{finding}", target_sha=sha,
                    base_dir=self.tools,
                )
            groups.append(_group(finding))
        return groups

    def _assert_the_claim_is_bounded(self, dispatch: Any, verdicts: tuple[str, str]) -> None:
        groups = self._hold_groups(verdicts)
        result = dispatch(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual(result["minted_count"], 0)
        self.assertEqual(len(result["skipped"]), self.HELD, "every held group is named in the per-decision skips")
        [row] = self.holds()
        details = row["details"]
        self.assertEqual(details["held_count"], self.HELD, "the count is of every group held, not of the ids listed")
        self.assertEqual(details["judgment_group_ids"], sorted(groups)[: self.DISCLOSED])
        self.assertEqual(len(details["judgment_group_ids"]), self.DISCLOSED)

    def test_the_anchor_arm_discloses_the_first_twenty_of_many_held_groups_sorted(self) -> None:
        self._assert_the_claim_is_bounded(dispatch_arbiter_for_anchor_groups, ("true_positive", "true_positive"))

    def test_the_split_arm_discloses_the_first_twenty_of_many_held_groups_sorted(self) -> None:
        self._assert_the_claim_is_bounded(dispatch_arbiter_for_split_verdicts, ("true_positive", "false_positive"))


if __name__ == "__main__":
    unittest.main()
