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

ARIA-MEDIUM-231 — and only runs AT THE COMMITTED TIP. `apply_engine` records
the staging baseline under the same change id at `base_sha`; those runs are
evidence about the base, and a validated row that cites them attests more
than the commit it closes. A refused row is a named refusal the caller must
handle, never a return value it may ignore.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import _evaluate_triple_gate, record_pr_lifecycle
from aria_kernel.change_ledger import emit_change_committed, emit_change_planned, emit_change_validated
from aria_kernel.implementation_delivery import ChangeValidatedRefused, _record_change_validated
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS
from aria_kernel.validation_runs_ledger import record_validation_run, refs_for_change
from tests._helpers.operator_acts import operator_set_profile

REPO_ROOT = Path(__file__).resolve().parents[2]


class ChangeValidatedProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-h196-"))
        self.base = self.tmp / "aria-tools"
        operator_set_profile("strict", base_dir=self.base)
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

    def _record(self, cmd: str, exit_code: int, *, commit_sha: str | None = None) -> None:
        record_validation_run(
            change_id=self.change_id, cmd=cmd, exit_code=exit_code, duration_ms=1_500,
            log_path=str(self.log), commit_sha=commit_sha or self.commit_sha,
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
        with self.assertRaises(ChangeValidatedRefused) as refused:
            self._deliver_step()
        self.assertIn("validation_run_refs must not be empty", refused.exception.reason)
        governance = [
            json.loads(line) for line in (self.base / "governance.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        refused = [row for row in governance if row.get("kind") == "change_validated_refused"]
        self.assertEqual(len(refused), 1)
        self.assertEqual(refused[0]["details"]["change_id"], self.change_id)
        result = _evaluate_triple_gate(pr_number=196, head_sha=self.commit_sha, base_dir=self.base)
        self.assertFalse(result["passed"])

    def test_baseline_runs_at_the_base_sha_are_not_the_tips_evidence(self) -> None:
        """The staging baseline, recorded under this change id at the base:
        green, verified — and about a different commit."""
        base_sha = "0bade00000000"
        for cmd in CANONICAL_VALIDATION_COMMANDS:
            self._record(cmd, 0, commit_sha=base_sha)
        self._record("nx affected --target=test", 0)
        refs = refs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual([ref["cmd"] for ref in refs], ["nx affected --target=test"])

    def test_a_green_baseline_cannot_validate_an_untested_tip(self) -> None:
        """Every canonical command green at the BASE, nothing run at the tip:
        the validated row is refused, and the triple gate stays shut."""
        for cmd in CANONICAL_VALIDATION_COMMANDS:
            self._record(cmd, 0, commit_sha="0bade00000000")
        with self.assertRaises(ChangeValidatedRefused):
            self._deliver_step()
        result = _evaluate_triple_gate(pr_number=196, head_sha=self.commit_sha, base_dir=self.base)
        self.assertFalse(result["passed"])

    def test_a_change_with_no_committed_tip_has_no_refs(self) -> None:
        planned = emit_change_planned(
            plan_id="plan-h196-uncommitted", finding_id="F-h196-u",
            intended_affected_files=["docs/runbooks/b.md"],
            intended_validation_refs=["nx affected --target=test"],
            architectural_tier=1, base_dir=self.base,
        )
        record_validation_run(
            change_id=planned["change_id"], cmd="nx affected --target=test", exit_code=0, duration_ms=1,
            log_path=str(self.log), commit_sha=self.commit_sha,
            runner_identity="aria-executor:REQ-h196", change_author_identity="agent:aria-implementer",
            started_at="2026-09-25T13:00:00+00:00", completed_at="2026-09-25T13:01:00+00:00",
            base_dir=self.base,
        )
        self.assertEqual(refs_for_change(planned["change_id"], base_dir=self.base), [])

    def test_a_retry_at_the_same_tip_finds_the_same_row(self) -> None:
        """A delivery refused AFTER the row was written (the credential, the
        push, the PR) is retried at the same tip, and its gate records the
        suite there again. The row is a fact about the tip: the retry must
        re-attest the same row, not read the grown run list as drift and
        stop the delivery that the first attempt's refusal left pending."""
        for cmd in CANONICAL_VALIDATION_COMMANDS:
            self._record(cmd, 0)
        first = self._deliver_step()
        for cmd in CANONICAL_VALIDATION_COMMANDS:
            self._record(cmd, 0)
        second = self._deliver_step()
        self.assertEqual(second, first)
        refs = refs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual([ref["cmd"] for ref in refs], list(CANONICAL_VALIDATION_COMMANDS))

    def test_a_command_that_passed_after_failing_at_the_tip_is_attested_by_its_passing_run(self) -> None:
        self._record("nx affected --target=test", 1)
        self._record("nx affected --target=test", 0)
        self._record("nx affected --target=test", 0)
        refs = refs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual([(ref["cmd"], ref["exit_code"]) for ref in refs], [("nx affected --target=test", 0)])

    def test_refs_are_the_ok_runs_in_the_matrix_shape(self) -> None:
        self._record("nx affected --target=test", 0)
        self._record("nx affected --target=lint", 1)
        refs = refs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual([ref["cmd"] for ref in refs], ["nx affected --target=test"])
        self.assertEqual(set(refs[0]), {"cmd", "exit_code", "log_path", "ran_at"})


if __name__ == "__main__":
    unittest.main()
