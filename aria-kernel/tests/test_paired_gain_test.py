"""PLAN-v2 F1.7 — one paired gain test decides a promotion's "improved" (ARIA-HIGH-734).

WHY THIS EXISTS. ``agent_eval.compare_eval_windows`` is the program's success test and
``genesis_superiority`` promotes on its ``improved``. Today it compares two 30-day TIME
windows of ONE agent and says ``improved`` on any positive pass_rate delta once each side
has five runs: no significance test, no candidate-vs-incumbent pairing. Two identical
agents are "improved" about 36% of the time (measurement review M1), and
``genesis_superiority`` calls it without ``mock_mode``, so mock runs count toward a gain.

The repaired contract (PLAN-v2 §2 'Kazanç/anlamlılık', §3 F1.7):

* ``compare_eval_windows`` gains a PAIRED mode: candidate and incumbent on the SAME case
  ids (``fixture_id``); only discordant pairs carry information; the decision is an exact
  McNemar test on them, ONE-SIDED for a gain: p = P(Binomial(n, 1/2) >= candidate_only),
  n = candidate_only + incumbent_only. The interval on the candidate's share of the
  discordant pairs is ``judge_calibration.wilson_lower`` (reused, not rewritten).
  ``improved`` needs p <= alpha AND n >= min_discordant_pairs; fewer pairs is
  ``insufficient_evidence``. Mock runs are never scored.
* alpha and min_discordant_pairs are pre-registered in the genesis_policy ``superiority``
  block, parsed by the SE-13 strict parser: a block that omits one is refused by its
  dotted path, never filled from a default.
* ``genesis_superiority`` calls it with ``mock_mode=False`` and the parsed values.
* Exit: in an A/A comparison of the same agent the "improved" rate is <= alpha.

Red at the branch base on an assertion (existing API): ``SuperiorityPolicyTests``,
``PromotionDecisionTests``. New API pinned (red at base on the unknown keyword):
``PairedModeTests`` — ``compare_eval_windows(..., incumbent_agent=, alpha=,
min_discordant_pairs=, mock_mode=False)`` and its result keys ``mode``, ``verdict``,
``p_value``, ``wilson_lower``, ``discordant_pairs``, ``paired_case_count``, ``alpha``,
``min_discordant_pairs``. F1.8(a) (anytime-valid sequential decision) extends this mode
later and is not pinned here.
"""
from __future__ import annotations

import json
import random
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import genesis_superiority
from aria_kernel.agent_eval import EVAL_RUNS_PATH, compare_eval_windows
from aria_kernel.genesis_policy import superiority_policy
from aria_kernel.genesis_superiority import compute_eval_window_superiority
from aria_kernel.judge_calibration import wilson_lower
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

ALPHA = 0.05
MIN_PAIRS = 6
# The full pre-registered superiority block a test override writes (the override
# replaces the block whole, so it must carry every key).
SUPERIORITY_BLOCK = {
    "min_duel_matches": 3,
    "window_days": 30,
    "alpha": ALPHA,
    "min_discordant_pairs": MIN_PAIRS,
}
# A/A fixture: identical agents on heterogeneous cases. Seeded, so the rate is fixed.
AA_SEED = 1729
AA_TRIALS = 200
AA_CASES = 40
AA_PASS_PROBABILITIES = (0.3, 0.5, 0.6, 0.7, 0.8, 0.9)


def _row(agent: str, case: str, passed: bool, *, days_ago: float = 1.0, mock_mode: bool = False) -> dict[str, Any]:
    recorded = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "schema_version": 1,
        "target_agent": agent,
        "fixture_id": case,
        "passed": passed,
        "verdict_match": passed,
        "missing_evidence_refs": [] if passed else ["evidence.md:1"],
        "rounds_used": 1,
        "tokens_used": 100,
        "mock_mode": mock_mode,
        "recorded_at": recorded.isoformat().replace("+00:00", "Z"),
    }


def _write_runs(tools: Path, rows: list[dict[str, Any]]) -> None:
    path = tools.joinpath(*EVAL_RUNS_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows), encoding="utf-8")


def _table(*, both: int, candidate_only: int, incumbent_only: int, neither: int) -> list[dict[str, Any]]:
    """One run per agent per case: a 2x2 McNemar table spelled out as eval rows."""
    rows: list[dict[str, Any]] = []
    cells = [(True, True)] * both + [(True, False)] * candidate_only
    cells += [(False, True)] * incumbent_only + [(False, False)] * neither
    for index, (cand, inc) in enumerate(cells):
        case = f"CASE-{index:03d}"
        rows += [_row("cand", case, cand), _row("inc", case, inc)]
    return rows


def _aa_trials(rng: random.Random) -> list[tuple[list[bool], list[bool]]]:
    """AA_TRIALS draws of two identical agents (same per-case pass probability)."""
    trials = []
    for _ in range(AA_TRIALS):
        probabilities = [rng.choice(AA_PASS_PROBABILITIES) for _ in range(AA_CASES)]
        first = [rng.random() < p for p in probabilities]
        second = [rng.random() < p for p in probabilities]
        trials.append((first, second))
    return trials


class _ToolsCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tools = Path(tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo_root = Path(tmp.name) / "repo"

    def _override(self, block: Any) -> Path:
        path = self.repo_root / "aria-config" / "genesis_policy.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"superiority": block}), encoding="utf-8")
        return self.repo_root


class SuperiorityPolicyTests(_ToolsCase):
    """alpha and min_discordant_pairs are pre-registered: shipped, read, never defaulted."""

    def test_the_shipped_block_registers_alpha_and_min_discordant_pairs(self) -> None:
        policy = superiority_policy()
        self.assertIn("alpha", policy, "the shipped superiority block registers no alpha")
        self.assertIn("min_discordant_pairs", policy)
        self.assertTrue(0.0 < policy["alpha"] < 1.0)
        self.assertIsInstance(policy["min_discordant_pairs"], int)
        self.assertGreaterEqual(policy["min_discordant_pairs"], 1)

    def test_the_operator_value_is_read_not_replaced(self) -> None:
        policy = superiority_policy(self._override({**SUPERIORITY_BLOCK, "alpha": 0.01, "min_discordant_pairs": 12}))
        self.assertEqual(policy.get("alpha"), 0.01)
        self.assertEqual(policy.get("min_discordant_pairs"), 12)

    def test_a_block_missing_a_registered_value_is_refused_by_its_dotted_path(self) -> None:
        for key in ("alpha", "min_discordant_pairs"):
            block = {k: v for k, v in SUPERIORITY_BLOCK.items() if k != key}
            with self.subTest(missing=key):
                with self.assertRaises(GovernanceError) as raised:
                    superiority_policy(self._override(block))
                self.assertIn("genesis_policy_preregistered_key_missing", str(raised.exception))
                self.assertIn(f"superiority.{key}", str(raised.exception))

    def test_a_nonsense_registered_value_is_refused(self) -> None:
        for key, value in (("alpha", 0.0), ("alpha", 1.0), ("alpha", True),
                           ("min_discordant_pairs", 0), ("min_discordant_pairs", 2.5)):
            with self.subTest(key=key, value=value):
                with self.assertRaises(GovernanceError) as raised:
                    superiority_policy(self._override({**SUPERIORITY_BLOCK, key: value}))
                self.assertIn("genesis_policy_preregistered_", str(raised.exception))
                self.assertIn(f"superiority.{key}", str(raised.exception))


class PromotionDecisionTests(_ToolsCase):
    """genesis_superiority: the promotion decision runs the paired test on real runs only."""

    def test_aa_noise_does_not_promote_more_often_than_alpha(self) -> None:
        # The same agent, identical per-case pass probability in both windows, the same
        # case ids. Today the window comparison promotes ~44% of these trials.
        repo_root = self._override(SUPERIORITY_BLOCK)
        promoted = 0
        for earlier, later in _aa_trials(random.Random(AA_SEED))[:100]:
            rows = [_row("cand", f"CASE-{i:03d}", p, days_ago=40) for i, p in enumerate(earlier)]
            rows += [_row("cand", f"CASE-{i:03d}", p, days_ago=5) for i, p in enumerate(later)]
            _write_runs(self.tools, rows)
            proof = compute_eval_window_superiority(entity_id="cand", base_dir=self.tools, repo_root=repo_root)
            promoted += proof["passed"] is True
        self.assertLessEqual(promoted / 100, ALPHA, f"A/A promoted {promoted}/100 trials")

    def test_mock_runs_never_make_a_promotion(self) -> None:
        rows = [_row("cand", f"CASE-{i:03d}", False, days_ago=40, mock_mode=True) for i in range(10)]
        rows += [_row("cand", f"CASE-{i:03d}", True, days_ago=5, mock_mode=True) for i in range(10)]
        _write_runs(self.tools, rows)
        proof = compute_eval_window_superiority(
            entity_id="cand", base_dir=self.tools, repo_root=self._override(SUPERIORITY_BLOCK)
        )
        self.assertFalse(proof["passed"], "a gain made of mock eval runs promoted the candidate")

    def test_the_comparison_is_called_real_only_with_the_registered_values(self) -> None:
        with mock.patch.object(genesis_superiority, "compare_eval_windows", wraps=compare_eval_windows) as spy:
            compute_eval_window_superiority(
                entity_id="cand", base_dir=self.tools, repo_root=self._override(SUPERIORITY_BLOCK)
            )
        self.assertTrue(spy.call_args_list, "the promotion decision ran no comparison")
        for call in spy.call_args_list:
            self.assertIs(call.kwargs.get("mock_mode"), False, "promotion read mock eval runs")
        self.assertTrue(
            any(c.kwargs.get("alpha") == ALPHA and c.kwargs.get("min_discordant_pairs") == MIN_PAIRS
                for c in spy.call_args_list),
            "the paired test did not receive the pre-registered alpha / min_discordant_pairs",
        )


class PairedModeTests(_ToolsCase):
    """compare_eval_windows' paired mode: exact McNemar on discordant pairs (new API)."""

    def _paired(self, *, alpha: float = ALPHA, min_pairs: int = MIN_PAIRS, mock_mode: bool = False) -> dict[str, Any]:
        return compare_eval_windows(
            target_agent="cand", incumbent_agent="inc", base_dir=self.tools,
            alpha=alpha, min_discordant_pairs=min_pairs, mock_mode=mock_mode,
        )

    def test_exact_mcnemar_and_wilson_lower_on_a_known_table(self) -> None:
        _write_runs(self.tools, _table(both=5, candidate_only=9, incumbent_only=1, neither=3))
        result = self._paired(min_pairs=10)
        self.assertEqual(result["mode"], "paired")
        self.assertEqual(result["paired_case_count"], 18)
        self.assertEqual(result["discordant_pairs"], {"candidate_only": 9, "incumbent_only": 1})
        # P(X >= 9 | n=10, 1/2) = (C(10,9) + C(10,10)) / 2^10 = 11/1024.
        self.assertAlmostEqual(result["p_value"], 11 / 1024, places=12)
        # Wilson 95% lower bound of 9/10 (z=1.96), the judge_calibration owner's value.
        self.assertEqual(result["wilson_lower"], 0.5958)
        self.assertEqual(result["wilson_lower"], wilson_lower(9, 10))
        self.assertEqual((result["alpha"], result["min_discordant_pairs"]), (ALPHA, 10))
        self.assertEqual(result["verdict"], "improved")

    def test_known_tables_decide_by_p_value_and_pair_count(self) -> None:
        # (candidate_only, incumbent_only, min_pairs) -> (exact one-sided p, verdict)
        cases = {
            (6, 0, 6): (1 / 64, "improved"),
            (3, 0, 3): (1 / 8, None),  # p > alpha: measured, not a gain
            (5, 5, 6): (638 / 1024, None),
            (1, 9, 6): (1023 / 1024, None),
            (6, 0, 10): (1 / 64, "insufficient_evidence"),  # significant but too few pairs
        }
        for (c, b, min_pairs), (p_value, verdict) in cases.items():
            with self.subTest(candidate_only=c, incumbent_only=b, min_pairs=min_pairs):
                _write_runs(self.tools, _table(both=4, candidate_only=c, incumbent_only=b, neither=2))
                result = self._paired(min_pairs=min_pairs)
                self.assertAlmostEqual(result["p_value"], p_value, places=12)
                if verdict is None:
                    self.assertNotIn(result["verdict"], ("improved", "insufficient_evidence"))
                else:
                    self.assertEqual(result["verdict"], verdict)

    def test_only_shared_case_ids_are_paired(self) -> None:
        rows = _table(both=2, candidate_only=1, incumbent_only=1, neither=0)
        rows += [_row("cand", f"ONLY-CAND-{i}", True) for i in range(20)]
        rows += [_row("inc", f"ONLY-INC-{i}", False) for i in range(20)]
        _write_runs(self.tools, rows)
        result = self._paired()
        self.assertEqual(result["paired_case_count"], 4)
        self.assertEqual(result["discordant_pairs"], {"candidate_only": 1, "incumbent_only": 1})

    def test_mock_runs_are_not_scored(self) -> None:
        rows = _table(both=2, candidate_only=1, incumbent_only=1, neither=0)
        for i in range(20):
            rows += [_row("cand", f"MOCK-{i}", True, mock_mode=True), _row("inc", f"MOCK-{i}", False, mock_mode=True)]
        _write_runs(self.tools, rows)
        self.assertEqual(self._paired()["discordant_pairs"], {"candidate_only": 1, "incumbent_only": 1})
        with self.assertRaises(GovernanceError):
            self._paired(mock_mode=True)

    def test_aa_improved_rate_is_at_most_alpha(self) -> None:
        improved = 0
        for first, second in _aa_trials(random.Random(AA_SEED)):
            rows = []
            for i, (cand, inc) in enumerate(zip(first, second)):
                rows += [_row("cand", f"CASE-{i:03d}", cand), _row("inc", f"CASE-{i:03d}", inc)]
            _write_runs(self.tools, rows)
            improved += self._paired()["verdict"] == "improved"
        self.assertLessEqual(improved / AA_TRIALS, ALPHA, f"A/A improved {improved}/{AA_TRIALS}")


if __name__ == "__main__":
    unittest.main()
