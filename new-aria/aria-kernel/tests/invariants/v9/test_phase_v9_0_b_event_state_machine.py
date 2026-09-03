"""Plan ARIA-V9.0-B — kernel event-type + terminal-state + state
precondition + cache deepcopy + bridge match/case invariants.

Closes:
- architectural-arbiter CRIT-002 (closed EVENT_TYPES)
- architectural-arbiter CRIT-003 (impossible-state reachability)
- architectural-arbiter HIGH-001 (typing.assert_never role exhaustiveness)
- architectural-arbiter MED-009 (invariant false-confidence)
- performance-expert PERF-CRIT-004 (cache deepcopy)
- performance-expert PERF-MED-011 (shallow-copy leak)
"""
from __future__ import annotations

import copy
import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence as _pc
from aria_kernel import plan_convergence_bridge as _pcb
from aria_kernel.tool_registry import GovernanceError


class TestV9EventTypeWhitelist(unittest.TestCase):
    """I-V9-EVENT-01 — kernel EVENT_TYPES extended with 5 new types."""

    def test_i_v9_event_01_five_new_implementation_types(self):
        required = {
            "implementation_requested",
            "implementation_started",
            "implementation_outcome_recorded",
            "implementation_merged",
            "implementation_rejected",
        }
        missing = required - _pc.EVENT_TYPES
        self.assertEqual(
            missing, set(),
            f"EVENT_TYPES MUST include V9 implementation types; missing: {missing}",
        )

    def test_i_v9_event_01_v8_event_types_preserved(self):
        """V9 extension MUST NOT regress any V8 event types."""
        v8_types = {
            "plan_started", "challenger_plan_drafted", "critic_tasks_requested",
            "critique_recorded", "cross_review_tasks_requested", "cross_review_recorded",
            "stale_tasks_reaped", "revision_recorded", "plan_evaluated",
            "plan_abandoned", "lock_reaped",
        }
        missing = v8_types - _pc.EVENT_TYPES
        self.assertEqual(missing, set(), f"V8 event_types regressed: {missing}")


class TestV9TerminalStatesExtension(unittest.TestCase):
    """I-V9-STATE-01 — TERMINAL_STATES extended with 2 V9 terminal states.

    Plan ARIA-V9.0-B preserves CONVERGED as terminal (V8 invariant —
    active-plan filters depend on it) AND adds IMPLEMENTATION_MERGED
    + IMPLEMENTATION_REJECTED. The V9 transition from CONVERGED to
    IMPLEMENTATION_REQUESTED happens via implementation_requested
    event which the reducer permits explicitly."""

    def test_i_v9_state_01_v9_terminal_states_present(self):
        for state in ("IMPLEMENTATION_MERGED", "IMPLEMENTATION_REJECTED"):
            self.assertIn(
                state, _pc.TERMINAL_STATES,
                f"TERMINAL_STATES MUST include {state}",
            )

    def test_i_v9_state_01_v8_terminal_states_preserved(self):
        for state in ("CONVERGED", "HUMAN_REQUIRED", "ABANDONED"):
            self.assertIn(
                state, _pc.TERMINAL_STATES,
                f"V8 terminal state {state} MUST remain",
            )


class TestV9ImpossibleStateReachability(unittest.TestCase):
    """I-V9-STATE-01 — Out-of-order implementation events MUST raise
    GovernanceError(invalid_transition: ...).

    Tier-1 — make impossible to reach IMPLEMENTATION_RECORDED without
    first transitioning through IMPLEMENTATION_REQUESTED + IN_FLIGHT.
    Closes architectural-arbiter CRIT-003.
    """

    def _make_state(self, current_state: str | None) -> dict:
        s = _pc._initial_state("test-plan")
        s["state"] = current_state
        return s

    def test_implementation_requested_rejects_non_converged(self):
        state = self._make_state("DRAFT")
        event = {
            "event_type": "implementation_requested",
            "payload": {
                "implementer_agent": "aria-implementer",
                "converged_plan_revision_id": "rev-001",
                "converged_plan_content_hash": "sha256:" + "0" * 64,
            },
        }
        with self.assertRaises(GovernanceError) as ctx:
            _pc._apply_event(state, event)
        self.assertIn("invalid_transition", str(ctx.exception))
        self.assertIn("expected=CONVERGED", str(ctx.exception))

    def test_implementation_started_rejects_non_requested(self):
        state = self._make_state("CONVERGED")
        event = {
            "event_type": "implementation_started",
            "payload": {
                "claim_id": "claim-001",
                "implementer_agent": "aria-implementer",
            },
        }
        with self.assertRaises(GovernanceError) as ctx:
            _pc._apply_event(state, event)
        self.assertIn("expected=IMPLEMENTATION_REQUESTED", str(ctx.exception))

    def test_implementation_outcome_rejects_non_in_flight(self):
        state = self._make_state("IMPLEMENTATION_REQUESTED")
        event = {
            "event_type": "implementation_outcome_recorded",
            "payload": {
                "claim_id": "c1", "pr_url": "https://x", "diff_hash": "sha256:" + "1" * 64,
                "branch_tip_sha": "abc", "validation_results": [], "signer_key_fp": "fp",
                "base_branch_sha": "def",
            },
        }
        with self.assertRaises(GovernanceError) as ctx:
            _pc._apply_event(state, event)
        self.assertIn("expected=IMPLEMENTATION_IN_FLIGHT", str(ctx.exception))

    def test_implementation_merged_rejects_non_recorded(self):
        state = self._make_state("IMPLEMENTATION_IN_FLIGHT")
        event = {
            "event_type": "implementation_merged",
            "payload": {
                "merge_sha": "abc", "merged_at": "2026-05-18T00:00:00Z",
                "idempotency_key_hash": "sha256:" + "2" * 64,
            },
        }
        with self.assertRaises(GovernanceError) as ctx:
            _pc._apply_event(state, event)
        self.assertIn("expected=IMPLEMENTATION_RECORDED", str(ctx.exception))

    def test_implementation_rejected_accepts_three_predecessors(self):
        """rejected fires on REQUESTED / IN_FLIGHT / RECORDED — 3 legal
        predecessors covering the 3 rejection windows."""
        for predecessor in (
            "IMPLEMENTATION_REQUESTED",
            "IMPLEMENTATION_IN_FLIGHT",
            "IMPLEMENTATION_RECORDED",
        ):
            state = self._make_state(predecessor)
            event = {
                "event_type": "implementation_rejected",
                "payload": {
                    "rejection_class": "validation_failed",
                    "rejected_at": "2026-05-18T00:00:00Z",
                },
            }
            _pc._apply_event(state, event)  # MUST NOT raise
            self.assertEqual(state["state"], "IMPLEMENTATION_REJECTED")
            self.assertEqual(state["terminal_state"], "IMPLEMENTATION_REJECTED")
            self.assertEqual(state["implementation"]["rejected_from_state"], predecessor)

    def test_implementation_rejected_refuses_unknown_predecessor(self):
        state = self._make_state("CONVERGED")
        event = {
            "event_type": "implementation_rejected",
            "payload": {
                "rejection_class": "validation_failed",
                "rejected_at": "2026-05-18T00:00:00Z",
            },
        }
        with self.assertRaises(GovernanceError) as ctx:
            _pc._apply_event(state, event)
        self.assertIn("invalid_transition", str(ctx.exception))


class TestV9CacheDeepcopy(unittest.TestCase):
    """I-V9-CACHE-01 — fold_plan_state uses copy.deepcopy on both cache
    HIT and cache WRITE paths.

    Closes perf-expert PERF-CRIT-004 + PERF-MED-011 (shallow-copy
    nested-mutable cache corruption when state.implementation appears).
    """

    def test_i_v9_cache_01_fold_plan_state_imports_copy(self):
        """plan_convergence module MUST import copy (deepcopy SSoT)."""
        src = inspect.getsource(_pc)
        self.assertIn("import copy", src, "plan_convergence MUST import copy module")

    def test_i_v9_cache_01_fold_plan_state_uses_deepcopy(self):
        """fold_plan_state body MUST contain at least 2 copy.deepcopy
        calls (HIT-side return + WRITE-side cache store)."""
        src = inspect.getsource(_pc.fold_plan_state)
        deepcopy_count = src.count("copy.deepcopy")
        self.assertGreaterEqual(
            deepcopy_count, 2,
            f"fold_plan_state MUST call copy.deepcopy >=2× "
            f"(HIT + WRITE paths); found {deepcopy_count}",
        )

    def test_i_v9_cache_01_shallow_dict_comp_removed(self):
        """Pre-V9 shallow `{k: v.copy() if isinstance(...) else v}` dict
        comprehension MUST be gone from EXECUTABLE code — leftover
        shallow copy on either path = nested-mutable corruption.

        Implementation note: scans only non-comment lines so an
        explanatory docstring/comment that cites the pre-V9 pattern
        as documentation does not trip the invariant. V9.0-B left
        the citation in place (architectural decision lineage)."""
        src = inspect.getsource(_pc.fold_plan_state)
        executable_lines = [
            line for line in src.splitlines()
            if not line.lstrip().startswith("#")
        ]
        executable_src = "\n".join(executable_lines)
        self.assertNotIn(
            "v.copy() if isinstance(v, (dict, list)) else v", executable_src,
            "fold_plan_state still contains pre-V9 shallow dict-comp "
            "in EXECUTABLE code; V9.0-B deepcopy refactor incomplete",
        )


class TestV9BridgeDispatchExhaustiveness(unittest.TestCase):
    """I-V9-DISPATCH-01 — plan_convergence_bridge.record_plan_result
    uses match/case + typing.assert_never for role exhaustiveness.

    Closes architectural-arbiter HIGH-001 (silent fallthrough on a
    new role).
    """

    def test_i_v9_dispatch_01_uses_match_case(self):
        src = inspect.getsource(_pcb.record_plan_result)
        self.assertIn(
            "match role:", src,
            "record_plan_result MUST use match/case for role dispatch",
        )

    def test_i_v9_dispatch_01_uses_assert_never(self):
        src = inspect.getsource(_pcb.record_plan_result)
        self.assertIn(
            "assert_never", src,
            "record_plan_result MUST call assert_never on case _: arm",
        )

    def test_i_v9_dispatch_01_assert_never_imported(self):
        """typing.assert_never (or fallback shim) MUST be importable in
        the bridge module."""
        self.assertTrue(
            hasattr(_pcb, "assert_never"),
            "plan_convergence_bridge MUST expose assert_never (typing or fallback)",
        )

    def test_i_v9_dispatch_01_planner_bridge_role_literal_present(self):
        """The Literal type discriminant MUST be declared (V9.2/V9.3
        will extend it with 'implementation' — having the alias keeps
        the extension a single-source-of-truth edit)."""
        self.assertTrue(
            hasattr(_pcb, "PlannerBridgeRole"),
            "plan_convergence_bridge MUST export PlannerBridgeRole Literal",
        )


class TestV9NewEventPayloadValidators(unittest.TestCase):
    """_validate_event recognizes the 5 new event types + their payload
    shape rules (5th invariant — payload schema completeness)."""

    def _base_event(self, event_type: str, payload: dict) -> dict:
        return {
            "event_id": "evt-001",
            "event_type": event_type,
            "plan_id": "plan-001",
            "idempotency_key": "sha256:" + "0" * 64,
            "payload": payload,
        }

    def test_implementation_requested_payload_validated(self):
        # Missing implementer_agent → reject
        with self.assertRaises(GovernanceError):
            _pc._validate_event(self._base_event("implementation_requested", {
                "converged_plan_revision_id": "rev-001",
                "converged_plan_content_hash": "sha256:" + "0" * 64,
            }))

    def test_implementation_rejected_class_must_be_valid(self):
        # Unknown rejection_class → reject
        with self.assertRaises(GovernanceError):
            _pc._validate_event(self._base_event("implementation_rejected", {
                "rejection_class": "totally_made_up_class",
                "rejected_at": "2026-05-18T00:00:00Z",
            }))

    def test_implementation_outcome_validation_results_list(self):
        # validation_results not a list → reject
        with self.assertRaises(GovernanceError):
            _pc._validate_event(self._base_event("implementation_outcome_recorded", {
                "claim_id": "c1", "pr_url": "https://x", "diff_hash": "sha256:" + "1" * 64,
                "branch_tip_sha": "abc", "validation_results": "not-a-list",
                "signer_key_fp": "fp", "base_branch_sha": "def",
            }))


if __name__ == "__main__":
    unittest.main()
