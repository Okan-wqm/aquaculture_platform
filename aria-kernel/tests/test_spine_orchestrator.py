"""Plan 020 Phase 4 — fresh spine orchestrator tests.

What this suite pins (≥10 tests):
- 5-adapter scope locked (security-boundary, tenant-scoping, schema-drift,
  event-contracts, test-gap).
- Default freshness window 600 s.
- Cache hit: same repo_state_id + within freshness window → adapter NOT
  re-executed; cached_count incremented.
- Cache miss: drifted repo_state_id → adapter re-executed; fresh_count
  incremented.
- Cache miss: stale recorded_at → adapter re-executed.
- Per-adapter run_id surfaced in run_ids dict.
- spine_orchestrator_refresh_complete governance event emitted with the
  full summary payload.
- Frozen profile blocks the orchestrator (spine_orchestrator surface).
- Observe profile blocks the orchestrator (tool_runs not allowed).
- Architecture spine gate take_baseline + take_postcheck honour the
  invariant_checks-bypass rule (synthetic checks → orchestrator skipped).
- Failed adapter run does not crash orchestrator; surface adapter_states
  source='failed' for the failure.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.runtime_profile import set_profile
from aria_kernel.spine_orchestrator import (
    DEFAULT_FRESHNESS_MAX_AGE_SECONDS,
    SPINE_ADAPTER_IDS,
    latest_orchestrator_refresh,
    refresh_spine_adapters,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-spine-orch-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    return tools, repo


def _write_run_row(tools: Path, *, tool_id: str, repo_state_id: str, recorded_at: str, run_id: str = "rid-1") -> None:
    """Append a synthetic runs.jsonl row so the orchestrator's freshness
    check has cached data to work against without invoking real adapters."""
    row = {
        "schema_version": 1,
        "tool_id": tool_id,
        "run_id": run_id,
        "status": "ok",
        "recorded_at": recorded_at,
        "repo_snapshot": {"repo_state_id": repo_state_id},
        "runner": {"raw_findings_count": 0, "raw_observations_count": 0},
    }
    with (tools / "runs.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


class ScopeAndDefaultsTests(unittest.TestCase):
    def test_spine_adapter_scope_locked(self) -> None:
        # Plan 020 Phase 4 baseline: 5 adapters.
        # Plan 020 Phase 10 extension: +1 (agent-harness-security-adapter
        # feeds the harness_security invariant).
        self.assertEqual(SPINE_ADAPTER_IDS, (
            "security-boundary-adapter",
            "tenant-scoping-adapter",
            "schema-drift-adapter",
            "event-contracts-adapter",
            "test-gap-adapter",
            "agent-harness-security-adapter",
        ))

    def test_default_freshness_window_is_600s(self) -> None:
        self.assertEqual(DEFAULT_FRESHNESS_MAX_AGE_SECONDS, 600)


class CacheHitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_cache_hit_when_same_repo_state_id_and_within_window(self) -> None:
        # Pre-populate runs.jsonl with rows matching the snapshot built
        # by build_repo_snapshot (mock its return).
        target_rsid = "repo-state:abc1234567"
        now = datetime.now(timezone.utc)
        for adapter_id in SPINE_ADAPTER_IDS:
            _write_run_row(
                self.tools, tool_id=adapter_id,
                repo_state_id=target_rsid,
                recorded_at=now.isoformat(),
                run_id=f"cached-{adapter_id}",
            )
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            summary = refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
            )
        self.assertEqual(summary["cached_count"], len(SPINE_ADAPTER_IDS))
        self.assertEqual(summary["fresh_count"], 0)
        for adapter_id in SPINE_ADAPTER_IDS:
            self.assertEqual(summary["run_ids"][adapter_id], f"cached-{adapter_id}")
            entry = next(s for s in summary["adapter_states"] if s["adapter_id"] == adapter_id)
            self.assertEqual(entry["source"], "cached")


class CacheMissTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_drifted_repo_state_id_triggers_fresh_run(self) -> None:
        # Cached rows have OLD repo_state_id; current snapshot has a NEW one.
        old_rsid = "repo-state:old-old-old"
        new_rsid = "repo-state:new-new-new"
        now = datetime.now(timezone.utc)
        for adapter_id in SPINE_ADAPTER_IDS:
            _write_run_row(
                self.tools, tool_id=adapter_id,
                repo_state_id=old_rsid,
                recorded_at=now.isoformat(),
            )
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": new_rsid, "snapshot_hash": "fake"}
            mock_run.side_effect = lambda **kw: {
                "status": "ok",
                "run_id": f"fresh-{kw['tool_id']}",
                "recorded_at": now.isoformat(),
                "repo_snapshot": {"repo_state_id": new_rsid},
            }
            summary = refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
            )
        self.assertEqual(summary["fresh_count"], len(SPINE_ADAPTER_IDS))
        self.assertEqual(summary["cached_count"], 0)
        self.assertEqual(mock_run.call_count, len(SPINE_ADAPTER_IDS))

    def test_stale_recorded_at_triggers_fresh_run(self) -> None:
        # Cached row matches repo_state_id but is 2 hours old.
        target_rsid = "repo-state:fresh"
        stale = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        for adapter_id in SPINE_ADAPTER_IDS:
            _write_run_row(self.tools, tool_id=adapter_id,
                           repo_state_id=target_rsid, recorded_at=stale)
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            now = datetime.now(timezone.utc).isoformat()
            mock_run.side_effect = lambda **kw: {
                "status": "ok", "run_id": f"new-{kw['tool_id']}",
                "recorded_at": now,
                "repo_snapshot": {"repo_state_id": target_rsid},
            }
            summary = refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
                freshness_max_age_seconds=600,
            )
        self.assertEqual(summary["fresh_count"], len(SPINE_ADAPTER_IDS))


class GovernanceEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_orchestrator_emits_complete_event(self) -> None:
        target_rsid = "repo-state:event-test"
        now = datetime.now(timezone.utc)
        for adapter_id in SPINE_ADAPTER_IDS:
            _write_run_row(self.tools, tool_id=adapter_id,
                           repo_state_id=target_rsid,
                           recorded_at=now.isoformat())
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        last = latest_orchestrator_refresh(base_dir=self.tools)
        self.assertIsNotNone(last)
        self.assertEqual(last["kind"], "spine_orchestrator_refresh_complete")
        details = last["details"]
        self.assertEqual(details["repo_state_id"], target_rsid)
        self.assertEqual(set(details["run_ids"].keys()), set(SPINE_ADAPTER_IDS))


class FailedRunIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_one_failed_adapter_does_not_crash_orchestrator(self) -> None:
        target_rsid = "repo-state:failed"
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            now = datetime.now(timezone.utc).isoformat()
            def runner(**kw: object) -> dict:
                if kw["tool_id"] == "tenant-scoping-adapter":
                    raise GovernanceError("synthetic adapter failure")
                return {
                    "status": "ok", "run_id": f"r-{kw['tool_id']}",
                    "recorded_at": now,
                    "repo_snapshot": {"repo_state_id": target_rsid},
                }
            mock_run.side_effect = runner
            summary = refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        states_by_id = {s["adapter_id"]: s for s in summary["adapter_states"]}
        self.assertEqual(states_by_id["tenant-scoping-adapter"]["source"], "failed")
        self.assertIn("synthetic adapter failure", states_by_id["tenant-scoping-adapter"]["error"])
        # All other adapters (current scope - 1) still ran.
        self.assertEqual(summary["fresh_count"], len(SPINE_ADAPTER_IDS) - 1)


class ProfileGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_orchestrator(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        self.assertIn("spine_orchestrator", str(cm.exception))
        self.assertIn("frozen", str(cm.exception))

    def test_observe_blocks_orchestrator(self) -> None:
        set_profile("observe", operator_approval_ref="op:observe",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        self.assertIn("observe", str(cm.exception))


class InputValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_zero_freshness_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
                freshness_max_age_seconds=0,
            )

    def test_zero_workers_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
                max_workers=0,
            )

    def test_empty_adapter_ids_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
                adapter_ids=(),
            )


class ArchitectureSpineGateBypassTests(unittest.TestCase):
    """Phase 4.B contract — invariant_checks override bypasses orchestrator.

    Smoke tests + fixture-driven tests pass invariant_checks for synthetic
    measurements; the orchestrator must NOT fire on those paths because
    its goal (fresh adapter rows) is irrelevant when the caller is
    feeding measurements directly.
    """

    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_take_baseline_skips_orchestrator_when_invariant_checks_provided(self) -> None:
        from aria_kernel.architecture_spine_gate import (
            InvariantMeasurement,
            take_baseline,
        )
        called = {"refresh": 0}
        def stub_refresh(**kw: object) -> dict:
            called["refresh"] += 1
            return {}
        # Use real take_baseline; orchestrator should NOT be invoked because
        # we pass invariant_checks (synthetic).
        with patch("aria_kernel.spine_orchestrator.refresh_spine_adapters", side_effect=stub_refresh):
            take_baseline(
                plan_id="phase-4-bypass-test",
                cycle_id="cyc-1",
                workspace_root=self.repo,
                base_dir=self.tools,
                invariant_checks={
                    inv: (lambda root, _i=inv: InvariantMeasurement(
                        invariant=_i, measured_at="2026-05-08T00:00:00+00:00",
                        measurements={"test": True}, source=f"fixture:{_i}",
                    ))
                    for inv in ("tenant_scoping", "event_contracts",
                                "schema_entity", "auth_security")
                },
            )
        self.assertEqual(called["refresh"], 0,
            "orchestrator must NOT fire when caller provides invariant_checks")


if __name__ == "__main__":
    unittest.main()
