"""Plan 022 M-6 — registry <-> adapter manifest sync invariant tests.

Pre-Plan-022 v1 audit verdict said "registry-adapter synchronized"
but the operator deeper-look found:
1. tools/aria-adapters/typeorm-entity-schema-adapter.tool.json existed
   but was NOT bound to aria-tools/registry.json.
2. aria_kernel/adapter_portfolio.py:43 carried admitted-stub pattern
   (4 newly-shipped adapters intentionally on shadow_runner.py).

Fix: surface_manifest_validator.validate_registry_adapter_sync emits
'missing_registry_row' and 'unallowlisted_stub_runner' failures.
The intentional-stub allowlist lives in
aria-tools/registry-stub-allowlist.json with explicit
{tool_id, justification, plan_021_stream_a_owner} per entry.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.surface_manifest_validator import validate_registry_adapter_sync


def _seed_workspace() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-m6-"))
    repo = tmp / "repo"
    (repo / "aria-tools").mkdir(parents=True)
    (repo / "tools" / "aria-adapters").mkdir(parents=True)
    return repo, tmp


def _write_registry(repo: Path, tools: list[dict]) -> None:
    (repo / "aria-tools" / "registry.json").write_text(
        json.dumps({"schema_version": 2, "tools": tools}, indent=2),
        encoding="utf-8",
    )


def _write_allowlist(repo: Path, entries: list[dict]) -> None:
    (repo / "aria-tools" / "registry-stub-allowlist.json").write_text(
        json.dumps({"schema_version": 1, "entries": entries}, indent=2),
        encoding="utf-8",
    )


def _write_manifest(repo: Path, tool_id: str) -> None:
    (repo / "tools" / "aria-adapters" / f"{tool_id}.tool.json").write_text(
        json.dumps({"tool_id": tool_id, "kind": "adapter"}, indent=2),
        encoding="utf-8",
    )


class _M6TestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.repo, self._tmp = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)


class RegistryAdapterSyncTests(_M6TestCase):
    def test_all_manifests_bound_no_failures(self) -> None:
        _write_manifest(self.repo, "alpha-adapter")
        _write_registry(self.repo, [{"tool_id": "alpha-adapter",
                                     "runner": {"argv": ["python3", "alpha.py"]}}])
        _write_allowlist(self.repo, [])
        failures = validate_registry_adapter_sync(repo_root=self.repo, base_dir="aria-tools")
        self.assertEqual(failures, [])

    def test_manifest_without_registry_row_flagged(self) -> None:
        _write_manifest(self.repo, "alpha-adapter")
        _write_manifest(self.repo, "ghost-adapter")  # not in registry
        _write_registry(self.repo, [{"tool_id": "alpha-adapter",
                                     "runner": {"argv": ["python3", "alpha.py"]}}])
        _write_allowlist(self.repo, [])
        failures = validate_registry_adapter_sync(repo_root=self.repo, base_dir="aria-tools")
        ghost_fail = [f for f in failures if f.get("tool_id") == "ghost-adapter"]
        self.assertEqual(len(ghost_fail), 1)
        self.assertEqual(ghost_fail[0]["reason"], "missing_registry_row")

    def test_shadow_runner_in_allowlist_passes(self) -> None:
        _write_registry(self.repo, [{
            "tool_id": "stub-tool",
            "runner": {"argv": ["python3", "shadow_runner.py"], "cwd": "tools/aria-poc"},
        }])
        _write_allowlist(self.repo, [{
            "tool_id": "stub-tool",
            "justification": "Plan 021 Stream A pending parser",
            "plan_021_stream_a_owner": "platform-data-team",
        }])
        failures = validate_registry_adapter_sync(repo_root=self.repo, base_dir="aria-tools")
        # No 'unallowlisted_stub_runner' for the allowlisted tool.
        unallowlisted = [f for f in failures if f.get("reason") == "unallowlisted_stub_runner"]
        self.assertEqual(unallowlisted, [])

    def test_shadow_runner_outside_allowlist_flagged(self) -> None:
        _write_registry(self.repo, [{
            "tool_id": "rogue-stub",
            "runner": {"argv": ["python3", "shadow_runner.py"], "cwd": "tools/aria-poc"},
        }])
        _write_allowlist(self.repo, [])  # empty allowlist
        failures = validate_registry_adapter_sync(repo_root=self.repo, base_dir="aria-tools")
        unallowlisted = [f for f in failures if f.get("reason") == "unallowlisted_stub_runner"]
        self.assertEqual(len(unallowlisted), 1)
        self.assertEqual(unallowlisted[0]["tool_id"], "rogue-stub")

    def test_real_runner_not_flagged_as_stub(self) -> None:
        # A registry row whose runner.argv does NOT contain shadow_runner.py
        # is fine even without an allowlist entry.
        _write_registry(self.repo, [{
            "tool_id": "real-tool",
            "runner": {"argv": ["python3", "real_parser.py"], "cwd": "tools/aria-poc"},
        }])
        _write_allowlist(self.repo, [])
        failures = validate_registry_adapter_sync(repo_root=self.repo, base_dir="aria-tools")
        unallowlisted = [f for f in failures if f.get("reason") == "unallowlisted_stub_runner"]
        self.assertEqual(unallowlisted, [])


if __name__ == "__main__":
    unittest.main()
