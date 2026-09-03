"""Plan ARIA-V9.8 — V9 arc invariant-coverage consolidation.

The V9 arc landed across V9.0-A through V9.7 with per-phase invariant
test files. V9.8 is the consolidation gate: a meta-invariant that
verifies the V9 arc's invariant footprint matches the v3 plan's
acceptance criteria.

Pin the COUNT + SET of per-phase invariant files so a refactor that
silently drops a phase's test file fails CI before merge.

Closes: F-015-V9-8 (V9 invariant consolidation).
"""
from __future__ import annotations

import unittest
from pathlib import Path


_V9_INVARIANTS_DIR = (
    Path(__file__).resolve().parents[1] / "v9"
)


# Plan ARIA-V9.8 — canonical per-phase invariant test file set.
# Adding a V9.X phase = invariant amendment + new test file.
CANONICAL_V9_TEST_FILES = frozenset({
    "test_phase_v9_0_a_plan_candidate_source.py",
    "test_phase_v9_0_b_event_state_machine.py",
    "test_phase_v9_0_c_preflight.py",
    "test_phase_v9_0_c_gh_token_factory.py",
    "test_phase_v9_0_d_implementation_safety.py",
    "test_phase_v9_0_e_sandbox.py",
    "test_phase_v9_0_f_knowledge_graph.py",
    "test_phase_v9_1_aria_implementer_agent.py",
    "test_phase_v9_2_implementation_public_api.py",
    "test_phase_v9_3_envelope_dispatch.py",
    "test_phase_v9_4_pressure_sources.py",
    "test_phase_v9_6_auto_merge.py",
    "test_phase_v9_7_cli_flags.py",
    "test_phase_v9_8_v9_arc_completeness.py",  # this file
})


class TestV9ArcCompleteness(unittest.TestCase):

    def test_i_v9_8_all_canonical_test_files_present(self):
        """Every V9.X phase MUST have an invariant test file at the
        canonical path. A missing file = a phase whose contract is
        not pinned + an audit-trail gap."""
        present_files = {
            p.name for p in _V9_INVARIANTS_DIR.glob("test_phase_v9_*.py")
        }
        missing = CANONICAL_V9_TEST_FILES - present_files
        self.assertEqual(
            missing, set(),
            f"V9 invariant test files missing: {missing}; "
            f"present: {sorted(present_files)}",
        )

    def test_i_v9_8_no_extra_test_files(self):
        """V9 arc files MUST be exactly the canonical set — extra
        files would indicate an un-tracked phase or a stray test
        artifact that drifted from the plan."""
        present_files = {
            p.name for p in _V9_INVARIANTS_DIR.glob("test_phase_v9_*.py")
        }
        extra = present_files - CANONICAL_V9_TEST_FILES
        self.assertEqual(
            extra, set(),
            f"unexpected V9 invariant test files: {extra}",
        )

    def test_i_v9_8_kernel_modules_present(self):
        """Each V9.0 phase MUST have its kernel module present at
        the documented location (no _maintenance/-only ships)."""
        kernel = (
            Path(__file__).resolve().parents[3] / "aria_kernel"
        )
        required_modules = (
            "plan_candidate_source.py",
            "preflight.py",
            "gh_token_factory.py",
            "implementation_safety.py",
            "skill_genesis_sandbox.py",
            "knowledge_graph.py",
        )
        for mod in required_modules:
            self.assertTrue(
                (kernel / mod).exists(),
                f"V9.0 module {mod} not present at {kernel}",
            )

    def test_i_v9_8_aria_implementer_agent_at_lane_a(self):
        """V9.1 agent file MUST be at Lane-A runtime location, not
        _maintenance/."""
        repo = Path(__file__).resolve().parents[4]
        runtime = repo / ".claude" / "agents" / "aria-implementer.md"
        maintenance = repo / ".claude" / "agents" / "_maintenance" / "aria-implementer.md"
        self.assertTrue(runtime.exists())
        self.assertFalse(
            maintenance.exists(),
            "aria-implementer.md MUST NOT be at _maintenance/ (V9.1 Lane-A pin)",
        )

    def test_i_v9_8_safety_contracts_policy_doc_exists(self):
        """V9.5 docs/aria/v3-v9-5-safety-contracts-policy.md MUST
        exist — operator-facing policy semantics for the 15 hard-fail
        checks shipped in V9.0-D."""
        repo = Path(__file__).resolve().parents[4]
        doc = repo / "docs" / "aria" / "v3-v9-5-safety-contracts-policy.md"
        self.assertTrue(doc.exists())

    def test_i_v9_8_github_app_runbook_exists(self):
        """V9.0-C operator runbook MUST exist — Mode A precondition
        setup for the autonomous profile."""
        repo = Path(__file__).resolve().parents[4]
        runbook = repo / "docs" / "runbooks" / "aria-github-app-setup.md"
        self.assertTrue(runbook.exists())

    def test_i_v9_8_module_inventory_doc_exists(self):
        """V8-RC docs/aria/v3-plan-module-inventory.md MUST exist —
        the reconciliation artifact closing arb CRIT-001 stale
        module-presence flagging."""
        repo = Path(__file__).resolve().parents[4]
        doc = repo / "docs" / "aria" / "v3-plan-module-inventory.md"
        self.assertTrue(doc.exists())


if __name__ == "__main__":
    unittest.main()
