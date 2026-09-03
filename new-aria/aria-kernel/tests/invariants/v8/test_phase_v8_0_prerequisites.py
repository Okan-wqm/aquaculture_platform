"""Plan ARIA-V8 v2 §4 Phase 8.0 — pre-V8 prerequisite invariants.

Closes F-014-D0. 6 invariants:

- I-V8.0-01 — INVERTED (CL-1): the drainer has no polling primitive at all
- I-V8.0-02 — fold_plan_state cache hits when events.jsonl mtime stable
- I-V8.0-03 — fold_plan_state cache invalidates when events.jsonl mtime advances
- I-V8.0-04 — CLI fail-fast: --cycle-deadline-seconds too small → exit 2
- I-V8.0-05 — Budget reservation + reconciliation round-trip
- I-V8.0-06 — Budget enforcement: BudgetExhausted raised when remaining < estimate
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401 — wires aria-kernel into sys.path

from aria_kernel import budget, plan_convergence, secret_scrub
class TestNoPollingInConvergence(unittest.TestCase):
    """I-V8.0-01 INVERTED by CL-1 (ORPHAN-725): the poll this pin used to
    protect is deliberately dead. The cycle lane mints envelopes; the
    executor lane delivers them in a LATER workflow run, so any in-cycle
    wait for plan state is structurally a lost lottery (13/13 timeouts in
    production). The successor truth: the drainer module contains no
    polling primitive and never sleeps."""

    def test_poll_primitive_is_gone(self):
        import aria_kernel.convergence_drainer as drainer_module

        self.assertFalse(hasattr(drainer_module, "_poll_for_state"))

    def test_drainer_source_never_sleeps(self):
        import inspect

        import aria_kernel.convergence_drainer as drainer_module

        source = inspect.getsource(drainer_module)
        self.assertNotIn("time.sleep", source)


class TestFoldPlanStateCache(unittest.TestCase):
    """I-V8.0-02 + I-V8.0-03 — Per-mtime cache + invalidation."""

    def _setup_plan(self, base: Path, plan_id: str) -> None:
        from aria_kernel.plan_convergence import start_plan
        start_plan(
            plan_id=plan_id,
            plan_content={
                "schema_version": 1,
                "title": "fixture",
                "summary": "fixture plan for cache test",
                "affected_surfaces": ["fixture.py"],
                "key_changes": [{"id": "c1", "description": "fixture", "paths": ["fixture.py"]}],
                "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
                "evidence_refs": ["fixture.py:1:ok"],
            },
            initial_revision_id=f"{plan_id}-r1",
            base_dir=base,
        )

    def test_cache_hit_when_mtime_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plan_id = "plan-cache-hit"
            self._setup_plan(base, plan_id)
            # Clear any cached entries from setup
            plan_convergence._FOLD_PLAN_STATE_CACHE.clear()
            # Call fold_plan_state 5 times; only the first should hit disk
            first = plan_convergence.fold_plan_state(plan_id=plan_id, base_dir=base)
            for _ in range(4):
                subsequent = plan_convergence.fold_plan_state(plan_id=plan_id, base_dir=base)
                self.assertEqual(subsequent.get("state"), first.get("state"))
            # Cache should contain 1 entry for this plan
            entries = [k for k in plan_convergence._FOLD_PLAN_STATE_CACHE if k[2] == plan_id]
            self.assertEqual(len(entries), 1)

    def test_cache_invalidates_on_events_jsonl_size_change(self):
        """When events.jsonl size advances (real append), cache invalidates
        and the next fold_plan_state reads fresh from disk.

        Strategy: directly append a synthetic row to events.jsonl that
        changes file size; verify cache key changes; verify the next
        fold call observes the new size and recomputes (size-based
        key naturally invalidates)."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plan_id = "plan-cache-invalidate"
            self._setup_plan(base, plan_id)
            plan_convergence._FOLD_PLAN_STATE_CACHE.clear()
            events_path = plan_convergence.events_path(base)
            size_before = events_path.stat().st_size
            # Cache should populate on first read
            plan_convergence.fold_plan_state(plan_id=plan_id, base_dir=base)
            cache_keys_before = list(plan_convergence._FOLD_PLAN_STATE_CACHE.keys())
            from tests._helpers.declared_fixtures import append_declared_fixture
            append_declared_fixture(
                events_path,
                {"plan_id": "other-plan", "event_type": "noop"},
                expected_surface="plan_convergence_events",
            )
            size_after = events_path.stat().st_size
            self.assertGreater(size_after, size_before)
            # Next call should compute a new cache entry (different size key)
            plan_convergence.fold_plan_state(plan_id=plan_id, base_dir=base)
            cache_keys_after = list(plan_convergence._FOLD_PLAN_STATE_CACHE.keys())
            # The cache keys' first element (size) MUST differ
            sizes_in_cache = {k[0] for k in cache_keys_after}
            self.assertGreater(len(sizes_in_cache), 1, "cache should have entries for both old + new size")


class TestCliFailFast(unittest.TestCase):
    """I-V8.0-04 INVERTED by CL-1 (ORPHAN-725): the deadline floor was
    sized for in-cycle waits (max_rounds × 3 envelopes × timeout) that
    no longer exist — the step function never blocks, so a 60s deadline
    with a 1800s challenger timeout is now a LEGAL configuration and the
    CLI must not refuse it."""

    def test_small_cycle_deadline_is_no_longer_refused_at_parse_time(self):
        # Source-level pin: reintroducing the floor expression fails here
        # without spawning a real orchestrator run.
        import inspect

        from aria_kernel import cli as cli_module

        source = inspect.getsource(cli_module)
        self.assertNotIn("_v8_min_cycle_deadline", source)
        self.assertNotIn("max_rounds × 3 envelopes", source)


class TestBudgetReservation(unittest.TestCase):
    """I-V8.0-05 + I-V8.0-06 — reservation + reconciliation + exhaustion."""

    def test_reservation_reconciliation_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            token = budget.reserve_cycle_budget(
                cycle_id="cyc-test",
                estimated_cost_usd=0.50,
                base_dir=base,
                max_budget_usd_per_run=5.00,
            )
            self.assertTrue(token.startswith("sha256:"))
            remaining_after_reserve = budget.check_remaining_budget(
                reservation_token=token, base_dir=base
            )
            self.assertAlmostEqual(remaining_after_reserve, 0.50, places=4)
            budget.reconcile_envelope_cost(
                reservation_token=token,
                envelope_id="env-1",
                actual_cost_usd=0.30,
                base_dir=base,
            )
            remaining_after_reconcile = budget.check_remaining_budget(
                reservation_token=token, base_dir=base
            )
            self.assertAlmostEqual(remaining_after_reconcile, 0.20, places=4)

    def test_reservation_exhausted_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # First reservation consumes most of the budget
            token = budget.reserve_cycle_budget(
                cycle_id="cyc-1",
                estimated_cost_usd=0.40,
                base_dir=base,
                max_budget_usd_per_run=0.50,
            )
            budget.reconcile_envelope_cost(
                reservation_token=token,
                envelope_id="env-large",
                actual_cost_usd=0.45,
            base_dir=base,
            )
            # Second reservation should exhaust
            with self.assertRaises(budget.BudgetExhausted) as ctx:
                budget.reserve_cycle_budget(
                    cycle_id="cyc-2",
                    estimated_cost_usd=0.10,
                    base_dir=base,
                    max_budget_usd_per_run=0.50,
                )
            self.assertIn("remaining_run=", str(ctx.exception))


class TestSecretScrub(unittest.TestCase):
    """Smoke test for secret_scrub.scrub_text (used by C5)."""

    def test_scrub_redacts_known_patterns(self):
        fake_aws_key = "AKIA" + "1234567890ABCDEF"
        text = f"API key {fake_aws_key} used by alice@example.com from 192.168.1.1"
        scrubbed, types = secret_scrub.scrub_text(text)
        self.assertNotIn(fake_aws_key, scrubbed)
        self.assertNotIn("alice@example.com", scrubbed)
        self.assertNotIn("192.168.1.1", scrubbed)
        self.assertIn("aws_access_key", types)
        self.assertIn("email", types)
        self.assertIn("ipv4_octet", types)


if __name__ == "__main__":
    unittest.main()
