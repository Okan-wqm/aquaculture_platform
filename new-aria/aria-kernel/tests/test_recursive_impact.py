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

    def test_non_matching_files_produce_no_specialized_source_entries(self) -> None:
        # Plan 019 Phase 4 — graphql_api, db_entity, frontend_module are
        # now real sources (DEBT-2026-05-07-002 closure). Each filters
        # intended_files to its domain glob and returns empty when
        # nothing matches. event_contract was already real (Plan 017
        # Phase 5.2). For a generic .ts file outside every domain glob,
        # NO specialized source emits — only nx_graph / import_graph
        # produce entries (and only when their dependencies are
        # observable).
        result = compute_recursive_impact(
            intended_files=["apps/foo-service/src/x.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        specialized = [
            e for e in result["entries"]
            if e["source"] in {"event_contract", "graphql_api", "db_entity", "frontend_module"}
        ]
        self.assertEqual(
            specialized, [],
            f"specialized sources should not emit for non-domain files; got {specialized}",
        )

    def test_db_entity_source_emits_when_entity_file_in_intended(self) -> None:
        # Seed a synthetic entity file in the fixture repo + run the
        # compute. db_entity_source must produce at least one defines:
        # entry. ADR-011-violating entity (no schema) produces an
        # unknown entry with the block_reason naming the rule.
        entity_dir = self.repo / "apps" / "foo-service" / "src" / "things" / "entities"
        entity_dir.mkdir(parents=True, exist_ok=True)
        entity_path = entity_dir / "thing.entity.ts"
        entity_path.write_text(
            "import { Entity, PrimaryGeneratedColumn } from 'typeorm';\n"
            "@Entity('things', { schema: 'foo' })\n"
            "export class ThingEntity {\n"
            "  @PrimaryGeneratedColumn('uuid') id!: string;\n"
            "}\n",
            encoding="utf-8",
        )
        rel = entity_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        db_entries = [e for e in result["entries"] if e["source"] == "db_entity"]
        self.assertTrue(any("defines:foo.things" in e["relationship"] for e in db_entries),
                        f"expected defines:foo.things; got {db_entries}")

    def test_db_entity_source_flags_missing_schema(self) -> None:
        # ADR-011 invariant: missing schema in @Entity decorator is an
        # architectural violation. The source emits an unknown entry
        # with block_reason naming ADR-011.
        entity_dir = self.repo / "apps" / "foo-service" / "src" / "things" / "entities"
        entity_dir.mkdir(parents=True, exist_ok=True)
        entity_path = entity_dir / "no_schema.entity.ts"
        entity_path.write_text(
            "import { Entity } from 'typeorm';\n"
            "@Entity('orphans')\n"
            "export class OrphanEntity {}\n",
            encoding="utf-8",
        )
        rel = entity_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        db_entries = [e for e in result["entries"] if e["source"] == "db_entity"]
        violation = next((e for e in db_entries if "missing_schema_decl" in e["relationship"]), None)
        self.assertIsNotNone(violation, f"expected missing_schema entry; got {db_entries}")
        self.assertEqual(violation["status"], "unknown")
        self.assertIn("ADR-011", violation["block_reason"] or "")

    def test_graphql_api_source_emits_when_graphql_file_in_intended(self) -> None:
        # Seed a synthetic .graphql file + run compute.
        gql_dir = self.repo / "apps" / "foo-service" / "src"
        gql_dir.mkdir(parents=True, exist_ok=True)
        gql_path = gql_dir / "schema.graphql"
        gql_path.write_text(
            "type Query {\n  things: [Thing!]!\n}\n"
            "type Thing {\n  id: ID!\n  name: String!\n}\n",
            encoding="utf-8",
        )
        rel = gql_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        gql_entries = [e for e in result["entries"] if e["source"] == "graphql_api"]
        self.assertTrue(
            any("defines:" in e["relationship"] for e in gql_entries),
            f"expected defines: entry; got {gql_entries}",
        )

    def test_frontend_module_source_emits_when_module_federation_in_intended(self) -> None:
        # Seed a synthetic module-federation.config.ts + run compute.
        mod_dir = self.repo / "web" / "modules" / "foo"
        mod_dir.mkdir(parents=True, exist_ok=True)
        mf_path = mod_dir / "module-federation.config.ts"
        mf_path.write_text(
            "export default {\n"
            "  name: 'foo',\n"
            "  exposes: {\n"
            "    './FooModule': './src/FooModule.tsx',\n"
            "    './FooRoutes': './src/FooRoutes.tsx',\n"
            "  },\n"
            "  remotes: {\n"
            "    'shell': 'shell@http://localhost:4200/remoteEntry.js',\n"
            "  },\n"
            "};\n",
            encoding="utf-8",
        )
        rel = mf_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        mf_entries = [e for e in result["entries"] if e["source"] == "frontend_module"]
        exposed = [e for e in mf_entries if "exposes:" in e["relationship"]]
        consumed = [e for e in mf_entries if "consumes:" in e["relationship"]]
        self.assertTrue(exposed, f"expected exposes entry; got {mf_entries}")
        self.assertTrue(consumed, f"expected consumes entry; got {mf_entries}")

    def test_graphql_api_source_picks_up_code_first_resolver(self) -> None:
        # Plan 019 Phase 9.5 (operator critique #7) — repo uses code-first
        # GraphQL: @Resolver/@Query/@Mutation decorators on plain *.ts
        # files (no .resolver.ts naming). The widened glob must catch
        # apps/**/*.ts that carries any of these decorators.
        svc_dir = self.repo / "apps" / "foo-service" / "src" / "farm"
        svc_dir.mkdir(parents=True, exist_ok=True)
        resolver_path = svc_dir / "farm.controller.ts"
        resolver_path.write_text(
            "import { Resolver, Query, Mutation } from '@nestjs/graphql';\n"
            "@Resolver(() => Farm)\n"
            "export class FarmController {\n"
            "  @Query(() => [Farm])\n"
            "  async farms(): Promise<Farm[]> { return []; }\n"
            "  @Mutation(() => Farm)\n"
            "  async createFarm(input: any): Promise<Farm> { return null!; }\n"
            "}\n",
            encoding="utf-8",
        )
        rel = resolver_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        gql_entries = [e for e in result["entries"] if e["source"] == "graphql_api"]
        self.assertTrue(gql_entries, f"expected graphql_api entries on code-first resolver; got {result['entries']}")

    def test_graphql_api_source_skips_non_decorator_apps_ts(self) -> None:
        # An apps/**/*.ts file with NO GraphQL decorator must NOT trigger
        # the graphql_api source (otherwise every backend file would
        # match — false positive flood).
        svc_dir = self.repo / "apps" / "foo-service" / "src" / "util"
        svc_dir.mkdir(parents=True, exist_ok=True)
        utility_path = svc_dir / "logger.ts"
        utility_path.write_text(
            "export class Logger { log(msg: string): void {} }\n",
            encoding="utf-8",
        )
        rel = utility_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        gql_entries = [e for e in result["entries"] if e["source"] == "graphql_api"]
        self.assertEqual(gql_entries, [],
                         f"expected zero graphql_api entries on non-decorator ts; got {gql_entries}")

    def test_frontend_module_source_picks_up_vite_config(self) -> None:
        # Plan 019 Phase 9.5 (operator critique #7) — snowball web/ uses
        # vite.config.ts as primary build config. The widened glob must
        # catch *.vite.config.ts paths in addition to module-federation.
        mod_dir = self.repo / "web" / "shared-ui"
        mod_dir.mkdir(parents=True, exist_ok=True)
        vite_path = mod_dir / "vite.config.ts"
        vite_path.write_text(
            "import { federation } from '@module-federation/vite';\n"
            "export default {\n"
            "  plugins: [federation({\n"
            "    name: 'shared-ui',\n"
            "    exposes: {\n"
            "      './Button': './src/Button.tsx',\n"
            "    },\n"
            "  })],\n"
            "};\n",
            encoding="utf-8",
        )
        rel = vite_path.relative_to(self.repo).as_posix()
        result = compute_recursive_impact(
            intended_files=[rel],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        mf_entries = [e for e in result["entries"] if e["source"] == "frontend_module"]
        self.assertTrue(mf_entries, f"expected frontend_module entry on vite.config.ts; got {result['entries']}")


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


class EventContractSourceTests(unittest.TestCase):
    """Plan 017 Phase 5.2 — event_contract source replaces the stub."""

    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        _write_repo_identity(self.tools, self.repo)
        # Seed an event-contract file with a BaseEvent interface and a consumer.
        contract_dir = self.repo / "libs" / "event-contracts" / "src"
        contract_dir.mkdir(parents=True, exist_ok=True)
        (contract_dir / "base-event.ts").write_text(
            "export interface BaseEvent { eventId: string; }\n", encoding="utf-8"
        )
        (contract_dir / "farm-events.ts").write_text(
            "import { BaseEvent } from './base-event';\n"
            "export interface FarmHarvestedEvent extends BaseEvent { batchId: string; }\n"
            "export interface FarmStockedEvent extends BaseEvent { ponds: string[]; }\n",
            encoding="utf-8",
        )
        consumer_dir = self.repo / "apps" / "farm-service" / "src"
        consumer_dir.mkdir(parents=True, exist_ok=True)
        (consumer_dir / "consumer.ts").write_text(
            "import { FarmHarvestedEvent } from '../../libs/event-contracts/src/farm-events';\n"
            "function handle(e: FarmHarvestedEvent) {}\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_event_contract_emits_known_entries(self) -> None:
        result = compute_recursive_impact(
            intended_files=["libs/event-contracts/src/farm-events.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
            max_depth=1,
        )
        # event_contract source must produce at least:
        # - 1 defines:* entry for the source file
        # - 1 consumes:FarmHarvestedEvent entry for the consumer
        ec_entries = [e for e in result["entries"] if e["source"] == "event_contract"]
        self.assertGreaterEqual(len(ec_entries), 2, ec_entries)
        relationships = {e["relationship"] for e in ec_entries}
        self.assertTrue(any(r.startswith("defines:") for r in relationships), ec_entries)
        self.assertTrue(any(r.startswith("consumes:") for r in relationships), ec_entries)
        # All event_contract entries are known status (no stubs).
        for e in ec_entries:
            self.assertEqual(e["status"], "known", e)

    def test_event_contract_skips_non_contract_files(self) -> None:
        result = compute_recursive_impact(
            intended_files=["apps/farm-service/src/consumer.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        ec_entries = [e for e in result["entries"] if e["source"] == "event_contract"]
        # No event-contract file in intended; source emits zero entries
        # (no spurious unknown stub).
        self.assertEqual(ec_entries, [])


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

    def test_governance_event_carries_phase_7_5_fields(self) -> None:
        # Plan 019 Phase 7.5 — operator critique #6 made the governance
        # event the SSoT for impact-graph summaries (the local
        # impact-graphs/*.json directory is gitignored runtime artifact).
        # The event must carry source_breakdown + intended_files +
        # known_count + explicitly_blocked_count alongside the original
        # fingerprint + entry_count + unknown_count.
        compute_recursive_impact(
            intended_files=["apps/foo-service/src/x.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        events = [
            json.loads(line) for line in gov if line.strip()
        ]
        impact_events = [e for e in events if e.get("kind") == "impact_graph_computed"]
        self.assertGreaterEqual(len(impact_events), 1)
        latest = impact_events[-1]
        details = latest.get("details", {})
        # Phase 7.5 added fields:
        self.assertIn("source_breakdown", details)
        self.assertIsInstance(details["source_breakdown"], dict)
        self.assertIn("known_count", details)
        self.assertIn("explicitly_blocked_count", details)
        self.assertIn("intended_files", details)
        self.assertEqual(details["intended_files"], ["apps/foo-service/src/x.ts"])
        # Plan 016 D1 baseline fields preserved:
        self.assertIn("fingerprint", details)
        self.assertIn("entry_count", details)
        self.assertIn("unknown_count", details)
        self.assertIn("max_depth_reached", details)


if __name__ == "__main__":
    unittest.main()
