from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .evidence_probe import BaselineResolution, GitProbeSession
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
    probe_session: GitProbeSession | None = None,
) -> EvidenceEnvelope:
    """Grade one evidence ref against the committed tree at ``target_sha``.

    ``probe_session`` is the clock and baseline cache of the DECISION this
    ref belongs to (`evidence_probe.GitProbeSession`): a caller grading many
    refs for one submission constructs one session and passes it to every
    call, so the baseline is resolved once and the whole decision's git
    probes share one liveness bound. A call without one gets a fresh
    session — the production bounds, scoped to this ref.
    """
    session = probe_session if probe_session is not None else GitProbeSession()
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
    # The baseline is resolved ONCE per decision (cached on the session):
    # `None` when the caller threaded no target at all, a readable commit,
    # or a resolution that says WHY the workspace cannot read it.
    baseline = _resolve_baseline(root, target_sha, session)
    resolved_target_sha = (
        None if baseline is None
        else (baseline.commit_sha if baseline.readable else baseline.requested)
    )
    is_glob = _is_glob(path_part) and not exists
    glob_match_count: int | None = None
    # Tri-state outcome of the ONE probe against the committed tree: True
    # (the tree has exactly this), False (the tree was read and disagrees),
    # None (the tree could not be read). ``attempted`` separates "no probe
    # ran" from "the probe ran and could not answer".
    verification: bool | None = None
    attempted = False
    if not validation_errors and self_output_class is None and not is_glob:
        if baseline is not None and not baseline.readable and exists:
            # The baseline probe ran and this workspace cannot read the
            # commit — `bad object` because the target was never fetched
            # here, `not a git repository`, or a stall. Nothing about the
            # path can be compared; a path probe would fail for the SAME
            # reason and read as the agent's disagreement.
            attempted = True
        elif is_file and baseline is not None and baseline.readable:
            attempted = True
            verification = _git_blob_matches(
                root, canonical_ref, baseline.commit_sha, content_hash,
                session=session,
            )
        elif is_dir and baseline is not None and baseline.readable:
            attempted = True
            verification = _git_tree_exists(
                root, canonical_ref, baseline.commit_sha, session=session,
            )
    if validation_errors:
        trust_grade = "invalid"
    elif self_output_class is not None:
        trust_grade = "self_output"
    elif is_glob:
        # E5/M1 — grade the glob by its real committed matches.
        trust_grade, glob_match_count = _glob_repo_verified(
            root, canonical_ref, baseline, session=session,
        )
    elif verification is True:
        trust_grade = "repo_verified"
    elif attempted and verification is None:
        # A probe RAN and git did not answer — a stall past its retries, a
        # binary that could not be spawned, a decision whose probe clock
        # ran out — or the baseline commit is not readable from this
        # workspace at all. Nothing was compared, so this cannot wear
        # ``worktree_candidate``'s name (below): that grade is a statement
        # about the agent's evidence, and this is a statement about the
        # host. Observed on the loaded pre-push host of 2026-09-12: one
        # `git show` past its bound graded a committed glob "disagrees with
        # the tree". The 2026-08-09 `baseline_unavailable` lesson, one probe
        # deeper. Still unverified — every policy rejects it — but under a
        # name the acceptance seam can retry on instead of charging the
        # request.
        trust_grade = "verification_unavailable"
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


def _resolve_baseline(
    root: Path,
    target_sha: str | None,
    session: GitProbeSession,
) -> BaselineResolution | None:
    """``None`` when no target was threaded (nothing to verify against);
    otherwise the session's once-per-decision resolution of it."""
    if not isinstance(target_sha, str) or not target_sha.strip():
        return None
    return session.resolve_baseline(root, target_sha)


def _git_blob_matches(
    root: Path,
    rel: str,
    target_sha: str,
    content_hash: str | None,
    *,
    session: GitProbeSession,
) -> bool | None:
    """Does the blob at ``target_sha:rel`` hash to ``content_hash``?

    Tri-state on purpose. ``True``/``False`` are verdicts about the tree;
    ``None`` means the probe could not run (git did not answer inside the
    session's bounds, or could not be spawned) and NO verdict exists.
    Collapsing ``None`` into ``False`` graded a host that was slow as an
    agent that was wrong. ``target_sha`` is a commit the session already
    proved readable, so a non-zero exit here is about the PATH: the tree
    was read and does not carry it.
    """
    if not content_hash:
        return False
    outcome = session.run(["git", "show", f"{target_sha}:{rel}"], cwd=root)
    if not outcome.answered:
        return None
    if outcome.returncode != 0:
        return False
    blob_hash = "sha256:" + hashlib.sha256(outcome.stdout).hexdigest()
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
# A glob is graded repo-verified only when EVERY match resolves as a
# committed blob at the baseline SHA. Verifying a bounded sample and
# generalizing to the set (the pre-audit shape) let an uncommitted file
# hide behind five sorted-first committed siblings. A glob with more
# matches than this ceiling is graded insufficient — never
# verified-by-sample.
_GLOB_VERIFY_LIMIT = 500


def _is_glob(path_part: str) -> bool:
    return any(ch in path_part for ch in _GLOB_METACHARS)


def _glob_repo_verified(
    root: Path,
    path_part: str,
    baseline: BaselineResolution | None,
    *,
    session: GitProbeSession,
) -> tuple[str, int]:
    """(grade, match_count) for a glob ref.

    Deterministic: sorted worktree matches; every match must resolve as a
    real blob at the baseline so a glob that matches only uncommitted files
    cannot pass. No baseline → cannot verify committment → not glob-verified.
    A baseline this workspace cannot read, or a match whose probe could not
    run, grades the whole glob ``verification_unavailable``: the set was not
    compared, so it can be neither verified nor called a disagreement.
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
    if baseline is None:
        # Nothing to verify committment against — honest "unbaselined", not
        # verified (mirrors the file path's baseline_unavailable).
        return ("baseline_unavailable", count)
    if not baseline.readable:
        return ("verification_unavailable", count)
    if count > _GLOB_VERIFY_LIMIT:
        # More matches than the verification ceiling: honest insufficient
        # evidence, not a sample generalized into a grade.
        return ("glob_too_large_to_verify", count)
    for match in matches:
        try:
            rel = match.resolve().relative_to(root).as_posix()
        except ValueError:
            return ("worktree_candidate", count)
        content_hash = _file_sha256(match)
        verification = _git_blob_matches(
            root, rel, baseline.commit_sha, content_hash, session=session,
        )
        if verification is None:
            return ("verification_unavailable", count)
        if verification is False:
            return ("worktree_candidate", count)
    return ("repo_glob_verified", count)


def _git_tree_exists(
    root: Path,
    rel: str,
    target_sha: str,
    *,
    session: GitProbeSession,
) -> bool | None:
    """Is ``target_sha:rel`` a tree? Tri-state like ``_git_blob_matches``:
    ``None`` is "the probe could not run", never a verdict."""
    outcome = session.run(["git", "cat-file", "-t", f"{target_sha}:{rel}"], cwd=root)
    if not outcome.answered:
        return None
    return (
        outcome.returncode == 0
        and outcome.stdout.decode("utf-8", errors="replace").strip() == "tree"
    )


__all__ = [
    "EvidenceEnvelope",
    "EvidencePolicy",
    "GitProbeSession",
    "SELF_OUTPUT_PREFIXES",
    "classify_evidence_ref",
]
