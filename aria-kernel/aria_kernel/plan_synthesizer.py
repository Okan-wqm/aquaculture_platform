"""Plan ARIA-V7 §2i v2 Phase 7.1 — plan_content synthesis from real workspace.

V5+V6 wired the consumer-side architecture (Tier-1 contracts for
convergence + specialist + auto-merge); V7.1 wires the PRODUCER that
feeds them. Pre-V7, the autonomy_orchestrator hardcoded
``plan_seed = {"cycle_id": cycle_id}`` — a 1-key sentinel that
``plan_convergence._validate_plan_content`` rejected as malformed,
crashing every autonomous cycle at Gate A (ORPHAN-HIGH-079).

V7.1 introduces ``synthesize_plan_content_from_cycle`` that discovers
real workspace deltas via ``git diff`` and mints a valid
``plan_content`` dict matching the 7-field schema
``plan_convergence`` enforces. NO synthetic / fake data — every field
is derived from real repo state. When discovery finds no deltas,
returns ``None`` so the orchestrator emits ``cycle_runner_no_pressure``
verdict and routes to reflection without invoking Gate A.

Three Tier-1 V7 constraints (operator vision):

  1. **No silent crash and no silent skip.** Synthesizer returns
     ``None`` only when no real workspace pressure exists; every
     returned dict is structurally complete + would pass
     ``_validate_plan_content`` on its own.

  2. **Producer-consumer parity.** V5.1 ``convergence_runner``
     expects a real plan_content; V7.1 produces one. No dead
     contracts.

  3. **Producer is live, not pending.** The function is INVOKED by the
     orchestrator on every cycle. CLI factory
     ``select_plan_synthesizer(profile)`` wires the production default.
     No dead code, no scheduled-for-later wiring.

Source-substring invariant I-V7.1-04 pins the literal
``_REQUIRED_FIELDS = (...)`` 7-tuple so a refactor that drops or
renames a field fails CI before merge.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Protocol


__all__ = [
    "PlanSynthesizer",
    "synthesize_plan_content_from_cycle",
    "select_plan_synthesizer",
]


# Plan ARIA-V7 §2i v2 — load-bearing 7-field schema (pinned by
# I-V7.1-04 source-substring invariant). plan_convergence.
# _validate_plan_content REJECTS any plan_content missing any of
# these. A refactor that drops or renames a field would re-introduce
# ORPHAN-HIGH-079.
_REQUIRED_FIELDS = (
    "schema_version",
    "title",
    "summary",
    "affected_surfaces",
    "key_changes",
    "validation_commands",
    "evidence_refs",
)


# Plan ARIA-V7 §2i v2 — bounded outputs to keep plan_content payload
# reasonable; over-bounded paths trigger _validate_plan_content's
# MAX_AFFECTED_PATHS (200) + MAX_RISKS limits.
_MAX_AFFECTED_SURFACES = 100
_MAX_KEY_CHANGES = 50
_MAX_EVIDENCE_REFS = 10
_MAX_SNIPPET_CHARS = 200


class PlanSynthesizer(Protocol):
    """Plan ARIA-V7 §2i v2 — injection-seam contract."""

    def __call__(
        self,
        *,
        cycle_id: str,
        workspace_root: Path,
        base_dir: Path,
        git_diff_base: str = "HEAD~1",
    ) -> dict[str, Any] | None:
        ...


def synthesize_plan_content_from_cycle(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path,
    git_diff_base: str = "HEAD~1",
) -> dict[str, Any] | None:
    """Plan ARIA-V7 §2i v2 — mint valid plan_content from real workspace.

    Workflow:
      1. ``git diff <git_diff_base>..HEAD --name-only`` → affected paths
      2. If no changes detected, fall back through:
         ``HEAD~10`` → ``HEAD --since="24 hours ago"`` → return ``None``
      3. Build plan_content from real observed deltas:
         * ``schema_version: 1``
         * ``title``: f"Auto-discovered cycle {cycle_id}"
         * ``summary``: f"{N} files changed since {base}"
         * ``affected_surfaces``: deduped + bounded affected paths
         * ``key_changes``: one entry per change cluster (max 50)
         * ``validation_commands``: ``nx affected --target=lint`` +
           ``nx affected --target=test`` (real CI commands)
         * ``evidence_refs``: top N file:line refs from changed files

    Returns ``None`` only when:
      * Three fallback git diff strategies all return empty deltas, OR
      * git is not available in workspace_root

    NEVER returns malformed plan_content. NEVER raises GovernanceError
    (the orchestrator's V7.2 try/except envelope catches downstream
    crashes; this function returns None instead of propagating).
    """
    workspace_root = Path(workspace_root).resolve()
    if not workspace_root.exists() or not workspace_root.is_dir():
        return None

    affected_paths = _discover_affected_paths(workspace_root, git_diff_base)
    if not affected_paths:
        return None

    affected_paths = affected_paths[:_MAX_AFFECTED_SURFACES]

    key_changes = _cluster_changes(workspace_root, affected_paths)
    if not key_changes:
        # Discovery found paths but no extractable change clusters — still
        # return None rather than ship an empty key_changes list (which
        # _validate_plan_content rejects).
        return None

    evidence_refs = _collect_evidence_refs(
        workspace_root=workspace_root,
        paths=affected_paths,
        limit=_MAX_EVIDENCE_REFS,
        git_diff_base=git_diff_base,
    )
    if not evidence_refs:
        # _validate_plan_content rejects empty evidence_refs.
        return None

    validation_commands = [
        {
            "cmd": "nx affected --target=lint",
            "timeout_ms": 600_000,
            "expected_exit": 0,
        },
        {
            "cmd": "nx affected --target=test",
            "timeout_ms": 1_800_000,
            "expected_exit": 0,
        },
    ]

    return {
        "schema_version": 1,
        "title": f"Auto-discovered cycle {cycle_id}",
        "summary": (
            f"{len(affected_paths)} files changed since {git_diff_base}; "
            f"{len(key_changes)} change clusters extracted"
        ),
        "affected_surfaces": affected_paths,
        "key_changes": key_changes,
        "validation_commands": validation_commands,
        "evidence_refs": evidence_refs,
    }


def select_plan_synthesizer(profile: str = "standard") -> PlanSynthesizer:
    """Plan ARIA-V7 §2i v2 — production factory.

    Always returns ``synthesize_plan_content_from_cycle``: plan
    synthesis is architecturally required for every autonomous cycle
    (Tier-1 producer). Tests inject mock synthesizers directly via the
    ``plan_synthesizer`` kwarg on ``run_autonomy_orchestrator``; they
    do NOT go through this factory.

    The ``profile`` parameter is accepted for API symmetry with
    ``select_convergence_runner`` / ``select_review_runner`` /
    ``select_specialist_review_runner`` (V5/V6 §A1 pattern).
    """
    return synthesize_plan_content_from_cycle


def _discover_affected_paths(
    workspace_root: Path,
    git_diff_base: str,
) -> list[str]:
    """Plan ARIA-V7 §2i v2 — git diff with operator-set base + fallbacks.

    Fallback chain: ``git_diff_base`` → ``HEAD~10`` → 24-hour window.
    Returns empty list when all strategies find no deltas.
    """
    for base in (git_diff_base, "HEAD~10"):
        paths = _git_diff_names(workspace_root, base)
        if paths:
            return paths

    # Last-resort fallback: 24-hour window via reflog.
    return _git_diff_since(workspace_root, "24 hours ago")


def _git_diff_names(workspace_root: Path, base: str) -> list[str]:
    """``git diff <base>..HEAD --name-only`` with deduping."""
    if not re.fullmatch(r"[A-Za-z0-9_.~^/-]+", base or ""):
        return []
    result = subprocess.run(
        ["git", "diff", f"{base}..HEAD", "--name-only"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    paths = sorted({
        line.strip() for line in result.stdout.splitlines() if line.strip()
    })
    return paths


def _git_diff_since(workspace_root: Path, since: str) -> list[str]:
    """``git log --since=<since> --name-only`` — fallback for stale HEAD~N."""
    result = subprocess.run(
        ["git", "log", f"--since={since}", "--name-only", "--pretty=format:"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    paths = sorted({
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip() and not line.startswith("commit ")
    })
    return paths


def _cluster_changes(
    workspace_root: Path,
    affected_paths: list[str],
) -> list[dict[str, Any]]:
    """Plan ARIA-V7 §2i v2 — group affected paths into change clusters.

    Clustering rule: paths under the same top-2-level prefix form a
    cluster (e.g. ``apps/farm-service/src/...`` → cluster
    ``apps/farm-service``). Each cluster carries a description listing
    file count + sample paths.

    Returns a list of dicts shaped per ``plan_convergence`` expectation:
    ``{id: str, description: str, paths: list[str]}``.
    """
    clusters: dict[str, list[str]] = {}
    for path in affected_paths:
        parts = path.split("/")
        prefix = "/".join(parts[:2]) if len(parts) >= 2 else parts[0]
        clusters.setdefault(prefix, []).append(path)

    out: list[dict[str, Any]] = []
    for prefix in sorted(clusters.keys())[:_MAX_KEY_CHANGES]:
        cluster_paths = clusters[prefix]
        out.append({
            "id": f"change-{re.sub(r'[^A-Za-z0-9_-]+', '_', prefix)[:64]}",
            "description": (
                f"{len(cluster_paths)} files changed under {prefix}: "
                + ", ".join(cluster_paths[:3])
                + (f", … (+{len(cluster_paths) - 3} more)"
                   if len(cluster_paths) > 3 else "")
            ),
            "paths": cluster_paths,
        })
    return out


def _collect_evidence_refs(
    *,
    workspace_root: Path,
    paths: list[str],
    limit: int,
    git_diff_base: str = "HEAD~1",
) -> list[str]:
    """Plan ARIA-V8.14 — extract evidence_refs from the ACTUAL git diff hunks.

    Pre-V8.14 this function picked the FIRST non-blank non-comment line
    of each changed file (`path:1:from __future__ import annotations`
    for Python imports). The aria-challenger-planner agent rightly
    refused with `reason_class=insufficient_evidence` because a single
    line-1 ref does not let it independently ground a competing plan.

    V8.14 changes the source: for each affected path, query
    `git diff <base>..HEAD -- <path>` to get the unified diff, parse
    the hunk headers (`@@ -X,Y +A,B @@`), and emit one ref per
    representative changed line up to `limit` total. The challenger
    now sees the SUBSTANTIVE changes (function additions, control-
    flow edits, schema mutations) and can compose a real competing
    plan from them.

    Plan ARIA-V7 §2i v2 invariant I-V7.1-05: every ref MUST resolve
    via Path.exists() at the workspace root. Refs to deleted paths
    (rare; git diff may include deleted files) are skipped.

    Fallback: if git diff fails OR the file has no parseable hunks
    (binary, deleted, etc.), fall back to the pre-V8.14 first-non-
    blank-line strategy so the synthesizer never returns an empty
    evidence list (which would fail `_validate_plan_content`).
    """
    refs: list[str] = []
    for path in paths:
        if len(refs) >= limit:
            break
        abs_path = workspace_root / path
        if not abs_path.exists() or not abs_path.is_file():
            continue
        # Primary path — extract from git diff hunks. Each ref carries a
        # snippet of the changed line so operators can spot-check intent.
        hunk_refs = _evidence_refs_from_hunks(
            workspace_root=workspace_root,
            path=path,
            git_diff_base=git_diff_base,
            remaining=limit - len(refs),
        )
        if hunk_refs:
            refs.extend(hunk_refs)
            continue
        # Fallback path — first non-blank non-comment line (pre-V8.14
        # behaviour). Triggers when the file has no hunks (e.g.
        # whitespace-only change, binary file) so the synthesizer
        # still produces a non-empty evidence_refs list to satisfy
        # _validate_plan_content.
        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_no, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith(("//", "#", "/*", "*", "--", '"""', "'''")):
                continue
            snippet = stripped[:_MAX_SNIPPET_CHARS]
            refs.append(f"{path}:{line_no}:{snippet}")
            break
    return refs


_HUNK_HEADER_RE = re.compile(r"^@@\s*-\d+(?:,\d+)?\s*\+(\d+)(?:,(\d+))?\s*@@")


def _evidence_refs_from_hunks(
    *,
    workspace_root: Path,
    path: str,
    git_diff_base: str,
    remaining: int,
) -> list[str]:
    """Parse `git diff` hunks for ``path`` and emit one ref per changed line.

    Returns up to ``remaining`` refs of shape ``path:line:snippet``,
    where each line is one that was ADDED or CONTEXT in the new file
    (we skip pure-deletion hunks because the line no longer exists
    in the working tree — `Path.exists()` would resolve but the
    line number is meaningless).
    """
    if remaining <= 0:
        return []
    if not re.fullmatch(r"[A-Za-z0-9_.~^/-]+", git_diff_base or ""):
        return []
    try:
        result = subprocess.run(
            ["git", "diff", f"{git_diff_base}..HEAD", "--unified=0", "--", path],
            cwd=workspace_root,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0 or not result.stdout:
        return []
    refs: list[str] = []
    current_new_line = 0
    for diff_line in result.stdout.splitlines():
        if len(refs) >= remaining:
            break
        m = _HUNK_HEADER_RE.match(diff_line)
        if m:
            current_new_line = int(m.group(1))
            continue
        if not current_new_line:
            continue
        if diff_line.startswith("+++") or diff_line.startswith("---"):
            continue
        if diff_line.startswith("+"):
            snippet = diff_line[1:].strip()[:_MAX_SNIPPET_CHARS]
            if snippet:
                refs.append(f"{path}:{current_new_line}:{snippet}")
            current_new_line += 1
        elif diff_line.startswith("-"):
            # Deletion — no new-file line consumed.
            continue
        else:
            # Context line (rare under --unified=0 but possible).
            current_new_line += 1
    return refs
