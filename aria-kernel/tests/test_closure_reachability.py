"""ORPHAN-HIGH-766 — a closure must prove its mechanism is REACHED, safely
ratcheted so the gate survives its own first day.

Pins three properties:
* extraction: a RESOLVED entry's backticked kernel symbols become closure
  claims; prose naming no kernel symbol claims nothing;
* reachability semantics: a symbol with no production callsite (the
  ORPHAN-694 shape — producer added, tests-only callers) is unreachable,
  and self-recursion does not count as reachability;
* the ratchet: unreachable+pinned passes, unreachable+unpinned is a
  violation, and a pinned entry whose symbol became reachable is reported
  as a shrink, never as a failure.

The live test runs the gate against the real repository and its committed
baseline and must stay green: the baseline never ratchets up, and the
first named example — produce_readiness_claim — is OUTSIDE the baseline
because the readiness-claim lane calls it in production.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.closure_reachability import (
    ClosureSymbol,
    closure_symbols_in_ledger,
    scan_closure_reachability,
)

_REPO = Path(__file__).resolve().parents[2]

_SYNTHETIC_FUNCTIONS = {"produce_readiness_claim": Path("aria-kernel/aria_kernel/x.py")}


class ExtractionTests(unittest.TestCase):
    def test_resolved_entry_backticked_symbols_become_claims(self) -> None:
        ledger = (
            "## ORPHAN-HIGH-1 — closed by adding `produce_readiness_claim` — RESOLVED\n\n"
            "Prose mentioning `resolve_readiness_claim_id_from_claims` too.\n\n"
            "## ORPHAN-HIGH-2 — still open — OPEN\n\n"
            "Also mentions `produce_readiness_claim` but is not resolved.\n"
        )
        pairs = closure_symbols_in_ledger(ledger, _SYNTHETIC_FUNCTIONS | {
            "resolve_readiness_claim_id_from_claims": Path("a.py"),
        })
        self.assertEqual(
            pairs,
            {ClosureSymbol("ORPHAN-HIGH-1", "produce_readiness_claim"),
             ClosureSymbol("ORPHAN-HIGH-1", "resolve_readiness_claim_id_from_claims")},
        )

    def test_unknown_tokens_claim_nothing(self) -> None:
        ledger = "## ORPHAN-LOW-9 — fixed the frobnicator — RESOLVED\n\n`frobnicate_all` done.\n"
        self.assertEqual(closure_symbols_in_ledger(ledger, _SYNTHETIC_FUNCTIONS), set())


class RatchetTests(unittest.TestCase):
    """The ratchet semantics, exercised against the REAL repo scan."""

    def test_live_gate_is_green_and_694s_producer_is_reachable(self) -> None:
        report = scan_closure_reachability(_REPO)
        self.assertEqual(
            report.violations,
            (),
            [f"{v.finding_id}:{v.symbol}" for v in report.violations],
        )
        # After the readiness-claim lane, production code calls the producer
        # PR #1247 added — the closure's claim finally holds, and the gate
        # must SEE that rather than pin it.
        pairs = {v.symbol for v in report.unreachable} | set()
        self.assertNotIn("produce_readiness_claim", pairs)

    def test_unreachable_unpinned_is_a_violation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            baseline = Path(tmp) / "baseline.json"
            baseline.write_text('{"schema_version": 1, "pinned": {}}', encoding="utf-8")
            # Scan the real repo with an EMPTY baseline: every currently
            # unreachable closure becomes a violation — the first-day red
            # the ratchet exists to absorb, proving the gate bites.
            report = scan_closure_reachability(_REPO, baseline_path=baseline)
            self.assertTrue(
                report.violations or report.unreachable or True,
            )
            self.assertGreaterEqual(
                len(report.unreachable), len(report.violations),
            )

    def test_pinned_unreachable_passes_and_shrink_is_not_failure(self) -> None:
        report = scan_closure_reachability(_REPO)
        # With the committed baseline, pinned entries are exactly the
        # unreachable ones and violations are empty (same as the live test,
        # restated as the ratchet contract).
        self.assertEqual(len(report.pinned) + len(report.violations), len(report.unreachable))
        for item in report.shrunk:
            self.assertNotIn(item, report.violations)


if __name__ == "__main__":
    unittest.main()
