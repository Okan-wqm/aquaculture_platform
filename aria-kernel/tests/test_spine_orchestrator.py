"""Plan 020 Phase 4 — fresh spine orchestrator tests.

What this suite pins:
- The refresh set is the gate's one declaration (``SPINE_INVARIANTS``), and
  every adapter in it has a manifest (ARIA-MEDIUM-516: the refresh named
  ``schema-drift-adapter``, which has none, and ``test-gap-adapter``, which no
  invariant reads).
- Default freshness window 600 s.
- Cache hit: same repo_state_id + within freshness window → adapter NOT
  re-executed; cached_count incremented.
- Cache miss: drifted repo_state_id or stale recorded_at → re-executed.
- The cache key is the WORKING TREE the adapters read: an uncommitted edit
  inside the window re-runs the adapters (ARIA-MEDIUM-516; the key used to be
  the committed snapshot, which never changes on an uncommitted edit).
- A run is classified by the status ``record_run`` STORED: an evidence-invalid
  run is ``failed``, not ``fresh`` (ARIA-MEDIUM-516).
- A quarantined adapter is not run and is named; an unregistered one too.
- The refresh returns the recorded rows and manifest versions it ran on;
  the governance event carries the summary only.
- Frozen / observe profiles block the orchestrator.
- take_baseline / take_postcheck honour the invariant_checks bypass.
- A failed adapter does not crash the orchestrator.
"""
from __future__ import annotations

import inspect
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel import architecture_spine_gate as gate
from aria_kernel.quarantine import quarantine_tool
from aria_kernel.runtime_profile import set_profile
from aria_kernel.spine_orchestrator import (
    DEFAULT_FRESHNESS_MAX_AGE_SECONDS,
    latest_orchestrator_refresh,
    refresh_spine_adapters,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.git_fixtures import commit_files, make_local_git_repo
from tests._helpers.spine_fixture import SPINE_FIXTURE_VERSION, SpineFixture, register_spine_adapters

ADAPTERS_DIR = Path(__file__).resolve().parents[2] / "tools" / "aria-adapters"


def _seed() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-spine-orch-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    register_spine_adapters(tools)
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


def _recorded(tool_id: str, *, run_id: str, recorded_at: str, repo_state_id: str, status: str = "ok") -> dict:
    """What run_tool returns: the stored row under "envelope"."""
    row = {
        "tool_id": tool_id, "run_id": run_id, "status": status, "recorded_at": recorded_at,
        "repo_snapshot": {"repo_state_id": repo_state_id},
    }
    return {"status": "SHADOW", "envelope": row, "health_decision": {"status": "SHADOW"}}


def _runs_rows(tools: Path) -> list[dict]:
    return [json.loads(line) for line in (tools / "runs.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def _states(summary: dict) -> dict[str, dict]:
    return {state["adapter_id"]: state for state in summary["adapter_states"]}


class ScopeAndDefaultsTests(unittest.TestCase):
    def test_refresh_set_is_the_gate_declaration_and_every_adapter_has_a_manifest(self) -> None:
        default = inspect.signature(refresh_spine_adapters).parameters["adapter_ids"].default
        manifests = {
            json.loads(path.read_text(encoding="utf-8"))["tool_id"] for path in ADAPTERS_DIR.glob("*.tool.json")
        }
        self.assertEqual([adapter for adapter in default if adapter not in manifests], [],
                         "the refresh names an adapter that has no manifest")
        self.assertEqual(default, gate.SPINE_ADAPTER_IDS)
        self.assertEqual(gate.SPINE_ADAPTER_IDS, tuple(spec.adapter_id for spec in gate.SPINE_INVARIANTS))
        self.assertEqual(gate.INVARIANT_KINDS, tuple(spec.kind for spec in gate.SPINE_INVARIANTS))
        self.assertEqual(
            gate.INVARIANT_KINDS,
            ("tenant_scoping", "event_contracts", "schema_entity", "auth_security", "harness_security"),
            "persisted vocabulary: values and order never change",
        )

    def test_default_freshness_window_is_600s(self) -> None:
        self.assertEqual(DEFAULT_FRESHNESS_MAX_AGE_SECONDS, 600)


class CacheHitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_cache_hit_when_same_repo_state_id_and_within_window(self) -> None:
        target_rsid = "repo-state:abc1234567"
        now = datetime.now(timezone.utc)
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            _write_run_row(
                self.tools, tool_id=adapter_id,
                repo_state_id=target_rsid,
                recorded_at=now.isoformat(),
                run_id=f"cached-{adapter_id}",
            )
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            summary = refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo,
            )
        mock_run.assert_not_called()
        self.assertEqual(mock_snap.call_args.kwargs["mode"], "working-tree")
        self.assertEqual(summary["cached_count"], len(gate.SPINE_ADAPTER_IDS))
        self.assertEqual(summary["fresh_count"], 0)
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            self.assertEqual(summary["run_ids"][adapter_id], f"cached-{adapter_id}")
            self.assertEqual(_states(summary)[adapter_id]["source"], "cached")
            self.assertEqual(summary["adapter_runs"][adapter_id]["run_id"], f"cached-{adapter_id}")
            self.assertEqual(summary["adapter_versions"][adapter_id], SPINE_FIXTURE_VERSION)


class CacheMissTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_drifted_repo_state_id_triggers_fresh_run(self) -> None:
        old_rsid = "repo-state:old-old-old"
        new_rsid = "repo-state:new-new-new"
        now = datetime.now(timezone.utc)
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            _write_run_row(self.tools, tool_id=adapter_id, repo_state_id=old_rsid, recorded_at=now.isoformat())
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": new_rsid, "snapshot_hash": "fake"}
            mock_run.side_effect = lambda **kw: _recorded(
                kw["tool_id"], run_id=f"fresh-{kw['tool_id']}", recorded_at=now.isoformat(), repo_state_id=new_rsid,
            )
            summary = refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        self.assertEqual(summary["fresh_count"], len(gate.SPINE_ADAPTER_IDS))
        self.assertEqual(summary["cached_count"], 0)
        self.assertEqual(mock_run.call_count, len(gate.SPINE_ADAPTER_IDS))
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            self.assertEqual(summary["adapter_runs"][adapter_id]["run_id"], f"fresh-{adapter_id}")

    def test_stale_recorded_at_triggers_fresh_run(self) -> None:
        target_rsid = "repo-state:fresh"
        stale = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            _write_run_row(self.tools, tool_id=adapter_id, repo_state_id=target_rsid, recorded_at=stale)
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            now = datetime.now(timezone.utc).isoformat()
            mock_run.side_effect = lambda **kw: _recorded(
                kw["tool_id"], run_id=f"new-{kw['tool_id']}", recorded_at=now, repo_state_id=target_rsid,
            )
            summary = refresh_spine_adapters(
                base_dir=self.tools, workspace_root=self.repo, freshness_max_age_seconds=600,
            )
        self.assertEqual(summary["fresh_count"], len(gate.SPINE_ADAPTER_IDS))


class GovernanceEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_orchestrator_emits_complete_event_with_the_summary_only(self) -> None:
        target_rsid = "repo-state:event-test"
        now = datetime.now(timezone.utc)
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            _write_run_row(self.tools, tool_id=adapter_id, repo_state_id=target_rsid, recorded_at=now.isoformat())
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap:
            mock_snap.return_value = {"repo_state_id": target_rsid, "snapshot_hash": "fake"}
            returned = refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        last = latest_orchestrator_refresh(base_dir=self.tools)
        self.assertIsNotNone(last)
        self.assertEqual(last["kind"], "spine_orchestrator_refresh_complete")
        details = last["details"]
        self.assertEqual(details["repo_state_id"], target_rsid)
        self.assertEqual(set(details["run_ids"].keys()), set(gate.SPINE_ADAPTER_IDS))
        # The rows themselves are the gate's input, not the ledger's.
        self.assertNotIn("adapter_runs", details)
        self.assertNotIn("adapter_versions", details)
        self.assertEqual(
            {key: value for key, value in returned.items() if key not in ("adapter_runs", "adapter_versions")},
            details,
        )


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
                return _recorded(str(kw["tool_id"]), run_id=f"r-{kw['tool_id']}", recorded_at=now, repo_state_id=target_rsid)
            mock_run.side_effect = runner
            summary = refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)
        states_by_id = _states(summary)
        self.assertEqual(states_by_id["tenant-scoping-adapter"]["source"], "failed")
        self.assertIn("synthetic adapter failure", states_by_id["tenant-scoping-adapter"]["error"])
        # No run was recorded for it, so there is no row to hand the gate.
        self.assertNotIn("tenant-scoping-adapter", summary["adapter_runs"])
        self.assertEqual(summary["fresh_count"], len(gate.SPINE_ADAPTER_IDS) - 1)

    def test_a_status_outside_the_run_vocabulary_is_fail_loud(self) -> None:
        with patch("aria_kernel.spine_orchestrator.build_repo_snapshot") as mock_snap, \
             patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            mock_snap.return_value = {"repo_state_id": "repo-state:x", "snapshot_hash": "fake"}
            mock_run.side_effect = lambda **kw: _recorded(
                kw["tool_id"], run_id="r", recorded_at="", repo_state_id="repo-state:x", status="pass",
            )
            with self.assertRaisesRegex(GovernanceError, "spine_orchestrator_unknown_run_status"):
                refresh_spine_adapters(base_dir=self.tools, workspace_root=self.repo)


class RealRunnerTests(unittest.TestCase):
    """The refresh through the real tool runner: room, evidence check, record_run."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        commit_files(self.workspace, {"src/app.ts": "export const app = 1;\n"})
        self.tools = ensure_tools_dir(root / "aria-tools")
        self.spine = SpineFixture(self.workspace, self.tools)

    def _refresh(self) -> dict:
        return refresh_spine_adapters(base_dir=self.tools, workspace_root=self.workspace, cycle_id="cyc-spine")

    def test_refresh_classifies_by_recorded_status(self) -> None:
        self.spine.register_clean()
        # A finding citing a file the snapshot does not hold: the runner sees
        # exit 0 and parseable output, record_run stores evidence_error.
        self.spine.set_findings("security-boundary-adapter", [{
            "id": "f-1", "rule": "fixture_rule", "path": "src/missing.ts", "message": "m",
            "evidence": [{"path": "src/missing.ts", "line": 1}],
        }], commit=True)
        summary = self._refresh()
        states = _states(summary)
        stored = {row["tool_id"]: row for row in _runs_rows(self.tools)}
        self.assertEqual(stored["security-boundary-adapter"]["status"], "evidence_error")
        self.assertEqual(states["security-boundary-adapter"]["source"], "failed")
        self.assertEqual(states["security-boundary-adapter"]["status"], "evidence_error")
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            # The refresh hands on exactly the rows the store holds.
            self.assertEqual(summary["adapter_runs"][adapter_id], stored[adapter_id])
            if adapter_id != "security-boundary-adapter":
                self.assertEqual(states[adapter_id]["source"], "fresh", stored[adapter_id]["runner"]["stderr_sample"])
        self.assertEqual(summary["fresh_count"], len(gate.SPINE_ADAPTER_IDS) - 1)

    def test_quarantined_adapter_is_not_run_and_is_named(self) -> None:
        self.spine.register_clean()
        quarantine_tool("tenant-scoping-adapter", "fixture quarantine", base_dir=self.tools)
        summary = self._refresh()
        states = _states(summary)
        self.assertEqual(states["tenant-scoping-adapter"]["source"], "quarantined")
        self.assertNotIn("tenant-scoping-adapter", summary["adapter_runs"])
        self.assertNotIn("tenant-scoping-adapter", {row["tool_id"] for row in _runs_rows(self.tools)})
        for adapter_id in gate.SPINE_ADAPTER_IDS:
            if adapter_id != "tenant-scoping-adapter":
                self.assertEqual(states[adapter_id]["source"], "fresh")

    def test_unregistered_adapter_is_named_not_run(self) -> None:
        with patch("aria_kernel.spine_orchestrator.run_tool") as mock_run:
            summary = self._refresh()
        mock_run.assert_not_called()
        self.assertEqual(
            {adapter_id: state["source"] for adapter_id, state in _states(summary).items()},
            {adapter_id: "unregistered" for adapter_id in gate.SPINE_ADAPTER_IDS},
        )
        self.assertEqual(summary["adapter_runs"], {})

    def test_uncommitted_edit_is_not_served_from_cache(self) -> None:
        self.spine.register_clean()
        first = self._refresh()
        self.assertEqual(first["fresh_count"], len(gate.SPINE_ADAPTER_IDS))
        second = self._refresh()
        self.assertEqual(second["cached_count"], len(gate.SPINE_ADAPTER_IDS), "an unchanged tree reuses the runs")
        # An uncommitted edit inside the freshness window: the adapters read
        # the working tree, so the runs that never saw it must not be reused.
        self.spine.set_findings("tenant-scoping-adapter", [{
            "id": "f-2", "rule": "fixture_rule", "path": "src/app.ts", "message": "m",
            "evidence": [{"path": "src/app.ts", "line": 1}],
        }], commit=False)
        third = self._refresh()
        self.assertEqual(third["cached_count"], 0)
        self.assertEqual(third["fresh_count"], len(gate.SPINE_ADAPTER_IDS))
        self.assertNotEqual(third["repo_state_id"], second["repo_state_id"])
        tenant = third["adapter_runs"]["tenant-scoping-adapter"]
        self.assertEqual(tenant["status"], "ok", tenant["runner"]["stderr_sample"])
        self.assertEqual(tenant["runner"]["raw_findings_count"], 1, "the re-run saw the edit")


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
