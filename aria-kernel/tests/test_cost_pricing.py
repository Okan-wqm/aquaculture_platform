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

_REPO_ROOT = Path(__file__).resolve().parents[2]
CI_EXECUTOR = _REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"
NATIVE_ADMISSION = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "native_admission.py"
BUDGET = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "budget.py"

# Every name through which a module could price a reservation WITHOUT going
# through `price_spawn_reservation`: the raw pricing functions, the alias
# map they would need, the rate tables, and the ceiling itself.
_PRICING_ROADS_OUTSIDE_BUDGET: tuple[str, ...] = (
    "price_tokens", "estimate_tokens_usd", "alias_pricing_prefix",
    "MODEL_PRICING_USD_PER_MTOK", "MODEL_FAMILY_PRICING_USD_PER_MTOK", "ALIAS_PRICING_PREFIX",
    "SPAWN_RESERVATION_CEILING_TOKENS",
)


def _kernel_and_executor_modules() -> list[Path]:
    """Every production module that could price a dispatch, budget excluded
    (budget is where the ceiling is multiplied, by design)."""
    kernel = sorted(p for p in (_REPO_ROOT / "aria-kernel" / "aria_kernel").rglob("*.py") if p != BUDGET)
    executor = sorted((_REPO_ROOT / "tools" / "aria-poc").glob("*.py"))
    return kernel + executor


def _called_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


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
        # ORPHAN-HIGH-476 — the executor resolves through price_tokens now, so
        # it carries the pricing SOURCE alongside the number; estimate_tokens_usd
        # remains a bare-float wrapper for callers that do not persist cost.
        self.assertIn("price_tokens", self.source)
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
        self.assertIn("price_tokens", dumped)


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

        from aria_kernel.budget import alias_pricing_prefix

        for alias in sorted(VALID_MODELS):
            with self.subTest(alias=alias):
                # ORPHAN-HIGH-763 — deliberate breakage. This built the family
                # as f"claude-{alias}-", which asserted that every dispatchable
                # model is an Anthropic one. `glm-5.3` falsifies that, and the
                # successor truth is: an alias must be priced under ITS OWN
                # family, whoever ships it.
                family = alias_pricing_prefix(alias)
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


class DynamicFamilyPricingTests(unittest.TestCase):
    """ORPHAN-HIGH-476 — a new model generation must not price at $0.00.

    ARIA dispatches by CLI alias ("opus" = latest opus), so a new generation
    starts flowing through the ledger the day it ships, under an id nobody has
    added a row for. Keying pricing solely on exact ids therefore schedules the
    ORPHAN-HIGH-474 outage again on every release. Family rates make the common
    case self-maintaining; the source label keeps the estimate honest.
    """

    def test_a_future_generation_prices_by_family_instead_of_zero(self) -> None:
        from aria_kernel.budget import PRICING_SOURCE_FAMILY, price_tokens

        for unseen in ("claude-opus-9-2", "claude-fable-7", "claude-sonnet-6-20270101"):
            with self.subTest(model=unseen):
                priced = price_tokens(
                    model=unseen, input_tokens=1_000_000, output_tokens=1_000_000,
                )
                self.assertGreater(priced.usd, 0.0, "a priced family must never yield $0.00")
                self.assertEqual(priced.source, PRICING_SOURCE_FAMILY)

    def test_an_exact_id_always_beats_its_family(self) -> None:
        """Ordering is the contract: adding a family rate must never override a
        rate someone measured."""
        from aria_kernel.budget import PRICING_SOURCE_EXACT, price_tokens

        priced = price_tokens(model="claude-opus-5", input_tokens=1_000_000, output_tokens=0)
        self.assertEqual(priced.source, PRICING_SOURCE_EXACT)
        self.assertEqual(priced.matched_key, "claude-opus-5")

    def test_a_dated_suffix_on_an_exact_id_still_resolves_exact(self) -> None:
        from aria_kernel.budget import PRICING_SOURCE_EXACT, price_tokens

        priced = price_tokens(
            model="claude-haiku-4-5-20251001", input_tokens=1_000_000, output_tokens=0,
        )
        self.assertEqual(priced.source, PRICING_SOURCE_EXACT)

    def test_an_unknown_family_stays_loud(self) -> None:
        """Family fallback covers a new GENERATION, not a new vendor line; an
        unrecognised family must still surface rather than be guessed at."""
        from aria_kernel.budget import PRICING_SOURCE_UNKNOWN, price_tokens

        priced = price_tokens(model="claude-newthing-1", input_tokens=1000, output_tokens=1000)
        self.assertEqual(priced.usd, 0.0)
        self.assertEqual(priced.source, PRICING_SOURCE_UNKNOWN)

    def test_every_dispatchable_alias_has_a_family_rate(self) -> None:
        """This is the assertion the earlier alias-coverage test could not make.

        With family rates, alias coverage becomes a real guarantee: any model
        the CLI resolves from a dispatchable alias prices by its family even if
        the exact id is unknown. Previously an alias could be 'covered' by one
        stale dated entry while the current generation priced at zero.
        """
        from aria_kernel.agent_runtime_profile import VALID_MODELS
        from aria_kernel.budget import MODEL_FAMILY_PRICING_USD_PER_MTOK

        from aria_kernel.budget import alias_pricing_prefix

        for alias in sorted(VALID_MODELS):
            with self.subTest(alias=alias):
                self.assertIn(
                    alias_pricing_prefix(alias), MODEL_FAMILY_PRICING_USD_PER_MTOK,
                )

    def test_the_executor_records_the_pricing_source(self) -> None:
        """An inferred price filed as a measured one is the defect this label
        exists to prevent, so the callsite must actually use it."""
        ci = CI_EXECUTOR.read_text(encoding="utf-8")
        self.assertIn("price_tokens(", ci)
        self.assertIn("cost_pricing_inferred_from_family", ci)


class SpawnReservationPricesThroughTheAliasMap(unittest.TestCase):
    """ARIA-AUDIT-021 — the executor's pre-spawn reservation is a ledger price.

    Measured on the live lanes 2026-09-04: 82 agent requests minted, 0 results,
    no CLI invoked. The spawn gate priced the profile's raw alias (`opus`,
    `fable`) against the exact-id and family tables itself; neither is keyed
    by alias, so every Anthropic profile was "unknown cost", and unknown cost
    is deny. The ledger prices the same alias through `alias_pricing_prefix`
    and never had the defect. `price_spawn_reservation` is the one road both
    now take.
    """

    def test_opus_reserves_at_the_claude_opus_row_not_as_unknown(self) -> None:
        from aria_kernel.budget import (
            MODEL_FAMILY_PRICING_USD_PER_MTOK, PRICING_SOURCE_FAMILY, SPAWN_RESERVATION_CEILING_TOKENS,
            price_spawn_reservation,
        )

        priced = price_spawn_reservation(model="opus")
        self.assertEqual(priced.source, PRICING_SOURCE_FAMILY)
        self.assertEqual(priced.matched_key, "claude-opus")
        in_rate, out_rate = MODEL_FAMILY_PRICING_USD_PER_MTOK["claude-opus"]
        in_tokens, out_tokens = SPAWN_RESERVATION_CEILING_TOKENS
        self.assertAlmostEqual(priced.usd, (in_tokens * in_rate + out_tokens * out_rate) / 1_000_000)
        self.assertAlmostEqual(priced.usd, 3.6)

    def test_every_dispatchable_alias_reserves_a_positive_price(self) -> None:
        """The alias map is what makes this true for `fable`, `glm-5.3` and
        the rest; a raw-alias lookup is what made it false on 2026-09-04."""
        from aria_kernel.agent_runtime_profile import VALID_MODELS
        from aria_kernel.budget import PRICING_SOURCE_UNKNOWN, price_spawn_reservation

        for alias in sorted(VALID_MODELS):
            with self.subTest(alias=alias):
                priced = price_spawn_reservation(model=alias)
                self.assertNotEqual(priced.source, PRICING_SOURCE_UNKNOWN)
                self.assertGreater(priced.usd, 0.0)

    def test_the_reservation_and_the_ledger_price_one_alias_identically(self) -> None:
        from aria_kernel.budget import (
            SPAWN_RESERVATION_CEILING_TOKENS, alias_pricing_prefix, price_spawn_reservation, price_tokens,
        )

        in_tokens, out_tokens = SPAWN_RESERVATION_CEILING_TOKENS
        for alias in ("opus", "fable", "glm-5.3", "Opus "):
            with self.subTest(alias=alias):
                ledger = price_tokens(
                    model=alias_pricing_prefix(alias.strip().lower()),
                    input_tokens=in_tokens, output_tokens=out_tokens,
                )
                self.assertEqual(price_spawn_reservation(model=alias), ledger)

    def test_an_unknown_model_is_still_unknown_so_the_gate_still_denies(self) -> None:
        from aria_kernel.budget import PRICING_SOURCE_UNKNOWN, price_spawn_reservation

        priced = price_spawn_reservation(model="gpt-9-nebula")
        self.assertEqual(priced.source, PRICING_SOURCE_UNKNOWN)
        self.assertEqual(priced.usd, 0.0)

    def test_the_executor_gate_owns_no_pricing_lookup_of_its_own(self) -> None:
        """Make it impossible: the gate's ENTIRE budget import set is the
        reservation function and the one source constant it compares
        against. Any other budget name in the gate — a pricing function, a
        rate table, the ceiling constant — is a second pricing road, which
        is the divergence this closes (asserting two table names absent
        would let `price_tokens(alias)` back in unnoticed)."""
        tree = ast.parse(CI_EXECUTOR.read_text(encoding="utf-8"))
        gate = next(node for node in ast.walk(tree)
                    if isinstance(node, ast.FunctionDef) and node.name == "invoke_claude_cli")
        names = {node.id for node in ast.walk(gate) if isinstance(node, ast.Name)}
        attributes = {node.attr for node in ast.walk(gate) if isinstance(node, ast.Attribute)}
        imported = {alias.asname or alias.name for node in ast.walk(gate)
                    if isinstance(node, ast.ImportFrom) and node.module == "aria_kernel.budget"
                    for alias in node.names}
        self.assertEqual(imported, {"PRICING_SOURCE_UNKNOWN", "price_spawn_reservation"})
        for forbidden in _PRICING_ROADS_OUTSIDE_BUDGET:
            self.assertNotIn(forbidden, names, f"the gate names {forbidden} instead of pricing through budget")
            self.assertNotIn(forbidden, attributes, f"the gate reaches {forbidden} as an attribute")

    def test_no_module_outside_budget_multiplies_the_reservation_ceiling(self) -> None:
        """The fleet's admission row used to carry its own 400k/64k literals
        next to `price_tokens(alias_pricing_prefix(model))` — a second copy of
        the ceiling on the live admission path. Every kernel and executor
        module is scanned: a pricing call whose token counts are literals is
        a reservation priced somewhere other than budget, and naming the
        ceiling constant outside budget is the same copy one step removed.
        Measured usage (a name, a subscript, a call) is what the ledger
        prices and stays allowed."""
        offenders: list[str] = []
        for path in _kernel_and_executor_modules():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and node.id == "SPAWN_RESERVATION_CEILING_TOKENS":
                    offenders.append(f"{path.name}:{node.lineno} names the ceiling constant")
                if isinstance(node, ast.Call) and _called_name(node) in ("price_tokens", "estimate_tokens_usd"):
                    literal = [kw.arg for kw in node.keywords
                               if kw.arg in ("input_tokens", "output_tokens") and isinstance(kw.value, ast.Constant)]
                    if literal:
                        offenders.append(f"{path.name}:{node.lineno} prices literal {literal}")
        self.assertEqual(offenders, [])

    def test_the_fleet_admission_row_prices_through_the_reservation_function(self) -> None:
        tree = ast.parse(NATIVE_ADMISSION.read_text(encoding="utf-8"))
        admission = next(node for node in ast.walk(tree)
                         if isinstance(node, ast.FunctionDef) and node.name == "_native_runtime_admission")
        called = {_called_name(node) for node in ast.walk(admission) if isinstance(node, ast.Call)}
        self.assertIn("price_spawn_reservation", called)
        self.assertFalse(called & set(_PRICING_ROADS_OUTSIDE_BUDGET), called & set(_PRICING_ROADS_OUTSIDE_BUDGET))


class CostWindowBoundaryTests(unittest.TestCase):
    """ORPHAN-MEDIUM-482 — a row at exactly the window start must be counted.

    Rows are written as `...+00:00`; windows were built as `...Z`. A raw string
    `<` compares identically through the seconds and then puts '+' (0x2B) below
    'Z' (0x5A), so the midnight row read as EARLIER than midnight and dropped
    out of derived spend — under-counting a safety cap, which is the direction
    that matters.
    """

    def test_a_row_at_exactly_the_window_start_is_counted(self) -> None:
        from aria_kernel.budget import _before_instant

        # The exact pair the defect was found with.
        self.assertFalse(
            _before_instant("2026-07-28T00:00:00+00:00", "2026-07-28T00:00:00Z"),
            "a row recorded at exactly the window start must NOT be excluded",
        )
        # Proof the old implementation was wrong, so this test cannot pass for
        # the wrong reason: the raw string comparison it replaced said True.
        self.assertLess("2026-07-28T00:00:00+00:00", "2026-07-28T00:00:00Z")

    def test_both_iso_spellings_agree_across_the_boundary(self) -> None:
        from aria_kernel.budget import _before_instant

        for window in ("2026-07-28T00:00:00Z", "2026-07-28T00:00:00+00:00"):
            with self.subTest(window=window):
                self.assertTrue(_before_instant("2026-07-27T23:59:59+00:00", window))
                self.assertFalse(_before_instant("2026-07-28T00:00:00Z", window))
                self.assertFalse(_before_instant("2026-07-28T09:30:00+00:00", window))

    def test_an_unparseable_timestamp_is_counted_not_dropped(self) -> None:
        """Fail toward INCLUDING spend: a malformed row that vanishes from a
        budget is worse than one that inflates it."""
        from aria_kernel.budget import _before_instant

        self.assertFalse(_before_instant("garbage", "2026-07-28T00:00:00Z"))
        self.assertFalse(_before_instant("", "2026-07-28T00:00:00Z"))
        self.assertFalse(_before_instant("2026-07-28T00:00:00Z", "garbage"))

    def test_naive_timestamps_are_treated_as_utc(self) -> None:
        from aria_kernel.budget import _before_instant

        self.assertTrue(_before_instant("2026-07-27T23:00:00", "2026-07-28T00:00:00Z"))
        self.assertFalse(_before_instant("2026-07-28T01:00:00", "2026-07-28T00:00:00Z"))
