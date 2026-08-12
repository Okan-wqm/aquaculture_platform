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

    def test_within_cap_estimate_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "0.01"
            _assert_budget_before_spawn()  # no raise

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
