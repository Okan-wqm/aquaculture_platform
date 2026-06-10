from __future__ import annotations

import ast
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.evidence_trust import recompute_artifact_hash
from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
    emit_change_validated,
)
from aria_kernel.enterprise_readiness import (
    record_artifact_proof,
    record_branch_protection_proof,
    record_dlp_proof,
    record_enterprise_readiness_claim,
    record_remote_cas_proof,
    record_retention_proof,
    record_rollback_proof,
    record_token_proof,
    record_workflow_run_proof,
    readiness_source_evidence_path,
)
from aria_kernel.ledger import append_jsonl
from aria_kernel.merge_authority import merge_if_authorized
from aria_kernel.runtime_profile import set_profile
from aria_kernel.validation_runs_ledger import record_validation_run


HEAD_SHA = "abc1234567890abc1234567890abc1234567890a"
OTHER_HEAD_SHA = "def1234567890def1234567890def1234567890d"
TARGET_REF = "refs/heads/main"
TOKEN_HASH = "sha256:" + "3" * 64
SNAPSHOT_HASH = "sha256:" + "4" * 64
FUTURE = "2999-06-05T00:00:00Z"


def enabled_policy() -> dict[str, Any]:
    return {"enabled": True, "base_branch": "main", "merge_method": "squash"}


def clean_diff() -> str:
    return (
        "diff --git a/docs/ready.md b/docs/ready.md\n"
        "index 1234567..abcdefa 100644\n"
        "--- a/docs/ready.md\n"
        "+++ b/docs/ready.md\n"
        "@@ -1 +1,2 @@\n"
        " existing line\n"
        "+ready line\n"
    )


def pr_payload(**overrides: Any) -> dict[str, Any]:
    payload = {
        "number": 42,
        "base_branch": "main",
        "head_sha": HEAD_SHA,
        "changed_files": ["docs/ready.md"],
        "reviews": [],
        "diff_text": clean_diff(),
    }
    payload.update(overrides)
    return payload


def github_payload(**overrides: Any) -> dict[str, Any]:
    payload = {
        "latest_head_sha": HEAD_SHA,
        "branch_protection": {
            "readable": True,
            "required_checks": ["ci/test", "ci/lint"],
        },
        "checks": {
            "readable": True,
            "runs": [
                {
                    "name": "ci/test",
                    "head_sha": HEAD_SHA,
                    "status": "completed",
                    "conclusion": "success",
                },
                {
                    "name": "ci/lint",
                    "head_sha": HEAD_SHA,
                    "status": "completed",
                    "conclusion": "success",
                },
            ],
        },
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
    }
    payload.update(overrides)
    return payload


class SequencedGitHubAdapter:
    def __init__(
        self,
        *,
        prs: list[dict[str, Any]] | None = None,
        snapshots: list[dict[str, Any]] | None = None,
    ) -> None:
        self.prs = prs or [pr_payload()]
        self.snapshots = snapshots or [github_payload()]
        self.pr_calls = 0

    def get_pr(self, number: int) -> dict[str, Any]:
        index = min(self.pr_calls, len(self.prs) - 1)
        self.pr_calls += 1
        payload = dict(self.prs[index])
        payload["number"] = number
        return payload

    def _snapshot(self) -> dict[str, Any]:
        index = min(max(self.pr_calls - 1, 0), len(self.snapshots) - 1)
        return self.snapshots[index]

    def get_latest_head_sha(self, number: int) -> str | None:
        _ = number
        return self._snapshot().get("latest_head_sha")

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        _ = base_branch
        return dict(self._snapshot()["branch_protection"])

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        _ = head_sha
        checks = self._snapshot()["checks"]
        return {
            "readable": checks.get("readable", True),
            "runs": [dict(run) for run in checks.get("runs", [])],
        }

    def get_reviews(self, number: int) -> dict[str, Any]:
        _ = number
        return dict(self._snapshot()["reviews"])

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        _ = number
        return dict(self._snapshot()["conversations"])

    def get_pr_diff(self, number: int) -> str | None:
        _ = number
        return clean_diff()


class MergeAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-merge-authority-"))
        self.base = self.tmp / "aria-tools"
        set_profile("strict", operator_approval_ref="t", base_dir=self.base)
        self.log = self.tmp / "validation.log"
        self.log.write_text("ok\n", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_triple_gate(self, *, pr_number: int = 42, head_sha: str = HEAD_SHA) -> str:
        planned = emit_change_planned(
            plan_id=f"plan-merge-authority-{pr_number}",
            finding_id=f"F-merge-authority-{pr_number}",
            intended_affected_files=["docs/ready.md"],
            intended_validation_refs=["nx affected --target=test"],
            architectural_tier=1,
            base_dir=self.base,
        )
        change_id = planned["change_id"]
        emit_change_committed(
            change_id=change_id,
            commit_sha=head_sha,
            actual_affected_files=["docs/ready.md"],
            base_dir=self.base,
        )
        record_validation_run(
            change_id=change_id,
            cmd="nx affected --target=test",
            exit_code=0,
            log_path=str(self.log),
            commit_sha=head_sha,
            runner_identity="ci-executor:merge-authority-test",
            change_author_identity="agent:merge-authority-test",
            started_at="2026-05-11T13:00:00+00:00",
            completed_at="2026-05-11T13:01:00+00:00",
            base_dir=self.base,
        )
        emit_change_validated(
            change_id=change_id,
            validation_run_refs=[
                {
                    "cmd": "nx affected --target=test",
                    "exit_code": 0,
                    "log_path": str(self.log),
                    "ran_at": "2026-05-11T13:00:00+00:00",
                },
            ],
            validation_mode="historical_attestation",
            enforce_validation_matrix=False,
            base_dir=self.base,
        )
        from aria_kernel.auto_merge import record_pr_lifecycle

        record_pr_lifecycle(
            {
                "number": pr_number,
                "head_sha": head_sha,
                "change_id": change_id,
                "base_branch": "main",
            },
            event="opened",
            base_dir=self.base,
        )
        return change_id

    def _readiness_common(self, *, head_sha: str = HEAD_SHA) -> dict[str, Any]:
        return {
            "readiness_claim_id": "ready-claim-1",
            "repository": "acme/aqua",
            "pr_number": 42,
            "target_ref": TARGET_REF,
            "head_ref": "feature/readiness",
            "head_sha": head_sha,
        }

    def _source_ref(self, row_type: str, *, head_sha: str = HEAD_SHA) -> dict[str, Any]:
        row = append_jsonl(
            readiness_source_evidence_path(base_dir=self.base),
            {
                "schema_version": 1,
                "row_id": f"source-{row_type}",
                "row_type": row_type,
                "repository": "acme/aqua",
                "pr_number": 42,
                "target_ref": TARGET_REF,
                "head_ref": "feature/readiness",
                "head_sha": head_sha,
            },
        )
        return {
            "surface": "enterprise_source_evidence",
            "ledger_path": "enterprise/source-evidence.jsonl",
            "row_id": row["row_id"],
            "row_type": row["row_type"],
            "row_hash": row["ledger_hash"],
            "schema_version": 1,
        }

    def _artifact_ref(self, *, name: str = "readiness.json") -> dict[str, Any]:
        path = self.base / "evidence" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"ok": True, "name": name}, sort_keys=True) + "\n", encoding="utf-8")
        return {
            "artifact_id": f"artifact-{name}",
            "source_surface": "workflow_artifact",
            "uri": f"evidence/{name}",
            "sha256": recompute_artifact_hash(path),
            "content_type": "application/json",
            "produced_by_workflow_run_id": "123",
        }

    def _workflow_evidence_ref(self) -> dict[str, Any]:
        path = self.base / "evidence" / "workflow-proof.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schema_version": 1,
            "valid": True,
            "dlp_scan_clean": True,
            "token_provenance": "github_actions_artifact_token",
            "workflow_hash": "sha256:" + "5" * 64,
            "contract_hash": "sha256:" + "6" * 64,
            "network_policy": ["github_artifact"],
            "runtime_write_paths": ["runner-temp/aria-operational-proof"],
        }, sort_keys=True) + "\n", encoding="utf-8")
        return {
            "artifact_id": "artifact-workflow-proof",
            "source_surface": "workflow_preflight_artifact",
            "uri": "evidence/workflow-proof.json",
            "sha256": recompute_artifact_hash(path),
            "content_type": "application/json",
            "produced_by_workflow_run_id": "123",
        }

    def _seed_enterprise_readiness(
        self,
        *,
        head_sha: str = HEAD_SHA,
        skip: set[str] | None = None,
    ) -> str:
        readiness_claim_id = "ready-claim-1"
        skip = skip or set()
        common = self._readiness_common(head_sha=head_sha)
        record_enterprise_readiness_claim(
            {
                **common,
                "workflow_run_ids": [123],
                "artifact_refs": [self._artifact_ref()],
            },
            base_dir=self.base,
        )
        proofs: dict[str, tuple[Any, dict[str, Any]]] = {
            "cas": (
                record_remote_cas_proof,
                {
                    **common,
                    "state": "fresh",
                    "lease_id": "cas-lease-1",
                    "epoch": 7,
                    "expires_at": FUTURE,
                },
            ),
            "branch_protection": (
                record_branch_protection_proof,
                {
                    **common,
                    "required_status_checks": ["ci/test", "ci/lint"],
                    "required_approving_review_count": 1,
                    "snapshot_hash": SNAPSHOT_HASH,
                    "source_ledger_ref": self._source_ref("branch_protection", head_sha=head_sha),
                },
            ),
            "workflow_run": (
                record_workflow_run_proof,
                {
                    **common,
                    "workflow_run_id": 123,
                    "status": "completed",
                    "conclusion": "success",
                    "source_ledger_ref": self._source_ref("workflow_run", head_sha=head_sha),
                },
            ),
            "artifact": (
                record_artifact_proof,
                {
                    **common,
                    "workflow_run_id": 123,
                    "artifact_ref": self._artifact_ref(),
                    "source_ledger_ref": self._source_ref("artifact", head_sha=head_sha),
                },
            ),
            "rollback": (
                record_rollback_proof,
                {
                    **common,
                    "rollback_plan_ref": "runbooks/rollback.md#pr-42",
                    "status": "verified",
                    "artifact_ref": self._artifact_ref(),
                    "source_ledger_ref": self._source_ref("rollback", head_sha=head_sha),
                },
            ),
            "retention": (
                record_retention_proof,
                {
                    **common,
                    "status": "active",
                    "retention_days": 365,
                    "retained_until": FUTURE,
                    "artifact_ref": self._artifact_ref(),
                    "retention_event": {
                        "schema_version": 1,
                        "event": "artifact_archived",
                        "artifact_id": "artifact-readiness.json",
                        "original_path": "evidence/readiness.json",
                        "new_path": "evidence/readiness.json",
                        "sha256": self._artifact_ref()["sha256"],
                        "reason": "retention",
                        "operator_approval_ref": "operator:retention",
                        "reviewed": True,
                    },
                    "source_ledger_ref": self._source_ref("retention", head_sha=head_sha),
                },
            ),
            "dlp": (
                record_dlp_proof,
                {
                    **common,
                    "scanner": "dlp-ci",
                    "findings_count": 0,
                    "artifact_ref": self._artifact_ref(),
                    "workflow_evidence_ref": self._workflow_evidence_ref(),
                    "token_source": "github_actions_artifact_token",
                    "workflow_hash": "sha256:" + "5" * 64,
                    "contract_hash": "sha256:" + "6" * 64,
                    "source_ledger_ref": self._source_ref("dlp", head_sha=head_sha),
                },
            ),
            "token": (
                record_token_proof,
                {
                    **common,
                    "token_subject": "github-app:installation:42",
                    "scopes": ["contents:read", "pull_requests:read", "actions:read"],
                    "expires_at": FUTURE,
                    "token_hash": TOKEN_HASH,
                    "workflow_run_id": 123,
                    "token_source": "github_actions_artifact_token",
                    "workflow_hash": "sha256:" + "5" * 64,
                    "contract_hash": "sha256:" + "6" * 64,
                    "workflow_evidence_ref": self._workflow_evidence_ref(),
                    "source_ledger_ref": self._source_ref("token", head_sha=head_sha),
                },
            ),
        }
        for proof_type, (recorder, proof) in proofs.items():
            if proof_type not in skip:
                recorder(proof, base_dir=self.base)
        return readiness_claim_id

    def test_readiness_claim_id_is_required(self) -> None:
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id=None,
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertIn("readiness_claim_id_required", result["reasons"])
        self.assertEqual(calls, [])

    def test_unknown_readiness_claim_never_passes(self) -> None:
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id="missing-readiness-claim",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertTrue(
            any("enterprise_readiness_claim_not_found" in reason for reason in result["reasons"]),
            result["reasons"],
        )
        self.assertEqual(calls, [])

    def test_readiness_claim_must_match_head_sha(self) -> None:
        self._seed_enterprise_readiness(head_sha=OTHER_HEAD_SHA)
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id="ready-claim-1",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertIn("readiness_claim_head_sha_mismatch", result["reasons"])
        self.assertEqual(calls, [])

    def test_enterprise_proof_chain_is_required_before_merge(self) -> None:
        self._seed_enterprise_readiness(skip={"dlp"})
        self._seed_triple_gate()
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id="ready-claim-1",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "enterprise_readiness_verification")
        self.assertIn("dlp_proof_required", result["readiness"]["failure_classes"])
        self.assertEqual(calls, [])

    def test_fresh_re_evaluation_blocks_before_executor(self) -> None:
        self._seed_enterprise_readiness()
        self._seed_triple_gate()
        red_checks = github_payload(
            checks={
                "readable": True,
                "runs": [
                    {
                        "name": "ci/test",
                        "head_sha": HEAD_SHA,
                        "status": "completed",
                        "conclusion": "success",
                    },
                    {
                        "name": "ci/lint",
                        "head_sha": HEAD_SHA,
                        "status": "completed",
                        "conclusion": "failure",
                    },
                ],
            },
        )
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(snapshots=[github_payload(), red_checks]),
            pr_number=42,
            readiness_claim_id="ready-claim-1",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "pre_merge_re_evaluation")
        self.assertTrue(any("required checks not successful" in reason for reason in result["reasons"]))
        self.assertEqual(calls, [])

    def test_triple_gate_blocks_before_executor(self) -> None:
        self._seed_enterprise_readiness()
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id="ready-claim-1",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "triple_gate_pre_merge")
        self.assertIn("auto_merge_triple_gate_blocked", result["reasons"])
        self.assertIn("triple_gate_missing_change_id_binding", result["reasons"])
        self.assertEqual(calls, [])

    def test_authority_executes_merge_with_expected_head_sha_after_all_gates(self) -> None:
        set_profile("autonomous", operator_approval_ref="operator:autonomous-merge", base_dir=self.base)
        self._seed_enterprise_readiness()
        change_id = self._seed_triple_gate()
        calls: list[tuple[int, str, str | Path]] = []

        def executor(pr_number: int, expected_head_sha: str, cwd: str | Path) -> dict[str, Any]:
            calls.append((pr_number, expected_head_sha, cwd))
            return {
                "merged": True,
                "method": "squash",
                "expected_head_sha": expected_head_sha,
            }

        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id="ready-claim-1",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=executor,
        )
        self.assertEqual(result["decision"], "merged")
        self.assertEqual(result["change_id"], change_id)
        self.assertEqual(result["expected_head_sha"], HEAD_SHA)
        self.assertEqual(calls, [(42, HEAD_SHA, ".")])
        self.assertEqual(result["merge_result"]["expected_head_sha"], HEAD_SHA)
        rows = [
            json.loads(line)
            for line in (self.base / "auto-merge-decisions.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(rows[-1]["decision"], "merged")

    def test_strict_profile_blocks_real_merge_even_after_all_gates(self) -> None:
        self._seed_enterprise_readiness()
        self._seed_triple_gate()
        calls: list[tuple[int, str, str | Path]] = []
        result = merge_if_authorized(
            adapter=SequencedGitHubAdapter(),
            pr_number=42,
            readiness_claim_id="ready-claim-1",
            policy=enabled_policy(),
            base_dir=self.base,
            dry_run=False,
            merge_executor=lambda pr_number, sha, cwd: calls.append((pr_number, sha, cwd)) or {},
        )
        self.assertEqual(result["decision"], "failed")
        self.assertIn("profile_violation", result["reasons"][0])
        self.assertEqual(calls, [])


class MergeBoundaryStaticInvariantTests(unittest.TestCase):
    def test_direct_real_merge_only_lives_in_merge_authority(self) -> None:
        kernel_dir = Path(__file__).resolve().parent.parent / "aria_kernel"
        violations: list[str] = []
        authority_has_real_merge = False
        for path in kernel_dir.glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if _is_gh_pr_merge_subprocess(node):
                    if path.name == "merge_authority.py":
                        authority_has_real_merge = True
                    else:
                        violations.append(f"{path.name}: subprocess gh pr merge")
                if _is_merge_pr_call(node) and path.name != "merge_authority.py":
                    violations.append(f"{path.name}: direct merge_pr call")
        self.assertEqual(violations, [])
        self.assertTrue(
            authority_has_real_merge,
            "merge_authority.py must own the real gh pr merge subprocess call",
        )


def _is_gh_pr_merge_subprocess(node: ast.Call) -> bool:
    func = node.func
    if not (
        isinstance(func, ast.Attribute)
        and func.attr == "run"
        and isinstance(func.value, ast.Name)
        and func.value.id == "subprocess"
    ):
        return False
    if not node.args:
        return False
    strings = [
        item.value
        for item in getattr(node.args[0], "elts", [])
        if isinstance(item, ast.Constant) and isinstance(item.value, str)
    ]
    return strings[:3] == ["gh", "pr", "merge"]


def _is_merge_pr_call(node: ast.Call) -> bool:
    return isinstance(node.func, ast.Attribute) and node.func.attr == "merge_pr"


if __name__ == "__main__":
    unittest.main()
