"""ARIA-HIGH-196 — implementation delivery writes change_validated.

`emit_change_validated` had two callers, the operator CLI and a backfill
script. The auto-merge triple gate and `change_outcome` both require the row,
so every autonomous change stopped at `change_committed`. Delivery now writes
it right after the commit row, from the runs the apply gate recorded under the
change id (`validation_runs_ledger.refs_for_change`, the one mapping the matrix
CLI also reads).

These tests pin:
1. With the canonical suite recorded ok, delivery's step writes the validated
   row and the triple gate passes.
2. With no ok run, the refusal is recorded by name and nothing is written;
   the triple gate still refuses (the PR stays human-reviewable only).
3. `refs_for_change` returns only ok runs, in the matrix's ref shape.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import _evaluate_triple_gate, record_pr_lifecycle
from aria_kernel.change_ledger import emit_change_committed, emit_change_planned, emit_change_validated
from aria_kernel.implementation_delivery import _record_change_validated
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS
from aria_kernel.runtime_profile import set_profile
from aria_kernel.validation_runs_ledger import record_validation_run, refs_for_change

REPO_ROOT = Path(__file__).resolve().parents[2]


class ChangeValidatedProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-h196-"))
        self.base = self.tmp / "aria-tools"
        set_profile("strict", operator_approval_ref="t", base_dir=self.base)
        self.log = self.tmp / "log.txt"
        self.log.write_text("ok\n", encoding="utf-8")
        self.commit_sha = "abc1234567890"
        planned = emit_change_planned(
            plan_id="plan-h196", finding_id="F-h196",
            intended_affected_files=["docs/runbooks/a.md"],
            intended_validation_refs=["nx affected --target=test"],
            architectural_tier=1, base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(
            change_id=self.change_id, commit_sha=self.commit_sha,
            actual_affected_files=["docs/runbooks/a.md"], base_dir=self.base,
        )
        record_pr_lifecycle(
            {"number": 196, "head_sha": self.commit_sha, "change_id": self.change_id, "base_branch": "main"},
            event="opened", base_dir=self.base,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _record(self, cmd: str, exit_code: int) -> None:
        record_validation_run(
            change_id=self.change_id, cmd=cmd, exit_code=exit_code, duration_ms=1_500,
            log_path=str(self.log), commit_sha=self.commit_sha,
            runner_identity="aria-executor:REQ-h196", change_author_identity="agent:aria-implementer",
            started_at="2026-09-25T13:00:00+00:00", completed_at="2026-09-25T13:01:00+00:00",
            base_dir=self.base,
        )

    def _deliver_step(self):
        return _record_change_validated(
            change_id=self.change_id, base_dir=self.base, workspace=REPO_ROOT,
            emit=emit_change_validated, request_id="REQ-h196", cycle_id="cyc-h196",
        )

    def test_recorded_suite_closes_the_chain_and_the_triple_gate_passes(self) -> None:
        for cmd in CANONICAL_VALIDATION_COMMANDS:
            self._record(cmd, 0)
        row = self._deliver_step()
        self.assertIsNotNone(row)
        self.assertEqual(row["change_id"], self.change_id)
        self.assertEqual(len(row["validation_run_refs"]), len(CANONICAL_VALIDATION_COMMANDS))
        result = _evaluate_triple_gate(pr_number=196, head_sha=self.commit_sha, base_dir=self.base)
        self.assertTrue(result["passed"], result)

    def test_no_ok_run_is_refused_by_name_and_writes_nothing(self) -> None:
        self.assertIsNone(self._deliver_step())
        governance = [
            json.loads(line) for line in (self.base / "governance.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        refused = [row for row in governance if row.get("kind") == "change_validated_refused"]
        self.assertEqual(len(refused), 1)
        self.assertEqual(refused[0]["details"]["change_id"], self.change_id)
        result = _evaluate_triple_gate(pr_number=196, head_sha=self.commit_sha, base_dir=self.base)
        self.assertFalse(result["passed"])

    def test_refs_are_the_ok_runs_in_the_matrix_shape(self) -> None:
        self._record("nx affected --target=test", 0)
        self._record("nx affected --target=lint", 1)
        refs = refs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual([ref["cmd"] for ref in refs], ["nx affected --target=test"])
        self.assertEqual(set(refs[0]), {"cmd", "exit_code", "log_path", "ran_at"})


if __name__ == "__main__":
    unittest.main()
