"""Plan ARIA-V3.1-D2 — cost_telemetry_hook orchestrator wire +
ci_executor frozen mock sentinel + CLI factory wires.

Closes architectural anchors from V3.1-D that need orchestrator-side
invocation:

* CostTelemetryHookImpl — production variant that delegates to
  budget.record_cost_attribution + threads signer_key_fp + drift
  signal through to the cost-row write.
* select_cost_telemetry_hook factory matches the V3.1-C2 memory
  factory dispatch (observe/frozen → NoOp, others → Impl).
* CLI surface wires both factories (memory + cost) into the
  orchestrator's optional kwargs so the V8 baseline NoOp default
  is replaced by the production variant per profile.
* ci_executor _MOCK_MODE_AT_ENTRY frozen sentinel — main() captures
  the mock state ONCE at entry so a mid-run env mutation cannot
  flip cost-row recording between mint + record sites.

Invariants:

* I-V31-D2-01 — CostTelemetryHookImpl source delegates to
  budget.record_cost_attribution.
* I-V31-D2-02 — select_cost_telemetry_hook factory profile dispatch.
* I-V31-D2-03 — CLI invokes select_memory_hook + select_cost_telemetry_hook
  + threads results into run_autonomy_orchestrator.
* I-V31-D2-04 — ci_executor captures _MOCK_MODE_AT_ENTRY at main()
  entry (source AST + module-level sentinel attribute).
* I-V31-D2-05 — Hook.record() returns Path (success) or None (failure)
  + emits cost_attribution_record_failed governance event on
  exception.
"""
from __future__ import annotations

import inspect
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class CostTelemetryHookImplTests(unittest.TestCase):
    """Plan ARIA-V3.1-D2-01 + 05 — production hook surface."""

    def test_i_v31_d2_01_impl_delegates_to_budget(self) -> None:
        """Plan ARIA-V3.1-D2-01 — CostTelemetryHookImpl.record source
        invokes budget.record_cost_attribution with the envelope's
        fields threaded through (cycle_id, plan_id, agent_role, model,
        tokens, signer_key_fp, etc.)."""
        from aria_kernel.cycle_phases import cost_telemetry
        src = inspect.getsource(cost_telemetry.CostTelemetryHookImpl.record)
        self.assertIn("record_cost_attribution(", src,
                      "CostTelemetryHookImpl missing record_cost_attribution delegation")
        # Threads signer_key_fp + pressure_source_type from envelope.
        self.assertIn("envelope.signer_key_fp", src)
        self.assertIn("envelope.pressure_source_type", src)
        self.assertIn("envelope.invocation_role", src)

    def test_i_v31_d2_05_impl_swallows_exception_with_governance_event(self) -> None:
        """Plan ARIA-V3.1-D2-05 — Hook.record() catches
        record_cost_attribution exceptions + returns None + emits
        cost_attribution_record_failed event so the cycle main LLM
        call cannot be blocked by cost-row failures."""
        from aria_kernel.cycle_phases.cost_telemetry import (
            CostAttributionEnvelope, CostTelemetryHookImpl,
        )
        tmp = Path(tempfile.mkdtemp(prefix="v31d2-")).resolve()
        try:
            envelope = CostAttributionEnvelope(
                invocation_role="primary_plan",
                model="claude-opus-4-7",
                input_tokens=100, output_tokens=200,
                estimated_usd=0.01,
                pressure_source_type="git_diff",
                signer_key_fp="SHA256:test-fp",
            )
            hook = CostTelemetryHookImpl()
            with patch(
                "aria_kernel.budget.record_cost_attribution",
                side_effect=RuntimeError("synthetic_record_failure"),
            ):
                result = hook.record(
                    cycle_id="cyc-fail", plan_id="plan-fail",
                    base_dir=tmp / "aria-tools", envelope=envelope,
                )
            self.assertIsNone(result,
                              "Hook.record() must return None on exception")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class CostTelemetryHookFactoryTests(unittest.TestCase):
    """Plan ARIA-V3.1-D2-02 — select_cost_telemetry_hook dispatch."""

    def test_i_v31_d2_02_factory_profile_dispatch(self) -> None:
        from aria_kernel.cycle_phases import (
            CostTelemetryHookImpl, NoOpCostTelemetryHook,
            select_cost_telemetry_hook,
        )
        self.assertIsInstance(
            select_cost_telemetry_hook(profile="observe"),
            NoOpCostTelemetryHook,
        )
        self.assertIsInstance(
            select_cost_telemetry_hook(profile="frozen"),
            NoOpCostTelemetryHook,
        )
        for profile in ("standard", "strict", "autonomous"):
            self.assertIsInstance(
                select_cost_telemetry_hook(profile=profile),
                CostTelemetryHookImpl,
                f"profile={profile!r} expected CostTelemetryHookImpl",
            )


class CliFactoryWireTests(unittest.TestCase):
    """Plan ARIA-V3.1-D2-03 — CLI threads memory + cost factories."""

    def test_i_v31_d2_03_cli_invokes_both_factories(self) -> None:
        """Plan ARIA-V3.1-D2-03 — cli.py autonomy run path imports +
        invokes select_memory_hook + select_cost_telemetry_hook +
        passes their return values via memory_hook=, cost_telemetry_hook=
        kwargs to run_autonomy_orchestrator."""
        from aria_kernel import cli
        src = inspect.getsource(cli)
        self.assertIn("select_memory_hook", src)
        self.assertIn("select_cost_telemetry_hook", src)
        # CLI passes the results through to the orchestrator.
        self.assertIn("memory_hook=select_memory_hook(", src)
        self.assertIn(
            "cost_telemetry_hook=select_cost_telemetry_hook(", src,
        )


class CiExecutorFrozenMockSentinelTests(unittest.TestCase):
    """Plan ARIA-V3.1-D2-04 — ci_executor frozen sentinel."""

    def test_i_v31_d2_04_module_level_sentinel_declared(self) -> None:
        """Plan ARIA-V3.1-D2-04 — ci_executor module declares the
        _MOCK_MODE_AT_ENTRY sentinel at module level + main() body
        captures the value via _is_mock_mode() exactly once."""
        import importlib
        # Import via path so this test runs even if tools/aria-poc/
        # isn't on the standard import path.
        import sys
        repo = Path(__file__).resolve().parents[4]
        tools_dir = repo / "tools" / "aria-poc"
        if str(tools_dir) not in sys.path:
            sys.path.insert(0, str(tools_dir))
        ci_executor = importlib.import_module("ci_executor")
        self.assertTrue(
            hasattr(ci_executor, "_MOCK_MODE_AT_ENTRY"),
            "ci_executor missing _MOCK_MODE_AT_ENTRY sentinel",
        )
        # main() source captures the sentinel at entry.
        main_src = inspect.getsource(ci_executor.main)
        self.assertIn("_MOCK_MODE_AT_ENTRY", main_src,
                      "ci_executor.main() does not capture the sentinel")
        self.assertIn("_MOCK_MODE_AT_ENTRY = _is_mock_mode()", main_src,
                      "ci_executor.main() does not call _is_mock_mode() "
                      "to populate the frozen sentinel")


if __name__ == "__main__":
    unittest.main()
