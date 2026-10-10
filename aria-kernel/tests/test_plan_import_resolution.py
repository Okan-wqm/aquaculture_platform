"""ARIA-HIGH-397 — a plan converges only on module specifiers its projects can resolve.

Three layers, each pinned here:

* a key change DECLARES its imports (``imports: [{from_path, specifier}]``,
  bound to its own source files); prose is never parsed;
* the witness asks the repository's TypeScript for the file that imports
  each one, under the project that compiles that file (references and the
  ``extends`` chain included), with the files the key changes write overlaid;
  assets and ambient module declarations are not misjudged; a missing
  toolchain is ``environment_unable``, never "resolved";
* the evaluator judges the body that would CONVERGE (in round 1 the primary,
  never the challenger the closure measured) and refuses CONVERGED by name.

The measured case is F-015 (2026-10-08): a converged plan prescribed
``@platform/shared-ui/generated/graphql-types`` in hr-module, whose tsconfig
maps no such alias; the implementer met TS2307 and refused the plan.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.plan_convergence import (
    _validate_cross_review_risk,
    evaluate_plan,
    fold_plan_state,
    key_change_violation,
    record_coverage,
)
from aria_kernel.plan_import_resolution import (
    VERDICT_ENVIRONMENT_UNABLE,
    VERDICT_NOT_APPLICABLE,
    VERDICT_RESOLVED,
    VERDICT_UNRESOLVED,
    build_synthetic_risk,
    compute_import_resolution,
    import_resolution_for_round,
    planned_paths,
    prescribed_imports,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.node_modules import REPO_ROOT, installed_node_modules
from tests.test_plan_coverage_gate import PlanCoverageGateTests

LEAVE_TYPES = "mod-b/src/types/leave.types.ts"


def change(change_id: str, paths: list[str], *imports: tuple[str, str], description: str = "step") -> dict:
    return {"id": change_id, "description": description, "paths": paths,
            "imports": [{"from_path": from_path, "specifier": specifier} for from_path, specifier in imports]}


class ImportsAreDeclaredNeverParsed(unittest.TestCase):
    def test_only_declared_imports_are_read(self) -> None:
        prose = ("Move the status from 'PENDING' to 'APPROVED'; replace the broken import from 'X' with 'Y'; "
                 "do not import 'lodash'.")
        body = {"key_changes": [
            {"id": "k0", "description": prose, "paths": [LEAVE_TYPES]},
            change("k1", [LEAVE_TYPES, "apps/svc/src/a.ts"], (LEAVE_TYPES, "Y")),
        ]}
        self.assertEqual([(item["specifier"], item["from_path"], item["key_change_id"])
                          for item in prescribed_imports(body)], [("Y", LEAVE_TYPES, "k1")])

    def test_each_import_is_bound_to_one_of_its_changes_own_source_files(self) -> None:
        self.assertIsNone(key_change_violation(change("k", [LEAVE_TYPES], (LEAVE_TYPES, "@lib/status"))))
        for bad in (
            change("k", [LEAVE_TYPES], ("apps/svc/src/a.ts", "x")),       # another change's file
            change("k", ["docs/a.md"], ("docs/a.md", "x")),               # not a source file
            {**change("k", [LEAVE_TYPES]), "imports": [{"from_path": LEAVE_TYPES}]},
            {**change("k", [LEAVE_TYPES]), "imports": [{"from_path": LEAVE_TYPES, "specifier": "a b"}]},
            {**change("k", [LEAVE_TYPES]), "imports": "x"},
        ):
            with self.subTest(bad=bad):
                self.assertIsNotNone(key_change_violation(bad))

    def test_a_source_key_change_must_declare_its_imports_from_contract_2(self) -> None:
        from aria_kernel.plan_contract import PLAN_CONTRACT_SCHEMA_VERSION, plan_contract_violations

        undeclared = {"architectural_tier": 2, "validation_commands": [],
                      "key_changes": [{"id": "k", "description": "d", "paths": [LEAVE_TYPES]}]}
        declared = {**undeclared, "key_changes": [change("k", [LEAVE_TYPES])]}
        self.assertEqual(PLAN_CONTRACT_SCHEMA_VERSION, 2)
        refused = plan_contract_violations(undeclared, base_dir=None, contract_version=2)
        self.assertTrue(any(v.startswith("plan_key_change_imports_undeclared:") for v in refused), refused)
        self.assertEqual(plan_contract_violations(declared, base_dir=None, contract_version=2), [])
        # A plan already in flight (contract 1) and the kernel's own seed are not held to it.
        self.assertEqual(plan_contract_violations(undeclared, base_dir=None, contract_version=1), [])
        self.assertEqual(plan_contract_violations(undeclared, base_dir=None, contract_version=2,
                                                  require_tier=False), [])
        config_only = {**undeclared, "key_changes": [{"id": "k", "description": "d", "paths": ["a/tsconfig.json"]}]}
        self.assertEqual(plan_contract_violations(config_only, base_dir=None, contract_version=2), [])

    def test_the_contract_version_is_fixed_at_the_plans_start(self) -> None:
        from aria_kernel.plan_convergence import start_plan, started_contract_version

        with tempfile.TemporaryDirectory() as tmp:
            start_plan(plan_id="plan-v", initial_revision_id="r0", base_dir=Path(tmp) / "aria-tools", plan_content={
                "schema_version": 1, "title": "t", "summary": "s", "affected_surfaces": [], "key_changes": ["x"],
                "validation_commands": [], "evidence_refs": ["docs/aria/SPEC.md"]})
            self.assertEqual(started_contract_version(fold_plan_state(plan_id="plan-v",
                                                                      base_dir=Path(tmp) / "aria-tools")), 2)
        self.assertEqual(started_contract_version({"plan_started": {"plan_content": {}}}), 1)

    def test_only_the_key_changes_files_are_planned(self) -> None:
        body = {"affected_surfaces": ["mod-b/tsconfig.json"], "key_changes": [change("k", [LEAVE_TYPES])]}
        self.assertEqual(planned_paths(body), [LEAVE_TYPES])


def _fixture_repo(root: Path) -> Path:
    """mod-a maps `@lib/*` through a base config it extends; mod-b maps nothing (the hr-module shape);
    mod-c is a solution config referencing the project that compiles its sources; shell declares a remote."""
    files = {
        "package.json": json.dumps({"name": "imports-fixture", "private": True}),
        "lib/src/status.ts": "export type Status = 'A' | 'B';\n",
        "tsconfig.base.json": json.dumps({"compilerOptions": {
            "moduleResolution": "bundler", "module": "ESNext", "baseUrl": ".", "paths": {"@lib/*": ["lib/src/*"]},
        }}),
        "mod-a/tsconfig.json": json.dumps({"extends": "../tsconfig.base.json"}),
        "mod-a/src/a.ts": "export const a = 1;\n",
        "mod-b/tsconfig.json": json.dumps({"compilerOptions": {
            "moduleResolution": "bundler", "module": "ESNext", "baseUrl": ".", "paths": {"@/*": ["src/*"]},
        }}),
        LEAVE_TYPES: "export const b = 1;\n",
        "mod-b/src/types/index.ts": "export const STATUSES = [];\n",
        "mod-c/tsconfig.json": json.dumps({"files": [], "references": [{"path": "./tsconfig.app.json"}]}),
        "mod-c/tsconfig.app.json": json.dumps({"extends": "../tsconfig.base.json", "include": ["src"]}),
        "mod-c/src/c.ts": "export const c = 1;\n",
        "shell/tsconfig.json": json.dumps({"compilerOptions": {"moduleResolution": "bundler", "module": "ESNext"},
                                           "include": ["src"]}),
        "shell/src/remotes.d.ts": "declare module 'hrModule/Module' { const M: unknown; export default M; }\n",
        "shell/src/app.ts": "export const s = 1;\n",
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

    def _compute(self, key_changes: list, *, affected: list | None = None) -> tuple[dict, list]:
        body = {"key_changes": key_changes, "affected_surfaces": affected or []}
        return compute_import_resolution(plan_content=body, round_number=1, workspace_root=self.repo,
                                         input_path=self.input)

    def test_the_f015_shape_is_unresolved_for_the_file_that_imports_it(self) -> None:
        self._link_node_modules()
        block, risks = self._compute([
            change("kc-a", ["mod-a/src/a.ts"], ("mod-a/src/a.ts", "@lib/status")),
            change("kc-b", [LEAVE_TYPES, "mod-a/src/a.ts"], (LEAVE_TYPES, "@lib/status"), (LEAVE_TYPES, "../types")),
        ])
        self.assertEqual(block["verdict"], VERDICT_UNRESOLVED, block)
        self.assertEqual(block["checked"], 3)
        self.assertEqual([(item["specifier"], item["from_path"], item["project_config"])
                          for item in block["unresolved"]], [("@lib/status", LEAVE_TYPES, "mod-b/tsconfig.json")])
        self.assertTrue(block["witness"]["typescript_version"])
        [risk] = risks
        _validate_cross_review_risk(risk)
        self.assertTrue(risk["risk_id"].startswith("IMP-R1-"))
        self.assertEqual(risk["affected_files"], [LEAVE_TYPES, "mod-b/tsconfig.json"])

    def test_the_alias_belongs_to_the_config_that_declares_paths(self) -> None:
        self._link_node_modules()
        block, risks = self._compute([change("k", ["mod-a/src/a.ts"], ("mod-a/src/a.ts", "@lib/missing"))])
        [entry] = block["unresolved"]
        self.assertEqual((entry["project_config"], entry["paths_config"]),
                         ("mod-a/tsconfig.json", "tsconfig.base.json"))
        self.assertEqual(risks[0]["affected_files"], ["mod-a/src/a.ts", "tsconfig.base.json"])

    def test_a_referenced_project_compiles_its_own_sources(self) -> None:
        self._link_node_modules()
        block, _risks = self._compute([change("k", ["mod-c/src/c.ts"], ("mod-c/src/c.ts", "@lib/status"))])
        self.assertEqual(block["verdict"], VERDICT_RESOLVED, block)

    def test_assets_and_ambient_remotes_are_not_misjudged(self) -> None:
        self._link_node_modules()
        block, _risks = self._compute([change(
            "k", ["shell/src/app.ts"], ("shell/src/app.ts", "./styles.css"), ("shell/src/app.ts", "./x.svg?react"),
            ("shell/src/app.ts", "hrModule/Module"))])
        self.assertEqual(block["verdict"], VERDICT_RESOLVED, block)

    def test_a_file_a_key_change_creates_resolves_and_an_affected_surface_does_not(self) -> None:
        self._link_node_modules()
        block, _ = self._compute([change("k", [LEAVE_TYPES, "mod-b/src/types/fresh.ts"], (LEAVE_TYPES, "./fresh"))])
        self.assertEqual(block["verdict"], VERDICT_RESOLVED, block)
        block, _ = self._compute([change("k", [LEAVE_TYPES], (LEAVE_TYPES, "./fresh"))],
                                 affected=["mod-b/src/types/fresh.ts"])
        self.assertEqual(block["verdict"], VERDICT_UNRESOLVED, block)

    def test_a_config_the_key_changes_write_anywhere_in_the_chain_is_the_plans_to_make_true(self) -> None:
        self._link_node_modules()
        block, risks = self._compute([change("k", ["mod-a/src/a.ts", "tsconfig.base.json"],
                                             ("mod-a/src/a.ts", "@lib/missing"))])
        self.assertEqual(block["verdict"], VERDICT_RESOLVED, block)
        self.assertEqual([item["specifier"] for item in block["config_planned"]], ["@lib/missing"])
        self.assertEqual(risks, [])
        # Listed only as an affected surface, the config is not the plan's.
        block, _ = self._compute([change("k", ["mod-a/src/a.ts"], ("mod-a/src/a.ts", "@lib/missing"))],
                                 affected=["tsconfig.base.json"])
        self.assertEqual(block["verdict"], VERDICT_UNRESOLVED, block)

    def test_no_repository_typescript_is_environment_unable(self) -> None:
        block, risks = self._compute([change("k", [LEAVE_TYPES], (LEAVE_TYPES, "@lib/status"))])
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
        block, _risks = self._compute([change("k", [LEAVE_TYPES], (LEAVE_TYPES, "@lib/status"))])
        self.assertEqual(block["verdict"], VERDICT_ENVIRONMENT_UNABLE, block)

    def test_a_witness_that_cannot_be_run_is_environment_unable(self) -> None:
        self._link_node_modules()

        def refuse(cmd: list[str], cwd: str, timeout: int) -> None:
            raise PermissionError("denied")

        block, risks = compute_import_resolution(
            plan_content={"key_changes": [change("k", [LEAVE_TYPES], (LEAVE_TYPES, "@lib/status"))]},
            round_number=1, workspace_root=self.repo, input_path=self.input, runner=refuse)
        self.assertEqual((block["verdict"], risks), (VERDICT_ENVIRONMENT_UNABLE, []))
        self.assertIn("PermissionError", block["reason"])

    def test_a_plan_that_declares_nothing_runs_no_witness(self) -> None:
        block, risks = self._compute([change("k", ["a/b.ts"])])
        self.assertEqual((block["verdict"], block["checked"], risks), (VERDICT_NOT_APPLICABLE, 0, []))


class TheEvaluatorJudgesTheBodyThatConverges(PlanCoverageGateTests):
    """The coverage gate's own fixture; the primary (plan_started) declares an import."""

    def plan(self, schema_version: int, coverage_block: dict | None) -> dict:
        plan = super().plan(schema_version, coverage_block)
        plan["key_changes"] = [change("kc-1", ["libs/farm-shared/src/index.ts"],
                                      ("libs/farm-shared/src/index.ts", "@lib/x"))]
        return plan

    def submit_challenger(self, challenger_revision_id: str):
        # A clean challenger: it must never stand in for the primary.
        original = self.plan
        self.plan = lambda schema_version, coverage_block: {  # type: ignore[method-assign]
            **original(schema_version, coverage_block), "key_changes": ["widen shared lib"]}
        try:
            return super().submit_challenger(challenger_revision_id)
        finally:
            self.plan = original  # type: ignore[method-assign]

    def _imports(self, verdict: str, *, unresolved: int = 0) -> dict:
        latest = fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)["latest_revision"]
        entries = [{"specifier": "@lib/x", "from_path": "libs/farm-shared/src/index.ts", "key_change_id": "kc-1",
                    "project_config": "libs/farm-shared/tsconfig.json",
                    "paths_config": "libs/farm-shared/tsconfig.json", "reason": "module_not_resolved"}][:unresolved]
        return {"verdict": verdict, "checked": 1, "unresolved": entries, "config_planned": [],
                "witness": {"tool": "tools/gates/plan-import-witness.ts"},
                "target_revision_id": latest["revision_id"], "target_plan_content_hash": latest["content_hash"],
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
        self.start(schema_version=2)
        payload = self._evaluate_started(self._imports(VERDICT_RESOLVED))["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "CONVERGED")
        self.assertTrue(self.gate_decision(payload, "prescribed_imports_resolve")["passed"])

    def _evaluate_started(self, imports: dict, *, max_rounds: int = 2) -> dict:
        self.drive_to_cross_reviewed(1)
        coverage = self.coverage_payload()
        coverage["import_resolution"] = imports
        record_coverage(plan_id="plan-1", coverage=coverage, base_dir=self.tools_dir)
        return evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir, max_rounds=max_rounds)

    def test_an_unresolved_import_is_a_named_blocker_and_a_material_risk(self) -> None:
        self.start(schema_version=2)
        result = self._evaluate_started(self._imports(VERDICT_UNRESOLVED, unresolved=1))
        self.assertEqual(result["status"], "next_round_required")
        self.assertIn("prescribed_imports_unresolved", result["reason_codes"])
        self.assertIn("material_cross_review_risks_present", result["reason_codes"])

    def test_an_unresolved_import_at_max_rounds_is_human_required(self) -> None:
        self.start(schema_version=2)
        payload = self._evaluate_started(self._imports(VERDICT_UNRESOLVED, unresolved=1),
                                         max_rounds=1)["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("prescribed_imports_unresolved", payload["reason_codes"])

    def test_an_unchecked_primary_is_human_required(self) -> None:
        payload = self._evaluate(None)["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("prescribed_imports_unchecked", payload["reason_codes"])

    def test_a_block_that_judged_the_challenger_does_not_count(self) -> None:
        self.start(schema_version=2)
        imports = self._imports(VERDICT_RESOLVED)
        self.drive_to_cross_reviewed(1)
        challenger = fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)["challenger"]
        imports.update(target_revision_id=challenger["challenger_revision_id"],
                       target_plan_content_hash=challenger["content_hash"])
        coverage = self.coverage_payload()
        coverage["import_resolution"] = imports
        record_coverage(plan_id="plan-1", coverage=coverage, base_dir=self.tools_dir)
        payload = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)["event"]["payload"]
        self.assertIn("prescribed_imports_unchecked", payload["reason_codes"])

    def test_the_round_block_is_computed_on_the_primary_not_the_clean_challenger(self) -> None:
        # Review of #1908, HIGH-1: the reviewer's probe, a primary carrying the
        # F-015 specifier beside a clean challenger, converged in round 1.
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)
        block = import_resolution_for_round(state=state, plan_id="plan-1", round_number=1,
                                            workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(block["target_revision_id"], state["latest_revision"]["revision_id"])
        self.assertEqual(block["checked"], 1)  # the primary's import was asked about
        self.assertEqual(block["verdict"], VERDICT_ENVIRONMENT_UNABLE)  # this fixture has no TypeScript
        coverage = self.coverage_payload()
        coverage["import_resolution"] = block
        record_coverage(plan_id="plan-1", coverage=coverage, base_dir=self.tools_dir)
        payload = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)["event"]["payload"]
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
    setattr(TheEvaluatorJudgesTheBodyThatConverges, _inherited, None)
del PlanCoverageGateTests, _inherited

if __name__ == "__main__":
    unittest.main()
