"""ORPHAN-HIGH-311 — truthful USD cost attribution.

The FIRST real production cycle (run 28586601819) recorded a claude-fable-5
dispatch of 15,801 input + 27,294 output tokens with a hardcoded
``estimated_usd=0.0`` — the operator's USD budget caps ($3/cycle, $20/run)
could never bind and the daily-report ROI metric would read $0 forever.
This suite pins the notional pricing SSoT and the executor's resolution
order (actual CLI cost > notional token pricing > LOUD zero).
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel.budget import MODEL_PRICING_USD_PER_MTOK, estimate_tokens_usd

CI_EXECUTOR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"


class EstimateTokensUsdTests(unittest.TestCase):
    def test_first_real_cycle_dispatch_is_no_longer_free(self):
        # The exact token pair the defect was found with.
        usd = estimate_tokens_usd(model="claude-fable-5", input_tokens=15_801, output_tokens=27_294)
        self.assertAlmostEqual(usd, 15_801 * 10 / 1e6 + 27_294 * 50 / 1e6, places=6)
        self.assertGreater(usd, 1.5)

    def test_dated_model_suffix_matches_by_prefix(self):
        usd = estimate_tokens_usd(model="claude-haiku-4-5-20251001", input_tokens=1_000_000, output_tokens=0)
        self.assertEqual(usd, 1.0)

    def test_unknown_model_returns_zero_for_caller_to_surface(self):
        self.assertEqual(
            estimate_tokens_usd(model="claude-cli", input_tokens=1000, output_tokens=1000), 0.0,
        )

    def test_negative_tokens_clamped(self):
        self.assertEqual(
            estimate_tokens_usd(model="claude-fable-5", input_tokens=-5, output_tokens=-5), 0.0,
        )

    def test_pricing_table_covers_the_dispatch_tier_policy_models(self):
        # ARIA's tier policy dispatches fable decision nodes + opus judges;
        # both tiers MUST price or the caps under-count silently.
        for model in (
            "claude-fable-5", "claude-opus-5", "claude-opus-4-8",
            "claude-sonnet-4-6", "claude-haiku-4-5",
        ):
            self.assertIn(model, MODEL_PRICING_USD_PER_MTOK)

    def test_rates_are_positive_input_output_pairs(self):
        for model, (in_rate, out_rate) in MODEL_PRICING_USD_PER_MTOK.items():
            self.assertGreater(in_rate, 0, model)
            self.assertGreater(out_rate, in_rate, model)


class ExecutorAttributionSourcePins(unittest.TestCase):
    """The executor source must never regress to the silent hardcoded zero."""

    def setUp(self):
        self.source = CI_EXECUTOR.read_text(encoding="utf-8")

    def test_no_hardcoded_zero_attribution(self):
        self.assertNotIn("estimated_usd=0.0,", self.source)

    def test_resolution_order_present(self):
        self.assertIn("estimate_tokens_usd", self.source)
        self.assertIn("total_cost_usd", self.source)
        self.assertIn("cost_pricing_unknown_model", self.source)

    def test_actual_cost_read_from_terminal_result_event(self):
        tree = ast.parse(self.source)
        func = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_record_claude_cli_usage"
        )
        dumped = ast.dump(func)
        self.assertIn("total_cost_usd", dumped)
        self.assertIn("estimate_tokens_usd", dumped)


if __name__ == "__main__":
    unittest.main()


class AliasPricingCoverageTests(unittest.TestCase):
    """ORPHAN-HIGH-473 — every dispatchable ALIAS must have a priced family.

    The hardcoded list above could not catch the defect that motivated this:
    ARIA dispatches by CLI alias (`opus`, `fable`, ...), the alias means
    "latest <family>", and the id written to the cost ledger is whatever full
    name the CLI resolved. So a new model generation shipping under an existing
    alias silently falls through to the unknown-model 0.0 without any list in
    this file changing — exactly how `opus` -> claude-opus-5 came to record
    $0.00.

    Deriving the assertion from the alias allowlist catches one specific
    regression: adding a dispatch tier and shipping it with no pricing at all.

    It does NOT catch the case that actually happened, and saying so matters
    more than the test looking strong. `opus` -> claude-opus-5 fell through
    while claude-opus-4-8 was still priced, so the claude-opus-* family was
    non-empty and this assertion stayed green. Catching a NEW GENERATION inside
    an already-priced family needs the resolved id, which is runtime
    information no static test has. The complements that do cover it are the
    explicit id list above and the runtime cost_pricing_unknown_model
    governance event — and that event is currently emitted inside a nested
    try/except, which is tracked separately in ORPHAN-HIGH-473.
    """

    def test_every_dispatchable_alias_has_at_least_one_priced_model(self) -> None:
        from aria_kernel.agent_runtime_profile import VALID_MODELS

        for alias in sorted(VALID_MODELS):
            with self.subTest(alias=alias):
                family = f"claude-{alias}-"
                priced = [k for k in MODEL_PRICING_USD_PER_MTOK if k.startswith(family)]
                self.assertTrue(
                    priced,
                    f"alias {alias!r} is dispatchable but no claude-{alias}-* row is "
                    f"priced; a dispatch on it would record $0.00",
                )

    def test_no_truncated_key_shadows_a_dated_key(self) -> None:
        """budget.py returns the FIRST dict-order match, not the longest prefix.

        A short key such as `claude-opus` would therefore swallow every dated
        opus entry that follows it and price them all at the wrong rate.
        """
        keys = list(MODEL_PRICING_USD_PER_MTOK)
        for i, short in enumerate(keys):
            for long in keys[i + 1:]:
                with self.subTest(short=short, long=long):
                    self.assertFalse(
                        long.startswith(f"{short}-"),
                        f"{short!r} precedes and shadows {long!r}",
                    )
