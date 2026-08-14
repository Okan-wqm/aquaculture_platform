"""F5-a — enterprise workflow-run proof production from live CI evidence.

The whole point of F5-a: a proof row's ``source_ledger_ref`` must RESOLVE
via ``ledger_refs.find_row_by_source_ledger_ref`` back to the concrete
``ci/workflow-runs.jsonl`` row it claims as evidence. These tests seed CI
rows through the REAL writer path (``record_ci_report``) so the row
identity stamped by ``ci._workflow_run_row`` is the exact shape production
writes — not a hand-crafted fixture that could drift.

Deliberate-break coverage:
* failed-conclusion runs produce no proof;
* a legacy row without row identity is skipped with a structural reason
  (never a crash);
* double-run is idempotent (no duplicate proofs);
* empty binding inputs are refused fail-closed.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from aria_kernel.ci import record_ci_report
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.ledger_refs import find_row_by_source_ledger_ref
from aria_kernel.readiness_proofs import (
    CI_WORKFLOW_RUN_ROW_TYPE,
    CI_WORKFLOW_RUNS_LEDGER_PATH,
    CI_WORKFLOW_RUNS_SURFACE,
    SKIP_REASON_ALREADY_PROVEN,
    SKIP_REASON_LEGACY_ROW,
    WORKFLOW_RUN_PROOFS_LEDGER_PATH,
    WORKFLOW_RUN_PROOFS_SURFACE,
    produce_workflow_run_proofs,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
PR_NUMBER = 7
REPO = "example/aqua"
TARGET_REF = "main"
HEAD_REF = "feature/f5a"
LEGACY_RUN_ID = 999


def pr_snapshot() -> dict:
    return {
        "number": PR_NUMBER,
        "base_branch": TARGET_REF,
        "head_sha": HEAD_SHA,
        "changed_files": ["apps/farm-service/src/app.module.ts"],
        "reviews": [],
    }


def github_snapshot() -> dict:
    """Two successful runs (100, 101) and one failed run (102)."""

    def run(run_id: int, name: str, conclusion: str) -> dict:
        return {
            "id": run_id,
            "name": name,
            "status": "completed",
            "conclusion": conclusion,
            "head_sha": HEAD_SHA,
        }

    return {
        "latest_head_sha": HEAD_SHA,
        "branch_protection": {"readable": True, "required_checks": ["ci/test"]},
        "checks": {
            "readable": True,
            "runs": [
                {
                    "name": "ci/test",
                    "head_sha": HEAD_SHA,
                    "status": "completed",
                    "conclusion": "success",
                },
            ],
        },
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
        "workflow_runs": [
            run(100, "ci-full", "success"),
            run(101, "invariants-fast", "success"),
            run(102, "ci-flaky", "failure"),
        ],
    }


class ReadinessProofProductionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed_ci_rows(self) -> None:
        record_ci_report(
            pr=pr_snapshot(),
            github=github_snapshot(),
            changed_files=["apps/farm-service/src/app.module.ts"],
            base_dir=self.tools_dir,
        )
        # A pre-F5-a row: real ledger append (hash-chained) but WITHOUT the
        # row identity pair — exactly what every historical row looks like.
        append_declared_fixture(
            self.tools_dir / CI_WORKFLOW_RUNS_LEDGER_PATH,
            {
                "schema_version": 1,
                "pr_number": PR_NUMBER,
                "head_sha": HEAD_SHA,
                "workflow_run_id": LEGACY_RUN_ID,
                "name": "legacy-run",
                "status": "completed",
                "conclusion": "success",
            },
            expected_surface=CI_WORKFLOW_RUNS_SURFACE,
        )

    def _produce(self) -> dict:
        return produce_workflow_run_proofs(
            pr_number=PR_NUMBER,
            repo=REPO,
            target_ref=TARGET_REF,
            head_ref=HEAD_REF,
            head_sha=HEAD_SHA,
            base_dir=self.tools_dir,
        )

    def _proof_rows(self) -> list[dict]:
        return load_declared_jsonl(
            self.tools_dir / WORKFLOW_RUN_PROOFS_LEDGER_PATH,
            expected_surface=WORKFLOW_RUN_PROOFS_SURFACE,
        )

    def test_source_row_identity_is_stamped_by_the_real_writer(self) -> None:
        self._seed_ci_rows()
        rows = load_declared_jsonl(
            self.tools_dir / CI_WORKFLOW_RUNS_LEDGER_PATH,
            expected_surface=CI_WORKFLOW_RUNS_SURFACE,
        )
        stamped = {row.get("row_id") for row in rows if row.get("row_type") == CI_WORKFLOW_RUN_ROW_TYPE}
        self.assertEqual(
            stamped,
            {"ci-workflow-run:100", "ci-workflow-run:101", "ci-workflow-run:102"},
        )
        gates = load_declared_jsonl(
            self.tools_dir / "ci" / "pr-ci-gates.jsonl",
            expected_surface="ci_pr_gates",
        )
        self.assertEqual(gates[-1]["row_id"], f"ci-pr-gate:{PR_NUMBER}:{HEAD_SHA[:12]}")
        self.assertEqual(gates[-1]["row_type"], "ci_pr_gate")

    def test_produced_proof_source_ledger_ref_resolves(self) -> None:
        """The whole point: every proof's ref resolves to its source row."""
        self._seed_ci_rows()
        report = self._produce()
        self.assertEqual(report["produced_count"], 2)
        self.assertEqual(
            sorted(proof["workflow_run_id"] for proof in report["produced"]),
            [100, 101],
        )
        for proof in report["produced"]:
            resolved = find_row_by_source_ledger_ref(
                Path(self.tools_dir),
                proof["source_ledger_ref"],
                expected_surface=CI_WORKFLOW_RUNS_SURFACE,
                expected_row_type=CI_WORKFLOW_RUN_ROW_TYPE,
            )
            self.assertEqual(resolved["workflow_run_id"], proof["workflow_run_id"])
            self.assertEqual(resolved["head_sha"], HEAD_SHA)
            self.assertEqual(resolved["conclusion"], "success")
        # The proofs are durably recorded on the enterprise surface, with
        # the full PR binding required by the readiness-claim verifier.
        rows = self._proof_rows()
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(row["repo"], REPO)
            self.assertEqual(row["pr_number"], PR_NUMBER)
            self.assertEqual(row["target_ref"], TARGET_REF)
            self.assertEqual(row["head_ref"], HEAD_REF)
            self.assertEqual(row["head_sha"], HEAD_SHA)

    def test_failed_conclusion_run_produces_no_proof(self) -> None:
        self._seed_ci_rows()
        report = self._produce()
        produced_ids = {proof["workflow_run_id"] for proof in report["produced"]}
        self.assertNotIn(102, produced_ids)
        self.assertFalse(
            any(row.get("workflow_run_id") == 102 for row in self._proof_rows()),
        )

    def test_legacy_row_without_identity_is_skipped_structurally(self) -> None:
        self._seed_ci_rows()
        report = self._produce()
        legacy_skips = [
            item for item in report["skipped"]
            if item["reason"] == SKIP_REASON_LEGACY_ROW
        ]
        self.assertEqual(len(legacy_skips), 1)
        self.assertEqual(legacy_skips[0]["workflow_run_id"], LEGACY_RUN_ID)
        self.assertFalse(
            any(row.get("workflow_run_id") == LEGACY_RUN_ID for row in self._proof_rows()),
        )

    def test_double_run_is_idempotent(self) -> None:
        self._seed_ci_rows()
        first = self._produce()
        self.assertEqual(first["produced_count"], 2)
        second = self._produce()
        self.assertEqual(second["produced_count"], 0)
        already = {
            item["workflow_run_id"]
            for item in second["skipped"]
            if item["reason"] == SKIP_REASON_ALREADY_PROVEN
        }
        self.assertEqual(already, {100, 101})
        self.assertEqual(len(self._proof_rows()), 2)

    def test_empty_binding_inputs_are_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            produce_workflow_run_proofs(
                pr_number=0,
                repo=REPO,
                target_ref=TARGET_REF,
                head_ref=HEAD_REF,
                head_sha=HEAD_SHA,
                base_dir=self.tools_dir,
            )
        with self.assertRaises(GovernanceError):
            produce_workflow_run_proofs(
                pr_number=PR_NUMBER,
                repo="   ",
                target_ref=TARGET_REF,
                head_ref=HEAD_REF,
                head_sha=HEAD_SHA,
                base_dir=self.tools_dir,
            )

    def test_cli_verb_produces_proofs(self) -> None:
        from aria_kernel.cli import main

        self._seed_ci_rows()
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = main(
                [
                    "readiness",
                    "produce-workflow-proofs",
                    "--tools-dir",
                    str(self.tools_dir),
                    "--pr-number",
                    str(PR_NUMBER),
                    "--repo",
                    REPO,
                    "--target-ref",
                    TARGET_REF,
                    "--head-ref",
                    HEAD_REF,
                    "--head-sha",
                    HEAD_SHA,
                ],
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["produced_count"], 2)
        # And the CLI-produced refs resolve too — same contract as the API.
        for proof in payload["produced"]:
            resolved = find_row_by_source_ledger_ref(
                Path(self.tools_dir),
                proof["source_ledger_ref"],
                expected_surface=CI_WORKFLOW_RUNS_SURFACE,
                expected_row_type=CI_WORKFLOW_RUN_ROW_TYPE,
            )
            self.assertEqual(resolved["workflow_run_id"], proof["workflow_run_id"])


if __name__ == "__main__":
    unittest.main()
