"""ARIA drift scan compares what actually travels, per transport.

The scan used to lower-case every value, record TS enum KEYS only, ignore
``registerEnumType`` and the composed supergraph, and call every UI-vs-
backend pair cross-service because ownership was a path prefix. That made
it report the farm-module FARM_* finance scope subset (HR_EXPENSE belongs
to hr-service) as a HIGH drift, and normalise away the hr-module leave
filter sending lower-case ``pending`` where the GraphQL wire carries the
UPPER-case keys of ``LeaveRequestStatus``.

These fixtures are small repositories: a registered entity enum, a UI
select, the module's GraphQL operation, the subgraph registry and a
composed supergraph excerpt in the shape ``@apollo/composition`` prints.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_POC_PATH = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
_SPEC = importlib.util.spec_from_file_location("aria_poc_for_wire_semantics", _POC_PATH)
assert _SPEC and _SPEC.loader
aria_poc = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = aria_poc
_SPEC.loader.exec_module(aria_poc)


SUBGRAPHS = {
    "subgraphs": [
        {"name": "farm", "nxProject": "farm-service"},
        {"name": "hr", "nxProject": "hr-service"},
    ],
}

SUPERGRAPH = '''
enum join__Graph {
  FARM @join__graph(name: "farm", url: "http://farm-service:3000/graphql")
  HR @join__graph(name: "hr", url: "http://hr-service:3000/graphql")
}

"""Which farm finance ledger a category belongs to"""
enum FinanceCategoryScope
  @join__type(graph: FARM)
{
  FARM_OPEX @join__enumValue(graph: FARM)
  FARM_REVENUE @join__enumValue(graph: FARM)
}

enum LeaveRequestStatus
  @join__type(graph: HR)
{
  DRAFT @join__enumValue(graph: HR)
  PENDING @join__enumValue(graph: HR)
  APPROVED @join__enumValue(graph: HR)
  REJECTED @join__enumValue(graph: HR)
  CANCELLED @join__enumValue(graph: HR)
  WITHDRAWN @join__enumValue(graph: HR)
}

type Query
  @join__type(graph: FARM)
  @join__type(graph: HR)
{
  """Finance categories of the tenant"""
  financeCategories(scope: FinanceCategoryScope): [FinanceCategory!]! @join__field(graph: FARM)
  leaveRequests(employeeId: ID, status: LeaveRequestStatus, page: Int): LeaveRequestPage! @join__field(graph: HR)
}
'''

LEAVE_ENTITY = """
import { registerEnumType } from '@nestjs/graphql';

export enum LeaveRequestStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  WITHDRAWN = 'withdrawn',
}

registerEnumType(LeaveRequestStatus, { name: 'LeaveRequestStatus' });
"""

FINANCE_ENTITY = """
import { registerEnumType } from '@nestjs/graphql';

export enum FinanceCategoryScope {
  FARM_OPEX = 'FARM_OPEX',
  FARM_REVENUE = 'FARM_REVENUE',
}

registerEnumType(FinanceCategoryScope, {
  name: 'FinanceCategoryScope',
  description: 'Which farm finance ledger a category belongs to',
});
"""


def _select(element_id: str, values: list[str]) -> str:
    options = "\n".join(f"        {{ value: '{v}', label: '{v}' }}," for v in values)
    return (
        "export default function Page() {\n"
        "  return (\n"
        "    <Select\n"
        "      options={[\n"
        "        { value: '', label: 'All' },\n"
        f"{options}\n"
        "      ]}\n"
        f"      id=\"{element_id}\"\n"
        "      onChange={(e) => setValue(e.target.value)}\n"
        "    />\n"
        "  );\n"
        "}\n"
    )


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _repo(root: Path, *, with_supergraph: bool = True) -> None:
    _write(root, "infrastructure/apollo-router/subgraphs.json", json.dumps(SUBGRAPHS))
    if with_supergraph:
        _write(root, "dist/graphql/supergraph.graphql", SUPERGRAPH)
    _write(root, "apps/hr-service/src/leave/entities/leave-request.entity.ts", LEAVE_ENTITY)
    _write(root, "apps/farm-service/src/finance/entities/finance-category.entity.ts", FINANCE_ENTITY)
    _write(
        root, "apps/hr-service/src/finance/handlers/hr-finance-entry.handlers.ts",
        "export const scopeOf = () => ({ scope: 'HR_EXPENSE' });\n",
    )
    _write(
        root, "libs/event-contracts/src/finance-events.ts",
        "export type FinanceScope = 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';\n",
    )
    _write(
        root, "web/modules/hr-module/src/graphql/leave.operations.ts",
        "export const GET_LEAVE_REQUESTS = gql`\n"
        "  query GetLeaveRequests($status: LeaveRequestStatus, $page: Int) {\n"
        "    leaveRequests(status: $status, page: $page) {\n"
        "      items { ...LeaveRequestFull }\n"
        "      total\n"
        "    }\n"
        "  }\n"
        "  ${LEAVE_REQUEST_FRAGMENT}\n"
        "`;\n",
    )
    _write(
        root, "web/modules/farm-module/src/hooks/useFinance.ts",
        "const FINANCE_CATEGORIES = `\n"
        "  query FinanceCategories($scope: FinanceCategoryScope) {\n"
        "    categories: financeCategories(scope: $scope) { id code }\n"
        "  }\n"
        "`;\n",
    )


def _fates(root: Path) -> list:
    return [
        aria_poc.FileFate(str(p.relative_to(root)), "read_deeply")
        for p in sorted(root.rglob("*")) if p.is_file()
    ]


def _scan(root: Path) -> tuple[list[dict], list[dict], object]:
    fates = _fates(root)
    sources = [
        *aria_poc.detect_ts_enums(root, fates),
        *aria_poc.detect_ts_union_types(root, fates),
    ]
    groups = aria_poc.detect_ui_option_groups(root, fates)
    wire = aria_poc.load_wire(root, fates)
    annotated, drifts = aria_poc.annotate_ui_option_groups(sources, [], groups, wire=wire)
    return annotated, drifts, wire


class DriftWireSemantics(unittest.TestCase):
    def test_ts_enum_records_keys_values_and_graphql_exposure(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _repo(root)
            enums = aria_poc.detect_ts_enums(root, _fates(root))
        leave = next(e for e in enums if e["name"] == "LeaveRequestStatus")
        self.assertEqual(leave["keys"], [
            "APPROVED", "CANCELLED", "DRAFT", "PENDING", "REJECTED", "WITHDRAWN",
        ])
        self.assertEqual(leave["values"], [
            "approved", "cancelled", "draft", "pending", "rejected", "withdrawn",
        ])
        self.assertEqual(leave["graphql_name"], "LeaveRequestStatus")

    def test_lowercase_ui_value_against_registered_enum_is_not_on_wire(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _repo(root)
            _write(
                root, "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
                _select("leave-filter-status", ["pending", "approved", "rejected", "cancelled"]),
            )
            _annotated, drifts, _wire = _scan(root)
        self.assertEqual(len(drifts), 1, drifts)
        drift = drifts[0]
        self.assertEqual(drift["classification"], "ui_value_not_on_wire")
        self.assertEqual(drift["severity"], "HIGH")
        self.assertEqual(drift["transport"], "graphql")
        self.assertEqual(drift["missing_in_source"], ["approved", "cancelled", "pending", "rejected"])
        self.assertIs(drift["cross_service"], False)

    def test_hr_module_against_hr_service_is_not_cross_service(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _repo(root)
            _write(
                root, "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
                _select("leave-filter-status", ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]),
            )
            _annotated, drifts, _wire = _scan(root)
        self.assertEqual(len(drifts), 1, drifts)
        drift = drifts[0]
        self.assertIs(drift["cross_service"], False)
        self.assertEqual(drift["ui_backends"], ["apps/hr-service"])
        self.assertEqual(drift["classification"], "own_service_subset")
        self.assertEqual(drift["severity"], "LOW")
        self.assertEqual(drift["missing_in_ui"], ["DRAFT", "WITHDRAWN"])

    def test_subset_whose_missing_values_belong_to_another_service_is_no_finding(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _repo(root)
            _write(
                root, "web/modules/farm-module/src/pages/finance/components/CategoriesTab.tsx",
                _select("new-category-scope", ["FARM_OPEX", "FARM_REVENUE"]),
            )
            annotated, drifts, _wire = _scan(root)
        self.assertEqual(drifts, [])
        group = next(g for g in annotated if g["name"] == "new-category-scope")
        self.assertEqual(group["promotion_reason"], "matches_related_value_set")
        verdicts = {v["source_name"]: v["verdict"] for v in group["wire_verdicts"]}
        self.assertEqual(verdicts["FinanceScope"], "foreign_service_subset")
        self.assertEqual(verdicts["FinanceCategoryScope"], "match")

    def test_missing_supergraph_fails_closed_with_named_reason(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _repo(root, with_supergraph=False)
            _write(
                root, "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
                _select("leave-filter-status", ["pending", "approved", "rejected", "cancelled"]),
            )
            annotated, drifts, wire = _scan(root)
        self.assertEqual(drifts, [])
        self.assertEqual(wire.status, "unavailable")
        self.assertEqual(wire.reason, "supergraph_not_found")
        group = next(g for g in annotated if g["name"] == "leave-filter-status")
        self.assertEqual(group["promotion_reason"], "wire_unverifiable:supergraph_not_found")

    def test_db_comparison_uses_enum_values_exactly(self) -> None:
        ts = [{
            "name": "BatchStatus", "keys": ["ACTIVE", "CLOSED"], "values": ["ACTIVE", "CLOSED"],
            "ref": "apps/farm-service/src/batch/batch.entity.ts:3", "kind": "enum",
            "surface": "backend_app",
        }]
        sql = [{
            "name": "batch_status", "values": ["active", "closed"],
            "ref": "apps/farm-service/src/database/migrations/1-batch.ts:9", "kind": "sql_enum",
            "surface": "migration",
        }]
        above, _filtered = aria_poc.find_drifts(ts, sql)
        self.assertEqual(len(above), 1)
        self.assertEqual(above[0]["missing_in_sql"], ["ACTIVE", "CLOSED"])
        self.assertEqual(above[0]["classification"], "ts_value_not_in_db")
        self.assertEqual(above[0]["severity"], "HIGH")
        self.assertIs(above[0]["cross_service"], False)


if __name__ == "__main__":
    unittest.main()
