"""WP-J D-2 — mutation canaries: labels by construction, measured nightly.

What this suite pins, one property per test:

  * the corpus is BUILT, not judged: mutants are true positives because a
    real defect was planted; false claims are false positives because
    nothing is wrong — in a hermetic-git sandbox, disk-bounded;
  * the corpus registers through the goldset lane (one active corpus the
    replay/fitness consumers read), named by hash;
  * the label rows mint as ``source_type='canary'`` under ``canary:``
    groups — refused by the closed vocabulary before the widening (the
    red run of this suite), never ground truth afterwards;
  * the panel envelopes are the SAME judge question the live fan-out asks
    (``judge_request_fields`` with the item's constructed contract), blind;
  * the lane holds with no measured drain;
  * role_fitness reports the ≥90 %/≥90 % canary block, named by corpus
    hash, and the bars fail when the panel misses;
  * a canary row scores judges under its own prefix and never enters
    organic scoring.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    FEEDBACK_SOURCE_TYPES,
    is_ground_truth_row,
    load_feedback,
    record_operator_feedback,
)
from aria_kernel.judge_calibration import is_calibration_truth_row, score_judges
from aria_kernel.mutation_canary import (
    CANARY_GROUP_PREFIX,
    CANARY_SOURCE_TYPE,
    CANARY_TOOL_ID,
    _FALSE_CLAIMS,
    _MUTANTS,
    _SANDBOX_FILES,
    build_canary_corpus,
    mint_canary_judgments,
    register_canary_corpus,
)
from aria_kernel.role_fitness import measure_role_fitness
from aria_kernel.stability_reask import STABILITY_GROUP_PREFIX
from aria_kernel.tool_registry import ensure_tools_dir


class CanaryBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-canary-"))
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.sandbox = self.tmp / "canary-sandbox"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _corpus(self) -> dict:
        corpus = build_canary_corpus(sandbox_root=self.sandbox)
        register_canary_corpus(corpus, base_dir=self.tools)
        return corpus

    def _mint(self, *, drain: float = 12.0, corpus: dict | None = None) -> dict:
        return mint_canary_judgments(
            base_dir=self.tools, cycle_id="c1", corpus=corpus, drain=drain,
        )

    def _panel_verdicts(self, corpus: dict, *, miss_mutant: bool = False,
                        miss_claim: bool = False) -> None:
        """Simulate the drained panel: both seats vote on every corpus item."""
        from aria_kernel.judge_fanout import JUDGE_FANOUT

        missed_one_mutant = False
        for item in corpus["items"]:
            group = f"{CANARY_GROUP_PREFIX}{corpus['corpus_hash'][:12]}:{item['item_id']}"
            verdict = str(item["verdict"])
            # miss_mutant: exactly ONE mutant slips past the panel.
            if miss_mutant and item["kind"] == "mutant" and not missed_one_mutant:
                verdict = "false_positive"
                missed_one_mutant = True
            if miss_claim and item["kind"] == "false_claim":
                verdict = "true_positive"
            for _role, agent in JUDGE_FANOUT:
                record_operator_feedback(
                    tool_id=CANARY_TOOL_ID, run_id=CANARY_TOOL_ID,
                    finding_id=str(item["item_id"]), verdict=verdict,
                    severity="medium", note="panel vote", source_type="ai_judge",
                    judge_id=agent, confidence=0.9, judgment_group_id=group,
                    base_dir=self.tools,
                )


class CorpusTests(CanaryBase):
    def test_corpus_labels_are_by_construction(self) -> None:
        corpus = build_canary_corpus(sandbox_root=self.sandbox)
        self.assertEqual(corpus["mutant_count"], 3)
        self.assertEqual(corpus["false_claim_count"], 2)
        self.assertTrue(all(item["verdict"] == "true_positive" for item in corpus["items"] if item["kind"] == "mutant"))
        self.assertTrue(all(item["verdict"] == "false_positive" for item in corpus["items"] if item["kind"] == "false_claim"))
        self.assertTrue(corpus["corpus_hash"])
        # The mutants are real: the sandbox file actually changed.
        text = (self.sandbox / "sensor_range.py").read_text()
        self.assertIn("return lo < value < hi", text)

    def test_every_item_ref_names_its_anchor_line_one_indexed(self) -> None:
        """An item's evidence ref is ``<file>:<line>`` in the kernel's
        1-indexed convention, and that line of the unmutated sandbox text IS
        the line the item is about: the mutant's ``find`` or the false
        claim's ``anchor``. A 0-indexed ref names the line above it (a
        docstring or a def), so a judge would be handed evidence for a
        different line than the planted defect."""
        corpus = build_canary_corpus(sandbox_root=self.sandbox)
        anchors = {f"canary:{mutant['rule']}": mutant["find"] for mutant in _MUTANTS}
        anchors.update({f"canary:{claim['rule']}": claim["anchor"] for claim in _FALSE_CLAIMS})
        self.assertEqual({item["item_id"] for item in corpus["items"]}, set(anchors))
        for item in corpus["items"]:
            file, line = str(item["path"]).rsplit(":", 1)
            self.assertGreaterEqual(int(line), 1, item["path"])
            self.assertEqual(
                _SANDBOX_FILES[file].splitlines()[int(line) - 1],
                anchors[item["item_id"]],
                item["path"],
            )

    def test_sandbox_is_a_fresh_hermetic_repo(self) -> None:
        corpus = build_canary_corpus(sandbox_root=self.sandbox)
        head = Path(corpus["sandbox_root"])
        self.assertTrue((head / ".git").exists())
        # A second corpus at the same root is refused: one sandbox per build.
        with self.assertRaises(ValueError):
            build_canary_corpus(sandbox_root=self.sandbox)

    def test_registration_goes_through_the_goldset_lane(self) -> None:
        corpus = build_canary_corpus(sandbox_root=self.sandbox)
        record = register_canary_corpus(corpus, base_dir=self.tools)
        self.assertEqual(record["tool_id"], CANARY_TOOL_ID)
        self.assertTrue(str(record["curator"]).startswith("aria-mutation-canary:"))
        from aria_kernel.goldset import load_active_goldset

        active = load_active_goldset(tool_id=CANARY_TOOL_ID, base_dir=self.tools)
        self.assertIsNotNone(active)
        self.assertEqual(len(active["true_positive_items"]), 3)
        self.assertEqual(len(active["known_false_positive_items"]), 2)


class MintTests(CanaryBase):
    def test_canary_source_type_is_admitted_and_never_ground_truth(self) -> None:
        self.assertIn("canary", FEEDBACK_SOURCE_TYPES)
        corpus = self._corpus()
        result = self._mint(corpus=corpus)
        self.assertEqual(result["labelled_count"], 5, result.get("skipped"))
        rows = [r for r in load_feedback(base_dir=self.tools) if r.get("source_type") == CANARY_SOURCE_TYPE]
        self.assertEqual(len(rows), 5)
        for row in rows:
            self.assertTrue(str(row["judgment_group_id"]).startswith(CANARY_GROUP_PREFIX))
            self.assertFalse(is_ground_truth_row(row))
            self.assertTrue(is_calibration_truth_row(row))

    def test_envelopes_ask_the_one_judge_question_blind(self) -> None:
        corpus = self._corpus()
        result = self._mint(corpus=corpus)
        self.assertEqual(result["minted_count"], 10, result.get("skipped"))
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        requests = [
            row for row in list_agent_invocation_requests(base_dir=self.tools)
            if str(row.get("judgment_group_id") or "").startswith(CANARY_GROUP_PREFIX)
        ]
        self.assertEqual(len(requests), 10)
        for row in requests:
            self.assertIn("Decide whether this adapter finding names a product defect.", row["suggested_prompt"])

    def test_no_envelope_tells_the_judge_what_was_planted(self) -> None:
        """WP-J review — the self-exam is BLIND or it is meaningless.

        The corpus message used to state the item's kind in plain text
        ("planted mutant: ...", "planted false claim: ...") and that message
        renders into the judge prompt, so the >=0.9 detection/refutation
        bars were answered in the prompt itself. The envelope must carry
        only what a real finding envelope carries: a neutral message — the
        defect claim, never its provenance or label.
        """
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        self._mint(corpus=self._corpus())
        requests = [
            row for row in list_agent_invocation_requests(base_dir=self.tools)
            if str(row.get("judgment_group_id") or "").startswith(CANARY_GROUP_PREFIX)
        ]
        self.assertTrue(requests)
        for row in requests:
            prompt = str(row.get("suggested_prompt") or "")
            lowered = prompt.lower()
            for leak in ("planted", "mutant", "false claim"):
                self.assertNotIn(
                    leak, lowered,
                    f"the canary envelope labels its item: {leak!r} reached the judge prompt",
                )

    def test_idempotent_and_hold_on_dead_drain(self) -> None:
        corpus = self._corpus()
        first = self._mint(corpus=corpus)
        second = self._mint(corpus=corpus)
        self.assertEqual(first["minted_count"], 10)
        self.assertEqual(second["minted_count"], 0)
        held = self._mint(corpus=corpus, drain=0.0)
        self.assertEqual(held["minted_count"], 0)
        self.assertTrue(str(held.get("held") or "").startswith("held:"))


class FitnessBlockTests(CanaryBase):
    def test_no_corpus_is_unmeasured_by_name(self) -> None:
        report = measure_role_fitness(base_dir=self.tools)
        self.assertEqual(report["mutation_canary"]["status"], "unmeasured:no_registered_canary_corpus")

    def test_corpus_without_verdicts_is_unmeasured_by_name(self) -> None:
        self._corpus()
        report = measure_role_fitness(base_dir=self.tools)
        self.assertEqual(report["mutation_canary"]["status"], "unmeasured:no_canary_verdicts")
        self.assertTrue(report["mutation_canary"]["corpus_hash"])

    def test_bars_land_when_the_panel_finds_everything(self) -> None:
        corpus = self._corpus()
        self._mint(corpus=corpus)
        self._panel_verdicts(corpus)
        block = measure_role_fitness(base_dir=self.tools)["mutation_canary"]
        self.assertEqual(block["status"], "measured")
        self.assertEqual(block["mutant_detection_rate"], 1.0)
        self.assertEqual(block["false_claim_refutation_rate"], 1.0)
        self.assertTrue(block["bars_met"])
        self.assertEqual(block["bars"]["min_mutant_detection"], 0.9)
        self.assertEqual(block["bars"]["min_false_claim_refutation"], 0.9)

    def test_bars_fail_when_the_panel_misses_a_mutant(self) -> None:
        corpus = self._corpus()
        self._mint(corpus=corpus)
        self._panel_verdicts(corpus, miss_mutant=True)
        block = measure_role_fitness(base_dir=self.tools)["mutation_canary"]
        self.assertAlmostEqual(block["mutant_detection_rate"], 2 / 3, places=3)
        self.assertFalse(block["bars_met"])


class ScoringTests(CanaryBase):
    def test_canary_rows_score_judges_under_their_prefix_only(self) -> None:
        corpus = self._corpus()
        self._mint(corpus=corpus)
        self._panel_verdicts(corpus)
        prefixed = score_judges(base_dir=self.tools, judgment_group_prefix=CANARY_GROUP_PREFIX, min_samples=1)
        self.assertTrue(prefixed["judges"])
        organic = score_judges(base_dir=self.tools, min_samples=1)
        self.assertEqual(organic["judges"], [])


if __name__ == "__main__":
    unittest.main()
