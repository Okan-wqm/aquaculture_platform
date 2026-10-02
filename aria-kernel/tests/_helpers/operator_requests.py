"""Operator-signed plan requests for tests (ADR-0018 / ADR-0020) — never the operator's key.

A fixture is a git checkout that commits its own allowed-signers file for a
throwaway ed25519 key minted in the test's temp dir, plus the code files a
finding can cite, and a tools store under it. Every commit is published to
``refs/remotes/origin/main`` (the checkout is "on main", as a cycle's is),
unless a test asks otherwise. ``record`` goes through the production recorder
(``record_operator_request``), so the bytes a test admits are the bytes the
CLI writes; ``request_row`` + ``sign`` + ``append_raw`` build a row past the
recorder for cases the recorder refuses on purpose. ``seed_finding`` writes
the finding-event fold and the frozen ``F-*.json`` the way
``finding.emit_finding`` lays them out.
"""

from __future__ import annotations

import io
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aria_kernel.finding import findings_dir
from aria_kernel.finding_grounding import admit_finding, load_grounding_context
from aria_kernel.operator_feedback_signature import record_operator_request
from aria_kernel.operator_request_signature import (
    ALLOWED_SIGNERS_PATH,
    SIGNATURE_NAMESPACE,
    sign_operator_request,
)
from aria_kernel.operator_request_terms import request_audience
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import make_local_git_repo

PRINCIPAL = "operator@aria.test"
# A code path every grounded finding below may cite: tracked, writable.
GROUNDED_FILE = "apps/hr-service/src/leave/leave.service.ts"
_ZERO_DIGEST = "sha256:" + "0" * 64


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


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat()


class OperatorRequestFixture:
    """A checkout on main + tools store + throwaway operator key, enrolled at HEAD."""

    def __init__(self, root: Path, *, principal: str = PRINCIPAL) -> None:
        self.root = root
        self.principal = principal
        self.key = mint_ed25519_key(root / "keys")
        self.repo = make_local_git_repo(root, name="repo")
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        self.subjects = io.StringIO()
        # Every line a fixture finding cites exists: a plan cites a ref only
        # when the challenger's evidence rule admits it, and that rule reads
        # the line (ORPHAN-HIGH-519).
        self.commit_files({
            ALLOWED_SIGNERS_PATH: allowed_signers_line(principal, self.key),
            GROUNDED_FILE: "".join(f"export const leave{n} = {n};\n" for n in range(1, 401)),
            "apps/hr-service/src/leave/leave.entity.ts": "".join(
                f"export class Leave{n} {{}}\n" for n in range(1, 11)
            ),
            ".github/workflows/ci.yml": "name: ci\non:\n  push: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
            "aria-kernel/aria_kernel/example.py": "X = 1\n",
        })

    def commit_files(self, files: dict[str, str | None], message: str = "chore(test): fixture",
                     *, on_main: bool = True) -> str:
        """Commit ``files`` (None deletes one) and, by default, publish HEAD as origin/main."""
        for relative, text in files.items():
            path = self.repo / relative
            if text is None:
                git(self.repo, "rm", "-q", "--", relative)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            git(self.repo, "add", "--", relative)
        git(self.repo, "commit", "-q", "-m", message)
        head = git(self.repo, "rev-parse", "HEAD").strip()
        if on_main:
            git(self.repo, "update-ref", "refs/remotes/origin/main", head)
        return head

    def record(
        self, *, finding_id: str = "F-007", request: str = "Fix the leave balance drift",
        priority: str = "high", request_id: str | None = None, expires_in_hours: int | None = None,
    ) -> dict[str, Any]:
        return record_operator_request(
            request=request, priority=priority, authored_by="okan", finding_id=finding_id,
            signing_key=self.key, signer_principal=self.principal, request_id=request_id,
            expires_in_hours=expires_in_hours, base_dir=self.tools, repo_root=self.repo,
            subject_stream=self.subjects,
        )

    def request_row(self, **overrides: Any) -> dict[str, Any]:
        """A complete request row with valid terms, for building rows past the recorder."""
        now = datetime.now(timezone.utc)
        finding_id = overrides.get("finding_id", "F-007")
        admission = admit_finding(load_grounding_context(self.repo), finding_id)
        row: dict[str, Any] = {
            "schema_version": 2, "row_kind": "operator_request", "id": "OP-row",
            "finding_id": finding_id, "authored_at": _iso(now), "expires_at": _iso(now + timedelta(hours=1)),
            "audience": request_audience(), "grounding_digest": admission.grounding_digest or _ZERO_DIGEST,
            "authored_by": "okan", "request": "hand-built", "priority": "high", "status": "unaddressed",
        }
        row.update(overrides)
        return row

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
        append_declared_fixture(directory / "finding-events.jsonl", {
            "schema_version": 1, "event": "finding_emitted", "event_id": f"finding:{finding_id}:emitted",
            "finding_id": finding_id, "record": record,
        }, expected_surface="repo_finding_events")
        if status != "OPEN":
            self.set_status(finding_id, status)
        path = directory / f"{finding_id}.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        return path

    def set_status(self, finding_id: str, status: str) -> None:
        append_declared_fixture(findings_dir(self.repo) / "finding-events.jsonl", {
            "schema_version": 1, "event": "finding_status_changed",
            "event_id": f"finding:{finding_id}:{status}", "finding_id": finding_id,
            "to_status": status, "reason": "fixture", "actor": "test",
        }, expected_surface="repo_finding_events")


__all__ = [
    "GROUNDED_FILE",
    "PRINCIPAL",
    "OperatorRequestFixture",
    "allowed_signers_line",
    "git",
    "mint_ed25519_key",
]
