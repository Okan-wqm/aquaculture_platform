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
    is_glob: bool = False
    glob_match_count: int | None = None

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
            "is_glob": self.is_glob,
            "glob_match_count": self.glob_match_count,
            "validation_errors": list(self.validation_errors),
        }


# E5/M1 — the belief-evidence acceptance set. A finding must cite ONE
# concrete file:line (repo_verified); a belief may cite a CLASS of files
# via a glob that matches real committed files (repo_glob_verified). The
# strict require_repo_verified below is UNCHANGED so finding evidence stays
# file-exact.
REPO_OR_GLOB_VERIFIED_GRADES: frozenset[str] = frozenset(
    {"repo_verified", "repo_glob_verified"}
)


class EvidencePolicy:
    @staticmethod
    def require_repo_verified(envelope: EvidenceEnvelope) -> None:
        if envelope.trust_grade != "repo_verified":
            raise GovernanceError(
                f"evidence_ref_not_repo_verified:{envelope.canonical_ref}:"
                f"{envelope.trust_grade}"
            )

    @staticmethod
    def require_repo_or_glob_verified(envelope: EvidenceEnvelope) -> None:
        """E5/M1 — belief-scoped: file OR class-of-files evidence."""
        if envelope.trust_grade not in REPO_OR_GLOB_VERIFIED_GRADES:
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
    is_glob = _is_glob(path_part) and not exists
    glob_match_count: int | None = None
    if validation_errors:
        trust_grade = "invalid"
    elif self_output_class is not None:
        trust_grade = "self_output"
    elif is_glob:
        # E5/M1 — grade the glob by its real committed matches.
        trust_grade, glob_match_count = _glob_repo_verified(root, canonical_ref, resolved_target_sha)
    elif is_file and resolved_target_sha and _git_blob_matches(root, canonical_ref, resolved_target_sha, content_hash):
        trust_grade = "repo_verified"
    elif is_dir and resolved_target_sha and _git_tree_exists(root, canonical_ref, resolved_target_sha):
        trust_grade = "repo_verified"
    elif exists and resolved_target_sha is None:
        # NO BASELINE, so nothing could be verified — a different fact from
        # "verified and did not match", and it must not wear the same name.
        #
        # `worktree_candidate` says the agent's evidence disagrees with the
        # committed tree, which is a claim about the AGENT. When the caller
        # threaded no `target_sha`, the validator never attempted the
        # comparison at all, and reporting that as the agent's fault is how a
        # harness gap reads as agent misbehaviour.
        #
        # Observed live 2026-08-09: an autonomy-lane result was rejected with
        # 44 `agent_evidence_not_repo_verified` reasons, every ref a real file
        # the agent had genuinely read. The lane minted its requests without a
        # target_sha; the agent was blameless and the message said otherwise.
        # A policy that requires repo-verified evidence still rejects this —
        # correctly, because nothing was verified — but now it says WHY.
        trust_grade = "baseline_unavailable"
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
        "is_glob": is_glob,
        "glob_match_count": glob_match_count,
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
        is_glob=is_glob,
        glob_match_count=glob_match_count,
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


# E5/M1 — glob evidence. Beliefs are propositions about a CLASS of files
# ("every *.entity.ts in farm-service carries tenantId"), and the class is
# named by a glob, which is neither a file nor a directory. The pre-E5
# classifier graded a glob "missing" and require_repo_verified rejected it,
# so EVERY adapter belief candidate (all four emit glob evidence) died at
# the door — ARIA learned 0 beliefs from any tool. A glob is honest
# evidence when it matches real committed files; this grades it as such,
# distinct from a bare missing path.
_GLOB_METACHARS = ("*", "?", "[")
MIN_GLOB_MATCHES = 1
_GLOB_SAMPLE_SIZE = 5


def _is_glob(path_part: str) -> bool:
    return any(ch in path_part for ch in _GLOB_METACHARS)


def _glob_repo_verified(
    root: Path, path_part: str, target_sha: str | None
) -> tuple[str, int]:
    """(grade, match_count) for a glob ref.

    Deterministic: sorted worktree matches; a bounded sample must resolve as
    real blobs at target_sha so a glob that matches only uncommitted files
    cannot pass. No baseline → cannot verify committment → not glob-verified.
    """
    try:
        matches = sorted(
            p for p in root.glob(path_part)
            if p.is_file()
        )
    except (ValueError, OSError):
        return ("empty_glob", 0)
    count = len(matches)
    if count < MIN_GLOB_MATCHES:
        return ("empty_glob", 0)
    if target_sha is None:
        # Nothing to verify committment against — honest "unbaselined", not
        # verified (mirrors the file path's baseline_unavailable).
        return ("baseline_unavailable", count)
    for match in matches[:_GLOB_SAMPLE_SIZE]:
        try:
            rel = match.resolve().relative_to(root).as_posix()
        except ValueError:
            return ("worktree_candidate", count)
        content_hash = _file_sha256(match)
        if not _git_blob_matches(root, rel, target_sha, content_hash):
            return ("worktree_candidate", count)
    return ("repo_glob_verified", count)


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
