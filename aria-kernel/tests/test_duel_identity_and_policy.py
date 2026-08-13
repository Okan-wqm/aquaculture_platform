"""C8/E11 — the duel names its real combatants; the promotion reads policy.

Two teeth of one defect: (a) `_record_duel_observation` wrote the role
literals unconditionally, so a genesis candidate never appeared in its
own duel history and `genesis_superiority`'s `involved` filter kept the
duel component at not_evaluated forever; (b) `record_transition` called
`compute_eval_window_superiority` without repo_root, so the operator's
`superiority` policy block was dead configuration.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.genesis_policy import SUPERIORITY_DEFAULTS, superiority_policy
from aria_kernel.genesis_superiority import duel_observations
from aria_kernel.plan_convergence import _record_duel_observation
from aria_kernel.tool_registry import ensure_tools_dir

_CANDIDATE = "aria-challenger-planner-gen2-cafe1234"


def _fold(round_number: int, *, challenger: str | None, primary: str | None) -> dict:
    state: dict = {
        "cross_reviews": {
            round_number: {
                "reviews": [
                    {
                        "review_direction": "challenger_to_primary",
                        "verdict": "material_risks_present",
                    }
                ]
            }
        },
        "cross_review_risks_by_round": {},
        "resolved_review_risk_ids": [],
    }
    if challenger is not None:
        state["challenger"] = {"challenger_agent": challenger}
    if primary is not None:
        state["primary_agents_by_round"] = {round_number: primary}
    return state


class DuelIdentityTests(unittest.TestCase):
    def _record(self, fold: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            _record_duel_observation(root, "plan-c8", 1, fold, {"terminal_state": "CONVERGED"})
            path = root / "knowledge-graph" / "duel-ratings.jsonl"
            row = json.loads(path.read_text(encoding="utf-8").strip().splitlines()[-1])
            # duel_observations reads through the same tools root before
            # the tmp dir vanishes.
            self._observations = duel_observations(base_dir=root)
        return row

    def test_real_identities_reach_the_duel_row(self) -> None:
        row = self._record(_fold(1, challenger=_CANDIDATE, primary="aria-primary-planner-gen3-beef"))
        self.assertEqual(row["challenger_agent"], _CANDIDATE)
        self.assertEqual(row["primary_agent"], "aria-primary-planner-gen3-beef")

    def test_genesis_candidate_flows_into_bradley_terry_observations(self) -> None:
        # Deliberate-break for the ORIGINAL defect: pre-C8 this candidate
        # could never appear as winner or loser, so the superiority gate's
        # `involved` filter matched nothing.
        self._record(_fold(1, challenger=_CANDIDATE, primary=None))
        self.assertTrue(
            any(_CANDIDATE in (o["winner"], o["loser"]) for o in self._observations)
        )

    def test_role_defaults_remain_for_legacy_state(self) -> None:
        row = self._record(_fold(1, challenger=None, primary=None))
        self.assertEqual(row["primary_agent"], "aria-primary-planner")
        self.assertEqual(row["challenger_agent"], "aria-challenger-planner")


class SuperiorityPolicyThreadingTests(unittest.TestCase):
    def test_operator_override_is_read_through_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            override = repo_root / "aria-config" / "genesis_policy.json"
            override.parent.mkdir(parents=True, exist_ok=True)
            override.write_text(
                json.dumps({"superiority": {"min_duel_matches": 1}}),
                encoding="utf-8",
            )
            policy = superiority_policy(repo_root)
        self.assertEqual(policy["min_duel_matches"], 1)
        self.assertNotEqual(policy["min_duel_matches"], SUPERIORITY_DEFAULTS["min_duel_matches"])

    def test_record_transition_threads_repo_root_to_superiority(self) -> None:
        # Deliberate-break: pre-C8 `record_transition` had no repo_root
        # parameter at all — the policy could not reach the computation.
        from aria_kernel import genesis_lifecycle

        captured: dict = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return {"passed": False, "reasons": ["captured"], "duel": {}}

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with mock.patch(
                "aria_kernel.genesis_superiority.compute_eval_window_superiority",
                side_effect=_capture,
            ):
                try:
                    genesis_lifecycle.record_transition(
                        entity_id="agent-x",
                        entity_kind="agent",
                        to_state="ACTIVE",
                        evidence={},
                        base_dir=root,
                        repo_root="/some/repo",
                    )
                except Exception:
                    # The transition itself is expected to be rejected on
                    # missing evidence — the assertion is the threading.
                    pass
        self.assertEqual(captured.get("repo_root"), "/some/repo")


if __name__ == "__main__":
    unittest.main()
