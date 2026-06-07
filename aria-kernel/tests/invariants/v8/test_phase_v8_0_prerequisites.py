"""Plan ARIA-V8 v2 §4 Phase 8.0 — pre-V8 prerequisite invariants.

Closes F-014-D0. 6 invariants:

- I-V8.0-01 — _poll_for_state regression: returns state string (not None)
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
from aria_kernel.convergence_drainer import _poll_for_state


class TestPollForStateRegression(unittest.TestCase):
    """I-V8.0-01 — Pre-V8 bug: fold_plan_state returns dict, compared
    to set[str] → always False. After C0 fix the poll observes the
    REVISED state string and returns it."""

    def test_poll_returns_state_string_after_revised(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Simulate fold_plan_state returning a state dict in REVISED
            with mock.patch(
                "aria_kernel.convergence_drainer.fold_plan_state",
                return_value={"state": "REVISED"},
            ):
                result = _poll_for_state(
                    plan_id="plan-test",
                    target_states={"REVISED"},
                    base_dir=base,
                    deadline=time.monotonic() + 5.0,
                    aria_stop_root=base,
                    sleep_interval=0.05,
                )
                self.assertEqual(result, "REVISED")

    def test_poll_returns_none_on_unmatched_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with mock.patch(
                "aria_kernel.convergence_drainer.fold_plan_state",
                return_value={"state": "DRAFT"},
            ):
                result = _poll_for_state(
                    plan_id="plan-test",
                    target_states={"REVISED", "CROSS_REVIEWED"},
                    base_dir=base,
                    deadline=time.monotonic() + 0.5,
                    aria_stop_root=base,
                    sleep_interval=0.05,
                )
                self.assertIsNone(result)


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
            # Directly append a syntactically-valid JSON row (load_jsonl
            # parses it but filters by plan_id; doesn't affect our state)
            with events_path.open("a", encoding="utf-8") as fh:
                import json as _json
                fh.write(_json.dumps({"plan_id": "other-plan", "event_type": "noop"}) + "\n")
            size_after = events_path.stat().st_size
            self.assertGreater(size_after, size_before)
            # Next call should compute a new cache entry (different size key)
            plan_convergence.fold_plan_state(plan_id=plan_id, base_dir=base)
            cache_keys_after = list(plan_convergence._FOLD_PLAN_STATE_CACHE.keys())
            # The cache keys' first element (size) MUST differ
            sizes_in_cache = {k[0] for k in cache_keys_after}
            self.assertGreater(len(sizes_in_cache), 1, "cache should have entries for both old + new size")


class TestCliFailFast(unittest.TestCase):
    """I-V8.0-04 — argparse-level fail-fast for too-small deadline."""

    def test_cycle_deadline_too_small_returns_nonzero(self):
        # Direct exec of the CLI; verify exit code 2 and stderr message
        import subprocess
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[3])}
        result = subprocess.run(
            [
                sys.executable, "-m", "aria_kernel", "autonomy", "run",
                "--max-cycles", "1",
                "--workspace-root", ".",
                "--cycle-deadline-seconds", "60",
                "--max-rounds", "4",
                "--challenger-timeout-seconds", "1800",
                "--tools-dir", "/tmp/v8-fail-fast-test",
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 2, f"stdout={result.stdout!r} stderr={result.stderr!r}")
        self.assertIn("cycle-deadline-seconds", result.stderr)
        self.assertIn("max_rounds", result.stderr)


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
        text = "API key AKIA1234567890ABCDEF used by alice@example.com from 192.168.1.1"
        scrubbed, types = secret_scrub.scrub_text(text)
        self.assertNotIn("AKIA1234567890ABCDEF", scrubbed)
        self.assertNotIn("alice@example.com", scrubbed)
        self.assertNotIn("192.168.1.1", scrubbed)
        self.assertIn("aws_access_key", types)
        self.assertIn("email", types)
        self.assertIn("ipv4_octet", types)


if __name__ == "__main__":
    unittest.main()
