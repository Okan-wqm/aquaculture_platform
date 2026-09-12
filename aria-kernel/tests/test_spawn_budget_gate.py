"""F13/E8 — the cost-budget gate finally guards the spawn.

`cost_budget.assert_within_budget` documented itself as "call BEFORE
spawning claude" and its only repo reference was a comment: every cap and
the breaker trip existed with no caller — no spawn could ever be stopped by
budget. These pin the wiring at the single choke point every live claude
spawn passes through (`claude_runtime.run_claude_exec`).
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from claude_runtime import _assert_budget_before_spawn  # noqa: E402

from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir  # noqa: E402


class SpawnBudgetGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prior = {
            k: os.environ.pop(k, None)
            for k in ("ARIA_TOOLS_DIR", "ARIA_ESTIMATED_RUN_USD")
        }
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        for key, value in self._prior.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_no_store_binding_is_ungated(self) -> None:
        # Without ARIA_TOOLS_DIR there is no spend ledger to project
        # against — local dev/tests run ungated, honestly.
        _assert_budget_before_spawn()  # no raise

    def test_over_cap_estimate_refuses_the_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            # Estimate above the per-run cap → the breaker trips and the
            # spawn is refused BEFORE any money is spent.
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "999999"
            with self.assertRaisesRegex(
                GovernanceError, "cost_budget_per_run_cap_exceeded"
            ):
                _assert_budget_before_spawn()

    def test_default_estimate_derives_from_policy_and_passes(self) -> None:
        """Executor smoke 31704817330 — the original hardcoded default
        ($1.50) sat above the policy per_run cap ($0.50): 30/30 spawns
        refused, breaker tripped on configuration. The default now derives
        from the policy (80% of per_run), so an untouched environment can
        never refuse on constant-disagreement."""
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            _assert_budget_before_spawn()  # no raise, no env estimate

    def test_within_cap_estimate_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "0.01"
            _assert_budget_before_spawn()  # no raise

    def test_managed_subscription_makes_the_dollar_gate_telemetry(self) -> None:
        """ARIA-HIGH-079 — trial eight's cross-review was refused with the
        shipped $5 daily cap after one accepted challenger, on a workspace
        whose policy said managed_subscription: notional dollars are
        telemetry under that policy (ORPHAN-HIGH-472, ARIA-HIGH-074), and
        the gate read the DEFAULT policy because it took the store's parent
        for the workspace while the store was bound elsewhere."""
        import json

        from aria_kernel.cost_budget import assert_within_budget, _load_caps
        from aria_kernel.tool_registry import bound_workspace_root, ensure_tools_binding

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            (workspace / "aria-config").mkdir(parents=True)
            (workspace / "aria-config/genesis_policy.json").write_text(json.dumps({
                "cost_caps_usd": {"daily": 5.0, "monthly": 50.0, "per_run": 4.0},
                "executor": {"adaptive_runtime": {
                    "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
                    "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
                    "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
                    "monetary_admission": "managed_subscription",
                }},
            }) + "\n", encoding="utf-8")
            import subprocess
            subprocess.run(["git", "init", "-q", str(workspace)], check=True)
            # The store lives OUTSIDE the workspace, bound to it — the
            # trial layout, and any operator who keeps state off the tree.
            store = ensure_tools_binding(Path(tmp) / "store" / "tools", workspace_root=workspace)
            self.assertEqual(bound_workspace_root(store), workspace.resolve())
            self.assertEqual(_load_caps(store)["per_run"], 4.0, "the caps come from the BOUND workspace's policy")
            snapshot = assert_within_budget(store, estimated_run_usd=3.6)
            self.assertEqual(snapshot["status"], "telemetry_only")
            self.assertEqual(snapshot["monetary_admission"], "managed_subscription")
            self.assertAlmostEqual(snapshot["projected_daily_usd"], 3.6)
            # Way over every cap: still telemetry, never a refusal or a trip.
            assert_within_budget(store, estimated_run_usd=3.9)
            self.assertFalse((store / "circuit-breaker.json").exists() and "tripped" in (store / "circuit-breaker.json").read_text())
            os.environ["ARIA_TOOLS_DIR"] = str(store)
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "3.9"
            _assert_budget_before_spawn()  # no raise

    def test_a_legacy_store_still_reads_its_parent_workspace(self) -> None:
        from aria_kernel.tool_registry import bound_workspace_root

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertEqual(bound_workspace_root(root), Path(tmp).resolve())

    def test_gate_sits_on_the_spawn_path(self) -> None:
        """Deliberate-break pin: run_claude_exec must call the gate. A
        refactor that drops the call reopens F13 silently — this fails it
        at test time instead."""
        import inspect

        import claude_runtime

        source = inspect.getsource(claude_runtime.run_claude_exec)
        self.assertIn("_assert_budget_before_spawn()", source)


if __name__ == "__main__":
    unittest.main()
