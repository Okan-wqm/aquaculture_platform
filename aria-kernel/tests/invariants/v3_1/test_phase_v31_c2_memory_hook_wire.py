"""Plan ARIA-V3.1-C2 — MemoryHook orchestrator wire invariants.

Closes architectural anchors from V3.1-C that need orchestrator-side
invocation:

* Production MemoryHookImpl that chains bounded reader → stability
  check → record_convention → verify_chain_or_quarantine →
  skill_genesis HUMAN_REQUIRED dispatch in the correct order
  (V3.1-C HIGH-005 cycle-own-row-exclusion + MEDIUM-012 post-record
  verify + ai-safety HIGH-005 skill-genesis HUMAN_REQUIRED gate).
* Orchestrator post-CONVERGED body invokes memory_hook.record()
  BEFORE specialist_review_started so the V10 memory pillar fires
  per CONVERGED cycle.
* select_memory_hook factory dispatches observe/frozen → NoOp,
  others → MemoryHookImpl.

Invariants:

* I-V31-C2-01 — MemoryHookImpl source pipeline order:
  read_governance_rows_reverse → check_pattern_signature_stability
  → record_convention → verify_chain_or_quarantine.
* I-V31-C2-02 — skill_genesis dispatch goes through
  record_human_required (NOT direct registry.json write).
* I-V31-C2-03 — orchestrator body invokes memory_hook.record()
  BEFORE specialist_review_started.
* I-V31-C2-04 — select_memory_hook(profile=observe) returns NoOp.
* I-V31-C2-05 — MemoryHookImpl.record() returns the canonical
  result dict shape when invoked on an empty workspace.
* I-V31-C2-06 — stable=True triggers record_human_required call
  (behavioral, patched primitives).
"""
from __future__ import annotations

import inspect
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class MemoryHookImplPipelineOrderTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-01 — pipeline order assertion."""

    def test_i_v31_c2_01_pipeline_order_correct(self) -> None:
        """Plan ARIA-V3.1-C2-01 — the production MemoryHookImpl source
        contains the V3.1-C HIGH-005 + MEDIUM-012 ordering:
        bounded read FIRST, stability check SECOND,
        record_convention THIRD, verify_chain_or_quarantine FOURTH.
        """
        from aria_kernel.cycle_phases import memory
        src = inspect.getsource(memory.MemoryHookImpl.record)
        # Locate each anchor + assert their relative order.
        idx_read = src.find("read_governance_rows_reverse(")
        idx_stability = src.find("check_pattern_signature_stability(")
        idx_record = src.find("record_convention(")
        idx_verify = src.find("verify_chain_or_quarantine(")
        self.assertGreater(idx_read, 0)
        self.assertGreater(idx_stability, 0)
        self.assertGreater(idx_record, 0)
        self.assertGreater(idx_verify, 0)
        self.assertLess(
            idx_read, idx_stability,
            "read_governance_rows_reverse MUST come before "
            "check_pattern_signature_stability (V3.1-C HIGH-005)",
        )
        self.assertLess(
            idx_stability, idx_record,
            "stability check MUST come before record_convention "
            "(V3.1-C HIGH-005 — cycle's own row excluded from its check)",
        )
        self.assertLess(
            idx_record, idx_verify,
            "verify_chain_or_quarantine MUST come AFTER record_convention "
            "(V3.1-C MEDIUM-012 — Tier-3 detect at consumption side)",
        )

    def test_i_v31_c2_02_skill_genesis_dispatch_via_human_required(self) -> None:
        """Plan ARIA-V3.1-C2-02 — skill genesis activation goes
        through record_human_required (NOT a direct write to
        aria-tools/registry.json). Closes ai-safety HIGH-005:
        operator-reviewed PR before adapter activation."""
        from aria_kernel.cycle_phases import memory
        src = inspect.getsource(memory.MemoryHookImpl.record)
        self.assertIn("record_human_required", src,
                      "MemoryHookImpl missing record_human_required call")
        self.assertIn("skill_genesis_adapter_authoring", src,
                      "MemoryHookImpl missing canonical HUMAN_REQUIRED reason")
        # Must NOT write to registry.json directly.
        self.assertNotIn("registry.json", src,
                         "MemoryHookImpl leaked direct registry write — "
                         "operator review bypass")


class OrchestratorMemoryHookWireTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-03 — orchestrator post-CONVERGED wire."""

    def test_i_v31_c2_03_orchestrator_invokes_memory_hook_before_specialist(self) -> None:
        """Plan ARIA-V3.1-C2-03 — the orchestrator body calls
        memory_hook.record() BEFORE specialist_review_started so the
        V10 memory contribution lands per cycle even when specialist
        review later rejects."""
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        idx_memory = src.find("memory_hook.record(")
        idx_specialist = src.find('phase="specialist_review_started"')
        self.assertGreater(idx_memory, 0,
                           "orchestrator missing memory_hook.record() call")
        self.assertGreater(idx_specialist, 0)
        self.assertLess(
            idx_memory, idx_specialist,
            "memory_hook.record() MUST fire BEFORE specialist_review_started "
            "(V31-C2 ordering anchor)",
        )

    def test_i_v31_c2_03_memory_hook_wrapped_in_try_except(self) -> None:
        """Plan ARIA-V3.1-C2-03 — memory_hook failure must not block
        specialist_review + worker + auto_merge. The wire is wrapped
        in try/except + emits memory_hook_failed governance event."""
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        # The try block immediately before memory_hook.record(...)
        idx_memory = src.find("memory_hook.record(")
        # Look backwards 200 chars for `try:` open.
        preamble = src[max(0, idx_memory - 200):idx_memory]
        self.assertIn("try:", preamble,
                      "memory_hook.record() not wrapped in try/except")
        # memory_hook_failed governance event present.
        self.assertIn("memory_hook_failed", src)


class MemoryHookFactoryTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-04 — select_memory_hook factory dispatch."""

    def test_i_v31_c2_04_observe_returns_noop(self) -> None:
        from aria_kernel.cycle_phases import (
            NoOpMemoryHook, MemoryHookImpl, select_memory_hook,
        )
        self.assertIsInstance(select_memory_hook(profile="observe"), NoOpMemoryHook)
        self.assertIsInstance(select_memory_hook(profile="frozen"), NoOpMemoryHook)
        # All non-passive profiles get the production impl.
        for profile in ("standard", "strict", "autonomous"):
            self.assertIsInstance(
                select_memory_hook(profile=profile), MemoryHookImpl,
                f"profile={profile!r} expected MemoryHookImpl",
            )


class MemoryHookImplBehavioralTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-05+06 — behavioral path tests with mocked
    primitives (kernel state machine drive too deep for this scope)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31c2-")).resolve()
        self.base = self.tmp / "aria-tools"
        from aria_kernel.tool_registry import ensure_tools_dir
        ensure_tools_dir(self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_c2_05_returns_canonical_dict_shape(self) -> None:
        """Plan ARIA-V3.1-C2-05 — record() returns a dict with the
        documented keys regardless of stability/convention outcome."""
        from aria_kernel.cycle_phases import MemoryHookImpl
        hook = MemoryHookImpl()
        result = hook.record(
            cycle_id="cyc-test", plan_id="plan-test",
            workspace_root=self.tmp, base_dir=self.base,
            converged_plan={
                "schema_version": 1, "title": "t", "summary": "x",
                "affected_surfaces": ["x.py"],
                "key_changes": [{"id": "k1", "description": "d", "paths": ["x.py"]}],
                "validation_commands": [{"cmd": "echo", "timeout_ms": 1000,
                                          "expected_exit": 0}],
                "evidence_refs": ["x.py:1"],
            },
            plan_envelope_metadata={"_pressure_source_type": "git_diff"},
            profile="standard",
            signer_key_fp=None,  # No signing → record_convention skipped.
        )
        for key in (
            "status", "pattern_signature", "stability_result",
            "convention_recorded", "chain_verified",
            "skill_genesis_dispatched", "rows_scanned",
        ):
            self.assertIn(key, result, f"result missing key {key!r}")
        # signer_key_fp absent → no convention recorded.
        self.assertFalse(result["convention_recorded"])

    def test_i_v31_c2_06_stable_triggers_human_required(self) -> None:
        """Plan ARIA-V3.1-C2-06 — when check_pattern_signature_stability
        returns stable=True, MemoryHookImpl invokes record_human_required
        + emits skill_genesis_human_required_dispatched event."""
        from aria_kernel.cycle_phases import MemoryHookImpl
        called: dict[str, object] = {}
        def _fake_human_required(*, request_id, severity, reason,
                                 base_dir=None, now=None):
            called["request_id"] = request_id
            called["reason"] = reason
            called["severity"] = severity
            return {"status": "open", "request_id": request_id}
        hook = MemoryHookImpl()
        with patch(
            "aria_kernel.plan_synthesizer.compute_pattern_signature",
            return_value="sha256:" + "a" * 16,
        ), patch(
            "aria_kernel.skill_genesis_drainer.check_pattern_signature_stability",
            return_value={
                "stable": True,
                "matching_cycles": ["c0", "c1", "c2", "c3", "c4"],
                "distinct_pressure_source_types": ["operator_feedback", "failing_ci"],
                "distinct_cross_reviewer_agent_ids": ["rev-A", "rev-B"],
            },
        ), patch(
            "aria_kernel.human_required.record_human_required",
            side_effect=_fake_human_required,
        ):
            result = hook.record(
                cycle_id="cyc-stable", plan_id="plan-stable",
                workspace_root=self.tmp, base_dir=self.base,
                converged_plan={
                    "schema_version": 1, "title": "t", "summary": "x",
                    "affected_surfaces": ["x.py"],
                    "key_changes": [{"id": "k1", "description": "d", "paths": ["x.py"]}],
                    "validation_commands": [{"cmd": "echo", "timeout_ms": 1000,
                                              "expected_exit": 0}],
                    "evidence_refs": ["x.py:1"],
                },
                plan_envelope_metadata={"_pressure_source_type": "operator_feedback"},
                profile="standard",
                signer_key_fp=None,
            )
        self.assertTrue(result["skill_genesis_dispatched"])
        self.assertEqual(called["reason"], "skill_genesis_adapter_authoring")
        self.assertTrue(
            str(called["request_id"]).startswith("skill-genesis-cyc-stable-"),
        )


if __name__ == "__main__":
    unittest.main()
