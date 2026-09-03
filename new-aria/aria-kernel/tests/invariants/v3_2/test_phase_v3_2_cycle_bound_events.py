"""Plan ARIA-V3.2 Phase 3.1 — D3 cycle_id propagation + holistic guard.

Two cases:

  * I-V3.2-07 — discovery_dirty_tree_skipped carries cycle_id.
  * I-V3.2-08 — every cycle-bound governance event kind carries
    cycle_id (closed-allowlist holistic guard).

The 10-agent post-V4 audit found that V3+V3.1+V4 had
``assertIn("discovery_dirty_tree_skipped", governance)`` substring
check that gave false confidence — the kind appeared but the
field was missing. I-V3.2-08 closes the open-world hole.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


# Plan ARIA-V3.2 §2c — closed allowlist of governance event kinds
# that MUST carry cycle_id in details. Adding a new kind requires
# explicit classification here OR in CYCLE_INDEPENDENT_EVENT_KINDS;
# the invariant fails CI on unknown kinds (closes open-world hole).
CYCLE_BOUND_EVENT_KINDS: frozenset[str] = frozenset({
    "discovery_dirty_tree_skipped",
    "discovery_legacy_field_emitted",
    "agent_fitness_computed",
    "agent_dispatch_quarantined",
    "pressure_triaged",
    "planner_dispatch_iteration_started",
    "planner_dispatch_iteration_completed",
    "worker_scheduler_iteration_started",
    "worker_scheduler_iteration_completed",
    "memory_fates_rebuilt",
    "memory_fates_working_tree_drift_observed",
    "autonomy_orchestrator_started",
    "autonomy_orchestrator_exit",
    "planner_dispatch_daemon_started",
    "planner_dispatch_daemon_exit",
    "worker_scheduler_daemon_started",
    "worker_scheduler_daemon_exit",
    # V10.5 Phase 3 — F-023 API backoff governance events
    "api_backoff_engaged",
    "api_backoff_exhausted",
    "api_backoff_interrupted",
    # V10.5 Phase 1 — ARIA-Watchdog daemon governance events
    "aria_watchdog_daemon_started",
    "aria_watchdog_daemon_exit",
    "aria_watchdog_iteration_started",
    "aria_watchdog_finding_emitted",
    "aria_watchdog_finding_suppressed",
    "aria_watchdog_emit_rejected",
})

# Plan ARIA-V3.2 §2c — events that operate outside cycle context
# (operator action, bootstrap, identity binding, ack ledger).
CYCLE_INDEPENDENT_EVENT_KINDS: frozenset[str] = frozenset({
    "tools_root_bootstrapped",
    "tools_root_bound",
    "tools_root_canonical_identity_backfilled",
    "tools_root_worktree_resolved",
    "tools_root_shadow_purged",
    "runtime_profile_changed",
    "ack_token_minted",
    "ack_token_consumed",
    "ack_key_rotated",
    "circuit_breaker_failure_recorded",
    "circuit_breaker_tripped",
    "circuit_breaker_reset",
    "cost_budget_breaker_tripped",
    "cost_budget_breaker_reset",
    "materialize_attempt_started",
    "materialize_committed",
    "draft_validated",
    "autonomous_host_lease_acquired",
    "autonomous_host_lease_refreshed",
    "autonomous_host_lease_blocked",
    "autonomous_host_lease_released",
    "claude_mock_mode_resolved",
    "lock_reaped",
    "canonical_identity_offline_fallback",
    "gate_activity_visibility_restored",
    "l3_lane_classification_decided",
})


class PhaseV3_2CycleBoundEvents(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v3_2-cycle-events-"))
        self.workspace = self.tmp / "workspace"
        self.tools_root = self.workspace / "aria-tools"

    # I-V3.2-07 — discovery_dirty_tree_skipped carries cycle_id.
    def test_i_v3_2_07_discovery_dirty_tree_skipped_carries_cycle_id(
        self,
    ) -> None:
        from aria_kernel.discovery import run_discovery
        from tests.invariants.v3_2._helpers import (
            init_minimal_git_repo,
            read_governance_rows,
        )

        # Init minimal repo + commit baseline.
        init_minimal_git_repo(
            self.workspace,
            {"README.md": "# v3_2 fixture\n", "src/app.py": "print('hi')\n"},
        )
        # Add an untracked file to force the dirty-tree path.
        (self.workspace / "dirty.txt").write_text("dirty\n", encoding="utf-8")

        cycle_id = "cycle-v3_2-07"
        run_discovery(
            workspace_root=self.workspace,
            cycle_id=cycle_id,
            base_dir=self.tools_root,
            snapshot_mode="committed",
        )
        rows = read_governance_rows(self.tools_root)
        dirty_rows = [r for r in rows if r.get("kind") == "discovery_dirty_tree_skipped"]
        self.assertEqual(
            len(dirty_rows), 1,
            msg=(
                "discovery_dirty_tree_skipped expected exactly once for "
                "dirty-tree path under committed snapshot mode"
            ),
        )
        details = dirty_rows[0].get("details", {})
        self.assertIn(
            "cycle_id", details,
            msg=(
                "Plan ARIA-V3.2 §2c F-010-D3 — "
                "discovery_dirty_tree_skipped details MUST include "
                "cycle_id (was the V3.2 fix surface)"
            ),
        )
        self.assertEqual(details["cycle_id"], cycle_id)
        self.assertIn("dirty_files_count", details)
        self.assertGreaterEqual(details["dirty_files_count"], 1)
        self.assertIn("head_sha", details)

    # I-V3.2-08 — closed-allowlist holistic guard.
    def test_i_v3_2_08_every_cycle_bound_event_carries_cycle_id(self) -> None:
        from aria_kernel.discovery import run_discovery
        from tests.invariants.v3_2._helpers import (
            init_minimal_git_repo,
            read_governance_rows,
        )

        init_minimal_git_repo(
            self.workspace,
            {"README.md": "# v3_2 fixture\n", "src/app.py": "x = 1\n"},
        )
        (self.workspace / "dirty.txt").write_text("dirty\n", encoding="utf-8")
        cycle_id = "cycle-v3_2-08"
        run_discovery(
            workspace_root=self.workspace,
            cycle_id=cycle_id,
            base_dir=self.tools_root,
            snapshot_mode="committed",
        )
        rows = read_governance_rows(self.tools_root)
        self.assertGreater(len(rows), 0, msg="discovery emitted zero rows")

        unknown_kinds: list[str] = []
        missing_cycle_id: list[str] = []
        for row in rows:
            kind = row.get("kind")
            if kind not in CYCLE_BOUND_EVENT_KINDS and kind not in CYCLE_INDEPENDENT_EVENT_KINDS:
                unknown_kinds.append(f"{kind!r} (row event_id={row.get('event_id')})")
                continue
            if kind in CYCLE_BOUND_EVENT_KINDS:
                details = row.get("details", {})
                if not isinstance(details, dict) or not details.get("cycle_id"):
                    missing_cycle_id.append(
                        f"{kind!r} (event_id={row.get('event_id')}) — "
                        f"cycle-bound but details.cycle_id missing/empty"
                    )

        self.assertEqual(
            unknown_kinds, [],
            msg=(
                "Plan ARIA-V3.2 §2c — every governance event kind MUST "
                "be classified in CYCLE_BOUND_EVENT_KINDS or "
                "CYCLE_INDEPENDENT_EVENT_KINDS. Unknown kinds:\n"
                + "\n".join(unknown_kinds)
            ),
        )
        self.assertEqual(
            missing_cycle_id, [],
            msg=(
                "Plan ARIA-V3.2 §2c F-010-D3 — every cycle-bound "
                "governance event MUST carry cycle_id:\n"
                + "\n".join(missing_cycle_id)
            ),
        )


if __name__ == "__main__":
    unittest.main()
