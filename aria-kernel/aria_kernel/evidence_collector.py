"""Plan ARIA-V6 §2d v2 Phase 0 — pre-authoring evidence collection.

V6.2's convergent_skill_authoring loop demands that primary↔challenger
debate be bound to REAL repository observations, not hallucinated rule
space. ``collect_evidence_pack()`` is the Phase 0 gate: BEFORE any
drafter agent is invoked, scan the workspace for ≥10 file:line snippets
matching the seed's declared claim_types and freeze them in an
evidence_pack bound to ``base_commit_sha``.

Three Tier-1 invariants derived from operator vision (Plan ARIA-V6 §2a):

  1. 100% validation as structural exit — convergent authoring loops
     until adversarial + evidence judges agree AND calibration
     precision==1.0. Phase 0 is the precondition that makes such
     judgement meaningful.

  2. Evidence-grounded debate — every step of the loop MUST cite refs
     present in the evidence_pack. Without Phase 0, primary could
     invent a rule for code that doesn't exist; without evidence_pack
     bounding, challenger would have no fixed canvas to fact-check.

  3. Mutual hallucination guarantee — the cross-fact-check protocol in
     ``convergent_skill_authoring._cross_verify_evidence_refs()`` runs
     ``Path.exists() + git show + snippet-match`` against evidence_pack
     entries. evidence_pack IS the canonical truth that lets agents
     fact-check each other.

Public surface:

  * ``Observation`` TypedDict — single file:line repository snippet
  * ``EvidencePack`` TypedDict — frozen collection bound to a commit SHA
  * ``InsufficientEvidenceError`` — raised when fewer than
    ``min_observations`` snippets match the seed's claim_types
  * ``collect_evidence_pack()`` — Phase 0 entry point

CONCERN-tracked Phase 0 work (Plan §10):
  * Item 5 — sample correctness sub-check (re-verify 3 random
    observations against fresh ``git show`` to detect base_commit_sha
    drift mid-collection). Implemented below as ``_sample_resnap``.
  * Item 2 — stale base_commit_sha detection (verify the sha is
    reachable from HEAD before pack is sealed).
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, TypedDict

from .tool_registry import ensure_tools_dir, utc_now


__all__ = [
    "Observation",
    "EvidencePack",
    "InsufficientEvidenceError",
    "collect_evidence_pack",
    "evidence_pack_path",
]


# Plan ARIA-V6 §2d v2 — minimum-viable observation count.
MIN_OBSERVATIONS_DEFAULT = 10


# Plan ARIA-V6 §2d — discovery method tag for each observation.
# Used by the cross-verify protocol to weight evidence: AST > grep
# > regex (AST is structurally sound; grep matches lexical token;
# regex may include comment-only matches).
DISCOVERY_METHOD_RANK: dict[str, int] = {"ast": 3, "grep": 2, "regex": 1}


class Observation(TypedDict):
    """Plan ARIA-V6 §2d v2 — single file:line repository snippet."""

    file_path: str            # repo-relative
    line: int                 # 1-indexed
    snippet: str              # ≤ 200 chars of actual code
    claim_class: str          # one of seed.claim_types
    discovered_by: str        # "grep" | "ast" | "regex"


class EvidencePack(TypedDict):
    """Plan ARIA-V6 §2d v2 — frozen evidence collection.

    Bound to a single ``base_commit_sha``. The cross-verify protocol
    re-snaps each cited ref against this commit so that mid-cycle
    repo mutations (rebase, force-push, branch swap) surface as
    ``evidence_base_drift`` rather than silently invalidate the pack.
    """

    seed_id: str
    collected_at: str
    base_commit_sha: str
    declared_scope: list[str]
    claim_types: list[str]
    observations: list[Observation]
    observation_hash: str       # sha256 over canonical observations
    sample_resnap_status: str   # "ok" | "drift_detected" | "skipped"


class InsufficientEvidenceError(Exception):
    """Phase 0 reject — fewer than ``min_observations`` real snippets.

    Raised when ``collect_evidence_pack()`` cannot find enough
    file:line patterns matching the seed's claim_types. The seed is
    REJECTED for this cycle; operator must broaden ``declared_scope``
    OR add a richer regex set OR provide additional fixtures.

    Why a HARD reject (not a soft warning):
      Without a real evidence floor, primary↔challenger debate has
      no anchor; agents would invent rules for code that doesn't
      exist. Phase 0 is the Tier-1 gate that makes mutual-
      hallucination-guarantee structurally meaningful.
    """


def evidence_pack_path(
    base_dir: str | Path | None,
    seed_id: str,
) -> Path:
    """Canonical evidence_pack persistence path."""
    root = ensure_tools_dir(base_dir)
    pack_dir = root / "convergent-authoring" / "evidence-packs"
    pack_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", seed_id)[:120] or "seed"
    return pack_dir / f"{safe}.json"


def collect_evidence_pack(
    *,
    seed_id: str,
    declared_scope: list[str],
    claim_types: list[str],
    workspace_root: str | Path,
    base_dir: str | Path | None,
    base_commit_sha: str | None = None,
    min_observations: int = MIN_OBSERVATIONS_DEFAULT,
    claim_patterns: dict[str, list[str]] | None = None,
    persist: bool = True,
) -> EvidencePack:
    """Plan ARIA-V6 §2d v2 — Phase 0 evidence_pack scanner.

    Scans ``workspace_root`` under ``declared_scope`` globs for
    file:line snippets matching ``claim_types`` × ``claim_patterns``
    regexes. Returns an immutable ``EvidencePack`` bound to
    ``base_commit_sha``.

    Args:
      seed_id: stable identifier for the seed driving this collection.
      declared_scope: list of glob-style path prefixes that bound the
        search. Empty list means whole workspace (operator must
        explicitly opt in by passing ``["."]``).
      claim_types: list of claim_class tokens the adapter targets.
        Each observation MUST be tagged with one of these.
      workspace_root: filesystem root of the repository.
      base_dir: aria-tools dir for persistence.
      base_commit_sha: bind the pack to this commit. ``None`` means
        derive from ``git rev-parse HEAD`` at collection start.
      min_observations: HARD floor. Below this, ``InsufficientEvidenceError``
        is raised. Default 10 (Plan §2d).
      claim_patterns: per-claim-class regex list. ``None`` defaults to
        a permissive identifier-token match. Operator-curated patterns
        produce higher-quality packs.
      persist: write the pack to disk under ``base_dir`` for inspection
        + later cross-verify. Default True; tests pass False to skip
        I/O when checking semantics only.

    Raises:
      InsufficientEvidenceError: fewer than ``min_observations`` real
        snippets matched. The seed is REJECTED — no draft minted.
      ValueError: ``claim_types`` or ``declared_scope`` empty.

    Why bound to ``base_commit_sha``:
      The cross-verify protocol re-snaps each cited ref against the
      pack's ``base_commit_sha`` (NOT the current HEAD) so that
      repo mutations between Phase 0 and Phase 3 surface as
      ``evidence_base_drift`` rather than silently invalidate refs.
    """
    if not claim_types:
        raise ValueError("evidence_collect_requires_claim_types")
    if not declared_scope:
        raise ValueError("evidence_collect_requires_declared_scope")

    workspace_root = Path(workspace_root).resolve()
    if not workspace_root.exists() or not workspace_root.is_dir():
        raise ValueError(
            f"evidence_collect_workspace_not_found: {workspace_root}"
        )

    sha = base_commit_sha or _resolve_head_sha(workspace_root)
    # Plan §10 item 2 — stale sha detection. Verify the sha is reachable
    # from HEAD before sealing the pack. A pre-fetch sha that no longer
    # resolves means the operator scope changed mid-collection.
    if not _sha_is_reachable(workspace_root, sha):
        raise ValueError(
            f"evidence_collect_base_commit_sha_unreachable: {sha} "
            f"(workspace HEAD may have been rebased or force-pushed)"
        )

    patterns = claim_patterns or _default_patterns_for_claim_types(claim_types)

    observations: list[Observation] = []
    for scope_glob in declared_scope:
        for path in _iter_scope_paths(workspace_root, scope_glob):
            if not _is_text_file(path):
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for claim_class in claim_types:
                regex_list = patterns.get(claim_class, [])
                if not regex_list:
                    continue
                for regex_src in regex_list:
                    try:
                        regex = re.compile(regex_src, re.MULTILINE)
                    except re.error:
                        continue
                    for match in regex.finditer(content):
                        line_no = content.count("\n", 0, match.start()) + 1
                        snippet = _extract_line(content, line_no)[:200]
                        rel = path.relative_to(workspace_root).as_posix()
                        observations.append(Observation(
                            file_path=rel,
                            line=line_no,
                            snippet=snippet,
                            claim_class=claim_class,
                            discovered_by="regex",
                        ))

    observations = _dedupe_observations(observations)
    if len(observations) < min_observations:
        raise InsufficientEvidenceError(
            f"evidence_pack_below_floor: seed={seed_id!r} "
            f"found={len(observations)} required={min_observations} "
            f"declared_scope={declared_scope!r} claim_types={claim_types!r} "
            f"hint={_suggest_broader_scope(workspace_root, declared_scope)}"
        )

    # Plan §10 item 5 — sample correctness sub-check. Re-verify 3
    # random observations against a fresh ``git show <sha>:<file>``
    # to catch base_commit_sha drift mid-collection.
    sample_status = _sample_resnap(
        workspace_root=workspace_root,
        sha=sha,
        observations=observations,
    )

    observation_hash = _canonical_observation_hash(observations)
    pack: EvidencePack = {
        "seed_id": seed_id,
        "collected_at": utc_now(),
        "base_commit_sha": sha,
        "declared_scope": list(declared_scope),
        "claim_types": list(claim_types),
        "observations": observations,
        "observation_hash": observation_hash,
        "sample_resnap_status": sample_status,
    }
    if persist:
        path = evidence_pack_path(base_dir, seed_id)
        path.write_text(
            json.dumps(pack, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return pack


def _resolve_head_sha(workspace_root: Path) -> str:
    """Resolve the workspace's HEAD commit SHA."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(
            f"evidence_collect_git_rev_parse_failed: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def _sha_is_reachable(workspace_root: Path, sha: str) -> bool:
    """Plan §10 item 2 — verify sha reachable from current HEAD."""
    if not re.fullmatch(r"[0-9a-fA-F]{4,40}", sha or ""):
        return False
    result = subprocess.run(
        ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0


def _iter_scope_paths(workspace_root: Path, scope_glob: str):
    """Yield file paths under the scope glob."""
    if scope_glob in (".", "./"):
        yield from workspace_root.rglob("*")
        return
    # Treat scope_glob as a path prefix when it ends with "/" OR as a
    # glob pattern otherwise.
    if scope_glob.endswith("/"):
        base = workspace_root / scope_glob.rstrip("/")
        if base.exists():
            yield from base.rglob("*")
        return
    yield from workspace_root.glob(scope_glob)


def _is_text_file(path: Path) -> bool:
    """Skip binary + over-large files."""
    if not path.is_file():
        return False
    try:
        size = path.stat().st_size
    except OSError:
        return False
    if size > 2_000_000:
        return False
    suffix = path.suffix.lower()
    return suffix in {
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
        ".py", ".rs", ".go", ".java", ".kt", ".swift",
        ".md", ".yaml", ".yml", ".json", ".toml", ".ini",
        ".sql", ".sh", ".bash", ".zsh",
        ".html", ".css", ".scss",
        ".tf", ".hcl",
        ".rb", ".php",
        ".c", ".cc", ".cpp", ".h", ".hpp",
    }


def _extract_line(content: str, line_no: int) -> str:
    """Extract a single line (1-indexed)."""
    lines = content.splitlines()
    if 1 <= line_no <= len(lines):
        return lines[line_no - 1].strip()
    return ""


def _dedupe_observations(observations: list[Observation]) -> list[Observation]:
    """Stable de-dupe on (file_path, line, claim_class)."""
    seen: set[tuple[str, int, str]] = set()
    out: list[Observation] = []
    for obs in observations:
        key = (obs["file_path"], obs["line"], obs["claim_class"])
        if key in seen:
            continue
        seen.add(key)
        out.append(obs)
    return out


def _canonical_observation_hash(observations: list[Observation]) -> str:
    """Stable SHA-256 over canonicalized observations.

    Sort by (file_path, line, claim_class) so the hash is independent
    of discovery order. Snippet text is included so an evidence pack
    captured before a refactor doesn't silently match against the
    post-refactor file.
    """
    canonical = sorted(
        observations,
        key=lambda obs: (obs["file_path"], obs["line"], obs["claim_class"]),
    )
    payload = json.dumps(
        [
            {
                "file_path": obs["file_path"],
                "line": obs["line"],
                "claim_class": obs["claim_class"],
                "snippet": obs["snippet"],
            }
            for obs in canonical
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _sample_resnap(
    *,
    workspace_root: Path,
    sha: str,
    observations: list[Observation],
    sample_size: int = 3,
) -> str:
    """Plan §10 item 5 — re-snap 3 random observations.

    Verify that the file:line snippet stored at collection time STILL
    matches what ``git show <sha>:<file>`` returns. Mismatch means
    base_commit_sha drift mid-collection.

    Returns:
      "ok" — all sampled refs match
      "drift_detected" — at least one mismatch (operator-visible)
      "skipped" — too few observations to sample meaningfully
    """
    if len(observations) < sample_size:
        return "skipped"
    # Deterministic sample: first, middle, last.
    indices = [
        0,
        len(observations) // 2,
        len(observations) - 1,
    ]
    for idx in indices:
        obs = observations[idx]
        result = subprocess.run(
            ["git", "show", f"{sha}:{obs['file_path']}"],
            cwd=workspace_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return "drift_detected"
        lines = result.stdout.splitlines()
        line_no = obs["line"]
        if not (1 <= line_no <= len(lines)):
            return "drift_detected"
        captured_line = lines[line_no - 1].strip()
        if captured_line != obs["snippet"].strip():
            return "drift_detected"
    return "ok"


def _suggest_broader_scope(
    workspace_root: Path,
    current_scope: list[str],
) -> str:
    """Operator-readable hint when evidence floor is missed."""
    hints = []
    for prefix in ("apps/", "libs/", "platform/", "web/", "sens-api-gateway/"):
        if (workspace_root / prefix.rstrip("/")).exists():
            if prefix not in current_scope and prefix.rstrip("/") not in current_scope:
                hints.append(prefix)
    return f"try_adding_scope={hints}" if hints else "scope_already_broad"


def _default_patterns_for_claim_types(claim_types: list[str]) -> dict[str, list[str]]:
    """Permissive default regex per claim_class.

    Operator-curated patterns produce higher-quality packs; this
    fallback gives convergent_skill_authoring something to seed with
    when ``claim_patterns`` is not supplied.

    Each claim_class regex MUST be lexically conservative — false
    positives at Phase 0 are acceptable (challenger filters them in
    Phase 1); false negatives are not (they shrink the canvas the
    drafters can debate over).
    """
    defaults: dict[str, list[str]] = {}
    for claim_class in claim_types:
        token = re.escape(claim_class)
        # Catch identifier-token mentions + common code spellings.
        defaults[claim_class] = [
            rf"\b{token}\b",
            rf"\b{token.replace('_', '[_-]')}\b",
        ]
    return defaults
