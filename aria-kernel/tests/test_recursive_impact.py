"""Tests for the Plan 016 Faz D1 recursive impact graph (six-source)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.recursive_impact import (
    DEFAULT_MAX_DEPTH,
    IMPACT_SOURCES,
    IMPACT_STATUSES,
    ImpactEntry,
    compute_recursive_impact,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-d1-"))
    (repo / "apps" / "foo-service" / "src").mkdir(parents=True, exist_ok=True)
    (repo / "apps" / "bar-service" / "src").mkdir(parents=True, exist_ok=True)
    (repo / "libs" / "shared" / "src").mkdir(parents=True, exist_ok=True)
    return repo


def _write_repo_identity(tools: Path, repo: Path) -> None:
    identity = {
        "aria_tools_contract_version": 2,
        "schema_version": 2,
        "bound_repo_hash": "test-hash",
        "bound_repo_root": str(repo),
    }
    (tools / "repo_identity.json").write_text(json.dumps(identity), encoding="utf-8")


class FrameworkTests(unittest.TestCase):
    def test_six_sources_named(self) -> None:
        self.assertEqual(len(IMPACT_SOURCES), 6)
        self.assertEqual(
            set(IMPACT_SOURCES),
            {
                "nx_graph",
                "import_graph",
                "event_contract",
                "graphql_api",
                "db_entity",
                "frontend_module",
            },
        )

    def test_three_statuses(self) -> None:
        self.assertEqual(set(IMPACT_STATUSES), {"known", "unknown", "explicitly_blocked"})

    def test_default_max_depth_in_range(self) -> None:
        self.assertGreaterEqual(DEFAULT_MAX_DEPTH, 1)
        self.assertLessEqual(DEFAULT_MAX_DEPTH, 10)


class EmptyInputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        _write_repo_identity(self.tools, self.repo)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_empty_intended_files_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "intended_files"):
            compute_recursive_impact(
                intended_files=[],
                workspace_root=self.repo,
                base_dir=self.tools,
            )

    def test_invalid_max_depth_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "max_depth"):
            compute_recursive_impact(
                intended_files=["apps/foo-service/src/x.ts"],
                workspace_root=self.repo,
                base_dir=self.tools,
                max_depth=0,
            )


class StubSourceBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        _write_repo_identity(self.tools, self.repo)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_stub_sources_emit_unknown_per_source(self) -> None:
        result = compute_recursive_impact(
            intended_files=["apps/foo-service/src/x.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        # event_contract, graphql_api, db_entity, frontend_module each emit one
        # unknown stub entry per intended file (they cannot resolve real refs
        # in a fresh fixture repo). nx_graph also returns "unknown" because no
        # nx cache exists.
        unknown = result["summary"]["by_status"]["unknown"]
        self.assertGreaterEqual(unknown, 4, result["summary"])

    def test_stub_sources_carry_block_reason(self) -> None:
        result = compute_recursive_impact(
            intended_files=["apps/foo-service/src/x.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        stub_entries = [
            e for e in result["entries"]
            if e["source"] in {"event_contract", "graphql_api", "db_entity", "frontend_module"}
        ]
        self.assertGreater(len(stub_entries), 0)
        for entry in stub_entries:
            self.assertEqual(entry["status"], "unknown")
            self.assertIsNotNone(entry["block_reason"])
            self.assertIn("not yet implemented", entry["block_reason"])


class ImportGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        _write_repo_identity(self.tools, self.repo)
        # Seed a real importer relationship.
        (self.repo / "libs" / "shared" / "src" / "helper.ts").write_text(
            "export function helper(): void {}\n", encoding="utf-8"
        )
        (self.repo / "apps" / "foo-service" / "src" / "main.ts").write_text(
            "import { helper } from '../../libs/shared/src/helper';\n", encoding="utf-8"
        )
        (self.repo / "apps" / "bar-service" / "src" / "client.ts").write_text(
            "import { helper } from '../../libs/shared/src/helper';\n", encoding="utf-8"
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_import_graph_finds_direct_importers(self) -> None:
        result = compute_recursive_impact(
            intended_files=["libs/shared/src/helper.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
            max_depth=2,
        )
        importer_entries = [
            e for e in result["entries"]
            if e["source"] == "import_graph" and e["status"] == "known"
        ]
        importer_paths = {e["path"] for e in importer_entries}
        # Both files that import helper should appear.
        self.assertIn("apps/foo-service/src/main.ts", importer_paths)
        self.assertIn("apps/bar-service/src/client.ts", importer_paths)


class PersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        _write_repo_identity(self.tools, self.repo)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_graph_persisted_under_impact_graphs(self) -> None:
        result = compute_recursive_impact(
            intended_files=["apps/foo-service/src/x.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        fingerprint = result["intended_fingerprint"]
        path = self.tools / "impact-graphs" / f"{fingerprint}.json"
        self.assertTrue(path.exists())
        loaded = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(loaded["intended_fingerprint"], fingerprint)

    def test_governance_event_emitted(self) -> None:
        compute_recursive_impact(
            intended_files=["apps/foo-service/src/x.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = {json.loads(line).get("kind") for line in gov if line.strip()}
        self.assertIn("impact_graph_computed", kinds)


if __name__ == "__main__":
    unittest.main()
