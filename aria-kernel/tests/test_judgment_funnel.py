"""WP-J slice C — the judgment funnel is the ONE routing owner.

`_phase_judgment_pipeline` minted the full two-judge pair for every sampled
finding (cycle.py:1950→1958): no tier, no early stop, no cache, no
drain-sized envelope. Second sealed night measured: 462 envelopes minted
against ~9 drained, 296 dead of anchor staleness. WP-J's synthesis folds
WP-J-1's panel_router and WP-J-2's in-fanout gate into ONE module,
`judgment_funnel`, called between `generate_judgment_sample` and
`dispatch_judges_for_sample`; tier assignment, escalation, early stop,
cache key and batch key live nowhere else.

The first law these tests pin: **policy-off is bit-for-bit legacy**. With the
funnel policy block absent the phase must hand `dispatch_judges_for_sample`
the sampler's own sample object with the exact legacy kwargs and write no
funnel row anywhere — the mechanical proof of wire-don't-rewrite.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.tool_registry import GovernanceError


def _context(base: str):
    return cycle_mod.build_phase_context(
        cycle_id="cyc-funnel",
        workspace_root=Path(base),
        base_dir=Path(base) / "aria-tools",
    )


def _run_phase(tmp: str, *, sample_items: list[dict] | None = None):
    """Run the real phase entry point with the sampler/dispatch recorded.

    Production-shaped: nothing mocks the process under test — the phase, the
    policy accessor and the ledgers all run for real; only the two organs the
    funnel sits BETWEEN are recorded (the sampler's output is the funnel's
    real input, the dispatch's recorded kwargs are the funnel's real output).
    """
    ctx = _context(tmp)
    calls: dict[str, list] = {"dispatch": []}
    items = sample_items if sample_items is not None else [
        {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
    ]

    def fake_sample(**kw):
        return {"sample_id": "S1", "cycle_id": kw.get("cycle_id"), "items": [dict(i) for i in items]}

    def fake_dispatch(**kw):
        calls["dispatch"].append(kw)
        return {"minted": [], "skipped": []}

    with patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
         patch("aria_kernel.feedback_store.generate_judgment_sample", fake_sample), \
         patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_dispatch), \
         patch("aria_kernel.feedback_store.generate_ai_consensus",
               return_value={"consensus": []}), \
         patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value="a" * 40):
        result = cycle_mod._phase_judgment_pipeline(ctx)
    return result, calls, ctx


def _governance_kinds(base_dir: Path) -> list[str]:
    path = base_dir / "governance.jsonl"
    if not path.exists():
        return []
    import json

    return [json.loads(line).get("kind") for line in path.read_text().splitlines() if line.strip()]


class FunnelExistsTest(unittest.TestCase):
    def test_the_one_router_module_exists_and_names_its_law(self) -> None:
        # RED-first pin: the routing owner is ONE module, imported by the
        # phase, and no tier/routing logic lives in dispatch_judges_for_sample.
        from aria_kernel import judgment_funnel

        self.assertTrue(callable(judgment_funnel.route_judgment_sample))


class PolicyOffGoldenTest(unittest.TestCase):
    """The funnel block absent → the phase is byte-identical to legacy."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def test_policy_off_hands_dispatch_the_samplers_own_sample_with_legacy_kwargs(self) -> None:
        with TemporaryDirectory() as tmp:
            result, calls, ctx = _run_phase(tmp)

            # ONE dispatch call per tool, with the legacy kwarg set — the
            # funnel must not add, drop or rename a single kwarg while off.
            self.assertEqual(len(calls["dispatch"]), 1)
            dispatched = calls["dispatch"][0]
            self.assertEqual(
                set(dispatched),
                {"sample", "base_dir", "target_sha", "repo_root", "max_pending_per_role"},
            )
            self.assertEqual(dispatched["target_sha"], "a" * 40)
            self.assertEqual(dispatched["max_pending_per_role"], 32)
            # The sample is the sampler's own object, unfiltered, unreordered.
            self.assertEqual([i["finding_id"] for i in dispatched["sample"]["items"]], ["F1"])

    def test_policy_off_writes_no_funnel_row_anywhere(self) -> None:
        with TemporaryDirectory() as tmp:
            _result, _calls, ctx = _run_phase(tmp)
            self.assertEqual(_result["status"], "completed")

            kinds = [k for k in _governance_kinds(ctx.base_dir) if k and "judgment_funnel" in k]
            self.assertEqual(kinds, [], "policy-off must write no judgment_funnel governance row")
            self.assertFalse((ctx.base_dir / "judgment-funnel").exists(),
                             "policy-off must not create the funnel ledger")

    def test_the_pre_funnel_phase_pins_still_pass_unmodified(self) -> None:
        # The existing test_judgment_pipeline_phases suite pins the phase's
        # legacy counts; running it is part of this finding's proof, recorded
        # in the commit. Here: the phase result keeps its legacy shape.
        with TemporaryDirectory() as tmp:
            result, _calls, _ctx = _run_phase(tmp)
            for key in ("sampled_findings", "judge_requests_minted", "mint_skipped_backlog",
                        "consensus_rows", "arbiter_requests_minted", "target_sha", "blocked"):
                self.assertIn(key, result)


class FunnelPolicyKeysTest(unittest.TestCase):
    def test_the_funnel_keys_are_real_configuration(self) -> None:
        # A key absent from the defaults is dead JSON: judgment_pipeline_policy
        # merges only keys JUDGMENT_PIPELINE_DEFAULTS already names, and the
        # block joins the contract only through POLICY_KEYS.
        from aria_kernel.genesis_policy import JUDGMENT_PIPELINE_DEFAULTS, POLICY_KEYS

        self.assertIn("judgment_pipeline", POLICY_KEYS)
        for key in ("funnel_enabled", "funnel_nightly_envelope", "funnel_tier4_quota",
                    "funnel_tier1_budget_seconds", "funnel_calibration_sample_per_cycle"):
            self.assertIn(key, JUDGMENT_PIPELINE_DEFAULTS, key)

    def test_the_default_is_off(self) -> None:
        # Bit-for-bit legacy is the SHIPPED default; activation is the
        # operator's override (ARIA is paused — live activation is theirs).
        from aria_kernel.genesis_policy import JUDGMENT_PIPELINE_DEFAULTS

        self.assertIs(JUDGMENT_PIPELINE_DEFAULTS["funnel_enabled"], False)


if __name__ == "__main__":
    unittest.main()
