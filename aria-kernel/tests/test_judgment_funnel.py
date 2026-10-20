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


def _run_phase(tmp: str, *, sample_items: list[dict] | None = None, enable_funnel: bool = False,
               drained: int = 0):
    """Run the real phase entry point with the sampler/dispatch recorded.

    Production-shaped: nothing mocks the process under test — the phase, the
    policy accessor, the drain measurement and the ledgers all run for real;
    only the two organs the funnel sits BETWEEN are recorded (the sampler's
    output is the funnel's real input, the dispatch's recorded kwargs are the
    funnel's real output), plus the request ledgers that feed the drain
    measurement (the suite's established seeding shape,
    test_request_admission._ledgers).
    """
    ctx = _context(tmp)
    calls: dict[str, list] = {"dispatch": []}
    items = sample_items if sample_items is not None else [
        {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
    ]
    if enable_funnel:
        # The operator's production activation: the policy override file the
        # accessor merges over the shipped defaults.
        import json

        override = Path(tmp) / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(json.dumps({
            "$schema": "aria/genesis-policy/v1",
            "judgment_pipeline": {"funnel_enabled": True},
        }), encoding="utf-8")

    def fake_sample(**kw):
        return {"sample_id": "S1", "cycle_id": kw.get("cycle_id"), "items": [dict(i) for i in items]}

    def fake_dispatch(**kw):
        calls["dispatch"].append(kw)
        return {"minted": [], "skipped": []}

    from datetime import datetime, timedelta, timezone

    now = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)
    ledgers = _seed_ledgers(drained=drained, now=now)

    with patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
         patch("aria_kernel.feedback_store.generate_judgment_sample", fake_sample), \
         patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_dispatch), \
         patch("aria_kernel.feedback_store.generate_ai_consensus",
               return_value={"consensus": []}), \
         patch("aria_kernel.request_drain_capacity._request_ledgers", return_value=ledgers), \
         patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value="a" * 40):
        result = cycle_mod._phase_judgment_pipeline(ctx)
    return result, calls, ctx


def _seed_ledgers(*, drained: int, now) -> tuple[list[dict], list[dict], list[dict]]:
    """Request/result/claim ledgers with ``drained`` results inside the
    7-day window (drain_per_day = drained/7) and no claimable backlog."""
    from datetime import timedelta

    iso = lambda dt: dt.isoformat().replace("+00:00", "Z")  # noqa: E731

    requests, results = [], []
    for i in range(drained):
        requests.append({"request_id": f"d-{i}", "role": "evidence_judgment",
                         "state": "pending", "created_at": iso(now - timedelta(days=1, hours=1))})
        results.append({"request_id": f"d-{i}", "status": "rejected",
                        "submitted_at": iso(now - timedelta(days=1))})
    return requests, results, []


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


class EnvelopeBudgetHoldsTest(unittest.TestCase):
    """Caps HOLD (579 discipline): refusal, never a raise, never lost work."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def test_a_dead_drain_holds_the_night_mints_nothing_and_the_phase_completes(self) -> None:
        # The measured drain is 0 (the design-time verdict: last judgment
        # mint 2026-10-01) → tonight's envelope allowance is 0 → the funnel
        # plans no seat, dispatch is never handed an item, the phase returns
        # completed and ONE governance row names the held work.
        with TemporaryDirectory() as tmp:
            result, calls, ctx = _run_phase(
                tmp, enable_funnel=True, drained=0,
                sample_items=[
                    {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
                    {"finding_id": "F2", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
                ],
            )

            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["judge_requests_minted"], 0)
            for kw in calls["dispatch"]:
                self.assertEqual(kw["sample"]["items"], [],
                                 "a held night must not hand the fan-out any item")
            kinds = _governance_kinds(ctx.base_dir)
            self.assertEqual(kinds.count("judgment_funnel_budget_held"), 1)
            # HOLD, not fail: no blocked entry, no GovernanceError, nothing
            # that reads as a fault.
            self.assertEqual(result["blocked"], [])
            # 579 discipline: the findings stay sampleable — the funnel wrote
            # no feedback row that would exclude them from the next sample.
            feedback = ctx.base_dir / "feedback.jsonl"
            self.assertFalse(feedback.exists())

    def test_a_live_drain_grants_a_drain_sized_allowance(self) -> None:
        # 91 results in the 7-day window = 13/day → allowance = min(cap 13,
        # ceil(13)) = 13 envelopes; the item's pair (2 seats) fits.
        with TemporaryDirectory() as tmp:
            result, calls, _ctx = _run_phase(
                tmp, enable_funnel=True, drained=91,
                sample_items=[{"finding_id": "F1", "tool_id": "adapter-a",
                               "run_id": "run-1", "rule": "rule-x"}],
            )
            self.assertEqual(result["status"], "completed")
            self.assertTrue(any(kw["sample"]["items"] for kw in calls["dispatch"]),
                            "a live drain must route the sampled item")

    def test_the_mint_path_never_calls_the_raising_budget_gate(self) -> None:
        # assert_within_budget raises GovernanceError and trips the breaker:
        # banned from every mint path. The module's own source is the proof
        # surface — a call would have to be spelled here.
        import aria_kernel.judgment_funnel as funnel_mod
        import inspect

        source = inspect.getsource(funnel_mod)
        self.assertNotIn("assert_within_budget", source)
        self.assertNotIn("from .cost_budget", source)

    def test_the_funnel_is_admitted_through_the_request_admission_door(self) -> None:
        # The envelope hold is expressed THROUGH the door: a per-tier
        # producer classified in PRODUCER_CLASSES, so a refusal is named,
        # recorded by the door, and the finding is re-offered next cycle.
        from aria_kernel.request_admission import PRODUCER_CLASSES

        spec = PRODUCER_CLASSES.get("judgment_funnel.tiers")
        self.assertIsNotNone(spec, "the funnel's mint must be classified at the door")
        self.assertEqual(
            spec.roles,
            {"evidence_judgment": "discretionary", "adversarial_judgment": "discretionary"},
        )


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
