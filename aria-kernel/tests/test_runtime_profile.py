"""Plan 020 Phase 1 — runtime profile gate tests.

What this suite pins (≥18 tests):
- 4-mode lifecycle (observe / standard / strict / frozen).
- set_profile control-plane exception (operator_approval_ref required on
  every transition; bypasses enforce_profile_for_write so frozen can THAW).
- enforce_profile_for_action policy table (agent_claim, change_committed,
  change_validated, pr_open).
- enforce_profile_for_write Plan 020 scoped no-write semantic.
- Observe allowlist enforcement.
- Frozen no-write invariant for the 14-surface Plan 020 scope.
- Read-path safety: get_profile / list_profile_history use
  ensure_tools_dir_readonly so a frozen sandbox does not silently
  bootstrap-init the tools directory.
- Wiring smoke tests against agent_invocations.claim_request,
  change_ledger.emit_change_committed/validated, pr_manager.open_pr_for_action,
  tool_runner.run_tool — the 5 gated dispatch sites.

The tests are isolated through tempfile.mkdtemp(prefix='aria-rt-profile-')
so they cannot pollute the workspace base directory.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.runtime_profile import (
    ACTION_PERMISSIONS,
    DEFAULT_PROFILE,
    KNOWN_WRITE_SURFACES,
    OBSERVE_PERMITTED_SURFACES,
    PLAN_020_WRITE_SURFACES,
    PROFILE_HISTORY_FILENAME,
    PROFILE_STATE_FILENAME,
    PROFILES,
    enforce_profile_for_action,
    enforce_profile_for_write,
    get_profile,
    list_profile_history,
    set_profile,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_tools(prefix: str = "aria-rt-profile-") -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=prefix))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class ProfileTaxonomyTests(unittest.TestCase):
    def test_profiles_are_the_locked_5_mode_taxonomy(self) -> None:
        # Plan ARIA-V3 §B2 — added ``autonomous`` to the previous
        # 4-mode (observe/standard/strict/frozen) taxonomy. The
        # autonomous profile is explicit, but no live lane auto-mints ack.
        # Default stays standard; operator MUST set autonomous via
        # ``aria-kernel profile set --profile autonomous --operator-
        # approval-ref <ref>`` (Plan ARIA-V3 §B2 invariant I-V3-27).
        self.assertEqual(
            set(PROFILES),
            {"observe", "standard", "strict", "frozen", "autonomous"},
        )

    def test_default_profile_is_standard(self) -> None:
        self.assertEqual(DEFAULT_PROFILE, "standard")

    def test_action_permissions_table_is_locked(self) -> None:
        # Plan ARIA-V3 §B2 §2a + §2j + I-V3-27a — ACTION_PERMISSIONS
        # lists ``autonomous`` EXPLICITLY on every action_kind it
        # permits (no inherit-from-strict). The explicit listing
        # closes the test-runner missing-test-#6 invariant gap; a
        # future refactor that drops autonomous from any cell must
        # update this table directly.
        # ORPHAN-CRITICAL-728 — `plan_stage` and `apply_gate` join the table.
        # They are the two governed actions the convergence-to-PR producer
        # added, and a cell HERE is what enrols an action in profile gating
        # and — through the derived PROFILES_WITH_ACTION_AUTHORITY — in
        # breaker gating. Without cells both ran under `observe`, under
        # `frozen` and with the breaker tripped, reachable straight from the
        # implementer's Bash allowlist.
        self.assertEqual(set(ACTION_PERMISSIONS.keys()), {
            "agent_claim", "change_committed", "change_validated", "pr_create",
            "pr_open", "pr_merge", "plan_stage", "apply_gate",
        })
        self.assertEqual(
            ACTION_PERMISSIONS["agent_claim"],
            frozenset({"standard", "strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["change_committed"],
            frozenset({"standard", "strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["change_validated"],
            frozenset({"standard", "strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["pr_create"],
            frozenset({"strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["pr_open"],
            frozenset({"strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["pr_merge"],
            frozenset({"autonomous"}),
        )
        # Same set as pr_create/pr_open: steps of one pipeline, and a profile
        # that may not open a PR has no business minting the approval or the
        # gate ref a PR open consumes.
        self.assertEqual(
            ACTION_PERMISSIONS["plan_stage"],
            frozenset({"strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["apply_gate"],
            frozenset({"strict", "autonomous"}),
        )

    def test_plan_020_write_surfaces_include_required_enterprise_entries(self) -> None:
        # Plan 020 v3.3 Phase 1.B + Plan 026R §A.4 PLAN_020_WRITE_SURFACES
        # taxonomy. The original 14 surfaces (Phase 1.B → Phase 13) plus
        # the 8 §A.4 legacy-mutator surfaces.
        expected = {
            # Plan 020 original 14
            "context_audits", "handoffs", "agent_evals", "agent_compliance",
            "validation_matrix", "surface_validations", "instinct_candidates",
            "cost_telemetry", "change_ledger_committed", "change_ledger_validated",
            "tool_runs", "agent_claim", "pr_open", "spine_orchestrator",
            # Plan 026R §A.4 +8 legacy mutators now under no-write scope
            "finding", "debt", "governance", "observation",
            "agent_genesis", "tool_governance",
            "critical_observation", "human_required",
            # Enterprise autonomy hardening surfaces
            "runtime_v2_promotion", "plan_promotion_dispatch",
            "worker_verification", "worker_result",
            "pr_lifecycle", "pr_action",
            "tool_registry", "tool_lifecycle", "skill_genesis",
        }
        self.assertTrue(frozenset(expected).issubset(PLAN_020_WRITE_SURFACES))
        from aria_kernel.state_manifest import profile_surfaces
        self.assertTrue(profile_surfaces().issubset(PLAN_020_WRITE_SURFACES))

    def test_manifest_resolution_prefers_exact_dispatch_surfaces(self) -> None:
        from aria_kernel.state_manifest import surface_for_relative_path

        self.assertEqual(
            surface_for_relative_path("dispatch/requests.jsonl").name,
            "dispatch_requests",
        )
        self.assertEqual(
            surface_for_relative_path("dispatch/custom-worker.jsonl").name,
            "worker_dispatch",
        )

    def test_observe_allowlist_is_observation_class_only(self) -> None:
        # Observe-mode permission table per Plan 020 v3.3 Phase 1.B +
        # Plan 026R §A.4 (added ``tool_governance`` so observation-class
        # governance event emitters keep working under observe).
        expected = frozenset({
            "finding", "debt", "observation",
            "context_audits", "handoffs", "surface_validations",
            "instinct_candidates",
            "tool_governance",
        })
        self.assertTrue(expected.issubset(OBSERVE_PERMITTED_SURFACES))
        from aria_kernel.state_manifest import observe_permitted_profile_surfaces
        self.assertEqual(OBSERVE_PERMITTED_SURFACES, observe_permitted_profile_surfaces())

    def test_known_write_surfaces_is_union(self) -> None:
        # Plan 026R §A.4 — KNOWN_WRITE_SURFACES now also includes
        # DIAGNOSTIC_ALLOWLIST so the typo-guard accepts the bypass
        # surfaces (otherwise diagnostic emit would fail at the typo
        # check before reaching the bypass branch).
        from aria_kernel.runtime_profile import DIAGNOSTIC_ALLOWLIST
        self.assertEqual(
            KNOWN_WRITE_SURFACES,
            PLAN_020_WRITE_SURFACES
            | OBSERVE_PERMITTED_SURFACES
            | DIAGNOSTIC_ALLOWLIST,
        )


class GetProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_default_profile_when_state_file_absent(self) -> None:
        self.assertEqual(get_profile(base_dir=self.tools), DEFAULT_PROFILE)

    def test_get_profile_uses_readonly_helper_so_no_writes_under_fresh_dir(self) -> None:
        # When tools dir does not yet exist, get_profile must fall through
        # to DEFAULT_PROFILE without write-init. This tests the
        # ensure_tools_dir_readonly route — the frozen no-write invariant
        # rests on it.
        ghost = self.tools.parent / "ghost-aria-tools"
        self.assertEqual(get_profile(base_dir=ghost), DEFAULT_PROFILE)
        self.assertFalse(ghost.exists())

    def test_get_profile_returns_frozen_on_malformed_state_file(self) -> None:
        # Plan 024 §B-4 — fail-closed update. Pre-fix get_profile silently
        # returned DEFAULT_PROFILE ('standard') on JSONDecodeError, which
        # let an operator deploying intent 'frozen' silently flip to
        # write-enabled if the state file corrupted. Now the corrupt-
        # JSON path returns FROZEN_PROFILE; the diagnostic surfaces via
        # get_profile_with_diagnostic and is best-effort emitted as a
        # governance event at the write boundary
        # (enforce_profile_for_action / enforce_profile_for_write).
        from aria_kernel.runtime_profile import FROZEN_PROFILE
        state_file = self.tools / PROFILE_STATE_FILENAME
        state_file.write_text("not-json", encoding="utf-8")
        self.assertEqual(get_profile(base_dir=self.tools), FROZEN_PROFILE)


class SetProfileTransitionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_set_profile_to_strict_persists_state_and_history(self) -> None:
        result = set_profile(
            "strict",
            operator_approval_ref="operator-test:plan-020-phase-1",
            base_dir=self.tools,
        )
        self.assertEqual(result["active_profile"], "strict")
        self.assertEqual(result["previous_profile"], "standard")
        # State file written
        state = json.loads((self.tools / PROFILE_STATE_FILENAME).read_text(encoding="utf-8"))
        self.assertEqual(state["active_profile"], "strict")
        # History row appended
        history = list_profile_history(base_dir=self.tools)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["active_profile"], "strict")
        self.assertEqual(history[0]["operator_approval_ref"], "operator-test:plan-020-phase-1")

    def test_set_profile_emits_runtime_profile_changed_governance_event(self) -> None:
        set_profile(
            "frozen",
            operator_approval_ref="operator-test:plan-020-phase-1-incident",
            base_dir=self.tools,
        )
        events = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in events if line.strip()]
        self.assertIn("runtime_profile_changed", kinds)

    def test_set_profile_rejects_unknown_profile(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            set_profile("paranoid", operator_approval_ref="op:1", base_dir=self.tools)
        self.assertIn("unknown profile", str(cm.exception))

    def test_set_profile_requires_operator_approval_ref_on_every_transition(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            set_profile("strict", operator_approval_ref="", base_dir=self.tools)
        self.assertIn("runtime_profile_change_requires_approval", str(cm.exception))
        with self.assertRaises(GovernanceError):
            set_profile("strict", operator_approval_ref="   ", base_dir=self.tools)

    def test_set_profile_thaws_frozen_via_control_plane_exception(self) -> None:
        # Freeze, then thaw. Without the control-plane exception, the thaw
        # would fail because frozen blocks every write; the exception is
        # the documented escape hatch for incident response.
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        self.assertEqual(get_profile(base_dir=self.tools), "frozen")
        thaw = set_profile("standard", operator_approval_ref="op:thaw", base_dir=self.tools)
        self.assertEqual(thaw["active_profile"], "standard")
        self.assertEqual(thaw["previous_profile"], "frozen")

    def test_history_is_append_only_and_ordered(self) -> None:
        set_profile("strict", operator_approval_ref="op:1", base_dir=self.tools)
        set_profile("observe", operator_approval_ref="op:2", base_dir=self.tools)
        set_profile("frozen", operator_approval_ref="op:3", base_dir=self.tools)
        rows = list_profile_history(base_dir=self.tools)
        self.assertEqual([r["active_profile"] for r in rows], ["strict", "observe", "frozen"])
        self.assertEqual([r["previous_profile"] for r in rows], ["standard", "strict", "observe"])


class EnforceProfileForActionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_observe_blocks_every_action(self) -> None:
        set_profile("observe", operator_approval_ref="op:1", base_dir=self.tools)
        for action in ACTION_PERMISSIONS:
            with self.assertRaises(GovernanceError) as cm:
                enforce_profile_for_action(action, base_dir=self.tools)
            self.assertIn("profile_violation", str(cm.exception))

    def test_frozen_blocks_every_action(self) -> None:
        set_profile("frozen", operator_approval_ref="op:1", base_dir=self.tools)
        for action in ACTION_PERMISSIONS:
            with self.assertRaises(GovernanceError):
                enforce_profile_for_action(action, base_dir=self.tools)

    def test_standard_permits_claim_committed_validated_blocks_pr_open(self) -> None:
        set_profile("standard", operator_approval_ref="op:1", base_dir=self.tools)
        self.assertEqual(enforce_profile_for_action("agent_claim", base_dir=self.tools), "standard")
        self.assertEqual(enforce_profile_for_action("change_committed", base_dir=self.tools), "standard")
        self.assertEqual(enforce_profile_for_action("change_validated", base_dir=self.tools), "standard")
        with self.assertRaises(GovernanceError):
            enforce_profile_for_action("pr_open", base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            enforce_profile_for_action("pr_merge", base_dir=self.tools)

    def test_strict_permits_all_non_merge_actions(self) -> None:
        set_profile("strict", operator_approval_ref="op:1", base_dir=self.tools)
        for action in ACTION_PERMISSIONS:
            if action == "pr_merge":
                with self.assertRaises(GovernanceError):
                    enforce_profile_for_action(action, base_dir=self.tools)
                continue
            self.assertEqual(enforce_profile_for_action(action, base_dir=self.tools), "strict")

    def test_unknown_action_kind_raises(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            enforce_profile_for_action("teleport", base_dir=self.tools)
        self.assertIn("unknown profile action_kind", str(cm.exception))


class EnforceProfileForWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_every_plan_020_write_surface(self) -> None:
        set_profile("frozen", operator_approval_ref="op:1", base_dir=self.tools)
        for surface in PLAN_020_WRITE_SURFACES:
            with self.assertRaises(GovernanceError) as cm:
                enforce_profile_for_write(surface, base_dir=self.tools)
            self.assertIn("frozen profile", str(cm.exception))

    def test_observe_blocks_surfaces_outside_allowlist(self) -> None:
        set_profile("observe", operator_approval_ref="op:1", base_dir=self.tools)
        blocked = PLAN_020_WRITE_SURFACES - OBSERVE_PERMITTED_SURFACES
        for surface in blocked:
            with self.assertRaises(GovernanceError) as cm:
                enforce_profile_for_write(surface, base_dir=self.tools)
            self.assertIn("observe profile", str(cm.exception))

    def test_observe_permits_observation_class_surfaces(self) -> None:
        set_profile("observe", operator_approval_ref="op:1", base_dir=self.tools)
        for surface in OBSERVE_PERMITTED_SURFACES:
            self.assertEqual(enforce_profile_for_write(surface, base_dir=self.tools), "observe")

    def test_standard_permits_every_known_surface(self) -> None:
        # standard is default, no set_profile needed.
        for surface in KNOWN_WRITE_SURFACES:
            self.assertEqual(enforce_profile_for_write(surface, base_dir=self.tools), "standard")

    def test_strict_permits_every_known_surface(self) -> None:
        set_profile("strict", operator_approval_ref="op:1", base_dir=self.tools)
        for surface in KNOWN_WRITE_SURFACES:
            self.assertEqual(enforce_profile_for_write(surface, base_dir=self.tools), "strict")

    def test_unknown_surface_kind_raises(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            enforce_profile_for_write("teleporter_pad", base_dir=self.tools)
        self.assertIn("unknown profile write surface_kind", str(cm.exception))


class FrozenScopedNoWriteTests(unittest.TestCase):
    """Operator gap final — frozen invariant is SCOPED to Plan 020 surfaces.

    Plan 021 will harden legacy mutators (finding/debt emit, human_required,
    review_record, change_planned, agent_release/requeue, low-level
    append_tools_governance). Plan 020 frozen does NOT cover them — this is
    intentional and the test suite locks the scope.
    """

    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_no_write_invariant_now_covers_legacy_observation_surfaces(self) -> None:
        # Plan 026R §A.4 reversal: the pre-§A.4 invariant said "finding/
        # debt/observation are observe-mode allowlist surfaces but
        # NOT in PLAN_020_WRITE_SURFACES; under frozen they fall
        # through (Plan 021 scope)". §A.4 explicitly closes that gap
        # by adding all 8 legacy mutators (finding, debt, observation,
        # governance, agent_genesis, tool_governance,
        # critical_observation, human_required) to
        # PLAN_020_WRITE_SURFACES. Under frozen the validator now
        # raises GovernanceError on every legacy surface.
        set_profile("frozen", operator_approval_ref="op:1", base_dir=self.tools)
        for legacy_surface in ("finding", "debt", "observation"):
            with self.assertRaises(GovernanceError) as ctx:
                enforce_profile_for_write(legacy_surface, base_dir=self.tools)
            self.assertIn("profile_violation", str(ctx.exception))
            self.assertIn(repr(legacy_surface), str(ctx.exception))


class WiringSmokeTests(unittest.TestCase):
    """Defense-in-depth: each Phase 1.B wiring point fires the gate.

    These tests exercise the 5 dispatch sites (claim_request, change_committed,
    change_validated, pr_open, run_tool) against an observe profile to confirm
    each call site actually invokes the profile gate. Pure import smoke would
    miss a forgotten enforce_profile_for_action call at the top of one of the
    public APIs.
    """

    def setUp(self) -> None:
        self.tools = _seed_tools(prefix="aria-rt-wiring-")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_claim_request_gated_under_observe(self) -> None:
        from aria_kernel.agent_invocations import claim_request
        set_profile("observe", operator_approval_ref="op:1", base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            claim_request(request_id="REQ-x", agent_id="agent-y", base_dir=self.tools)
        self.assertIn("profile_violation", str(cm.exception))
        self.assertIn("agent_claim", str(cm.exception))

    def test_change_committed_gated_under_frozen(self) -> None:
        from aria_kernel.change_ledger import emit_change_committed
        set_profile("frozen", operator_approval_ref="op:1", base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            emit_change_committed(
                change_id="chg_test",
                commit_sha="abc1234",
                actual_affected_files=["x.ts"],
                base_dir=self.tools,
            )
        self.assertIn("profile_violation", str(cm.exception))
        self.assertIn("change_committed", str(cm.exception))

    def test_change_validated_gated_under_observe(self) -> None:
        from aria_kernel.change_ledger import emit_change_validated
        set_profile("observe", operator_approval_ref="op:1", base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            emit_change_validated(
                change_id="chg_test",
                validation_run_refs=["nx test:run-1"],
                base_dir=self.tools,
            )
        self.assertIn("profile_violation", str(cm.exception))
        self.assertIn("change_validated", str(cm.exception))

    def test_pr_open_gated_under_standard(self) -> None:
        from aria_kernel.pr_manager import open_pr_for_action
        # standard is default; pr_open is strict-only.
        with self.assertRaises(GovernanceError) as cm:
            open_pr_for_action(
                proposal_id="PROP-x",
                workspace_root=self.tools.parent,
                base_dir=self.tools,
                dry_run=True,
            )
        # Profile gate fires before the missing-proposal check.
        self.assertIn("profile_violation", str(cm.exception))
        self.assertIn("pr_create", str(cm.exception))

    def test_run_tool_gated_under_observe(self) -> None:
        from aria_kernel.tool_runner import run_tool
        set_profile("observe", operator_approval_ref="op:1", base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            run_tool(
                tool_id="any-tool-id",
                input_payload={"cycle_id": "cycle-test"},
                cycle_id="cycle-test",
                workspace_root=self.tools.parent,
                base_dir=self.tools,
            )
        # Profile gate fires before the get_tool lookup.
        self.assertIn("profile_violation", str(cm.exception))
        self.assertIn("tool_runs", str(cm.exception))


class ReadPathSafetyTests(unittest.TestCase):
    """get_profile + list_profile_history must not write-init under frozen."""

    def test_get_profile_on_nonexistent_dir_returns_default(self) -> None:
        # Path that does NOT exist; must NOT be created by get_profile.
        nonexistent = Path(tempfile.mkdtemp(prefix="aria-rt-read-")) / "never-created"
        try:
            self.assertEqual(get_profile(base_dir=nonexistent), DEFAULT_PROFILE)
            self.assertFalse(nonexistent.exists())
        finally:
            shutil.rmtree(nonexistent.parent, ignore_errors=True)

    def test_list_profile_history_on_nonexistent_dir_returns_empty(self) -> None:
        nonexistent = Path(tempfile.mkdtemp(prefix="aria-rt-read-")) / "never-created"
        try:
            self.assertEqual(list_profile_history(base_dir=nonexistent), [])
            self.assertFalse(nonexistent.exists())
        finally:
            shutil.rmtree(nonexistent.parent, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
