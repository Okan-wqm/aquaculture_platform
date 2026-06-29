from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError


SELF_OUTPUT_PREFIXES: tuple[str, ...] = (
    "aria-findings/",
    "aria-debts/",
    "aria-proposals/",
    "aria-incidents/",
    "aria-tools/",
    "agent-workspace/",
    ".aria-poc/",
    "runner-temp/",
    "tmp/",
)


@dataclass(frozen=True)
class EvidenceEnvelope:
    canonical_ref: str
    line: int | None
    source_hint: str | None
    trust_grade: str
    self_output_class: str | None
    content_hash: str | None
    envelope_hash: str
    target_sha: str | None = None
    exists: bool = False
    validation_errors: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "canonical_ref": self.canonical_ref,
            "line": self.line,
            "source_hint": self.source_hint,
            "trust_grade": self.trust_grade,
            "self_output_class": self.self_output_class,
            "content_hash": self.content_hash,
            "envelope_hash": self.envelope_hash,
            "target_sha": self.target_sha,
            "exists": self.exists,
            "validation_errors": list(self.validation_errors),
        }


class EvidencePolicy:
    @staticmethod
    def require_repo_verified(envelope: EvidenceEnvelope) -> None:
        if envelope.trust_grade != "repo_verified":
            raise GovernanceError(
                f"evidence_ref_not_repo_verified:{envelope.canonical_ref}:"
                f"{envelope.trust_grade}"
            )


def classify_evidence_ref(
    ref: str,
    *,
    workspace_root: str | Path | None = None,
    source_hint: str | None = None,
    context: str | None = None,
    target_sha: str | None = None,
) -> EvidenceEnvelope:
    path_part, line = _split_ref(ref)
    root = Path.cwd().resolve() if workspace_root is None else Path(workspace_root).resolve()
    canonical_ref, absolute, validation_errors = _canonicalize(path_part, root)
    self_output_class = (
        "aria_self_output"
        if any(canonical_ref.startswith(prefix) for prefix in SELF_OUTPUT_PREFIXES)
        else None
    )
    is_file = absolute.exists() and absolute.is_file()
    is_dir = absolute.exists() and absolute.is_dir()
    exists = is_file or is_dir
    content_hash = _file_sha256(absolute) if is_file else None
    resolved_target_sha = _resolve_target_sha(root, target_sha)
    # Plan 031-R R3 (B4) — a cited line MUST exist in the file. Pre-R3 only the
    # path was checked, so `real.ts:999999` resolved as worktree_candidate even
    # though the line does not exist. A line beyond the file's length is a
    # fabricated citation → invalid.
    if is_file and line is not None and line > 0:
        try:
            line_count = len(absolute.read_text(encoding="utf-8", errors="replace").splitlines())
        except OSError:
            line_count = 0
        if line > line_count:
            validation_errors = (*validation_errors, f"line_out_of_bounds:{line}>{line_count}")
    if validation_errors:
        trust_grade = "invalid"
    elif self_output_class is not None:
        trust_grade = "self_output"
    elif is_file and resolved_target_sha and _git_blob_matches(root, canonical_ref, resolved_target_sha, content_hash):
        trust_grade = "repo_verified"
    elif is_dir and resolved_target_sha and _git_tree_exists(root, canonical_ref, resolved_target_sha):
        trust_grade = "repo_verified"
    elif exists:
        trust_grade = "worktree_candidate"
    else:
        trust_grade = "missing"
    envelope_payload = {
        "canonical_ref": canonical_ref,
        "line": line,
        "source_hint": source_hint,
        "context": context,
        "trust_grade": trust_grade,
        "self_output_class": self_output_class,
        "content_hash": content_hash,
        "target_sha": resolved_target_sha,
        "exists": exists,
        "validation_errors": list(validation_errors),
    }
    envelope_hash = "sha256:" + hashlib.sha256(
        json.dumps(envelope_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()
    return EvidenceEnvelope(
        canonical_ref=canonical_ref,
        line=line,
        source_hint=source_hint,
        trust_grade=trust_grade,
        self_output_class=self_output_class,
        content_hash=content_hash,
        envelope_hash=envelope_hash,
        target_sha=resolved_target_sha,
        exists=exists,
        validation_errors=validation_errors,
    )


def _split_ref(ref: str) -> tuple[str, int | None]:
    raw = str(ref or "").strip()
    if not raw:
        return "", None
    path, sep, suffix = raw.rpartition(":")
    if sep and suffix.isdigit() and path:
        return path, int(suffix)
    return raw, None


def _canonicalize(raw_path: str, root: Path) -> tuple[str, Path, tuple[str, ...]]:
    if not raw_path.strip():
        return "", root, ("empty_evidence_ref",)
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        absolute = candidate.resolve()
    except (OSError, ValueError) as exc:
        absolute = candidate.absolute()
        return Path(raw_path).as_posix(), absolute, (f"path_resolution_failed:{type(exc).__name__}",)
    try:
        canonical = absolute.relative_to(root).as_posix()
    except ValueError:
        canonical = Path(raw_path).as_posix()
        return canonical, absolute, ("path_outside_workspace",)
    return canonical, absolute, ()


def _file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _resolve_target_sha(root: Path, target_sha: str | None) -> str | None:
    if not isinstance(target_sha, str) or not target_sha.strip():
        return None
    try:
        proc = subprocess.run(
            ["git", "rev-parse", target_sha],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return target_sha.strip()
    value = proc.stdout.strip()
    return value if proc.returncode == 0 and value else target_sha.strip()


def _git_blob_matches(root: Path, rel: str, target_sha: str, content_hash: str | None) -> bool:
    if not content_hash:
        return False
    try:
        proc = subprocess.run(
            ["git", "show", f"{target_sha}:{rel}"],
            cwd=root,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if proc.returncode != 0:
        return False
    blob_hash = "sha256:" + hashlib.sha256(proc.stdout).hexdigest()
    return blob_hash == content_hash


def _git_tree_exists(root: Path, rel: str, target_sha: str) -> bool:
    try:
        proc = subprocess.run(
            ["git", "cat-file", "-t", f"{target_sha}:{rel}"],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0 and proc.stdout.strip() == "tree"


__all__ = [
    "EvidenceEnvelope",
    "EvidencePolicy",
    "SELF_OUTPUT_PREFIXES",
    "classify_evidence_ref",
]
