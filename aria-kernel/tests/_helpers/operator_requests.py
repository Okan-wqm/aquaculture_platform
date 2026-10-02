"""Operator-signed plan requests for tests (ADR-0018 / ADR-0020) — never the operator's key.

A fixture is a git checkout that commits its own allowed-signers file for a
throwaway ed25519 key minted in the test's temp dir, plus the code files a
finding can cite, and a tools store under it. ``record`` goes through the
production recorder (``record_operator_request``), so the bytes a test admits
are the bytes the CLI writes; ``seed_finding`` writes the finding-event fold
and the frozen ``F-*.json`` the way ``finding.emit_finding`` lays them out.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from aria_kernel.finding import findings_dir
from aria_kernel.operator_feedback_signature import record_operator_request
from aria_kernel.operator_request_signature import (
    ALLOWED_SIGNERS_PATH,
    SIGNATURE_NAMESPACE,
    sign_operator_request,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import make_local_git_repo

PRINCIPAL = "operator@aria.test"
# A code path every grounded finding below may cite: tracked, writable.
GROUNDED_FILE = "apps/hr-service/src/leave/leave.service.ts"


def mint_ed25519_key(directory: Path, name: str = "operator-key") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    key = directory / name
    subprocess.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "aria-test", "-f", str(key)],
        check=True, capture_output=True, stdin=subprocess.DEVNULL,
    )
    return key


def allowed_signers_line(principal: str, key: Path, namespace: str = SIGNATURE_NAMESPACE) -> str:
    keytype, blob = key.with_suffix(".pub").read_text(encoding="utf-8").split()[:2]
    return f'{principal} namespaces="{namespace}" {keytype} {blob} aria-test\n'


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout


class OperatorRequestFixture:
    """A checkout + tools store + throwaway operator key, enrolled at HEAD."""

    def __init__(self, root: Path, *, principal: str = PRINCIPAL) -> None:
        self.root = root
        self.principal = principal
        self.key = mint_ed25519_key(root / "keys")
        self.repo = make_local_git_repo(root, name="repo")
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        self.commit_files({
            ALLOWED_SIGNERS_PATH: allowed_signers_line(principal, self.key),
            GROUNDED_FILE: "export const leave = 1;\n",
            ".github/workflows/ci.yml": "name: ci\n",
            "aria-kernel/aria_kernel/example.py": "X = 1\n",
        })

    def commit_files(self, files: dict[str, str], message: str = "chore(test): fixture") -> str:
        for relative, text in files.items():
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            _git(self.repo, "add", "--", relative)
        _git(self.repo, "commit", "-q", "-m", message)
        return _git(self.repo, "rev-parse", "HEAD").strip()

    def record(
        self, *, finding_id: str = "F-007", request: str = "Fix the leave balance drift",
        priority: str = "high", request_id: str | None = None,
    ) -> dict[str, Any]:
        return record_operator_request(
            request=request, priority=priority, authored_by="okan", finding_id=finding_id,
            signing_key=self.key, signer_principal=self.principal, request_id=request_id,
            base_dir=self.tools, repo_root=self.repo,
        )

    def sign(self, row: dict[str, Any], *, key: Path | None = None, principal: str | None = None) -> dict[str, Any]:
        return sign_operator_request(row, signing_key=key or self.key, signer_principal=principal or self.principal)

    def append_raw(self, row: dict[str, Any]) -> dict[str, Any]:
        """Append a row past the recorder — what a runner-uid process could do."""
        return append_declared_fixture(
            self.tools / "operator-feedback.jsonl", row, expected_surface="operator_feedback",
        )

    def seed_finding(
        self, finding_id: str, *, refs: list[str], status: str = "OPEN",
        body: dict[str, Any] | None = None,
    ) -> Path:
        """Mint ``finding_id`` OPEN in the event fold, then move it to ``status``.

        ``F-*.json`` keeps the mint-time OPEN status on purpose: the fold is
        the authority, and a reader of the JSON would see the wrong answer.
        """
        directory = findings_dir(self.repo)
        directory.mkdir(parents=True, exist_ok=True)
        record = {
            "$schema": "aria/finding/v1", "finding_id": finding_id, "severity": "HIGH",
            "status": "OPEN", "claim_type": "wrong_code", "claim_summary": "fixture finding",
            "certainty": "OBSERVED", "evidences": [
                {"ref": ref, "evidence_envelope": {"canonical_ref": ref, "trust_grade": "repo_verified"}}
                for ref in refs
            ],
            "scope": {"files": []}, "facts": [], "recommendation": None,
            **(body or {}),
        }
        events = directory / "finding-events.jsonl"
        append_declared_fixture(events, {
            "schema_version": 1, "event": "finding_emitted", "event_id": f"finding:{finding_id}:emitted",
            "finding_id": finding_id, "record": record,
        }, expected_surface="repo_finding_events")
        if status != "OPEN":
            append_declared_fixture(events, {
                "schema_version": 1, "event": "finding_status_changed",
                "event_id": f"finding:{finding_id}:{status}", "finding_id": finding_id,
                "to_status": status, "reason": "fixture", "actor": "test",
            }, expected_surface="repo_finding_events")
        path = directory / f"{finding_id}.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        return path


__all__ = [
    "GROUNDED_FILE",
    "PRINCIPAL",
    "OperatorRequestFixture",
    "allowed_signers_line",
    "mint_ed25519_key",
]
