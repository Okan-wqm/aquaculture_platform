"""Plan 020 Phase 11 — surface manifest validator tests."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.runtime_profile import set_profile
from aria_kernel.surface_manifest_validator import (
    REQUIRED_FRONTMATTER_FIELDS,
    VALIDATOR_NAMES,
    list_surface_validations,
    run_all_validators,
    validate_agent_frontmatter,
    validate_maintenance_agent_isolation,
    validate_plan_doc_freshness,
    validate_registry_runner_paths,
    validate_target_agent_existence,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-surface-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    (repo / ".claude" / "agents" / "_maintenance").mkdir(parents=True)
    (repo / ".claude" / "agents" / "product-audit").mkdir(parents=True)
    (repo / "docs" / "aria" / "plans").mkdir(parents=True)
    (repo / "aria-debts").mkdir(parents=True)
    (repo / "aria-tools").mkdir(parents=True)
    return tools, repo


def _write_agent_md(repo: Path, name: str, body: str = "", *,
                     location: str = "root") -> Path:
    base = repo / ".claude" / "agents"
    if location == "maintenance":
        base = base / "_maintenance"
    elif location == "product-audit":
        base = base / "product-audit"
    path = base / f"{name}.md"
    path.write_text(body, encoding="utf-8")
    return path


def _good_frontmatter(name: str = "x") -> str:
    return (
        f"---\nname: {name}\ndescription: y\nmodel: opus\n"
        f"tools: [Read, Grep]\n---\nbody\n"
    )


class TaxonomyTests(unittest.TestCase):
    def test_six_validators_locked(self) -> None:
        # Plan 022 §M-6 — 7th validator added (validate_registry_adapter_sync).
        self.assertEqual(len(VALIDATOR_NAMES), 7)
        self.assertEqual(REQUIRED_FRONTMATTER_FIELDS, ("name", "description", "tools"))


class FrontmatterValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_passes_when_all_required_fields_present(self) -> None:
        _write_agent_md(self.repo, "good", _good_frontmatter())
        self.assertEqual(validate_agent_frontmatter(repo_root=self.repo), [])

    def test_fails_when_missing_field(self) -> None:
        _write_agent_md(self.repo, "bad", "---\nname: x\n---\nbody\n")
        failures = validate_agent_frontmatter(repo_root=self.repo)
        self.assertEqual(len(failures), 1)
        self.assertIn("description", failures[0]["missing"])

    def test_excludes_non_agent_doc(self) -> None:
        # File without --- frontmatter is treated as a non-agent doc.
        path = self.repo / ".claude" / "agents" / "notes.md"
        path.write_text("# Notes\nNot an agent.\n", encoding="utf-8")
        # README excluded by name; notes.md excluded by no-frontmatter
        # heuristic.
        self.assertEqual(validate_agent_frontmatter(repo_root=self.repo), [])


class RegistryRunnerValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_passes_when_all_runner_paths_resolve(self) -> None:
        # Write a fake registry pointing at a real script file.
        script = self.repo / "tools" / "x.py"
        script.parent.mkdir(parents=True)
        script.write_text("print('x')", encoding="utf-8")
        registry = self.repo / "aria-tools" / "registry.json"
        registry.write_text(json.dumps({
            "tools": [{
                "tool_id": "x-adapter",
                "runner": {"argv": ["python3", "x.py"], "cwd": "tools"},
            }],
        }), encoding="utf-8")
        self.assertEqual(
            validate_registry_runner_paths(repo_root=self.repo, base_dir="aria-tools"),
            [],
        )

    def test_fails_when_runner_script_missing(self) -> None:
        registry = self.repo / "aria-tools" / "registry.json"
        registry.write_text(json.dumps({
            "tools": [{
                "tool_id": "ghost-adapter",
                "runner": {"argv": ["python3", "ghost.py"], "cwd": "tools"},
            }],
        }), encoding="utf-8")
        failures = validate_registry_runner_paths(repo_root=self.repo, base_dir="aria-tools")
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["tool_id"], "ghost-adapter")


class PlanDocFreshnessValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_flags_resolved_debt_referenced_as_open(self) -> None:
        # Resolved debt + plan doc that mentions it as 'open'.
        debt_path = self.repo / "aria-debts" / "DEBT-2026-05-08-001.json"
        debt_path.write_text(json.dumps({
            "debt_id": "DEBT-2026-05-08-001",
            "current_status": "RESOLVED",
        }), encoding="utf-8")
        plan = self.repo / "docs" / "aria" / "plans" / "020-x.md"
        plan.write_text("DEBT-2026-05-08-001 is open and pending\n", encoding="utf-8")
        failures = validate_plan_doc_freshness(repo_root=self.repo)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["debt_id"], "DEBT-2026-05-08-001")


class MaintenanceIsolationValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_no_failures_when_isolated(self) -> None:
        _write_agent_md(self.repo, "aria-primary-planner",
                         _good_frontmatter("aria-primary-planner"),
                         location="maintenance")
        # No product-audit overlap; no domain-review pairing leak.
        self.assertEqual(validate_maintenance_agent_isolation(repo_root=self.repo), [])


class RunAllValidatorsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_run_all_persists_summary_to_ledger(self) -> None:
        run_all_validators(repo_root=self.repo, base_dir=self.tools)
        rows = list_surface_validations(base_dir=self.tools)
        self.assertEqual(len(rows), 1)
        # Plan 022 §M-6 — 7th validator added.
        self.assertEqual(rows[0]["validator_count"], 7)

    def test_failure_emits_surface_validation_failed_event(self) -> None:
        # Force a failure: bad frontmatter agent.
        _write_agent_md(self.repo, "bad", "---\nname: x\n---\nbody\n")
        run_all_validators(repo_root=self.repo, base_dir=self.tools)
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("surface_validation_failed", kinds)


class ProfileGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_persist(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            run_all_validators(repo_root=self.repo, base_dir=self.tools)

    def test_observe_permits_persist(self) -> None:
        set_profile("observe", operator_approval_ref="op:observe",
                    base_dir=self.tools)
        # Observe is in OBSERVE_PERMITTED_SURFACES for surface_validations.
        result = run_all_validators(repo_root=self.repo, base_dir=self.tools)
        # Plan 022 §M-6 — 7th validator added.
        self.assertEqual(result["validator_count"], 7)


if __name__ == "__main__":
    unittest.main()
