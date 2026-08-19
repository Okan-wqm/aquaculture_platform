"""Plan ARIA-V3.1-0 — cycle_phases scaffold invariants.

Closes:
  * H-1 (god-function): Protocol-based DI seam ready for V3.1-A..D
    to install real implementations without re-touching the
    orchestrator body.
  * H-10 (cold-start imports): every phase module loads under
    PATH=/usr/bin:/bin + GH_TOKEN/HOME unset.
  * H-15 (Tier-1 honesty): each Protocol has a NoOp default variant
    so behavior neutrality holds when injection is absent.

Invariants:

* I-V31-0-01 — `autonomy_orchestrator.py` top-level imports do not
  pull from `cycle_phases.*` runtime (only the package-level
  re-export is permitted; submodules stay lazy).
* I-V31-0-02 — `run_autonomy_orchestrator` body has no inline
  `if/elif phase ==` chain longer than 3.
* I-V31-0-03 — every Protocol exposed by `cycle_phases` has at least
  a `NoOp*` variant declared in the same module.
* I-V31-0-04 — full V8 P+C+CR pipeline test suite (in `tests/`) is
  importable post-scaffold (behavior-neutral integration smoke).
* I-V31-0-05 — `python -c "import aria_kernel.autonomy_orchestrator"`
  succeeds under hermetic env (PATH=/usr/bin:/bin, GH_TOKEN/HOME
  unset).
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_CYCLE_PHASES_DIR = _KERNEL_ROOT / "cycle_phases"


class CyclePhasesScaffoldTests(unittest.TestCase):
    """Plan ARIA-V3.1-0 — invariant tests for the cycle_phases package."""

    def test_i_v31_0_03_cycle_phases_package_exposes_all_protocols(self) -> None:
        """Plan ARIA-V3.1-0 — every Protocol + NoOp variant is exported
        from the package level. The package re-export is the SSoT for
        the orchestrator import surface (single import line preserves
        I-V31-0-01)."""
        sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))
        try:
            import importlib
            module = importlib.import_module("aria_kernel.cycle_phases")
        finally:
            sys.path.pop(0)
        expected_exports = {
            # Plan ARIA-V3.1-B — concrete V9ImplementationRunner
            # variants (Autonomous, Strict, NoOp).
            "AutonomousV9ImplementationRunner",
            "CostAttributionEnvelope",
            "CostTelemetryHook",
            # Plan ARIA-V3.1-D2 — production CostTelemetryHookImpl
            # variant (delegates to budget.record_cost_attribution).
            "CostTelemetryHookImpl",
            "CyclePlanEnvelope",
            "MemoryHook",
            # Plan ARIA-V3.1-C2 — production MemoryHookImpl variant
            # (bounded reader + stability check + record_convention +
            # verify_chain + skill_genesis HUMAN_REQUIRED dispatch).
            "MemoryHookImpl",
            "NoOpCostTelemetryHook",
            "NoOpMemoryHook",
            "NoOpPlanContentProvider",
            "NoOpProfileGate",
            "NoOpV9ImplementationRunner",
            "PlanContentProvider",
            "ProfileGate",
            "StrictV9ImplementationRunner",
            # Plan ARIA-V3.1-A — concrete PlanContentProvider variants
            # (V9PressureSourceProvider for 5-source mining;
            # V7GitDiffProvider for fallback).
            "V7GitDiffProvider",
            "V9ImplementationResult",
            "V9ImplementationRunner",
            "V9PressureSourceProvider",
            "select_cost_telemetry_hook",
            "select_memory_hook",
            "select_v9_implementation_runner",
        }
        actual = set(getattr(module, "__all__", ()))
        self.assertEqual(
            expected_exports, actual,
            f"cycle_phases __all__ drift: missing="
            f"{sorted(expected_exports - actual)} "
            f"extra={sorted(actual - expected_exports)}",
        )

    def test_i_v31_0_03_each_protocol_has_a_no_op_variant(self) -> None:
        """Plan ARIA-V3.1-0 — every Protocol declared in cycle_phases
        has a `NoOp*` concrete variant in the same module so the
        orchestrator's default-injection path is structurally
        guaranteed (closes H-15)."""
        protocol_to_noop = {
            "plan_source.py":   ("PlanContentProvider",     "NoOpPlanContentProvider"),
            "implementer.py":   ("V9ImplementationRunner",  "NoOpV9ImplementationRunner"),
            "memory.py":        ("MemoryHook",              "NoOpMemoryHook"),
            "cost_telemetry.py":("CostTelemetryHook",       "NoOpCostTelemetryHook"),
            "profile_gate.py":  ("ProfileGate",             "NoOpProfileGate"),
        }
        for module_name, (proto, noop) in protocol_to_noop.items():
            path = _CYCLE_PHASES_DIR / module_name
            self.assertTrue(
                path.exists(),
                f"cycle_phases/{module_name} missing",
            )
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                f"class {proto}(Protocol):", text,
                f"{module_name}: Protocol class {proto!r} declaration absent",
            )
            self.assertIn(
                f"class {noop}:", text,
                f"{module_name}: NoOp variant {noop!r} absent",
            )

    def test_i_v31_0_01_orchestrator_does_not_runtime_import_phase_submodules(self) -> None:
        """Plan ARIA-V3.1-0 — `autonomy_orchestrator.py` top-level
        imports do not eagerly pull from `cycle_phases.<submodule>`.

        Pre-v3.1 baseline: zero `cycle_phases.*` imports. v3.1 may add
        ONE package-level re-export (`from .cycle_phases import ...`)
        if needed for type annotations; v3.1-A..E install lazy
        `from .cycle_phases.X import Y` inside function bodies so
        cold-start I/O cost stays at baseline.

        Asserts: at most ONE `from .cycle_phases` import at module top
        level, and ZERO `from .cycle_phases.<submodule>` direct imports
        at top level.
        """
        path = _KERNEL_ROOT / "autonomy_orchestrator.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        package_level = 0
        submodule_level: list[str] = []
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if mod == "cycle_phases":
                    package_level += 1
                elif mod.startswith("cycle_phases."):
                    submodule_level.append(mod)
        self.assertLessEqual(
            package_level, 1,
            "autonomy_orchestrator.py: more than one top-level "
            "`from .cycle_phases import ...` line — keep the surface "
            "single-line (I-V31-0-01).",
        )
        self.assertEqual(
            submodule_level, [],
            "autonomy_orchestrator.py: top-level submodule imports "
            f"detected ({submodule_level}). Use the package re-export "
            "or a lazy in-function import (I-V31-0-01).",
        )

    def test_i_v31_0_02_orchestrator_body_has_no_long_phase_chain(self) -> None:
        """Plan ARIA-V3.1-0 — `run_autonomy_orchestrator` body has no
        inline `if/elif phase ==` chain longer than 3 arms. v3.1+
        uses Protocol-based DI instead of string-tag chains."""
        path = _KERNEL_ROOT / "autonomy_orchestrator.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))

        def _max_chain(node: ast.AST) -> int:
            if not isinstance(node, ast.If):
                return 0
            depth = 1
            cur = node
            while cur.orelse and len(cur.orelse) == 1 and isinstance(cur.orelse[0], ast.If):
                cur = cur.orelse[0]
                depth += 1
            return depth

        max_chain = 0
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run_autonomy_orchestrator":
                for child in ast.walk(node):
                    chain = _max_chain(child)
                    if chain > max_chain:
                        max_chain = chain
        self.assertLessEqual(
            max_chain, 3,
            f"`run_autonomy_orchestrator` has an `if/elif` chain of "
            f"depth {max_chain} (max permitted: 3). Refactor via "
            "Protocol DI per Plan ARIA-V3.1-0 (I-V31-0-02).",
        )

    def test_i_v31_0_04_cycle_phases_protocols_smoke_instantiate(self) -> None:
        """Plan ARIA-V3.1-0 — every NoOp variant instantiates + calls
        its contract method without raising. This is the behavior-
        neutrality floor: if a future refactor breaks the NoOp surface,
        the orchestrator's default-injection path breaks."""
        sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))
        try:
            from aria_kernel.cycle_phases import (
                CostAttributionEnvelope,
                NoOpCostTelemetryHook,
                NoOpMemoryHook,
                NoOpPlanContentProvider,
                NoOpProfileGate,
                NoOpV9ImplementationRunner,
            )
        finally:
            sys.path.pop(0)
        repo = _REPO_ROOT
        tools = repo / "aria-tools"
        # PlanContentProvider NoOp returns None.
        provider = NoOpPlanContentProvider()
        self.assertIsNone(
            provider.synthesize(
                cycle_id="cyc-test", workspace_root=repo, base_dir=tools,
                profile="standard",
            ),
        )
        # V9ImplementationRunner NoOp refuses cleanly.
        runner = NoOpV9ImplementationRunner()
        result = runner.run(
            cycle_id="cyc-test", plan_id="plan-test",
            workspace_root=repo, base_dir=tools,
            cross_review_summary={},
            profile="standard",
        )
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_REQUEST_REFUSED")
        self.assertEqual(result.specialist_review_signal, "review_converged_plan")
        # MemoryHook NoOp.
        memory = NoOpMemoryHook()
        out = memory.record(
            cycle_id="cyc-test", plan_id="plan-test",
            workspace_root=repo, base_dir=tools,
            converged_plan={}, plan_envelope_metadata={},
            profile="standard", signer_key_fp=None,
        )
        self.assertFalse(out["convention_recorded"])
        # CostTelemetryHook NoOp returns None path.
        cost = NoOpCostTelemetryHook()
        env = CostAttributionEnvelope(
            invocation_role="primary_plan",
            model="claude-opus-4-7",
            input_tokens=10, output_tokens=20, estimated_usd=0.0,
            pressure_source_type="git_diff",
            signer_key_fp="SHA256:no-key",
        )
        self.assertIsNone(
            cost.record(
                cycle_id="cyc-test", plan_id="plan-test",
                base_dir=tools, envelope=env,
            ),
        )
        # ProfileGate NoOp permits unconditionally.
        gate = NoOpProfileGate()
        verdict = gate.evaluate(
            profile="autonomous", base_dir=tools, workspace_root=repo,
        )
        self.assertTrue(verdict.permitted)

    def test_i_v31_0_05_orchestrator_cold_start_hermetic_import(self) -> None:
        """Plan ARIA-V3.1-0 — `import aria_kernel.autonomy_orchestrator`
        succeeds under hermetic env (PATH=/usr/bin:/bin, GH_TOKEN/HOME
        unset). Closes H-10 cold-start IO discipline.

        Runs the import inside a fresh `python -c` subprocess with
        minimal env so no inherited PYTHON*/HOME/GH_TOKEN can mask a
        regression. PYTHONPATH is set to aria-kernel/ so the kernel
        module is discoverable.
        """
        env = {
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": str(_REPO_ROOT / "aria-kernel"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        # PATH-only: HOME, GH_TOKEN, etc. intentionally unset.
        result = subprocess.run(
            [sys.executable, "-c", "import aria_kernel.autonomy_orchestrator"],
            env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(
            result.returncode, 0,
            f"hermetic import failed (rc={result.returncode}): "
            f"stdout={result.stdout!r} stderr={result.stderr!r}",
        )


if __name__ == "__main__":
    unittest.main()
