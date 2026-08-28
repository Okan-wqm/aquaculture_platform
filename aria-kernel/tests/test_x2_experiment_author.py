"""X2 (ORPHAN-701) — the nightly experiment author.

  * falsifiable open findings gain red-contract bound experiments
  * one experiment per finding, ever (dedupe pinned)
  * the validation allowlist stays the single gate (refusal disclosed)
  * cap disclosed; author output feeds the planner's admissible set
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.experiment import list_experiments, list_recipes
from aria_kernel.experiment_author import (
    MAX_AUTHORED_PER_NIGHT,
    author_night_experiments,
)
from aria_kernel.experiment_night import plan_night_experiments
from aria_kernel.finding import emit_finding
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths


def _seed_repo() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-x2-"))
    for i in range(1, 9):
        path = tmp / "apps" / "farm-service" / "src" / f"module{i}.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"line {n}" for n in range(1, 45)) + "\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.invalid"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=tmp, check=True)
    subprocess.run(["git", "add", "apps"], cwd=tmp, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=tmp, check=True)
    paths = workspace_paths(tmp, tmp / "workspaces")
    ensure_workspace(paths)
    ensure_tools_dir(tmp / "aria-tools")
    return tmp


class AuthorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _finding(self, *, claim_type: str = "wrong_code", severity: str = "HIGH",
                 suffix: str = "1") -> str:
        record = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type=claim_type,
            claim_summary=f"Module {suffix} computes the wrong tenant scope",
            severity=severity,
            evidences=[
                {"ref": f"apps/farm-service/src/module{i}.ts:10", "summary": f"evidence {i}"}
                for i in (1, 2, 3)
            ],
            facts=["fact a", "fact b", "fact c"],
            scope_files=[f"apps/farm-service/src/module{suffix}.ts"],
        )
        return record["finding_id"]

    def test_falsifiable_finding_gains_bound_red_experiment(self) -> None:
        fid = self._finding()
        payload = author_night_experiments(self.repo, cycle_id="cyc-x2", base_dir=self.tools)
        self.assertEqual(len(payload["authored"]), 1)
        authored = payload["authored"][0]
        self.assertEqual(authored["finding_id"], fid)
        self.assertEqual(authored["service"], "farm-service")
        experiments = list_experiments(base_dir=self.tools)
        row = experiments[-1]
        self.assertEqual(row["finding_ref"], fid)
        self.assertEqual(row["observation_contract"], {"comparator": "status_equals", "expected": "failed"})
        recipe = list_recipes(base_dir=self.tools)[-1]
        self.assertIn("run-many", recipe["command"])
        self.assertIn("--projects=farm-service", recipe["command"])
        # ve planner artık kabul ediyor — zincirin bütün amacı
        plan = plan_night_experiments(self.repo, base_dir=self.tools)
        self.assertEqual(len(plan["problem"]), 1)
        self.assertEqual(plan["problem"][0]["finding_id"], fid)

    def test_author_is_idempotent_one_experiment_per_finding_ever(self) -> None:
        self._finding()
        author_night_experiments(self.repo, cycle_id="cyc-1", base_dir=self.tools)
        second = author_night_experiments(self.repo, cycle_id="cyc-2", base_dir=self.tools)
        self.assertEqual(second["authored"], [])
        self.assertEqual(len(second["deduped"]), 1)
        self.assertEqual(
            len([e for e in list_experiments(base_dir=self.tools) if e.get("finding_ref")]),
            1,
        )

    def test_non_falsifiable_claim_types_are_ignored(self) -> None:
        self._finding(claim_type="duplication")
        payload = author_night_experiments(self.repo, cycle_id="cyc-x2", base_dir=self.tools)
        self.assertEqual(payload["authored"], [])
        self.assertEqual(payload["unauthorable"], [])

    def test_cap_is_disclosed(self) -> None:
        for i in range(1, MAX_AUTHORED_PER_NIGHT + 2):
            self._finding(suffix=str(i))
        payload = author_night_experiments(self.repo, cycle_id="cyc-x2", base_dir=self.tools)
        self.assertEqual(len(payload["authored"]), MAX_AUTHORED_PER_NIGHT)
        self.assertEqual(payload["capped"], 1)

    def test_plain_nx_test_stays_refused_end_to_end(self) -> None:
        # the allowlist is the single gate: the author's template must be
        # run-many-shaped, and a plain `npx nx test` remains refused.
        from aria_kernel.tool_registry import GovernanceError
        from aria_kernel.validation import parse_allowed_command

        with self.assertRaises(GovernanceError):
            parse_allowed_command("npx nx test farm-service")

    def test_phase_registered_before_the_bench(self) -> None:
        from aria_kernel.cycle import CYCLE_PHASES

        names = [p.name for p in CYCLE_PHASES]
        self.assertIn("experiment_author", names)
        self.assertLess(names.index("experiment_author"), names.index("experiment_night"))
        phase = next(p for p in CYCLE_PHASES if p.name == "experiment_author")
        self.assertEqual(phase.on_error, "record_and_continue")


class SeederSchemaTests(unittest.TestCase):
    def test_finding_ref_is_accepted_and_red_exemplar_exists(self) -> None:
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))
        import seed_experiment_recipes as seeder

        self.assertIn("finding_ref", seeder._EXPERIMENT_FIELDS)
        doc = seeder.load_manifest()
        red = [
            e for e in doc["experiments"]
            if e.get("finding_ref")
            and e["observation_contract"] == {"comparator": "status_equals", "expected": "failed"}
        ]
        self.assertGreaterEqual(len(red), 1)


if __name__ == "__main__":
    unittest.main()
