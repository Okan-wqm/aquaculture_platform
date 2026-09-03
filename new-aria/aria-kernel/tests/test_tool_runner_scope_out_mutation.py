"""Plan 022 C-5 — scope-out mutation raw vs scoped snapshot tests.

Pre-Plan-022 _normalized_git_status filtered mutations through
_mutation_path_in_tool_scope BEFORE building the snapshot tuple. So a
buggy/malicious adapter that mutated files OUTSIDE its declared scope
(package.json, CI config, registry.json) was invisible: before == after
because both were tool-scope-filtered.

Fix: capture before_raw + after_raw via the new _workspace_snapshot_raw,
partition the diff into scoped_mutations + scope_out_mutations, surface
both in the runner envelope, and trigger quarantine via the new
immediate_quarantine_reason scope-out branch.

Tests:
1. _partition_mutations partitions a synthetic diff correctly.
2. _workspace_snapshot_raw returns unfiltered git status output.
3. immediate_quarantine_reason fires the scope-out branch when the run
   envelope carries scope_out_mutations.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_health import immediate_quarantine_reason
from aria_kernel.tool_runner import (
    _normalized_git_status_raw,
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
        "health_thresholds": {"precision_min": 0.85, "non_critical_false_positives_30d": 3, "critical_false_positives": 0, "crash_rate_last_10": 0.2},
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
    }


class PartitionMutationsTests(unittest.TestCase):
    def test_in_scope_mutation_classified_as_scoped(self) -> None:
        before = ("git", ())
        after = ("git", (" M apps/foo/bar.ts",))
        tool = _make_tool(allowed=["apps/**"])
        scoped, scope_out = _partition_mutations(
            before_raw=before, after_raw=after, tool=tool,
        )
        self.assertEqual(scoped, [" M apps/foo/bar.ts"])
        self.assertEqual(scope_out, [])

    def test_out_of_scope_mutation_classified_as_scope_out(self) -> None:
        before = ("git", ())
        after = ("git", (" M aria-tools/registry.json",))
        tool = _make_tool(allowed=["apps/**"])
        scoped, scope_out = _partition_mutations(
            before_raw=before, after_raw=after, tool=tool,
        )
        self.assertEqual(scoped, [])
        self.assertEqual(scope_out, [" M aria-tools/registry.json"])

    def test_mixed_diff_partitioned(self) -> None:
        before = ("git", ())
        after = ("git", (
            " M apps/x/foo.ts",
            " M aria-tools/registry.json",
            " M package.json",
        ))
        tool = _make_tool(allowed=["apps/**"])
        scoped, scope_out = _partition_mutations(
            before_raw=before, after_raw=after, tool=tool,
        )
        self.assertEqual(scoped, [" M apps/x/foo.ts"])
        self.assertEqual(set(scope_out), {
            " M aria-tools/registry.json",
            " M package.json",
        })

    def test_no_diff_returns_empty_lists(self) -> None:
        before = ("git", (" M apps/x/foo.ts",))
        after = ("git", (" M apps/x/foo.ts",))
        tool = _make_tool(allowed=["apps/**"])
        scoped, scope_out = _partition_mutations(
            before_raw=before, after_raw=after, tool=tool,
        )
        self.assertEqual(scoped, [])
        self.assertEqual(scope_out, [])


class WorkspaceSnapshotRawTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-c5-raw-"))
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@t.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=self.repo, check=True)
        (self.repo / "README.md").write_text("# r\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=self.repo, check=True, capture_output=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_raw_snapshot_includes_scope_out_mutations(self) -> None:
        # Mutate a file that an apps/** scoped tool would normally filter.
        (self.repo / "package.json").write_text("{}", encoding="utf-8")
        snap = _workspace_snapshot_raw(self.repo)
        self.assertEqual(snap[0], "git")
        # Untracked package.json appears in raw status.
        self.assertTrue(any("package.json" in entry for entry in snap[1]))


class ImmediateQuarantineReasonTests(unittest.TestCase):
    def test_scope_out_mutations_trigger_specific_reason(self) -> None:
        tool = _make_tool(allowed=["apps/**"])
        run = {
            "status": "ok",
            "read_paths": [],
            "evidence_validation": {"repository_mutation_attempt": True},
            "runner": {
                "scope_out_mutations": [" M aria-tools/registry.json"],
                "scoped_mutations": [],
            },
        }
        reason = immediate_quarantine_reason(tool, run)
        self.assertIsNotNone(reason)
        self.assertIn("scope-out mutation", reason)
        self.assertIn("aria-tools/registry.json", reason)

    def test_scoped_only_mutation_uses_generic_reason(self) -> None:
        tool = _make_tool(allowed=["apps/**"])
        run = {
            "status": "ok",
            "read_paths": [],
            "evidence_validation": {"repository_mutation_attempt": True},
            "runner": {
                "scope_out_mutations": [],
                "scoped_mutations": [" M apps/x/foo.ts"],
            },
        }
        reason = immediate_quarantine_reason(tool, run)
        self.assertEqual(reason, "repository mutation attempt")


if __name__ == "__main__":
    unittest.main()
