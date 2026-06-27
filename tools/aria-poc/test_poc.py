#!/usr/bin/env python3
"""Unit tests for the ARIA Phase-1 PoC.

Stdlib-only on purpose: the PoC must remain runnable before the full repo's
Node/Python dependency graph is healthy.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


POC_PATH = Path(__file__).with_name("poc.py")
SPEC = importlib.util.spec_from_file_location("aria_poc", POC_PATH)
assert SPEC and SPEC.loader
aria_poc = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = aria_poc
SPEC.loader.exec_module(aria_poc)


class AriaPocTests(unittest.TestCase):
    def test_walk_repo_includes_github_but_excludes_git(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".github" / "workflows").mkdir(parents=True)
            (root / ".github" / "workflows" / "ci.yml").write_text("name: ci\n", encoding="utf-8")
            (root / ".git").write_text("gitdir: /tmp/real\n", encoding="utf-8")

            rels = {str(p.relative_to(root)) for p in aria_poc.walk_repo(root)}

        self.assertIn(".github/workflows/ci.yml", rels)
        self.assertNotIn(".git", rels)

    def test_detect_ts_union_types_extracts_literal_value_set(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src = root / "web" / "modules" / "farm-module" / "src" / "types.ts"
            src.parent.mkdir(parents=True)
            src.write_text(
                "export type FarmStatus = 'active' | 'inactive' | 'archived';\n",
                encoding="utf-8",
            )
            fates = [aria_poc.FileFate(str(src.relative_to(root)), "read_deeply")]

            unions = aria_poc.detect_ts_union_types(root, fates)

        self.assertEqual(len(unions), 1)
        self.assertEqual(unions[0]["kind"], "union")
        self.assertEqual(unions[0]["name"], "FarmStatus")
        self.assertEqual(unions[0]["values"], ["active", "archived", "inactive"])

    def test_detect_rust_enums_extracts_all_variant_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src = root / "sens-api-gateway" / "src" / "protocol.rs"
            src.parent.mkdir(parents=True)
            src.write_text(
                "pub enum ProtocolState {\n"
                "    Idle,\n"
                "    Connected(SocketAddr),\n"
                "    #[serde(rename = \"err\")]\n"
                "    Failed { code: u8, msg: String },\n"
                "    Retrying = 3,\n"
                "}\n",
                encoding="utf-8",
            )
            fates = [aria_poc.FileFate(str(src.relative_to(root)), "read_deeply")]

            enums = aria_poc.detect_rust_enums(root, fates)

        self.assertEqual(len(enums), 1)
        self.assertEqual(enums[0]["name"], "ProtocolState")
        self.assertEqual(enums[0]["kind"], "rust_enum")
        self.assertEqual(enums[0]["values"], ["Connected", "Failed", "Idle", "Retrying"])
        self.assertEqual(enums[0]["surface"], "edge_source")

    def test_detect_rust_enums_skips_tests_and_handles_generics(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            gen = root / "crates" / "codec" / "src" / "msg.rs"
            gen.parent.mkdir(parents=True)
            gen.write_text("enum Wrap<T> { One(Vec<T>), Two }\n", encoding="utf-8")
            test = root / "crates" / "codec" / "tests" / "it.rs"
            test.parent.mkdir(parents=True)
            test.write_text("enum Helper { A, B }\n", encoding="utf-8")
            fates = [
                aria_poc.FileFate(str(gen.relative_to(root)), "read_deeply"),
                aria_poc.FileFate(str(test.relative_to(root)), "read_deeply"),
            ]

            enums = aria_poc.detect_rust_enums(root, fates)

        names = {e["name"] for e in enums}
        self.assertIn("Wrap", names)
        self.assertNotIn("Helper", names)  # /tests/ path is skipped
        wrap = next(e for e in enums if e["name"] == "Wrap")
        self.assertEqual(wrap["values"], ["One", "Two"])

    def test_detect_ui_option_groups_records_status_select(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src = root / "web" / "modules" / "farm-module" / "src" / "FarmStatusSelect.tsx"
            src.parent.mkdir(parents=True)
            src.write_text(
                """
export function FarmStatusSelect() {
  return <select name="farmStatus">
    <option value="active">Active</option>
    <option value="inactive">Inactive</option>
    <option value="archived">Archived</option>
  </select>;
}
""",
                encoding="utf-8",
            )
            fates = [aria_poc.FileFate(str(src.relative_to(root)), "read_deeply")]

            groups = aria_poc.detect_ui_option_groups(root, fates)

        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["name"], "farmStatus")
        self.assertEqual(groups[0]["values"], ["active", "archived", "inactive"])
        self.assertEqual(groups[0]["surface"], "frontend_ui")

    def test_service_of_classifies_web_apps_before_apps(self) -> None:
        ref = "web/apps/aquamobil/src/features/tasks/TaskStatusSelect.tsx:12"

        service = aria_poc.service_of(ref)

        self.assertEqual(service, "web/apps/aquamobil")

    def test_frontend_dropdown_drift_requires_safe_concept_and_overlap(self) -> None:
        ts_sets = [{
            "name": "FarmStatus",
            "values": ["active", "inactive", "archived", "maintenance"],
            "ref": "web/modules/farm-module/src/types.ts:1",
            "kind": "union",
        }]
        sql_enums: list[dict] = []
        ui_groups = [{
            "name": "farmStatus",
            "component": "FarmStatusSelect",
            "values": ["active", "inactive", "archived"],
            "ref": "web/modules/farm-module/src/FarmStatusSelect.tsx:2",
            "kind": "ui_option_group",
            "source": "select",
        }]

        drifts = aria_poc.find_frontend_dropdown_drifts(ts_sets, sql_enums, ui_groups)

        self.assertEqual(len(drifts), 1)
        self.assertEqual(drifts[0]["claim_type"], "frontend_dropdown_drift")
        self.assertEqual(drifts[0]["missing_in_ui"], ["maintenance"])
        self.assertEqual(drifts[0]["relationship"], "normalized_name_match")

    def test_frontend_dropdown_drift_does_not_promote_generic_timezone_select(self) -> None:
        ts_sets = [{
            "name": "FarmStatus",
            "values": ["active", "inactive", "archived"],
            "ref": "web/modules/farm-module/src/types.ts:1",
            "kind": "union",
        }]
        ui_groups = [{
            "name": "timezone",
            "component": "SettingsPage",
            "values": ["UTC", "Europe/Istanbul", "America/New_York"],
            "ref": "web/shell/src/pages/SettingsPage.tsx:10",
            "kind": "ui_option_group",
            "source": "select",
        }]

        drifts = aria_poc.find_frontend_dropdown_drifts(ts_sets, [], ui_groups)

        self.assertEqual(drifts, [])

    def test_leave_filter_status_matches_leave_request_status_by_tokens(self) -> None:
        ts_sets = [{
            "name": "LeaveRequestStatus",
            "values": ["pending", "approved", "rejected", "cancelled"],
            "ref": "web/modules/hr-module/src/types.ts:1",
            "kind": "union",
            "surface": "frontend_source",
        }]
        ui_groups = [{
            "name": "leave-filter-status",
            "component": "LeaveFilters",
            "values": ["pending", "approved", "rejected"],
            "ref": "web/modules/hr-module/src/LeaveFilters.tsx:2",
            "kind": "ui_option_group",
            "source": "select",
            "surface": "frontend_ui",
        }]

        drifts = aria_poc.find_frontend_dropdown_drifts(ts_sets, [], ui_groups)

        self.assertEqual(len(drifts), 1)
        self.assertEqual(drifts[0]["relationship"], "shared_concept_tokens:leave")
        self.assertEqual(drifts[0]["missing_in_ui"], ["cancelled"])

    def test_edge_online_options_do_not_match_status_by_value_overlap_alone(self) -> None:
        ts_sets = [{
            "name": "PlcConnectionStatus",
            "values": ["online", "offline", "unknown"],
            "ref": "apps/sensor-service/src/plc.ts:1",
            "kind": "enum",
            "surface": "backend_app",
        }]
        ui_groups = [{
            "name": "edgeOnlineOptions",
            "component": "EdgeStatusFilter",
            "values": ["online", "offline"],
            "ref": "web/modules/dashboard/src/EdgeFilter.tsx:2",
            "kind": "ui_option_group",
            "source": "const_options",
            "surface": "frontend_ui",
        }]

        annotated, drifts = aria_poc.annotate_ui_option_groups(ts_sets, [], ui_groups)

        self.assertEqual(drifts, [])
        self.assertEqual(annotated[0]["promotion_reason"], "no_related_value_set")

    def test_ui_option_groups_ignore_e2e_test_constants(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src = root / "e2e" / "tests" / "billing.spec.ts"
            src.parent.mkdir(parents=True)
            src.write_text(
                "const validStatuses = ['ACTIVE', 'CANCELLED', 'TRIAL'];\n",
                encoding="utf-8",
            )
            fates = [aria_poc.FileFate(str(src.relative_to(root)), "read_deeply")]

            groups = aria_poc.detect_ui_option_groups(root, fates)
            unions = aria_poc.detect_ts_union_types(root, fates)

        self.assertEqual(groups, [])
        self.assertEqual(unions, [])

    def test_ui_option_groups_ignore_backend_and_migration_surfaces(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            backend = root / "apps" / "gateway-api" / "src" / "websocket" / "StatusPanel.tsx"
            migration = root / "apps" / "farm-service" / "src" / "database" / "migrations" / "1-status.tsx"
            backend.parent.mkdir(parents=True)
            migration.parent.mkdir(parents=True)
            body = """
export function StatusPanel() {
  return <select name="farmStatus">
    <option value="active">Active</option>
    <option value="inactive">Inactive</option>
  </select>;
}
"""
            backend.write_text(body, encoding="utf-8")
            migration.write_text(body, encoding="utf-8")
            fates = [
                aria_poc.FileFate(str(backend.relative_to(root)), "read_deeply"),
                aria_poc.FileFate(str(migration.relative_to(root)), "read_deeply"),
            ]

            groups = aria_poc.detect_ui_option_groups(root, fates)

        self.assertEqual(groups, [])

    def test_const_array_zod_and_graphql_extractors(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            ts = root / "libs" / "shared" / "src" / "status.ts"
            gql = root / "apps" / "gateway-api" / "src" / "schema.graphql"
            ts.parent.mkdir(parents=True)
            gql.parent.mkdir(parents=True)
            ts.write_text(
                """
export const FarmStatusValues = ['active', 'inactive', 'maintenance'] as const;
export const AlertSeveritySchema = z.enum(['low', 'medium', 'high']);
""",
                encoding="utf-8",
            )
            gql.write_text(
                """
enum TicketPriority {
  LOW
  MEDIUM
  HIGH
}
""",
                encoding="utf-8",
            )
            fates = [
                aria_poc.FileFate(str(ts.relative_to(root)), "read_deeply"),
                aria_poc.FileFate(str(gql.relative_to(root)), "read_deeply"),
            ]

            const_arrays = aria_poc.detect_ts_const_arrays(root, fates)
            zod_enums = aria_poc.detect_zod_enums(root, fates)
            graphql_enums = aria_poc.detect_graphql_enums(root, fates)

        self.assertEqual(const_arrays[0]["kind"], "const_array")
        self.assertEqual(const_arrays[0]["values"], ["active", "inactive", "maintenance"])
        self.assertEqual(zod_enums[0]["kind"], "zod_enum")
        self.assertEqual(zod_enums[0]["values"], ["high", "low", "medium"])
        self.assertEqual(graphql_enums[0]["kind"], "graphql_enum")
        self.assertEqual(graphql_enums[0]["values"], ["HIGH", "LOW", "MEDIUM"])

    def test_git_blame_gracefully_degrades_outside_git(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src = root / "web" / "modules" / "farm-module" / "src" / "types.ts"
            src.parent.mkdir(parents=True)
            src.write_text("export type FarmStatus = 'active' | 'inactive';\n", encoding="utf-8")

            blame = aria_poc.git_blame_ref(root, "web/modules/farm-module/src/types.ts:1")

        self.assertFalse(blame["available"])


if __name__ == "__main__":
    unittest.main()
