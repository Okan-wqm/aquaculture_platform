"""ARIA-MEDIUM-376 — the operator's ``convergent-plan`` subcommand runs end to end.

The subcommand imported ``start_convergent_plan_with_envelope``, a function
V8 deleted (B-V2-07), so ``start`` and ``issue-challenger`` both died on an
ImportError before argument dispatch. The neighbouring CLI test only
asserted that no TypeError appeared, which an ImportError also satisfies.
These run the real module entry point in a subprocess and assert on what
the store holds afterwards.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import load_segments
from aria_kernel.plan_convergence import fold_plan_state

ARIA_KERNEL = Path(__file__).resolve().parent.parent

_PLAN = {
    "schema_version": 1, "title": "T", "summary": "S",
    "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
    "key_changes": ["x"], "validation_commands": [{"cmd": "nx affected --target=test"}],
    "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 2,
}


class ConvergentPlanCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-376-"))
        self.tools = self.tmp / "aria-tools"
        self.workspace = self.tmp / "workspace"
        (self.workspace / ".claude" / "agents").mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cli(self, *argv: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "aria_kernel", "convergent-plan", *argv],
            capture_output=True, text=True, cwd=self.tmp,
            env={**os.environ, "PYTHONPATH": str(ARIA_KERNEL)},
        )

    def write(self, name: str, payload: object) -> str:
        path = self.tmp / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def test_help_lists_both_subcommands(self) -> None:
        proc = self.cli("--help")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("start", proc.stdout)
        self.assertIn("issue-challenger", proc.stdout)

    def test_start_opens_the_plan_and_mints_its_round_one_challenger(self) -> None:
        proc = self.cli(
            "start", "--plan-id", "plan-op", "--initial-revision-id", "plan-op-r1",
            "--plan-content-file", self.write("plan.json", _PLAN),
            "--must-satisfy-file", self.write("ms.json", [{"id": "op-1", "description": "operator check"}]),
            "--workspace-root", str(self.workspace), "--tools-dir", str(self.tools),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["challenger_request"]["role"], "challenger_plan")
        self.assertEqual(result["challenger_request"]["round_number"], 1)
        self.assertIn("op-1", {item["id"] for item in result["challenger_request"]["must_satisfy"]})
        self.assertEqual(fold_plan_state(plan_id="plan-op", base_dir=self.tools).get("state"), "DRAFT")

        again = self.cli(
            "issue-challenger", "--plan-id", "plan-op", "--round-number", "1",
            "--must-satisfy-file", self.write("ms2.json", [{"id": "op-2", "description": "second look"}]),
            "--evidence-ref", "docs/aria/SPEC.md",
            "--allowed-scope", "aria-kernel/aria_kernel/plan_convergence.py",
            "--tools-dir", str(self.tools),
        )
        self.assertEqual(again.returncode, 0, again.stderr)
        rows = [row for row in load_segments(self.tools, "agent_invocation_requests")
                if row.get("convergence_id") == "plan-op"]
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
