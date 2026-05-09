"""Plan 023 v3 §C-1 — aria-tools/ scope-out mutation visibility tests.

Pre-Plan-023 the snapshot module's `DIRTY_IGNORE_PREFIXES` contained
`"aria-tools/"`. Both `build_repo_snapshot` (developer-context spine
gate) and `_workspace_snapshot_raw` (tool_runner mutation diff) routed
through `ignored_dirty_path` and silently dropped any aria-tools/ writes
from observation. A buggy or malicious adapter that wrote to
`aria-tools/registry.json`, `aria-tools/governance.jsonl`, or any other
ledger inside the kernel-managed tools directory was therefore invisible
to scope-out detection — the `_partition_mutations` + `record_run`
quarantine path could never see the write because the upstream snapshot
already filtered it out.

Note: `record_run` itself appends to `aria-tools/runs.jsonl` AFTER the
post-snapshot is taken (tool_health.py:97 `append_jsonl(runs_path(...))`
runs after `_partition_mutations`). The runner's own audit-trail row
therefore does NOT appear in the before/after diff, so no allowlist for
the runner's own writes is needed.

Tests:
1. `_workspace_snapshot_raw` includes aria-tools/registry.json writes.
2. `_workspace_snapshot_raw` includes aria-tools/governance.jsonl writes.
3. `_workspace_snapshot_raw` includes aria-tools/runs.jsonl writes
   (defense in depth — record_run timing handles the canonical case,
   but a buggy subprocess writing to runs.jsonl directly must surface).
4. `build_repo_snapshot` dirty_paths includes aria-tools/ writes when
   present, but `enforce_clean=False` (the default) does NOT block.
5. `_partition_mutations` end-to-end: subprocess that writes to
   aria-tools/registry.json surfaces as `scope_out_mutations`.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.snapshot import build_repo_snapshot
from aria_kernel.tool_runner import (
    _partition_mutations,
    _workspace_snapshot_raw,
)


def _make_tool(allowed: list[str], forbidden: list[str] | None = None) -> dict:
    return {
        "tool_id": "fake",
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "declared_scope": allowed,
        "allowed_read_globs": allowed,
        "forbidden_read_globs": forbidden or [".git/**", "node_modules/**"],
        "claim_types": ["fake"],
        "owner": "platform",
        "schema_version": 2,
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": {
            "precision_min": 0.85,
            "non_critical_false_positives_30d": 3,
            "critical_false_positives": 0,
            "crash_rate_last_10": 0.2,
        },
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
    }


class _GitRepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-c1-"))
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@t.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=self.repo, check=True)
        (self.repo / "README.md").write_text("# r\n", encoding="utf-8")
        (self.repo / "aria-tools").mkdir()
        (self.repo / "aria-tools" / "registry.json").write_text('{"tools": []}\n', encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "init"], cwd=self.repo, check=True, capture_output=True,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)


class WorkspaceSnapshotRawAriaToolsTests(_GitRepoTestCase):
    def test_aria_tools_registry_write_visible_in_raw_snapshot(self) -> None:
        """A subprocess mutation to aria-tools/registry.json must appear in
        _workspace_snapshot_raw output. Pre-fix the upstream filter
        suppressed every aria-tools/ path, defeating scope-out detection."""
        (self.repo / "aria-tools" / "registry.json").write_text(
            '{"tools": [{"tool_id": "injected"}]}\n', encoding="utf-8",
        )
        snap = _workspace_snapshot_raw(self.repo)
        self.assertEqual(snap[0], "git")
        self.assertTrue(
            any("aria-tools/registry.json" in entry for entry in snap[1]),
            f"aria-tools/registry.json mutation not visible in raw snapshot: {snap[1]!r}",
        )

    def test_aria_tools_governance_write_visible_in_raw_snapshot(self) -> None:
        """A subprocess mutation to aria-tools/governance.jsonl must appear
        in raw snapshot. Governance ledger writes are kernel-internal; an
        adapter writing here is a hard sandbox-escape signal."""
        (self.repo / "aria-tools" / "governance.jsonl").write_text(
            '{"event": "injected"}\n', encoding="utf-8",
        )
        snap = _workspace_snapshot_raw(self.repo)
        self.assertEqual(snap[0], "git")
        self.assertTrue(
            any("aria-tools/governance.jsonl" in entry for entry in snap[1]),
            f"aria-tools/governance.jsonl mutation not visible in raw snapshot: {snap[1]!r}",
        )

    def test_aria_tools_runs_write_visible_in_raw_snapshot(self) -> None:
        """Even though record_run is the canonical writer for aria-tools/
        runs.jsonl AFTER the post-snapshot is taken, a subprocess that
        writes to runs.jsonl directly during its own execution must still
        surface — defense in depth against premature/duplicate ledger
        writes by adapter code."""
        (self.repo / "aria-tools" / "runs.jsonl").write_text(
            '{"injected": true}\n', encoding="utf-8",
        )
        snap = _workspace_snapshot_raw(self.repo)
        self.assertEqual(snap[0], "git")
        self.assertTrue(
            any("aria-tools/runs.jsonl" in entry for entry in snap[1]),
            f"aria-tools/runs.jsonl mutation not visible in raw snapshot: {snap[1]!r}",
        )


class BuildRepoSnapshotAriaToolsTests(_GitRepoTestCase):
    def test_dirty_paths_include_aria_tools_when_dirty(self) -> None:
        """build_repo_snapshot's developer-context dirty_paths field must
        include aria-tools/ writes so spine/baseline observers can see
        cycle telemetry. Operator pre-flight commits keep the worktree
        clean between cycles when desired."""
        (self.repo / "aria-tools" / "governance.jsonl").write_text(
            '{"event": "telemetry"}\n', encoding="utf-8",
        )
        snap = build_repo_snapshot(workspace_root=self.repo, mode="working_tree")
        self.assertTrue(
            any("aria-tools/governance.jsonl" in path for path in snap["dirty_paths"]),
            f"aria-tools/governance.jsonl not in dirty_paths: {snap['dirty_paths']!r}",
        )

    def test_enforce_clean_false_does_not_block_on_aria_tools_dirty(self) -> None:
        """The default `enforce_clean=False` mode must NOT raise when
        aria-tools/ is dirty — visibility is the goal, not blocking. Only
        callers that explicitly opt-in to enforce_clean=True should
        receive the workspace_dirty_blocked exception."""
        (self.repo / "aria-tools" / "registry.json").write_text(
            '{"tools": [{"tool_id": "x"}]}\n', encoding="utf-8",
        )
        # Default mode (committed) does not enforce clean unless requested.
        snap = build_repo_snapshot(
            workspace_root=self.repo, mode="working_tree", enforce_clean=False,
        )
        self.assertIn("dirty_paths", snap)


class PartitionMutationsAriaToolsIntegrationTests(_GitRepoTestCase):
    def test_aria_tools_registry_write_classified_as_scope_out(self) -> None:
        """End-to-end: capture pre-snapshot, simulate subprocess mutation
        to aria-tools/registry.json, capture post-snapshot, partition the
        diff. The mutation must appear in scope_out_mutations because
        aria-tools/ is outside any tool's declared_scope."""
        before_raw = _workspace_snapshot_raw(self.repo)
        # Simulate adapter subprocess writing outside its declared scope.
        (self.repo / "aria-tools" / "registry.json").write_text(
            '{"tools": [{"tool_id": "injected_by_adapter"}]}\n', encoding="utf-8",
        )
        after_raw = _workspace_snapshot_raw(self.repo)
        tool = _make_tool(allowed=["apps/**"])
        scoped, scope_out = _partition_mutations(
            before_raw=before_raw, after_raw=after_raw, tool=tool,
        )
        self.assertEqual(scoped, [])
        self.assertTrue(
            any("aria-tools/registry.json" in entry for entry in scope_out),
            f"aria-tools/registry.json should be in scope_out_mutations: scope_out={scope_out!r}",
        )


if __name__ == "__main__":
    unittest.main()
