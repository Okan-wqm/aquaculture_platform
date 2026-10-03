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

ADR-0023 — the fixture's key is enrolled for the four operator namespaces,
and its first commit carries the enrolment genesis row for its own pair.
The kernel pins ONE genesis (the repository's); a fixture's throwaway pair
can never match it, so importing this helper widens ``genesis_pinned`` to
also accept a genesis a fixture minted in this process — never anything
else, and never outside tests (production code does not import this
module). ``enrol`` changes the anchor the only way production allows: the
production writer signs the edited pair as the child of the committed one.
"""

from __future__ import annotations

import io
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aria_kernel import operator_request_signature as _ors
from aria_kernel.finding import findings_dir
from aria_kernel.finding_grounding import admit_finding, load_grounding_context
from aria_kernel.operator_feedback_signature import record_operator_request
from aria_kernel.operator_request_signature import (
    ALLOWED_SIGNERS_PATH,
    ENROLMENTS_PATH,
    NAMESPACE_REGISTRY_PATH,
    OPERATOR_NAMESPACES,
    SIGNATURE_NAMESPACE,
    AllowedSigners,
    enrolment_genesis_row,
    parse_namespace_registry,
    record_enrolment,
    sign_operator_request,
)
from aria_kernel.operator_approval import OPERATORS_POLICY_RELPATH
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import make_local_git_repo

PRINCIPAL = "operator@aria.test"
_REPO_ROOT = Path(__file__).resolve().parents[3]
# ADR-0023 — the registry a fixture commits is the repository's own, byte
# for byte, so the namespaces a test signs in are the ones production reads.
REGISTRY_BYTES = (_REPO_ROOT / NAMESPACE_REGISTRY_PATH).read_bytes()
# ARIA-LOW-267 — the operators policy is read at the anchor commit too.
OPERATORS_POLICY_TEXT = (_REPO_ROOT / OPERATORS_POLICY_RELPATH).read_text(encoding="utf-8")
AUDIENCE = json.loads(OPERATORS_POLICY_TEXT)["repository"]
# A code path every grounded finding below may cite: tracked, writable.
GROUNDED_FILE = "apps/hr-service/src/leave/leave.service.ts"
_ZERO_DIGEST = "sha256:" + "0" * 64
ALL_OPERATOR_NAMESPACES = ",".join(OPERATOR_NAMESPACES)
_FIXTURE_GENESES: list[dict[str, str]] = []
_production_genesis_pinned = _ors.genesis_pinned


def _genesis_pinned_or_minted_here(child: Any) -> bool:
    return _production_genesis_pinned(child) or child in _FIXTURE_GENESES


_ors.genesis_pinned = _genesis_pinned_or_minted_here


def genesis_line(allowed_signers: bytes, registry: bytes = REGISTRY_BYTES, *, pin: bool = True) -> str:
    """The genesis row for a pair, registered as a fixture genesis unless ``pin`` is False."""
    row = enrolment_genesis_row(allowed_signers, registry)
    if pin:
        _FIXTURE_GENESES.append(row["child"])
    return json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n"


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


def anchor_from_bytes(allowed_signers: bytes, registry: bytes = REGISTRY_BYTES) -> AllowedSigners:
    """An anchor for verifier unit tests that need no git checkout."""
    namespaces = parse_namespace_registry(registry)
    assert namespaces is not None, "the committed namespace registry must parse"
    return AllowedSigners(content=allowed_signers, commit="0" * 40, blob_oid="0" * 40, namespaces=namespaces,
                          audience=AUDIENCE)


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
        signers = allowed_signers_line(principal, self.key, namespace=ALL_OPERATOR_NAMESPACES)
        self.commit_files({
            ALLOWED_SIGNERS_PATH: signers,
            NAMESPACE_REGISTRY_PATH: REGISTRY_BYTES.decode("utf-8"),
            ENROLMENTS_PATH: genesis_line(signers.encode("utf-8")),
            OPERATORS_POLICY_RELPATH: OPERATORS_POLICY_TEXT,
            GROUNDED_FILE: "export const leave = 1;\n",
            "apps/hr-service/src/leave/leave.entity.ts": "export class Leave {}\n",
            ".github/workflows/ci.yml": "name: ci\n",
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

    def enrol(self, files: dict[str, str], *, key: Path | None = None, principal: str | None = None,
              actor_class: str = "T0", expires_in_hours: int = 24) -> dict[str, Any]:
        """Change the allowed-signers file and/or the registry through a signed enrolment, on main."""
        for relative, text in files.items():
            (self.repo / relative).write_text(text, encoding="utf-8")
        row = record_enrolment(repo_root=self.repo, base_dir=self.tools, signing_key=key or self.key,
                               signer_principal=principal or self.principal, actor_class=actor_class,
                               expires_in_hours=expires_in_hours, subject_stream=self.subjects)
        paths = (ALLOWED_SIGNERS_PATH, NAMESPACE_REGISTRY_PATH, ENROLMENTS_PATH)
        self.commit_files({path: (self.repo / path).read_text(encoding="utf-8") for path in paths},
                          message="chore(test): enrol")
        return row

    def record(
        self, *, finding_id: str = "F-007", request: str = "Fix the leave balance drift",
        priority: str = "high", request_id: str | None = None, expires_in_hours: int | None = None,
        actor_class: str = "T0",
    ) -> dict[str, Any]:
        return record_operator_request(
            request=request, priority=priority, authored_by="okan", finding_id=finding_id,
            signing_key=self.key, signer_principal=self.principal, actor_class=actor_class, request_id=request_id,
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
            "audience": AUDIENCE, "grounding_digest": admission.grounding_digest or _ZERO_DIGEST,
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
        # The commit the mint verified against: emit_finding stamps it on the
        # event, and admission re-reads each cited line there (ARIA-HIGH-332).
        append_declared_fixture(directory / "finding-events.jsonl", {
            "schema_version": 1, "event": "finding_emitted", "event_id": f"finding:{finding_id}:emitted",
            "finding_id": finding_id, "target_sha": git(self.repo, "rev-parse", "HEAD").strip(),
            "record": record,
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
    "ALL_OPERATOR_NAMESPACES",
    "AUDIENCE",
    "GROUNDED_FILE",
    "PRINCIPAL",
    "REGISTRY_BYTES",
    "OperatorRequestFixture",
    "allowed_signers_line",
    "anchor_from_bytes",
    "genesis_line",
    "git",
    "mint_ed25519_key",
]
