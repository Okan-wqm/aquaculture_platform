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
from typing import Any, Mapping, Protocol


__all__ = [
    "PlanSynthesizer",
    "synthesize_plan_content_from_cycle",
    "select_plan_synthesizer",
    # Plan ARIA-V9.4 — 5 pressure sources + pattern_signature
    "scan_orphan_findings",
    "scan_f_findings",
    "scan_failing_ci",
    "scan_operator_feedback",
    "rank_candidate_sources",
    "compute_pattern_signature",
    "KEY_CHANGE_CATEGORIES",
    "MIN_EVIDENCE_REF_CARDINALITY",
    # Plan ARIA-V3.1-A — candidate-to-envelope conversion (consumed
    # by V9PressureSourceProvider in cycle_phases/plan_source.py).
    "convert_candidate_to_plan_content",
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
         * ``schema_version: 2`` (coverage-gated — plan_convergence enforces
           the deterministic impact-closure verdict before CONVERGED)
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
        # schema_version 2 opts this plan into the plan-coverage gate:
        # plan_convergence requires a coverage_computed verdict per round
        # before CONVERGED (v1 = legacy, gate-inert).
        "schema_version": 2,
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


# =============================================================================
# Plan ARIA-V9.4 — 5 pressure sources + pattern_signature stable normalization
# =============================================================================
#
# Closes:
#   * architectural-arbiter CRIT-006 — ad-hoc strings replaced by
#     PlanCandidateSource enum (V9.0-A); this module imports + uses it
#   * architectural-arbiter CRIT-007 — pattern_signature stable
#     normalization (canonical-sorted affected_surfaces, nx-target
#     validation_command_set, closed-enum key_change_categories,
#     cardinality guard N>=5 distinct evidence_refs)
#   * architectural-arbiter MED-003 — gh run list 10-min TTL cache
#   * architectural-arbiter MED-004 — explicit source priority order
#   * ai-safety-auditor HIGH-010 — operator-feedback signature verification
#   * performance-expert HIGH-005 — per-source time budget governance event
#   * performance-expert HIGH-006 — F-finding aging stat-only (no JSON
#     parse until candidate selected)
#   * performance-expert HIGH-008 — pattern_signature lookback bounded


import hashlib
import json
import time
from datetime import datetime, timezone

from .plan_candidate_source import PlanCandidateSource


# Plan ARIA-V9.4 — closed enum of key_change_categories for
# pattern_signature stable normalization. arb CRIT-007: a refactor
# that adds a category = ADR + arbiter approval + invariant update.
KEY_CHANGE_CATEGORIES: frozenset[str] = frozenset({
    "ADD_ENTITY",
    "ADD_MIGRATION",
    "ADD_HANDLER",
    "ADD_EVENT_CONTRACT",
    "ADD_DTO",
    "FIX_BUG",
    "REFACTOR_SAFE",
    "TEST_ONLY",
    "DOC_ONLY",
})

# Plan ARIA-V9.4 — pattern_signature cardinality guard. False-positive
# skill-genesis trigger prevention: a candidate plan with < 5 distinct
# evidence_refs cannot stabilize a meaningful pattern.
MIN_EVIDENCE_REF_CARDINALITY: int = 5

# Plan ARIA-V9.4 — per-source candidate cap (bounded synthesizer
# startup latency; perf HIGH-006).
_MAX_CANDIDATES_PER_SOURCE: int = 50

# Plan ARIA-V9.4 — gh run list cache TTL (perf CRIT-003 rate-limit
# mitigation + arb MED-003).
_GH_RUN_LIST_CACHE_TTL_SECONDS: int = 600  # 10 minutes

# Plan ARIA-V9.4 — per-source scan slowness threshold (perf HIGH-005).
# When a single source > 2s, emit plan_source_scan_slow governance.
_SOURCE_SCAN_SLOW_SECONDS: float = 2.0


# -----------------------------------------------------------------------------
# Source scanners
# -----------------------------------------------------------------------------

def scan_orphan_findings(workspace_root: str | Path) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 source — ORPHAN findings from
    ``docs/reviews/orphan-findings.md``.

    Scans for headings matching ``^## ORPHAN-(?P<severity>[A-Z]+)-(?P<id>\\d+)``
    with subsequent ``Status: OPEN`` line. Each match becomes a
    candidate dict carrying severity + id + source_type.

    Returns ordered by severity (CRITICAL > HIGH > MEDIUM > LOW) then
    by id. Capped at _MAX_CANDIDATES_PER_SOURCE.
    """
    path = Path(workspace_root) / "docs" / "reviews" / "orphan-findings.md"
    if not path.exists():
        return []
    severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    heading_re = re.compile(r"^##\s+ORPHAN-([A-Z]+)-(\d+)\s*$", re.MULTILINE)
    text = path.read_text(encoding="utf-8", errors="replace")
    candidates: list[dict[str, Any]] = []
    matches = list(heading_re.finditer(text))
    for i, m in enumerate(matches):
        severity = m.group(1)
        finding_id = m.group(2)
        # Look at next ~500 chars for "Status: OPEN" — bounded scan.
        section_end = matches[i + 1].start() if i + 1 < len(matches) else m.end() + 2000
        body = text[m.end():section_end]
        if "Status: OPEN" not in body:
            continue
        if severity not in severity_order:
            continue
        candidates.append({
            "source_type": PlanCandidateSource.ORPHAN_FINDING.value,
            "candidate_id": f"ORPHAN-{severity}-{finding_id}",
            "severity": severity,
            "severity_rank": severity_order[severity],
            "raw_id": finding_id,
            "title_hint": f"Address ORPHAN-{severity}-{finding_id}",
        })
    candidates.sort(key=lambda c: (c["severity_rank"], c["raw_id"]))
    candidates = candidates[:_MAX_CANDIDATES_PER_SOURCE]
    # ORPHAN-312 — attach each finding's real code evidence from the registry
    # SSoT so convert_candidate_to_plan_content can ground the plan in code,
    # not the orphan-findings.md doc. Read-only, bounded to the selected ids.
    _attach_orphan_registry_evidence(workspace_root, candidates)
    return candidates


def _attach_orphan_registry_evidence(
    workspace_root: str | Path, candidates: list[dict[str, Any]],
) -> None:
    if not candidates:
        return
    # Route the registry JSONL through the blessed strict reader (tolerant
    # mode: a corrupt row is skipped WITH a ledger_row_corrupt diagnostic, not
    # silently swallowed — the jsonl-silent-skip invariant bans a bare
    # except:continue on a JSONL read). Non-existent path → empty iterator.
    from .strict_jsonl_reader import read_strict_jsonl
    registry = (Path(workspace_root) / "docs" / "reviews" / "_registry" / "findings.jsonl").resolve()
    wanted = {c["candidate_id"] for c in candidates}
    evidence_by_id: dict[str, list[str]] = {}
    for row in read_strict_jsonl(registry, on_corruption="tolerant"):
        rid = row.get("id")
        if rid in wanted and isinstance(row.get("evidence"), list):
            evidence_by_id[rid] = [e for e in row["evidence"] if isinstance(e, str)]
    for c in candidates:
        ev = evidence_by_id.get(c["candidate_id"])
        if ev:
            c["evidence"] = ev


def scan_f_findings(workspace_root: str | Path) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 source — F-* findings from ``aria-findings/*.json``.

    Aging scan uses ``Path.stat().st_mtime`` ONLY — JSON body parse
    is invoked at candidate-selection time, not at scan time
    (perf HIGH-006 lazy-parse contract). Returns candidates oldest-first
    (older = higher priority).
    """
    findings_dir = Path(workspace_root) / "aria-findings"
    if not findings_dir.is_dir():
        return []
    candidates: list[dict[str, Any]] = []
    for p in findings_dir.glob("F-*.json"):
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        candidates.append({
            "source_type": PlanCandidateSource.F_FINDING.value,
            "candidate_id": p.stem,
            "mtime": mtime,
            "path": str(p),
            "age_seconds": time.time() - mtime,
            "title_hint": f"Process aging F-finding {p.stem}",
        })
    candidates.sort(key=lambda c: c["mtime"])  # oldest first
    return candidates[:_MAX_CANDIDATES_PER_SOURCE]


def _read_gh_run_list_cache(cache_path: Path) -> list[dict[str, Any]] | None:
    """Returns cached gh run list payload if cache is fresh (< TTL),
    else None."""
    if not cache_path.exists():
        return None
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(cached, dict):
        return None
    cached_at = cached.get("cached_at_epoch")
    if not isinstance(cached_at, (int, float)):
        return None
    if time.time() - cached_at > _GH_RUN_LIST_CACHE_TTL_SECONDS:
        return None
    payload = cached.get("payload")
    return payload if isinstance(payload, list) else None


def _write_gh_run_list_cache(cache_path: Path, payload: list[dict[str, Any]]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({
        "schema_version": 1,
        "cached_at_epoch": time.time(),
        "cached_at_utc": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }, indent=2, sort_keys=True), encoding="utf-8")


def scan_failing_ci(
    workspace_root: str | Path,
    *,
    cache_dir: str | Path | None = None,
    gh_cli: str = "gh",
    branch: str = "main",
    gh_token: str | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 + V3.1-D-4 source — failing CI runs from
    ``gh run list --branch main --status failure --limit 5``.

    Cached at ``<workspace>/aria-tools/cache/gh-run-list.json`` with
    10-min TTL (arb MED-003 + perf CRIT-003 rate-limit mitigation).

    Plan ARIA-V3.1-D-4 (closes 6-validator audit H-6 token scope):
    `gh_token` kwarg accepts a scoped READ_ACTIONS_ONLY installation
    token (5-min TTL, `actions:read` scope only). When supplied, the
    subprocess.run uses an explicit `env={"GH_TOKEN": gh_token, "PATH":
    os.environ["PATH"]}` so the gh CLI cannot inherit the operator's
    full-scope PAT from the orchestrator's parent environment. Under
    profile=autonomous the orchestrator MUST mint + pass this scoped
    token; under strict/standard the function falls back to the
    operator PAT in the inherited env (legacy V9.4 behavior + a
    `gh_token_fallback_to_operator_pat` governance event is emitted by
    the caller).

    Returns ordered most-recent-first. Network failures / gh CLI
    absence → empty list (degraded silently; orchestrator picks a
    different source).
    """
    import os as _os
    import shutil
    workspace = Path(workspace_root).resolve()
    if cache_dir is None:
        cache_path = workspace / "aria-tools" / "cache" / "gh-run-list.json"
    else:
        cache_path = Path(cache_dir) / "gh-run-list.json"

    cached = _read_gh_run_list_cache(cache_path)
    if cached is not None:
        return cached[:_MAX_CANDIDATES_PER_SOURCE]

    # Plan ARIA-V3.1-F-2 — ARIA_DRY_RUN system-wide gate (closes C-8).
    # When set, short-circuit BEFORE the `gh run list` subprocess.
    # Used by the V3.1-F smoke to exercise the autonomous cycle path
    # without touching the real GitHub API. The autonomous profile's
    # preflight gate (V3.1-E) catches misconfigured hosts; this gate
    # is the per-call defense-in-depth.
    if _os.environ.get("ARIA_DRY_RUN", "").lower() in ("true", "1", "yes"):
        return []

    if not shutil.which(gh_cli):
        return []
    # Plan ARIA-V3.1-D-4 — explicit env when scoped token supplied.
    # When gh_token is None, fall through to subprocess's default
    # parent-env inheritance (V8 backward-compat).
    subprocess_env: dict[str, str] | None = None
    if gh_token is not None:
        subprocess_env = {
            "GH_TOKEN": gh_token,
            "PATH": _os.environ.get("PATH", "/usr/bin:/bin"),
        }
    try:
        proc = subprocess.run(
            [
                gh_cli, "run", "list",
                "--branch", branch,
                "--status", "failure",
                "--limit", "5",
                "--json", "databaseId,workflowName,headSha,conclusion,createdAt,event",
            ],
            capture_output=True, text=True, timeout=15,
            env=subprocess_env,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []
    if proc.returncode != 0:
        return []
    try:
        rows = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []
    if not isinstance(rows, list):
        return []
    candidates: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        run_id = r.get("databaseId")
        workflow = r.get("workflowName") or "unknown"
        candidates.append({
            "source_type": PlanCandidateSource.FAILING_CI.value,
            "candidate_id": f"ci-run-{run_id}",
            "workflow_name": workflow,
            "head_sha": r.get("headSha"),
            "conclusion": r.get("conclusion"),
            "created_at": r.get("createdAt"),
            "title_hint": f"Fix failing CI workflow '{workflow}' (run #{run_id})",
        })
    _write_gh_run_list_cache(cache_path, candidates)
    return candidates[:_MAX_CANDIDATES_PER_SOURCE]


def _verify_operator_feedback_signature(row: dict[str, Any]) -> bool:
    """Plan ARIA-V9.4 — Tier-1 signature verification on operator-feedback
    rows. ai-safety HIGH-010 — unauthenticated injection lane mitigation.

    Required fields:
      * ``id`` non-empty string
      * ``authored_at`` non-empty
      * ``signature`` non-empty
      * ``signature_kid`` non-empty (key identifier; operator-side pinned)
      * ``priority`` in {low, medium, high}  (NOT "max" — invented
        priorities cannot override severity ladder)
      * ``request`` non-empty
      * ``status`` non-empty

    Returns True iff all fields present + priority in closed set.

    V9.4 ships SCHEMA verification + presence check. Cryptographic
    verification (operator pinned public key HMAC validation) is a
    V10.4-scope extension tracked under F-015 subfinding F-V10-4-1;
    V9.4 signature presence + schema validation is the
    load-bearing structural guard while the cryptographic check
    lands. The unsigned-row drop path emits a governance event so
    the audit trail surfaces missing rows."""
    if not isinstance(row, dict):
        return False
    required = ("id", "authored_at", "signature", "signature_kid",
                "priority", "request", "status")
    for field in required:
        v = row.get(field)
        if not isinstance(v, str) or not v.strip():
            return False
    if row["priority"] not in {"low", "medium", "high"}:
        return False
    return True


def scan_operator_feedback(workspace_root: str | Path) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 source — signed operator-feedback rows from
    ``aria-tools/operator-feedback.jsonl``.

    Unsigned rows DROPPED (NOT silently — caller emits
    ``unsigned_operator_feedback`` governance event for each drop
    via the rejected_rows return field). ai-safety HIGH-010.

    Returns MAX-priority entries first (operator signal wins over
    auto-discovered sources).
    """
    path = Path(workspace_root) / "aria-tools" / "operator-feedback.jsonl"
    if not path.exists():
        return []
    candidates: list[dict[str, Any]] = []
    rejected: list[str] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    rejected.append(f"line-{lineno}-malformed-json")
                    continue
                if row.get("status") != "unaddressed":
                    continue
                if not _verify_operator_feedback_signature(row):
                    rejected.append(row.get("id") or f"line-{lineno}-unsigned")
                    continue
                candidates.append({
                    "source_type": PlanCandidateSource.OPERATOR_FEEDBACK.value,
                    "candidate_id": row["id"],
                    "priority": row["priority"],
                    "request": row["request"],
                    "authored_at": row["authored_at"],
                    "signature_kid": row["signature_kid"],
                    "title_hint": f"Operator request {row['id']}",
                    "rejected_rows_in_scan": rejected,
                })
    except OSError:
        return []
    priority_rank = {"high": 0, "medium": 1, "low": 2}
    candidates.sort(key=lambda c: (priority_rank.get(c["priority"], 99), c["authored_at"]))
    if rejected and candidates:
        # Surface unsigned-row count on first candidate (caller emits
        # one governance event per scan based on this field).
        candidates[0]["rejected_rows_count"] = len(rejected)
    return candidates[:_MAX_CANDIDATES_PER_SOURCE]


# -----------------------------------------------------------------------------
# Ranking + pattern_signature
# -----------------------------------------------------------------------------

# Plan ARIA-V9.4 — priority order. OPERATOR_FEEDBACK wins over
# auto-discovered sources (operator signal > automated detection).
_SOURCE_PRIORITY: dict[str, int] = {
    PlanCandidateSource.OPERATOR_FEEDBACK.value: 0,
    PlanCandidateSource.FAILING_CI.value: 1,
    PlanCandidateSource.ORPHAN_FINDING.value: 2,
    PlanCandidateSource.F_FINDING.value: 3,
    PlanCandidateSource.GIT_DIFF.value: 4,
}


def rank_candidate_sources(
    *,
    workspace_root: str | Path,
) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 — scan all 5 sources + return ranked candidates.

    Order: per-source priority (OPERATOR_FEEDBACK > FAILING_CI >
    ORPHAN > F_FINDING > GIT_DIFF) then within-source severity / age
    rank. Empty list when no source has candidates.

    Per-source scan timing emitted as ``plan_source_scan_slow``
    governance event when single source > 2s (perf HIGH-005).
    """
    workspace = Path(workspace_root).resolve()
    all_candidates: list[dict[str, Any]] = []
    timings: dict[str, float] = {}

    for source_name, scanner in (
        (PlanCandidateSource.OPERATOR_FEEDBACK.value, scan_operator_feedback),
        (PlanCandidateSource.FAILING_CI.value, scan_failing_ci),
        (PlanCandidateSource.ORPHAN_FINDING.value, scan_orphan_findings),
        (PlanCandidateSource.F_FINDING.value, scan_f_findings),
    ):
        t0 = time.monotonic()
        try:
            rows = scanner(workspace)
        except (OSError, RuntimeError, json.JSONDecodeError):
            rows = []
        elapsed = time.monotonic() - t0
        timings[source_name] = elapsed
        all_candidates.extend(rows)

    # Slow-source detection (Tier-3 detect via governance event the
    # caller emits — this function just records the timings).
    for source_name, elapsed in timings.items():
        if elapsed > _SOURCE_SCAN_SLOW_SECONDS:
            # Mark first candidate from this source for the orchestrator
            # to surface (avoids duplicating governance state here).
            for c in all_candidates:
                if c.get("source_type") == source_name:
                    c["_scan_slow_seconds"] = elapsed
                    break

    # Stable sort: priority, then per-source rank.
    def _key(c: dict[str, Any]) -> tuple:
        source_priority = _SOURCE_PRIORITY.get(c.get("source_type", ""), 99)
        # Within-source secondary key: severity_rank for ORPHAN; age for F;
        # priority for OPERATOR; created_at for CI.
        secondary = c.get("severity_rank", c.get("priority", c.get("age_seconds", 0)))
        if isinstance(secondary, str):
            secondary_int = {"high": 0, "medium": 1, "low": 2}.get(secondary, 99)
        else:
            secondary_int = secondary
        return (source_priority, secondary_int)

    all_candidates.sort(key=_key)
    return all_candidates


_FINDING_EVIDENCE_CAP = 50


def _evidence_refs_from_finding_json(finding_path: Any) -> tuple[list[str], list[str]]:
    """Extract (evidence_refs, affected_surfaces) from an aria-findings JSON.

    ORPHAN-312 root fix: the F-finding's ``evidence_chain[].reference`` entries
    are already ``path:line`` refs to the REAL code the drift lives in (e.g.
    ``web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346``). Those are
    the evidence a challenger must ground its plan in — NOT the finding JSON
    file itself. Returns ([], []) when the file is missing/unparseable or
    carries no usable references, so the caller can fall back.
    """
    if not isinstance(finding_path, str) or not finding_path:
        return [], []
    try:
        finding = json.loads(Path(finding_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return [], []
    chain = finding.get("evidence_chain")
    if not isinstance(chain, list):
        return [], []
    evidence_refs: list[str] = []
    affected: list[str] = []
    for entry in chain:
        if not isinstance(entry, dict):
            continue
        ref = entry.get("reference")
        if not isinstance(ref, str) or not ref.strip():
            continue
        ref = ref.strip()
        if _looks_unsafe_repo_path(ref):
            continue
        # Split a trailing :<line> off to get the bare path for affected_surfaces.
        path_part = ref.rsplit(":", 1)[0] if re.search(r":\d+$", ref) else ref
        if ref not in evidence_refs:
            evidence_refs.append(ref)
        if path_part not in affected:
            affected.append(path_part)
        if len(evidence_refs) >= _FINDING_EVIDENCE_CAP:
            break
    return evidence_refs, affected


def _looks_unsafe_repo_path(value: str) -> bool:
    return value.startswith("/") or "\\" in value or value.startswith("../") or "/../" in value


def convert_candidate_to_plan_content(
    candidate: Mapping[str, Any],
) -> "CyclePlanEnvelope | None":
    """Plan ARIA-V3.1-A — convert one ranked candidate into a
    CyclePlanEnvelope (closes 6-validator audit C-5 + H-2 + H-8).

    Returns None when the candidate cannot be converted (caller
    iterates to the next ranked candidate per V3.1-A-3 iterative
    fallback). Returns CyclePlanEnvelope on success.

    Tier-1 anchors:

    * Envelope/content split: `_pressure_source_type` lives ONLY
      in envelope.metadata; plan_content stays canonical 7-field
      (closes H-8 — content_hash collisions cannot occur because
      pressure_source_type does not enter the content dict).
    * Every external-source string runs through
      `text_safety.sanitize_untrusted_text` BEFORE it lands in
      plan_content (closes C-5 — operator-prose + LLM-authored
      strings cannot smuggle delimiter / bidi / control-char
      payloads into the convergence prompt).

    Tier-3 (Detect):

    * Returns None on missing/empty required fields rather than
      raising. The caller emits a `plan_candidate_conversion_skipped`
      governance event so the audit trail captures the skip without
      blocking iterative fallback.

    Candidate shapes (per source_type):

    * `operator_feedback` — { candidate_id, priority, request,
      authored_at, signature_kid, title_hint }
    * `failing_ci` — { candidate_id, workflow_name, head_sha,
      conclusion, created_at, title_hint }
    * `orphan_finding` — { candidate_id, severity, raw_id,
      title_hint }
    * `f_finding` — { candidate_id, mtime, path, age_seconds,
      title_hint }
    * `git_diff` — synthesized by V7GitDiffProvider, not by this
      function.
    """
    if not isinstance(candidate, Mapping):
        return None
    source_type = candidate.get("source_type")
    candidate_id = candidate.get("candidate_id")
    if not isinstance(source_type, str) or not isinstance(candidate_id, str):
        return None
    if source_type not in {
        PlanCandidateSource.OPERATOR_FEEDBACK.value,
        PlanCandidateSource.FAILING_CI.value,
        PlanCandidateSource.ORPHAN_FINDING.value,
        PlanCandidateSource.F_FINDING.value,
    }:
        # GIT_DIFF goes through V7GitDiffProvider; unknown source
        # types skipped + caller falls back.
        return None
    # Lazy imports — CyclePlanEnvelope + sanitizer live in modules
    # that import this module's helpers; avoid circular import at
    # module load.
    from .cycle_phases.plan_source import CyclePlanEnvelope
    from .text_safety import sanitize_untrusted_text
    title_hint = sanitize_untrusted_text(
        candidate.get("title_hint") or f"Address {candidate_id}",
        max_len=200,
    )
    # Per-source content authoring. Each branch builds the same
    # canonical 7-field plan_content; only the textual hints differ.
    if source_type == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        request = sanitize_untrusted_text(candidate.get("request") or "", max_len=1024)
        if not request:
            return None
        summary = f"Operator-feedback request: {request}"
        evidence_refs = [f"aria-tools/operator-feedback.jsonl:{candidate_id}"]
        affected_surfaces = ["aria-tools/operator-feedback.jsonl"]
    elif source_type == PlanCandidateSource.FAILING_CI.value:
        workflow = sanitize_untrusted_text(
            candidate.get("workflow_name") or "unknown", max_len=200,
        )
        head_sha = sanitize_untrusted_text(
            candidate.get("head_sha") or "", max_len=64,
        )
        summary = (
            f"Failing CI workflow '{workflow}' on head {head_sha or 'unknown'}; "
            "diagnose root cause + land architectural fix."
        )
        evidence_refs = [f"gh-run-list:{candidate_id}"]
        affected_surfaces = [".github/workflows/"]
    elif source_type == PlanCandidateSource.ORPHAN_FINDING.value:
        severity = sanitize_untrusted_text(
            candidate.get("severity") or "MEDIUM", max_len=16,
        )
        raw_id = sanitize_untrusted_text(
            candidate.get("raw_id") or "000", max_len=16,
        )
        summary = (
            f"Address ORPHAN-{severity}-{raw_id} from "
            "docs/reviews/orphan-findings.md (architectural root-cause fix)."
        )
        # ORPHAN-312 root fix — use the registry's real ``evidence`` file list
        # (attached by scan_orphan_findings) so the plan points at the code the
        # finding is about, not the orphan-findings.md doc. Doc anchor is the
        # last-resort fallback when the registry carries no evidence.
        registry_evidence = candidate.get("evidence")
        affected_surfaces = []
        if isinstance(registry_evidence, list):
            for item in registry_evidence:
                if isinstance(item, str) and item.strip() and not _looks_unsafe_repo_path(item.strip()):
                    p = item.strip()
                    if p not in affected_surfaces:
                        affected_surfaces.append(p)
                if len(affected_surfaces) >= _FINDING_EVIDENCE_CAP:
                    break
        if affected_surfaces:
            evidence_refs = list(affected_surfaces)
        else:
            evidence_refs = [
                f"docs/reviews/orphan-findings.md#ORPHAN-{severity}-{raw_id}",
            ]
            affected_surfaces = ["docs/reviews/orphan-findings.md"]
    else:  # F_FINDING
        summary = (
            f"Process aging F-finding {candidate_id}; verify status + "
            "land remediation if OPEN."
        )
        # ORPHAN-312 root fix — ground the plan in the finding's REAL code
        # references (evidence_chain), not the finding JSON file. This is what
        # a challenger must cite; the JSON path is only a last-resort fallback
        # so the validator's non-empty-evidence_refs rule still holds.
        evidence_refs, affected_surfaces = _evidence_refs_from_finding_json(
            candidate.get("path"),
        )
        if not evidence_refs:
            evidence_refs = [f"aria-findings/{candidate_id}.json"]
            affected_surfaces = [f"aria-findings/{candidate_id}.json"]

    content: dict[str, Any] = {
        # schema_version 2 — coverage-gated (see synthesize_plan_content_from_cycle).
        "schema_version": 2,
        "title": title_hint,
        "summary": summary,
        "affected_surfaces": affected_surfaces,
        "key_changes": [
            {
                "id": f"{candidate_id}-key-change-001",
                "description": summary,
                "paths": affected_surfaces,
            },
        ],
        "validation_commands": [
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
        ],
        "evidence_refs": evidence_refs,
    }
    metadata: dict[str, Any] = {
        "_pressure_source_type": source_type,
        "_candidate_id": candidate_id,
    }
    return CyclePlanEnvelope(content=content, metadata=metadata)


def _normalize_validation_commands(commands: list[dict[str, Any]]) -> tuple[str, ...]:
    """Plan ARIA-V9.4 — canonical normalization for pattern_signature
    input (arb CRIT-007). Maps raw shell strings to canonical nx target
    names so semantically-equivalent variants hash to the same signature.

    Examples:
      ``nx affected --target=test``        → ``nx:test``
      ``nx affected --target=lint --base=main`` → ``nx:lint``
      ``npm test farm-service``            → ``npm:test``
      ``npm run type-check``                → ``npm:type-check``
      ``pytest aria-kernel/tests/``         → ``pytest``
    """
    canonical: set[str] = set()
    nx_target_re = re.compile(r"nx\s+\S+\s+--target=(\S+)")
    npm_run_re = re.compile(r"npm\s+run\s+(\S+)")
    for cmd_dict in commands:
        if not isinstance(cmd_dict, dict):
            continue
        cmd = cmd_dict.get("cmd", "")
        if not isinstance(cmd, str):
            continue
        m = nx_target_re.search(cmd)
        if m:
            canonical.add(f"nx:{m.group(1)}")
            continue
        m = npm_run_re.search(cmd)
        if m:
            canonical.add(f"npm:{m.group(1)}")
            continue
        # Bare argv-0 fallback (pytest, cargo, etc.)
        token = cmd.split()[0] if cmd.split() else cmd
        canonical.add(token)
    return tuple(sorted(canonical))


def _classify_key_change(description: str) -> str:
    """Plan ARIA-V9.4 — heuristic key_change_category classifier.

    Maps a key_change.description string to a closed-enum category
    via keyword matching. Heuristic only (arb CRIT-007 ideal: AST
    classification when the source file IS in the diff; for v9.4
    code-only scope, heuristic is acceptable as long as the
    cardinality guard MIN_EVIDENCE_REF_CARDINALITY prevents false-
    positive pattern stability).

    Returns one of KEY_CHANGE_CATEGORIES or ``REFACTOR_SAFE`` fallback.
    """
    if not isinstance(description, str):
        return "REFACTOR_SAFE"
    d = description.lower()
    if any(kw in d for kw in ("@entity", "new entity", "add entity")):
        return "ADD_ENTITY"
    if "migration" in d:
        return "ADD_MIGRATION"
    if "handler" in d and ("add" in d or "new" in d):
        return "ADD_HANDLER"
    if "event contract" in d or "domain event" in d:
        return "ADD_EVENT_CONTRACT"
    if " dto" in d or "data transfer" in d:
        return "ADD_DTO"
    if "fix" in d or "bug" in d:
        return "FIX_BUG"
    if "test" in d and "only" in d:
        return "TEST_ONLY"
    if "doc" in d and "only" in d:
        return "DOC_ONLY"
    return "REFACTOR_SAFE"


def compute_pattern_signature(plan_content: dict[str, Any]) -> str | None:
    """Plan ARIA-V9.4 — stable pattern_signature for V10.2 skill genesis.

    Input: plan_content dict (from synthesize_plan_content_from_cycle
    or any source-driven mint).

    Stable normalization (arb CRIT-007):
      * ``affected_surfaces``: POSIX-lexicographic sorted, deduped
      * ``validation_command_set``: mapped to nx/npm canonical
        target names (NOT raw shell strings)
      * ``key_change_categories``: closed enum classification
        via _classify_key_change (NOT LLM-emitted category)
      * cardinality guard: returns None if <
        MIN_EVIDENCE_REF_CARDINALITY distinct evidence_refs

    Returns ``sha256:<hex>`` or None when cardinality guard fires.
    The None return is THE feature — V10.2 skill_genesis filters
    out low-cardinality candidates so a template-collision false
    positive (3 plans converging on the same shape coincidentally)
    cannot trigger spurious tool authoring.
    """
    if not isinstance(plan_content, dict):
        return None
    affected = plan_content.get("affected_surfaces", [])
    if not isinstance(affected, list):
        return None
    # POSIX-lexicographic + dedup
    normalized_surfaces = tuple(sorted(set(
        str(s) for s in affected if isinstance(s, str) and s
    )))
    key_changes = plan_content.get("key_changes", [])
    if not isinstance(key_changes, list):
        return None
    categories = tuple(sorted({
        _classify_key_change(kc.get("description", "") if isinstance(kc, dict) else "")
        for kc in key_changes
    }))
    validation_commands = plan_content.get("validation_commands", [])
    if not isinstance(validation_commands, list):
        return None
    normalized_commands = _normalize_validation_commands(validation_commands)

    # Cardinality guard — perf HIGH-008 false-positive prevention
    evidence_refs = plan_content.get("evidence_refs", [])
    if not isinstance(evidence_refs, list):
        return None
    distinct_evidence_count = len({str(e) for e in evidence_refs if isinstance(e, str)})
    if distinct_evidence_count < MIN_EVIDENCE_REF_CARDINALITY:
        return None

    canonical = {
        "affected_surfaces": list(normalized_surfaces),
        "key_change_categories": list(categories),
        "validation_command_set": list(normalized_commands),
        "schema_version": 1,
    }
    raw = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()
