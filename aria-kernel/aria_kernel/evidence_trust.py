from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from .canonical_path import _canonical_evidence_path
from .tool_registry import GovernanceError


SELF_OUTPUT_PREFIXES: tuple[str, ...] = (
    "aria-tools/",
    "agent-workspace/",
    ".aria-poc/",
    "aria-findings/",
    "aria-debts/",
    "aria-proposals/",
    "aria-incidents/",
)

SourceType = Literal[
    "repo_source",
    "operator",
    "tool_output",
    "agent_output",
    "external_scanner",
    "legacy",
    "unknown",
]
TrustGrade = Literal[
    "repo_verified",
    "worktree_candidate",
    "external_candidate",
    "legacy_trust_unclassified",
    "self_output",
    "missing",
    "invalid",
]
SelfOutputClass = Literal["none", "aria_self_output", "outside_repo", "unresolvable"]

EVIDENCE_TRUST_SCHEMA_VERSION = "aria/evidence-envelope/v2"
EVIDENCE_TRUST_VERIFIER_VERSION = "evidence-trust-v2"


@dataclass(frozen=True)
class EvidenceEnvelope:
    schema_version: str
    verifier_version: str
    raw_ref: str
    canonical_ref: str | None
    source_type: SourceType
    trust_grade: TrustGrade
    self_output_class: SelfOutputClass
    exists: bool
    line: int | None
    content_hash: str | None
    repo_root: str | None
    target_sha: str | None
    validation_errors: tuple[str, ...]
    envelope_hash: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def classify_self_output(
    raw_ref: str,
    *,
    workspace_root: str | Path | None = None,
) -> SelfOutputClass:
    envelope = classify_evidence_ref(
        raw_ref,
        workspace_root=workspace_root,
        source_hint="unknown",
        allow_self_output=True,
    )
    return envelope.self_output_class


def classify_evidence_ref(
    raw_ref: Any,
    *,
    workspace_root: str | Path | None = None,
    source_hint: str | None = None,
    context: str | None = None,
    allow_self_output: bool = False,
    target_sha: str | None = None,
) -> EvidenceEnvelope:
    raw = str(raw_ref or "").strip().replace("\\", "/")
    line: int | None = None
    path_part = raw
    if ":" in raw:
        candidate_path, candidate_line, _tail = raw.split(":", 2) if raw.count(":") >= 2 else (*raw.split(":", 1), "")
        if candidate_line.isdigit():
            path_part = candidate_path
            line = int(candidate_line)

    source_type = _source_type(source_hint)
    errors: list[str] = []
    canonical_ref: str | None = None
    absolute: Path | None = None
    repo_root: Path | None = Path(workspace_root).resolve() if workspace_root is not None else None
    self_output: SelfOutputClass = "none"

    if not raw:
        errors.append("evidence_ref_empty")
        return _envelope(
            raw_ref=raw,
            canonical_ref=None,
            source_type=source_type,
            trust_grade="invalid",
            self_output_class="unresolvable",
            exists=False,
            line=line,
            content_hash=None,
            repo_root=repo_root,
            target_sha=target_sha,
            validation_errors=errors,
        )

    if repo_root is not None:
        try:
            canonical_ref, absolute = _canonical_evidence_path(path_part, repo_root)
        except GovernanceError as exc:
            msg = str(exc)
            self_output = "outside_repo" if msg.startswith("evidence_path_outside_repo") else "unresolvable"
            errors.append(msg)
    else:
        canonical_ref = _normalize_legacy(path_part)

    if canonical_ref and canonical_ref.startswith(SELF_OUTPUT_PREFIXES):
        self_output = "aria_self_output"
        if not allow_self_output:
            errors.append("self_output_evidence")

    resolved_target_sha: str | None = None
    if repo_root is not None:
        candidate_sha = target_sha if target_sha is not None else _git_head(repo_root)
        if candidate_sha:
            resolved_target_sha = _resolve_commit_sha(repo_root, candidate_sha)
            if resolved_target_sha is None:
                errors.append("target_sha_unresolved")
        target_sha = resolved_target_sha

    commit_bound = repo_root is not None and target_sha is not None and canonical_ref is not None
    git_blob = (
        _git_blob(repo_root, target_sha, canonical_ref)
        if commit_bound
        else None
    )
    if git_blob is not None:
        exists = True
        content_hash = _bytes_sha256(git_blob)
        line_count = _line_count_bytes(git_blob)
    else:
        exists = bool(absolute is not None and absolute.exists() and absolute.is_file())
        content_hash = _file_sha256(absolute) if exists and absolute is not None else None
        line_count = _line_count(absolute) if exists and absolute is not None else 0
        if commit_bound and exists:
            errors.append("target_sha_blob_missing")
    if absolute is not None and not exists:
        errors.append("evidence_path_missing")
    if line is not None:
        if line <= 0:
            errors.append("evidence_line_invalid")
        elif exists and line > line_count:
            errors.append("evidence_line_missing")

    trust_grade: TrustGrade
    if self_output == "aria_self_output" and not allow_self_output:
        trust_grade = "self_output"
    elif errors and not (set(errors) == {"evidence_path_missing"}):
        if set(errors) == {"target_sha_blob_missing"}:
            trust_grade = "worktree_candidate"
        else:
            trust_grade = "invalid"
    elif not exists:
        trust_grade = "missing"
    elif source_type == "legacy":
        trust_grade = "legacy_trust_unclassified"
    elif source_type == "external_scanner":
        trust_grade = "external_candidate"
    elif commit_bound and git_blob is None:
        trust_grade = "worktree_candidate"
    elif not commit_bound:
        trust_grade = "worktree_candidate"
    else:
        trust_grade = "repo_verified"

    if context:
        errors = [*errors, f"context:{context}"] if errors else []

    return _envelope(
        raw_ref=raw,
        canonical_ref=canonical_ref,
        source_type=source_type,
        trust_grade=trust_grade,
        self_output_class=self_output,
        exists=exists,
        line=line,
        content_hash=content_hash,
        repo_root=repo_root,
        target_sha=target_sha,
        validation_errors=errors,
    )


def envelope_hash(payload: dict[str, Any]) -> str:
    candidate = {
        key: payload.get(key)
        for key in (
            "raw_ref",
            "canonical_ref",
            "source_type",
            "trust_grade",
            "self_output_class",
            "exists",
            "line",
            "target_sha",
            "content_hash",
            "verifier_version",
            "validation_errors",
        )
    }
    candidate.pop("envelope_hash", None)
    raw = json.dumps(candidate, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


class EvidencePolicy:
    """Single trust-policy chokepoint for enterprise trusted writes."""

    @staticmethod
    def require_repo_verified(envelope: EvidenceEnvelope | dict[str, Any]) -> dict[str, Any]:
        payload = envelope.to_dict() if isinstance(envelope, EvidenceEnvelope) else dict(envelope)
        if payload.get("trust_grade") != "repo_verified":
            raise GovernanceError(
                "evidence_not_repo_verified: "
                f"ref={payload.get('raw_ref')!r} grade={payload.get('trust_grade')!r} "
                f"errors={payload.get('validation_errors')!r}"
            )
        if not payload.get("target_sha"):
            raise GovernanceError(f"evidence_repo_verified_requires_target_sha:{payload.get('raw_ref')!r}")
        if not payload.get("content_hash"):
            raise GovernanceError(f"evidence_repo_verified_requires_content_hash:{payload.get('raw_ref')!r}")
        return payload


def _envelope(
    *,
    raw_ref: str,
    canonical_ref: str | None,
    source_type: SourceType,
    trust_grade: TrustGrade,
    self_output_class: SelfOutputClass,
    exists: bool,
    line: int | None,
    content_hash: str | None,
    repo_root: Path | None,
    target_sha: str | None,
    validation_errors: list[str],
) -> EvidenceEnvelope:
    payload: dict[str, Any] = {
        "schema_version": EVIDENCE_TRUST_SCHEMA_VERSION,
        "verifier_version": EVIDENCE_TRUST_VERIFIER_VERSION,
        "raw_ref": raw_ref,
        "canonical_ref": canonical_ref,
        "source_type": source_type,
        "trust_grade": trust_grade,
        "self_output_class": self_output_class,
        "exists": exists,
        "line": line,
        "content_hash": content_hash,
        "repo_root": repo_root.as_posix() if repo_root is not None else None,
        "target_sha": target_sha,
        "validation_errors": tuple(validation_errors),
    }
    payload["envelope_hash"] = envelope_hash(payload)
    return EvidenceEnvelope(**payload)


def _source_type(source_hint: str | None) -> SourceType:
    if source_hint in {
        "repo_source",
        "operator",
        "tool_output",
        "agent_output",
        "external_scanner",
        "legacy",
    }:
        return source_hint  # type: ignore[return-value]
    return "unknown"


def _normalize_legacy(path: str) -> str:
    ref = path.replace("\\", "/")
    while ref.startswith("./"):
        ref = ref[2:]
    return ref


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return "sha256:" + digest.hexdigest()


def _line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8", errors="replace").splitlines())


def _line_count_bytes(raw: bytes) -> int:
    return len(raw.decode("utf-8", errors="replace").splitlines())


def _bytes_sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _git_head(repo_root: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def _resolve_commit_sha(repo_root: Path, target_sha: str) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", f"{target_sha}^{{commit}}"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    resolved = result.stdout.strip()
    if result.returncode != 0 or len(resolved) != 40:
        return None
    if not all(ch in "0123456789abcdef" for ch in resolved):
        return None
    return resolved


def _git_blob(repo_root: Path, target_sha: str, canonical_ref: str) -> bytes | None:
    result = subprocess.run(
        ["git", "show", f"{target_sha}:{canonical_ref}"],
        cwd=repo_root,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout


__all__ = [
    "EVIDENCE_TRUST_SCHEMA_VERSION",
    "EVIDENCE_TRUST_VERIFIER_VERSION",
    "EvidenceEnvelope",
    "SELF_OUTPUT_PREFIXES",
    "classify_evidence_ref",
    "classify_self_output",
    "envelope_hash",
]
