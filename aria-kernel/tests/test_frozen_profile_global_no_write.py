"""Plan 026R §A.4 — frozen no-write extended to 8 legacy mutators +
DIAGNOSTIC_ALLOWLIST SSoT + AST invariant on the writer gate wiring.

13 tests:

* 7 writer-gate tests: each new gated surface (finding, debt,
  observation via update_memory, critical_observation, agent_genesis,
  human_required, tool_governance) raises GovernanceError under
  frozen.
* set_profile control-plane bypass: transitioning from frozen → another
  profile MUST succeed (otherwise frozen is a one-way kill switch).
* DIAGNOSTIC_ALLOWLIST surfaces never blocked.
* OBSERVE_PERMITTED_SURFACES regression: observe still permits
  finding/debt/observation writes.
* Three SSoT shape tests: DIAGNOSTIC_ALLOWLIST has the two documented
  entries; PLAN_020_WRITE_SURFACES extended to exactly 22; AST
  invariant — each gated writer function calls enforce_profile_for_write
  with the correct surface_kind.
"""
from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

from aria_kernel.runtime_profile import (
    DIAGNOSTIC_ALLOWLIST,
    KNOWN_WRITE_SURFACES,
    OBSERVE_PERMITTED_SURFACES,
    PLAN_020_WRITE_SURFACES,
    enforce_profile_for_write,
    get_profile,
    set_profile,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance


ARIA_KERNEL = Path(__file__).resolve().parent.parent / "aria_kernel"


def _freeze(base: Path) -> None:
    """Helper: ensure the workspace is frozen via set_profile."""
    set_profile("standard", operator_approval_ref="bootstrap", base_dir=base)
    set_profile("frozen", operator_approval_ref="incident-test", base_dir=base)


class WriterGateFrozenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a4-frozen-"))
        self.base = self.tmp / "aria-tools"
        _freeze(self.base)
        self.assertEqual(get_profile(base_dir=self.base), "frozen")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_emit_finding_blocked_under_frozen(self) -> None:
        from aria_kernel.finding import emit_finding

        repo_root = self.tmp / "repo"
        repo_root.mkdir(parents=True, exist_ok=True)
        with self.assertRaises(GovernanceError) as ctx:
            emit_finding(
                repo_root=repo_root,
                base_dir=self.base,
                claim_type="adapter_signal",
                claim_summary="x",
                severity="LOW",
                evidences=[{"path": "a", "excerpt": "e"}, {"path": "b", "excerpt": "f"}],
                facts=["fact"],
                scope_files=["a"],
            )
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'finding'", str(ctx.exception))

    def test_emit_debt_blocked_under_frozen(self) -> None:
        from aria_kernel.debt import emit_debt

        repo_root = self.tmp / "repo"
        repo_root.mkdir(parents=True, exist_ok=True)
        with self.assertRaises(GovernanceError) as ctx:
            emit_debt(
                repo_root=repo_root,
                base_dir=self.base,
                originating_finding_id="F-XXX",
                root_cause_summary="root",
                short_term_action={"summary": "stub"},
                permanent_fix_required="fix",
                permanent_fix_owner="op",
                due_date="2026-12-31",
                severity="HIGH",
            )
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'debt'", str(ctx.exception))

    def test_record_critical_observation_blocked_under_frozen(self) -> None:
        from aria_kernel.critical_observation import record_critical_observation

        with self.assertRaises(GovernanceError) as ctx:
            record_critical_observation(
                severity="CRITICAL",
                category="security",
                summary="x",
                evidence_ref="a.ts",
                base_dir=self.base,
            )
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'critical_observation'", str(ctx.exception))

    def test_request_agent_genesis_blocked_under_frozen(self) -> None:
        from aria_kernel.agent_genesis import request_agent_genesis

        with self.assertRaises(GovernanceError) as ctx:
            request_agent_genesis(
                {"gap_id": "G1", "capability_gap_key": "K1"},
                base_dir=self.base,
            )
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'agent_genesis'", str(ctx.exception))

    def test_record_human_required_blocked_under_frozen(self) -> None:
        from aria_kernel.human_required import record_human_required

        with self.assertRaises(GovernanceError) as ctx:
            record_human_required(
                request_id="REQ-1",
                severity="CRITICAL",
                reason="x",
                base_dir=self.base,
            )
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'human_required'", str(ctx.exception))

    def test_append_tools_governance_blocked_under_frozen(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            append_tools_governance(self.base, "test_event", {"foo": "bar"})
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'tool_governance'", str(ctx.exception))

    def test_update_memory_observation_blocked_under_frozen(self) -> None:
        from aria_kernel.memory import update_memory

        with self.assertRaises(GovernanceError) as ctx:
            update_memory(cycle_id="cyc-1", base_dir=self.base)
        self.assertIn("profile_violation", str(ctx.exception))
        self.assertIn("'observation'", str(ctx.exception))


class ControlPlaneBypassTests(unittest.TestCase):
    def test_set_profile_can_thaw_frozen(self) -> None:
        # The control-plane MUST be able to THAW a frozen kernel —
        # otherwise frozen is a one-way kill switch with no recovery.
        tmp = Path(tempfile.mkdtemp(prefix="aria-a4-thaw-"))
        try:
            base = tmp / "aria-tools"
            set_profile("standard", operator_approval_ref="b", base_dir=base)
            set_profile("frozen", operator_approval_ref="incident", base_dir=base)
            self.assertEqual(get_profile(base_dir=base), "frozen")
            # Thaw — must succeed despite append_tools_governance gate.
            state = set_profile(
                "standard",
                operator_approval_ref="thaw-2026-05-11",
                base_dir=base,
            )
            self.assertEqual(state["active_profile"], "standard")
            self.assertEqual(get_profile(base_dir=base), "standard")
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class DiagnosticAllowlistTests(unittest.TestCase):
    def test_diagnostic_surfaces_allowed_under_every_profile(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-a4-diag-"))
        try:
            base = tmp / "aria-tools"
            set_profile("standard", operator_approval_ref="b", base_dir=base)
            set_profile("frozen", operator_approval_ref="incident", base_dir=base)
            # Both diagnostic-allowlist surfaces accepted under frozen.
            for surface in DIAGNOSTIC_ALLOWLIST:
                profile = enforce_profile_for_write(surface, base_dir=base)
                self.assertEqual(profile, "frozen")
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_diagnostic_allowlist_constant_shape(self) -> None:
        self.assertIsInstance(DIAGNOSTIC_ALLOWLIST, frozenset)
        self.assertEqual(
            DIAGNOSTIC_ALLOWLIST,
            frozenset({"ledger_corruption_diagnostic", "diagnostic_sink_fallback"}),
        )
        # Every allowlist surface IS in KNOWN_WRITE_SURFACES.
        for s in DIAGNOSTIC_ALLOWLIST:
            self.assertIn(s, KNOWN_WRITE_SURFACES)
        # No allowlist surface is in PLAN_020_WRITE_SURFACES (they bypass
        # frozen by construction; being in the blocked set would be a
        # contradiction).
        for s in DIAGNOSTIC_ALLOWLIST:
            self.assertNotIn(s, PLAN_020_WRITE_SURFACES)


class ObservePermissionRegressionTests(unittest.TestCase):
    def test_observe_permits_finding_debt_observation(self) -> None:
        # Regression: §A.4 must NOT break the observe-mode permission
        # surface for the three observation-class writers that pre-fix
        # were allowed under observe.
        for surface in ("finding", "debt", "observation"):
            self.assertIn(surface, OBSERVE_PERMITTED_SURFACES)


class SurfaceCountInvariantTests(unittest.TestCase):
    def test_plan_020_write_surfaces_extended_to_41(self) -> None:
        # Original Plan 020 set had 14 surfaces; §A.4 adds 8 legacy
        # mutators, and enterprise autonomy hardening adds the lifecycle,
        # dispatch, registry, promotion, and CI surfaces (total 40).
        # E21-a adds `experiment_bench`, the experiment bench's own write
        # surface, so a frozen profile can stop the bench without also
        # freezing the validation matrix it runs through. Total = 41.
        self.assertEqual(len(PLAN_020_WRITE_SURFACES), 41)
        self.assertIn("experiment_bench", PLAN_020_WRITE_SURFACES)
        for new_surface in (
            "finding", "debt", "governance", "observation",
            "agent_genesis", "tool_governance",
            "critical_observation", "human_required",
            "runtime_v2_promotion", "plan_promotion_dispatch",
            "worker_verification", "worker_result",
            "pr_lifecycle", "pr_action",
            "tool_registry", "tool_lifecycle", "skill_genesis",
            "ci",
        ):
            self.assertIn(new_surface, PLAN_020_WRITE_SURFACES)


class GateWiringAstInvariantTests(unittest.TestCase):
    """AST invariant: each gated writer function actually calls
    enforce_profile_for_write with the correct surface_kind at entry."""

    EXPECTED: dict[tuple[str, str], str] = {
        ("finding.py", "emit_finding"): "finding",
        ("debt.py", "emit_debt"): "debt",
        ("critical_observation.py", "record_critical_observation"): "critical_observation",
        ("agent_genesis.py", "request_agent_genesis"): "agent_genesis",
        ("human_required.py", "record_human_required"): "human_required",
        ("tool_registry.py", "append_tools_governance"): "tool_governance",
        ("memory.py", "update_memory"): "observation",
    }

    def _find_function(self, module: ast.Module, name: str) -> ast.FunctionDef | None:
        for node in ast.walk(module):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
        return None

    def _calls_enforce_with_surface(
        self, func: ast.FunctionDef, surface_kind: str,
    ) -> bool:
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            name = None
            if isinstance(f, ast.Name):
                name = f.id
            elif isinstance(f, ast.Attribute):
                name = f.attr
            if name != "enforce_profile_for_write":
                continue
            # First positional arg or `surface_kind=` kwarg must match.
            if node.args and isinstance(node.args[0], ast.Constant):
                if node.args[0].value == surface_kind:
                    return True
            for kw in node.keywords:
                if kw.arg == "surface_kind" and isinstance(kw.value, ast.Constant):
                    if kw.value.value == surface_kind:
                        return True
        return False

    def test_each_gated_writer_calls_enforce_with_correct_surface(self) -> None:
        offenders: list[str] = []
        for (module_name, func_name), expected_surface in self.EXPECTED.items():
            module_path = ARIA_KERNEL / module_name
            module = ast.parse(module_path.read_text(encoding="utf-8"))
            func = self._find_function(module, func_name)
            self.assertIsNotNone(
                func,
                f"{module_name}: function {func_name!r} not found",
            )
            if not self._calls_enforce_with_surface(func, expected_surface):
                offenders.append(
                    f"{module_name}:{func_name} missing "
                    f"enforce_profile_for_write({expected_surface!r}) at entry"
                )
        self.assertEqual(offenders, [], "\n  ".join(offenders))


if __name__ == "__main__":
    unittest.main()
