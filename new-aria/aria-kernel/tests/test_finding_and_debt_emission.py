"""Tests for the Plan 016 Faz A2/A3 operator-facing finding + debt emitters."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.debt import emit_debt, list_debts, show_debt
from aria_kernel.finding import (
    emit_finding,
    find_by_evidence_chain_id,
    list_findings,
    show_finding,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths


def _seed_repo() -> Path:
    """Create a tempdir that looks like a repo root for emit_*. Caller cleans up."""
    tmp = Path(tempfile.mkdtemp(prefix="aria-finding-test-"))
    for i in range(1, 4):
        path = tmp / "apps" / "farm-service" / "src" / "database" / "migrations" / f"000{i}-create.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"line {n}" for n in range(1, 45)) + "\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.email", "aria-test@example.com"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=tmp, check=True)
    subprocess.run(["git", "add", "apps"], cwd=tmp, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed evidence"], cwd=tmp, check=True)
    # ensure_tools_binding requires a workspace.
    workspace_base = tmp / "workspaces"
    paths = workspace_paths(tmp, workspace_base)
    ensure_workspace(paths)
    ensure_tools_dir(tmp / "aria-tools")
    return tmp


def _good_evidence(n: int = 2) -> list[dict[str, object]]:
    return [
        {"ref": f"apps/farm-service/src/database/migrations/000{i}-create.ts:42", "summary": f"migration {i}"}
        for i in range(1, n + 1)
    ]


class FindingEmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def test_minimal_emit_creates_file_and_index_and_governance_event(self) -> None:
        record = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type="duplication",
            claim_summary="Three migration files share identical column-add boilerplate",
            severity="LOW",
            evidences=_good_evidence(3),
            facts=["mig 001 adds tenant_id col", "mig 002 adds tenant_id col", "mig 003 adds tenant_id col"],
            scope_files=[
                "apps/farm-service/src/database/migrations/0001-a.ts",
                "apps/farm-service/src/database/migrations/0002-b.ts",
            ],
        )
        self.assertEqual(record["finding_id"], "F-001")
        self.assertEqual(record["status"], "OPEN")
        self.assertTrue(record["evidence_chain_id"].startswith("chain_"))
        self.assertEqual(record["source_event_id"], "finding:F-001:emitted")
        self.assertTrue(record["source_ledger_hash"].startswith("sha256:"))
        self.assertIn("evidence_envelope", record["evidences"][0])

        output = self.repo / "aria-findings" / "F-001.json"
        self.assertTrue(output.exists())
        self.assertTrue((self.repo / "aria-findings" / "finding-events.jsonl").exists())
        index = json.loads((self.repo / "aria-findings" / "_index.json").read_text())
        self.assertEqual(len(index["findings"]), 1)
        self.assertEqual(index["findings"][0]["finding_id"], "F-001")

        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        emitted = [json.loads(line) for line in governance if "finding_emitted" in line]
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["details"]["finding_id"], "F-001")
        self.assertTrue(emitted[0]["ledger_hash"].startswith("sha256:"))

    def test_sequential_id_allocation(self) -> None:
        for _ in range(3):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="duplication",
                claim_summary=f"finding number",
                severity="LOW",
                evidences=_good_evidence(3),
                facts=["a", "b", "c"],
                scope_files=["x.ts"],
            )
        records = list_findings(self.repo)
        self.assertEqual([r["finding_id"] for r in records], ["F-001", "F-002", "F-003"])

    def test_severity_floor_enforced(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "below floor"):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="regression",  # floor: HIGH
                claim_summary="baseline regression observed",
                severity="LOW",
                evidences=_good_evidence(2),
                facts=["a", "b"],
                scope_files=["x.ts"],
            )

    def test_min_evidence_count_enforced(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "requires >="):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="duplication",  # min_evidence: 3
                claim_summary="dup detected",
                severity="LOW",
                evidences=_good_evidence(2),
                facts=["a"],
                scope_files=["x.ts"],
            )

    def test_unknown_claim_type_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "unknown claim_type"):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="speculation",
                claim_summary="x",
                severity="LOW",
                evidences=_good_evidence(2),
                facts=["a"],
                scope_files=["x.ts"],
            )

    def test_banned_phrase_in_summary_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "banned phrase"):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="duplication",
                claim_summary="for now we accept this duplication",
                severity="LOW",
                evidences=_good_evidence(3),
                facts=["a", "b", "c"],
                scope_files=["x.ts"],
            )

    def test_originating_run_id_traceability(self) -> None:
        record = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type="wrong_code",
            claim_summary="missing await on async DB write",
            severity="MEDIUM",
            evidences=_good_evidence(1),
            facts=["fn returns promise without await"],
            scope_files=["x.ts"],
            originating_run_id="run-abc-123",
            originating_pressure_event_id="PE-2026-05-07-001",
        )
        self.assertEqual(record["originating_run_id"], "run-abc-123")
        self.assertEqual(record["originating_pressure_event_id"], "PE-2026-05-07-001")

    def test_missing_evidence_rejected_fail_closed(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "repo_verified"):
            emit_finding(
                repo_root=self.repo,
                base_dir=self.tools,
                claim_type="wrong_code",
                claim_summary="missing committed evidence is rejected",
                severity="MEDIUM",
                evidences=[{"ref": "missing/file.ts:1", "summary": "missing"}],
                facts=["missing evidence cannot back a finding"],
                scope_files=["missing/file.ts"],
            )

    def test_show_replays_event_ledger_not_tampered_doc(self) -> None:
        record = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type="wrong_code",
            claim_summary="committed evidence backs this finding",
            severity="MEDIUM",
            evidences=_good_evidence(1),
            facts=["a committed source line is cited"],
            scope_files=["x.ts"],
        )
        doc_path = self.repo / "aria-findings" / f"{record['finding_id']}.json"
        tampered = dict(record)
        tampered["claim_summary"] = "tampered derived view"
        doc_path.write_text(json.dumps(tampered, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        replayed = show_finding(self.repo, record["finding_id"])
        self.assertEqual(replayed["claim_summary"], "committed evidence backs this finding")


class DebtEmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        # Seed a finding so debts have a valid originator.
        self.finding = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type="duplication",
            claim_summary="three migrations share boilerplate",
            severity="LOW",
            evidences=_good_evidence(3),
            facts=["a", "b", "c"],
            scope_files=["m1.ts", "m2.ts", "m3.ts"],
        )

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _good_due(self, days: int = 30) -> str:
        return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_minimal_emit_creates_record_and_governance_event(self) -> None:
        debt = emit_debt(
            repo_root=self.repo,
            base_dir=self.tools,
            originating_finding_id=self.finding["finding_id"],
            root_cause_summary="Migration generator copies the column-add block verbatim across three files",
            short_term_action={
                "kind": "test_added",
                "ref": "apps/farm-service/src/database/migrations/0001-create.ts:1",
                "rationale": "Regression test asserts the three migrations produce identical AST nodes",
            },
            permanent_fix_required="Extract shared column-add helper and have each migration call it",
            permanent_fix_owner="platform-data-team",
            due_date=self._good_due(days=80),
            severity="MEDIUM",
        )
        self.assertTrue(debt["debt_id"].startswith("DEBT-"))
        self.assertEqual(debt["current_status"], "OPEN")
        self.assertTrue(debt["auto_close_forbidden"])
        self.assertEqual(debt["originating_finding_id"], self.finding["finding_id"])
        self.assertEqual(
            debt["originating_finding_evidence_chain_id"],
            self.finding["evidence_chain_id"],
        )
        self.assertEqual(debt["source_event_id"], f"debt:{debt['debt_id']}:emitted")
        self.assertTrue(debt["source_ledger_hash"].startswith("sha256:"))
        self.assertTrue((self.repo / "aria-debts" / "debt-events.jsonl").exists())

        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        emitted = [json.loads(line) for line in governance if "debt_emitted" in line]
        self.assertEqual(len(emitted), 1)

    def test_due_date_ceiling_enforced_per_severity(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "ceiling of 60 days"):
            emit_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                originating_finding_id=self.finding["finding_id"],
                root_cause_summary="Real root cause statement here",
                short_term_action={
                    "kind": "feature_flag",
                    "ref": "apps/farm-service/src/database/migrations/0001-create.ts:1",
                    "rationale": "Flag isolates new behavior",
                },
                permanent_fix_required="Real permanent fix description",
                permanent_fix_owner="platform-data-team",
                due_date=self._good_due(days=120),
                severity="HIGH",
            )

    def test_generic_owner_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "specific person or named team"):
            emit_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                originating_finding_id=self.finding["finding_id"],
                root_cause_summary="Real root cause",
                short_term_action={
                    "kind": "code_marker",
                    "ref": "x.ts:42",
                    "rationale": "Comment marker added",
                },
                permanent_fix_required="Replace marker with real type-system constraint",
                permanent_fix_owner="TBD",
                due_date=self._good_due(days=60),
                severity="MEDIUM",
            )

    def test_banned_phrase_in_root_cause_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "banned phrase"):
            emit_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                originating_finding_id=self.finding["finding_id"],
                root_cause_summary="for now we ship this duplication",
                short_term_action={
                    "kind": "test_added",
                    "ref": "x.ts:1",
                    "rationale": "Real rationale here",
                },
                permanent_fix_required="Real permanent description",
                permanent_fix_owner="platform-data-team",
                due_date=self._good_due(days=60),
                severity="MEDIUM",
            )

    def test_unknown_short_term_action_kind_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "unknown short_term_action kind"):
            emit_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                originating_finding_id=self.finding["finding_id"],
                root_cause_summary="Real root cause",
                short_term_action={
                    "kind": "magical_workaround",
                    "ref": "x.ts:1",
                    "rationale": "Real rationale",
                },
                permanent_fix_required="Real permanent fix",
                permanent_fix_owner="platform-data-team",
                due_date=self._good_due(days=60),
                severity="MEDIUM",
            )

    def test_missing_finding_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "not found"):
            emit_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                originating_finding_id="F-999",
                root_cause_summary="Real root cause",
                short_term_action={
                    "kind": "test_added",
                    "ref": "x.ts:1",
                    "rationale": "Real rationale",
                },
                permanent_fix_required="Real permanent fix",
                permanent_fix_owner="platform-data-team",
                due_date=self._good_due(days=60),
                severity="MEDIUM",
            )


if __name__ == "__main__":
    unittest.main()
