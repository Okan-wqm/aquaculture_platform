"""ARIA-HIGH-397 — a plan converges only on module specifiers its projects can resolve.

Three layers, each pinned here:

* the kernel reads the specifiers a plan's key changes prescribe and
  attributes them to the key change's own source files;
* the witness asks the repository's TypeScript, with the plan's planned files
  overlaid, and a missing toolchain is ``environment_unable``, never
  "resolved";
* the evaluator refuses CONVERGED by name while a prescribed specifier is
  unresolved, unchecked or uncheckable.

The measured case is F-015 (2026-10-08): a converged plan prescribed
``@platform/shared-ui/generated/graphql-types`` in hr-module, whose tsconfig
maps no such alias; the implementer met TS2307 and refused the plan.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.plan_convergence import _validate_cross_review_risk, evaluate_plan, record_coverage
from aria_kernel.plan_import_resolution import (
    VERDICT_ENVIRONMENT_UNABLE,
    VERDICT_NOT_APPLICABLE,
    VERDICT_RESOLVED,
    VERDICT_UNRESOLVED,
    compute_import_resolution,
    prescribed_imports,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.node_modules import REPO_ROOT, installed_node_modules
from tests.test_plan_coverage_gate import PlanCoverageGateTests

PRESCRIBING_CHANGE = {
    "id": "kc-1",
    "description": "In leave.types.ts add `import type { Status } from '@lib/status';` and, in the page, "
                   "`import { STATUSES } from '../types'`.",
    "paths": ["mod-b/src/types/leave.types.ts", "docs/notes.md"],
}


class PrescribedImportsAreReadFromKeyChanges(unittest.TestCase):
    def test_specifiers_are_attributed_to_the_key_changes_source_files_only(self) -> None:
        found = prescribed_imports({"key_changes": [PRESCRIBING_CHANGE]})
        self.assertEqual(
            [(item["specifier"], item["from_path"], item["key_change_id"]) for item in found],
            [("@lib/status", "mod-b/src/types/leave.types.ts", "kc-1"),
             ("../types", "mod-b/src/types/leave.types.ts", "kc-1")],
        )

    def test_every_prescription_form_is_read(self) -> None:
        text = ("import 'side-effect'; const a = await import('dyn'); const b = require('cjs'); "
                "export { c } from \"reexport\";")
        found = prescribed_imports({"key_changes": [{"id": "k", "description": text, "paths": ["a/x.ts"]}]})
        self.assertEqual(sorted(item["specifier"] for item in found), ["cjs", "dyn", "reexport", "side-effect"])

    def test_a_key_change_without_source_files_prescribes_nothing(self) -> None:
        self.assertEqual(prescribed_imports({"key_changes": [
            {"id": "k", "description": "from '@lib/status'", "paths": ["docs/a.md"]}, "a string change",
        ]}), [])
        self.assertEqual(prescribed_imports(None), [])


def _fixture_repo(root: Path) -> Path:
    """Two projects: mod-a maps `@lib/*`, mod-b does not (the hr-module shape)."""
    files = {
        "package.json": json.dumps({"name": "imports-fixture", "private": True}),
        "lib/src/status.ts": "export type Status = 'A' | 'B';\n",
        "mod-a/tsconfig.json": json.dumps({"compilerOptions": {
            "moduleResolution": "bundler", "module": "ESNext", "baseUrl": ".", "paths": {"@lib/*": ["../lib/src/*"]},
        }}),
        "mod-a/src/a.ts": "export const a = 1;\n",
        "mod-b/tsconfig.json": json.dumps({"compilerOptions": {
            "moduleResolution": "bundler", "module": "ESNext", "baseUrl": ".", "paths": {"@/*": ["src/*"]},
        }}),
        "mod-b/src/types/leave.types.ts": "export const b = 1;\n",
        "mod-b/src/types/index.ts": "export const STATUSES = [];\n",
    }
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for relative in ("tools/gates/plan-import-witness.ts", "tools/gates/tsconfig.json"):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((REPO_ROOT / relative).read_bytes())
    return root


class TheWitnessAsksTheRepositorysTypescript(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-imports-")
        self.addCleanup(tmp.cleanup)
        self.repo = _fixture_repo(Path(tmp.name) / "repo")
        self.input = Path(tmp.name) / "input.json"

    def _link_node_modules(self) -> None:
        (self.repo / "node_modules").symlink_to(installed_node_modules("typescript", "ts-node"),
                                                target_is_directory=True)

    def _compute(self, key_changes: list, *, round_number: int = 1) -> tuple[dict, list]:
        return compute_import_resolution(plan_content={"key_changes": key_changes}, round_number=round_number,
                                         workspace_root=self.repo, input_path=self.input)

    def test_the_f015_shape_is_unresolved_in_the_project_without_the_alias(self) -> None:
        self._link_node_modules()
        block, risks = self._compute([
            {"id": "kc-a", "description": "import type { Status } from '@lib/status'", "paths": ["mod-a/src/a.ts"]},
            PRESCRIBING_CHANGE,
        ])
        self.assertEqual(block["verdict"], VERDICT_UNRESOLVED, block)
        self.assertEqual(block["checked"], 3)
        self.assertEqual([(item["specifier"], item["project_config"]) for item in block["unresolved"]],
                         [("@lib/status", "mod-b/tsconfig.json")])
        self.assertTrue(block["witness"]["typescript_version"])
        self.assertEqual(len(risks), 1)
        _validate_cross_review_risk(risks[0])
        self.assertTrue(risks[0]["risk_id"].startswith("IMP-R1-"))
        self.assertEqual(risks[0]["severity"], "material")
        self.assertEqual(risks[0]["affected_files"], ["mod-b/src/types/leave.types.ts", "mod-b/tsconfig.json"])

    def test_a_file_the_plan_creates_resolves(self) -> None:
        self._link_node_modules()
        block, risks = self._compute([{"id": "kc-new", "description": "import { x } from './fresh'",
                                       "paths": ["mod-b/src/types/leave.types.ts", "mod-b/src/types/fresh.ts"]}])
        self.assertEqual((block["verdict"], block["config_planned"], risks), (VERDICT_RESOLVED, [], []), block)

    def test_a_project_whose_config_the_plan_changes_is_the_plans_to_make_true(self) -> None:
        self._link_node_modules()
        block, risks = self._compute([{"id": "kc-cfg", "description": "import type { Status } from '@lib/status'",
                                       "paths": ["mod-b/src/types/leave.types.ts", "mod-b/tsconfig.json"]}])
        self.assertEqual(block["verdict"], VERDICT_RESOLVED, block)
        self.assertEqual([(item["specifier"], item["project_config"]) for item in block["config_planned"]],
                         [("@lib/status", "mod-b/tsconfig.json")])
        self.assertEqual(risks, [])

    def test_no_repository_typescript_is_environment_unable(self) -> None:
        block, risks = self._compute([PRESCRIBING_CHANGE])
        self.assertEqual(block["verdict"], VERDICT_ENVIRONMENT_UNABLE)
        self.assertIn("toolchain_missing", block["reason"])
        self.assertEqual(risks, [])

    def test_a_typescript_from_outside_the_checkout_is_refused(self) -> None:
        # ts-node present, typescript absent from the checkout's node_modules:
        # the witness must not fall back to any other copy.
        installed = installed_node_modules("typescript", "ts-node")
        modules = self.repo / "node_modules"
        (modules / ".bin").mkdir(parents=True)
        (modules / ".bin" / "ts-node").symlink_to(installed / ".bin" / "ts-node")
        block, _risks = self._compute([PRESCRIBING_CHANGE])
        self.assertEqual(block["verdict"], VERDICT_ENVIRONMENT_UNABLE, block)

    def test_a_plan_that_prescribes_nothing_runs_no_witness(self) -> None:
        block, risks = self._compute([{"id": "k", "description": "rename a column", "paths": ["a/b.ts"]}])
        self.assertEqual((block["verdict"], block["checked"], risks), (VERDICT_NOT_APPLICABLE, 0, []))


class TheEvaluatorRefusesUnresolvedImports(PlanCoverageGateTests):
    """The coverage gate's own fixture, with a body that prescribes an import."""

    def plan(self, schema_version: int, coverage_block: dict | None) -> dict:
        plan = super().plan(schema_version, coverage_block)
        plan["key_changes"] = [{"id": "kc-1", "description": "import { x } from '@lib/x'",
                                "paths": ["libs/farm-shared/src/index.ts"]}]
        return plan

    def _imports(self, verdict: str, *, unresolved: int = 0) -> dict:
        entries = [{"specifier": "@lib/x", "from_path": "libs/farm-shared/src/index.ts", "key_change_id": "kc-1",
                    "project_config": "libs/farm-shared/tsconfig.json", "reason": "module_not_resolved"}][:unresolved]
        from aria_kernel.plan_import_resolution import build_synthetic_risk

        return {"verdict": verdict, "checked": 1, "unresolved": entries, "config_planned": [],
                "witness": {"tool": "tools/gates/plan-import-witness.ts"},
                "synthetic_risks": [build_synthetic_risk(entry, round_number=1) for entry in entries]}

    def _evaluate(self, imports: dict | None, *, max_rounds: int = 2) -> dict:
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        coverage = self.coverage_payload()
        if imports is not None:
            coverage["import_resolution"] = imports
        record_coverage(plan_id="plan-1", coverage=coverage, base_dir=self.tools_dir)
        return evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir, max_rounds=max_rounds)

    def test_resolved_imports_converge(self) -> None:
        payload = self._evaluate(self._imports(VERDICT_RESOLVED))["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "CONVERGED")
        self.assertTrue(self.gate_decision(payload, "prescribed_imports_resolve")["passed"])

    def test_an_unresolved_import_is_a_named_blocker_and_a_material_risk(self) -> None:
        result = self._evaluate(self._imports(VERDICT_UNRESOLVED, unresolved=1))
        self.assertEqual(result["status"], "next_round_required")
        self.assertIn("prescribed_imports_unresolved", result["reason_codes"])
        self.assertIn("material_cross_review_risks_present", result["reason_codes"])

    def test_an_unresolved_import_at_max_rounds_is_human_required(self) -> None:
        payload = self._evaluate(self._imports(VERDICT_UNRESOLVED, unresolved=1), max_rounds=1)["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("prescribed_imports_unresolved", payload["reason_codes"])

    def test_an_unchecked_prescribing_body_is_human_required(self) -> None:
        payload = self._evaluate(None)["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("prescribed_imports_unchecked", payload["reason_codes"])

    def test_an_uncheckable_body_is_human_required(self) -> None:
        imports = {"verdict": VERDICT_ENVIRONMENT_UNABLE, "checked": 1, "unresolved": [], "config_planned": [],
                   "reason": "toolchain_missing", "witness": {}, "synthetic_risks": []}
        payload = self._evaluate(imports)["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("prescribed_imports_environment_unable", payload["reason_codes"])

    def test_an_unresolved_verdict_without_its_risk_is_refused_at_record(self) -> None:
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        coverage = self.coverage_payload()
        coverage["import_resolution"] = {**self._imports(VERDICT_UNRESOLVED, unresolved=1), "synthetic_risks": []}
        with self.assertRaises(GovernanceError):
            record_coverage(plan_id="plan-1", coverage=coverage, base_dir=self.tools_dir)


# The coverage gate's own tests are that suite's; this class borrows its
# fixture only.
for _inherited in [name for name in vars(PlanCoverageGateTests) if name.startswith("test_")]:
    setattr(TheEvaluatorRefusesUnresolvedImports, _inherited, None)
del PlanCoverageGateTests, _inherited

if __name__ == "__main__":
    unittest.main()
