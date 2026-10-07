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
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol


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
    # ORPHAN-HIGH-519 — what a conversion returns, and where its refs are judged.
    "PlanCandidateConversion",
    "PlanEvidenceGround",
    "F_FINDING_UNSEEDED",
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
    # ORPHAN-HIGH-519 — the same rule as every candidate source: a diff ref
    # the challenger could not cite back (a dirty worktree line, a deleted
    # file) is dropped, and a diff with none left mints no plan.
    evidence_refs, refusal = _admit_plan_refs(evidence_refs, PlanEvidenceGround.of(workspace_root))
    if not evidence_refs:
        from .tool_registry import append_tools_governance

        append_tools_governance(base_dir, "plan_candidate_conversion_skipped", {
            "cycle_id": cycle_id,
            "candidate_id": f"git-diff:{git_diff_base}",
            "source_type": PlanCandidateSource.GIT_DIFF.value,
            "reason": refusal.skip_reason,
            "runner_fault": refusal.harness_fault,
            "refused_evidence_refs": list(refusal.refused_evidence_refs),
        })
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
        # Primary path — extract from git diff hunks, one `path:line` ref per
        # added line.
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
            # ARIA-HIGH-195 — `path:line`, the one evidence-ref grammar
            # (evidence_trust.EVIDENCE_REF_RE); a trailing snippet made the
            # plan's own evidence unresolvable.
            refs.append(f"{path}:{line_no}")
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

    Returns up to ``remaining`` refs of shape ``path:line`` (ARIA-HIGH-195),
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
            if diff_line[1:].strip():
                refs.append(f"{path}:{current_new_line}")
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
#     (V9.5 check 12: operator ed25519 signature at ingestion, ADR-0020,
#     owned by operator_feedback_ingestion / operator_request_signature)
#   * performance-expert HIGH-005 — per-source time budget governance event
#   * performance-expert HIGH-006 — F-finding aging stat-only (no JSON
#     parse until candidate selected)
#   * performance-expert HIGH-008 — pattern_signature lookback bounded


import hashlib
import json
import time
from datetime import datetime, timezone

from .evidence_trust import parse_evidence_ref
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

# ARIA-HIGH-250 — the failing_ci source answers "which workflows are red
# NOW", so it reads completed runs, not failed ones: a failed run stays failed
# after its workflow recovers, and the five newest failures on main named
# workflows that had long since gone green. The window is how many of the
# newest completed runs on the branch are read to find each workflow's newest
# verdict; a workflow with no completed run inside it has no current verdict.
_FAILING_CI_RUN_WINDOW: int = 200

# Only a pass or a fail says whether a workflow works. A cancelled, skipped,
# neutral, stale or action_required run says nothing about it, so it neither
# clears a red workflow nor turns a green one red.
_DECISIVE_RUN_CONCLUSIONS: frozenset[str] = frozenset({"success", "failure"})

# ORPHAN-HIGH-519 — the wall clock one scan spends asking which jobs of its
# red runs failed (one `gh run view` each). A run asked after it still cites
# its workflow file; only the job and step lines are lost.
_FAILING_CI_JOBS_LOOKUP_SECONDS: float = 60.0

# ADR-0019 — FAILING_CI is the slot ARCH-HIGH-002 gives production breakage,
# so only a red workflow whose verdict is about `main` or production fills it.
# The role manifest says what each workflow judges; a red `pr_verdict` or
# `observer` workflow is disclosed once per cycle and supplies no candidate.
# A workflow the manifest does not name counts as `main_verdict`, so a new
# workflow is never silently excluded. tests/invariants/workflow-roles.spec.ts
# pins the manifest to the files under .github/workflows/.
WORKFLOW_ROLES_MANIFEST_PATH = ".github/manifests/workflow-roles.json"
WORKFLOW_ROLES: tuple[str, ...] = ("main_verdict", "pr_verdict", "observer")
_MAIN_VERDICT_ROLE = "main_verdict"
FAILING_CI_WORKFLOW_EXCLUDED_EVENT = "failing_ci_workflow_excluded"
FAILING_CI_WORKFLOW_ROLES_UNAVAILABLE_EVENT = "failing_ci_workflow_roles_unavailable"
# The cache holds every red workflow BEFORE the role filter, each with its run
# id, so a manifest change applies on the next scan and every cycle discloses
# its own exclusions. Each entry carries its repository grounding (ORPHAN-HIGH-
# 519): the workflow file, and the failed jobs of a run the role filter kept.
# Version 1 held the filtered candidates without a run id; version 2 held no
# repository grounding, so a version-2 entry would reach the converter with
# nothing in the repository to cite.
_GH_RUN_LIST_CACHE_SCHEMA_VERSION: int = 3

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
    # ORPHAN-HIGH-519 — the heading's line is the register's citable anchor
    # (`orphan-findings.md:<line>`); `#<id>` names no file the rule can read.
    heading_line, counted_to = 1, 0
    for i, m in enumerate(matches):
        heading_line += text.count("\n", counted_to, m.start())
        counted_to = m.start()
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
            "heading_line": heading_line,
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
    # The one registry view (ARIA-HIGH-279): evidence a merged delta row
    # recorded is the finding's evidence. Tolerant mode: a corrupt or refused
    # row is skipped WITH a ledger_row_corrupt diagnostic / malformed record,
    # not silently swallowed. No registry in this checkout → nothing attached.
    from .report_ingestion import REGISTRY_FINDINGS_RELPATH, read_registry_view
    if not Path(workspace_root).joinpath(*REGISTRY_FINDINGS_RELPATH).is_file():
        return
    wanted = {c["candidate_id"] for c in candidates}
    evidence_by_id: dict[str, list[str]] = {}
    for row in read_registry_view(workspace_root, strict=False).rows:
        rid = row.get("id")
        if rid in wanted and isinstance(row.get("evidence"), list):
            evidence_by_id[rid] = [e for e in row["evidence"] if isinstance(e, str)]
    for c in candidates:
        ev = evidence_by_id.get(c["candidate_id"])
        if ev:
            c["evidence"] = ev


def scan_f_findings(findings: Mapping[str, Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 source — the F findings the finding-event fold holds.

    ARIA-MEDIUM-330 — candidates come from the fold
    (``finding.fold_findings``), the one authority for which findings
    exist. This scan used to glob ``F-*.json`` and age each file by its
    mtime, so F-101/F-102, which the pre-ORPHAN-702 seeder wrote beside the
    ledger, became candidates that admission then refused as
    ``finding_unknown``, and a store restore that reset every mtime reset
    every age. Age is the record's ``created_at``; an undateable record is
    as young as now. Returns candidates oldest-first.

    ``findings`` is the fold the synthesis already read
    (``finding_grounding.load_grounding_context``, ADR-0018 D5: one fold per
    synthesis), not a second read: the slot policy
    (``plan_slot_policy.order_for_slot``) judges status against that same
    fold, so the view that names the candidates and the view that drops the
    ones not OPEN cannot disagree. None — no ledger, or one the context
    refused — yields no candidates. Status stays the slot policy's and
    admission's question.
    """
    from .tool_registry import parse_utc_stamp

    now = time.time()
    candidates: list[dict[str, Any]] = []
    for finding_id, record in sorted((findings or {}).items()):
        stamp = record.get("created_at")
        created = parse_utc_stamp(stamp) if isinstance(stamp, str) else None
        created_epoch = created.timestamp() if created is not None else now
        candidates.append({
            "source_type": PlanCandidateSource.F_FINDING.value,
            "candidate_id": finding_id,
            "created_at": stamp,
            "age_seconds": now - created_epoch,
            "title_hint": f"Process aging F-finding {finding_id}",
        })
    candidates.sort(key=lambda c: -c["age_seconds"])  # oldest first
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
    if cached.get("schema_version") != _GH_RUN_LIST_CACHE_SCHEMA_VERSION:
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
        "schema_version": _GH_RUN_LIST_CACHE_SCHEMA_VERSION,
        "cached_at_epoch": time.time(),
        "cached_at_utc": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }, indent=2, sort_keys=True), encoding="utf-8")


def _newest_failures_of_red_workflows(rows: list[Any]) -> list[dict[str, Any]]:
    """The newest failed run of every workflow whose newest decisive run
    failed, newest first (ARIA-HIGH-250).

    A workflow is identified by ``workflowDatabaseId``: two workflow files
    may share a display name, and one going green must not clear the other.
    Runs are ordered here by ``createdAt`` rather than trusting the order
    ``gh`` printed them in, because "newest" is what decides the verdict.
    A row that names no workflow cannot be attributed to one and is skipped.
    """
    runs = [
        r for r in rows
        if isinstance(r, dict) and r.get("workflowDatabaseId") is not None
    ]
    runs.sort(key=lambda r: str(r.get("createdAt") or ""), reverse=True)
    decided: set[Any] = set()
    failing: list[dict[str, Any]] = []
    for r in runs:
        if r.get("conclusion") not in _DECISIVE_RUN_CONCLUSIONS:
            continue
        workflow_id = r["workflowDatabaseId"]
        if workflow_id in decided:
            continue
        decided.add(workflow_id)
        if r.get("conclusion") == "failure":
            failing.append(r)
    return failing


def _failing_jobs(payload: Any) -> list[dict[str, Any]]:
    """``[{name, failed_steps}]`` for the failed jobs of one ``gh run view --json jobs`` answer."""
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    failed: list[dict[str, Any]] = []
    for job in jobs if isinstance(jobs, list) else []:
        if not isinstance(job, dict) or job.get("conclusion") != "failure" or not isinstance(job.get("name"), str):
            continue
        steps = job.get("steps") if isinstance(job.get("steps"), list) else []
        failed.append({"name": job["name"], "failed_steps": [
            step["name"] for step in steps
            if isinstance(step, dict) and step.get("conclusion") == "failure" and isinstance(step.get("name"), str)
        ]})
    return failed


def _gh_json_reader(*, gh_cli: str, gh_token: str | None) -> Callable[..., Any] | None:
    """One read-only ``gh`` call, answering its parsed JSON (None when gh
    times out, exits non-zero or prints no JSON); the reader itself is None
    when GitHub must not be asked at all."""
    import os as _os
    import shutil

    # Plan ARIA-V3.1-F-2 — ARIA_DRY_RUN system-wide gate (closes C-8).
    # When set, short-circuit BEFORE the `gh run list` subprocess.
    # Used by the V3.1-F smoke to exercise the autonomous cycle path
    # without touching the real GitHub API. The autonomous profile's
    # preflight gate (V3.1-E) catches misconfigured hosts; this gate
    # is the per-call defense-in-depth.
    if _os.environ.get("ARIA_DRY_RUN", "").lower() in ("true", "1", "yes"):
        return None

    if not shutil.which(gh_cli):
        return None
    # Plan ARIA-V3.1-D-4 — explicit env when scoped token supplied.
    # When gh_token is None, fall through to subprocess's default
    # parent-env inheritance (V8 backward-compat).
    subprocess_env: dict[str, str] | None = None
    if gh_token is not None:
        subprocess_env = {
            "GH_TOKEN": gh_token,
            "PATH": _os.environ.get("PATH", "/usr/bin:/bin"),
        }

    def gh_json(*args: str) -> Any:
        try:
            proc = subprocess.run(
                [gh_cli, *args], capture_output=True, text=True, timeout=15, env=subprocess_env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return None
        if proc.returncode != 0:
            return None
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            return None
    return gh_json


def _red_workflow_runs(gh_json: Callable[..., Any], *, branch: str) -> list[dict[str, Any]] | None:
    """The newest failed run of every workflow red on ``branch`` now, as
    candidate dicts, before any role filter; None when GitHub did not answer.

    ORPHAN-HIGH-519 — a plan cites the repository, never the run: each red
    run is resolved to the workflow FILE GitHub ran (`gh run list` carries no
    path; one `gh workflow list` maps the workflow id to it). The file is the
    workflow's whatever its role, so it is resolved here; the failed jobs and
    steps are asked per run only for the candidates the role filter keeps
    (``_attach_failing_jobs``). An answer gh does not give leaves the field
    empty and the candidate ungrounded.
    """
    rows = gh_json(
        "run", "list", "--branch", branch, "--status", "completed",
        "--limit", str(_FAILING_CI_RUN_WINDOW), "--json",
        "databaseId,workflowDatabaseId,workflowName,headSha,conclusion,createdAt,event",
    )
    if not isinstance(rows, list):
        return None
    failing = _newest_failures_of_red_workflows(rows)
    workflows = gh_json("workflow", "list", "--all", "--limit", "1000", "--json", "id,path") if failing else None
    workflow_paths = {
        w.get("id"): w.get("path") for w in (workflows if isinstance(workflows, list) else [])
        if isinstance(w, dict)
    }
    red: list[dict[str, Any]] = []
    for r in failing:
        run_id = r.get("databaseId")
        workflow = r.get("workflowName") or "unknown"
        red.append({
            "source_type": PlanCandidateSource.FAILING_CI.value,
            "candidate_id": f"ci-run-{run_id}",
            "run_id": run_id,
            "workflow_name": workflow,
            "workflow_path": workflow_paths.get(r["workflowDatabaseId"]),
            "head_sha": r.get("headSha"),
            "conclusion": r.get("conclusion"),
            "created_at": r.get("createdAt"),
            "title_hint": f"Fix failing CI workflow '{workflow}' (run #{run_id})",
        })
    return red


def _attach_failing_jobs(
    candidates: list[dict[str, Any]], red: list[dict[str, Any]], gh_json: Callable[..., Any],
) -> None:
    """ORPHAN-HIGH-519 — the jobs and steps that failed in each kept
    candidate's run (one ``gh run view`` each, within
    ``_FAILING_CI_JOBS_LOOKUP_SECONDS``), which the converter locates in the
    workflow file. A red workflow the role filter excluded is never asked
    about. The answer is recorded on the run's red entry too, so the cached
    fetch carries it to every scan that reads the cache."""
    red_by_run = {entry.get("run_id"): entry for entry in red}
    deadline = time.monotonic() + _FAILING_CI_JOBS_LOOKUP_SECONDS
    for candidate in candidates:
        run_id = candidate.get("run_id")
        jobs = gh_json("run", "view", str(run_id), "--json", "jobs") if time.monotonic() < deadline else None
        candidate["failing_jobs"] = _failing_jobs(jobs)
        if run_id in red_by_run:
            red_by_run[run_id]["failing_jobs"] = list(candidate["failing_jobs"])


def _parse_workflow_roles(raw: bytes) -> dict[str, str] | None:
    """Role by the workflow name GitHub reports a run under, or None when
    the manifest is not the schema the invariant pins (no partial reading:
    a manifest the kernel cannot fully trust excludes nothing)."""
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        return None
    entries = manifest.get("workflows")
    if not isinstance(entries, list):
        return None
    roles: dict[str, str] = {}
    for entry in entries:
        name = entry.get("name") if isinstance(entry, dict) else None
        role = entry.get("role") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name or name in roles or role not in WORKFLOW_ROLES:
            return None
        roles[name] = role
    return roles


def _read_workflow_roles(workspace: Path) -> tuple[dict[str, str] | None, dict[str, Any]]:
    """The role manifest and where it was read from (ADR-0019).

    Read the way the operator channel reads its allowed-signers file: as
    committed at the checkout's commit once ``main_anchor`` proves that
    commit is on ``main``, through the hardened git. A checkout that cannot
    be anchored (no git, a commit not on main) is read from its working
    tree, and the provenance names which one was read. None: no usable
    manifest, so no workflow is excluded; the reason rides in the provenance.

    Only a workspace that is itself a checkout root (``.git`` dir, or file
    in a linked worktree) is anchored: git discovers a repository by walking
    UP from ``-C``, so a workspace that is not one would be judged by the
    manifest of whatever repository encloses it.
    """
    from .main_anchor import committed_blob, resolve_main_anchor

    anchor = resolve_main_anchor(workspace) if (workspace / ".git").exists() else None
    raw: bytes | None
    if anchor is not None and anchor.commit is not None:
        provenance: dict[str, Any] = {
            "manifest_source": "main_anchor", "manifest_commit": anchor.commit,
        }
        blob = committed_blob(workspace, commit=anchor.commit, path=WORKFLOW_ROLES_MANIFEST_PATH)
        raw = blob.content if blob is not None else None
    else:
        provenance = {
            "manifest_source": "checkout", "manifest_commit": None,
            "anchor_reason": anchor.reason if anchor is not None else "workspace_not_checkout_root",
        }
        try:
            raw = (workspace / WORKFLOW_ROLES_MANIFEST_PATH).read_bytes()
        except OSError:
            raw = None
    if raw is None:
        return None, {**provenance, "reason": "manifest_unavailable"}
    roles = _parse_workflow_roles(raw)
    if roles is None:
        return None, {**provenance, "reason": "manifest_malformed"}
    return roles, provenance


def _main_verdict_candidates(
    red: list[dict[str, Any]], *, workspace: Path, tools_root: Path, cycle_id: str | None,
) -> list[dict[str, Any]]:
    """The red workflows whose verdict is about ``main`` (ADR-0019).

    Every excluded red workflow is disclosed as ONE governance event per
    cycle (workflow, role, run id), never dropped silently; without a usable
    manifest every red stays a candidate and that is disclosed once per
    cycle instead.
    """
    if not red:
        return []
    from .tool_registry import append_tools_governance_once

    roles, provenance = _read_workflow_roles(workspace)
    if roles is None:
        append_tools_governance_once(tools_root, FAILING_CI_WORKFLOW_ROLES_UNAVAILABLE_EVENT, {
            "cycle_id": cycle_id, "manifest_path": WORKFLOW_ROLES_MANIFEST_PATH,
            "red_workflows": sorted({str(entry.get("workflow_name")) for entry in red}),
            **provenance,
        }, claim_keys=("cycle_id", "reason"))
    candidates: list[dict[str, Any]] = []
    for entry in red:
        declared = roles.get(str(entry.get("workflow_name"))) if roles is not None else None
        role = declared or _MAIN_VERDICT_ROLE
        if role == _MAIN_VERDICT_ROLE:
            candidates.append({
                **entry, "workflow_role": role, "workflow_role_declared": declared is not None,
            })
            continue
        append_tools_governance_once(tools_root, FAILING_CI_WORKFLOW_EXCLUDED_EVENT, {
            "cycle_id": cycle_id, "workflow_name": entry.get("workflow_name"), "role": role,
            "run_id": entry.get("run_id"), "head_sha": entry.get("head_sha"), **provenance,
        }, claim_keys=("cycle_id", "workflow_name", "role", "run_id"))
    return candidates


def scan_failing_ci(
    workspace_root: str | Path,
    *,
    cache_dir: str | Path | None = None,
    gh_cli: str = "gh",
    branch: str = "main",
    gh_token: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 + V3.1-D-4 source — the workflows that are red on
    ``main`` now and whose verdict is about ``main``: each workflow's newest
    decisive run (see ``_DECISIVE_RUN_CONCLUSIONS``) among the newest
    ``_FAILING_CI_RUN_WINDOW`` completed runs, kept when it failed. One
    candidate per red workflow, carrying that newest failed run
    (ARIA-HIGH-250). Only a ``main_verdict`` workflow of the role manifest
    (or one it does not name) supplies a candidate; each excluded red
    workflow is disclosed once per ``cycle_id`` in the governance ledger of
    ``base_dir`` (default ``<workspace>/aria-tools``) — ADR-0019.

    ORPHAN-HIGH-519 — each candidate is grounded in the repository, not in
    the run: ``workflow_path`` (the workflow file GitHub ran) and
    ``failing_jobs`` (the jobs and steps that failed in that run, asked only
    for the candidates the role filter keeps, within
    ``_FAILING_CI_JOBS_LOOKUP_SECONDS``), which the converter locates in
    that file.

    Cached at ``<workspace>/aria-tools/cache/gh-run-list.json`` with
    10-min TTL (arb MED-003 + perf CRIT-003 rate-limit mitigation). The
    cache holds the red workflows before the role filter, with that
    grounding.

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
    workspace = Path(workspace_root).resolve()
    if cache_dir is None:
        cache_path = workspace / "aria-tools" / "cache" / "gh-run-list.json"
    else:
        cache_path = Path(cache_dir) / "gh-run-list.json"

    red = _read_gh_run_list_cache(cache_path)
    gh_json: Callable[..., Any] | None = None
    if red is None:
        gh_json = _gh_json_reader(gh_cli=gh_cli, gh_token=gh_token)
        red = _red_workflow_runs(gh_json, branch=branch) if gh_json is not None else None
        if red is None:
            return []
    tools_root = Path(base_dir) if base_dir is not None else workspace / "aria-tools"
    candidates = _main_verdict_candidates(
        red, workspace=workspace, tools_root=tools_root, cycle_id=cycle_id,
    )[:_MAX_CANDIDATES_PER_SOURCE]
    if gh_json is not None:
        # This scan asked GitHub: the kept candidates' failed jobs are asked
        # now, and the fetch is cached with those answers on it.
        _attach_failing_jobs(candidates, red, gh_json)
        _write_gh_run_list_cache(cache_path, red)
    for candidate in candidates:
        # A cached red entry the fetch's role filter excluded was never asked
        # about; once kept it still cites its workflow file, as a run asked
        # past the lookup bound does.
        candidate.setdefault("failing_jobs", [])
    return candidates


def scan_operator_feedback(
    workspace_root: str | Path,
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 source — operator-signed request rows from
    ``aria-tools/operator-feedback.jsonl``, verified at ingestion.

    V9.5 hard-fail check 12 (ai-safety HIGH-010): the pre-fix verifier
    checked that ``signature`` and ``signature_kid`` were NON-EMPTY, so any
    process that could append a line spoke with operator authority, and the
    drop count rode on the first surviving candidate where nothing read it.
    ``operator_feedback_ingestion.ingest_operator_feedback`` now owns the
    read: ed25519 verification of every request against the allowed-signers
    file committed at the checkout's HEAD (ADR-0020), one
    ``unsigned_operator_feedback`` governance event per drop, spent requests
    skipped (ADR-0018 D3), and an ingestion row the pre-merge perimeter joins
    the merged plan back to. This function only orders what it admitted —
    highest priority first, oldest first within a priority.

    ``base_dir`` names the tools store when the caller knows it (the
    provider does; ``ARIA_TOOLS_DIR`` can point it away from
    ``<workspace>/aria-tools``); the legacy single-argument call keeps the
    workspace-relative default.
    """
    from .operator_feedback_ingestion import ingest_operator_feedback

    tools_root = Path(base_dir) if base_dir is not None else Path(workspace_root) / "aria-tools"
    candidates = list(ingest_operator_feedback(
        base_dir=tools_root, cycle_id=cycle_id, repo_root=workspace_root,
    ).candidates)
    priority_rank = {"high": 0, "medium": 1, "low": 2}
    candidates.sort(key=lambda c: (priority_rank.get(c["priority"], 99), c["authored_at"]))
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
    # Plan 032 Faz 032f — filed by a person, unsigned: same tier as failing CI.
    PlanCandidateSource.GITHUB_ISSUE.value: 1,
}


def scan_github_issue_missions(workspace_root: str | Path) -> list[dict[str, Any]]:
    """Plan 032 Faz 032f source — open missions the gateway opened from
    GitHub issues labelled ``aria``. Reads the mission fold only; the
    issue body never enters a candidate (the mission title is the
    gateway's 200-char, label-gated summary)."""
    from .gateway.router import ISSUE_MISSION_SOURCE_KIND
    from .mission import list_open_missions

    tools_root = Path(workspace_root) / "aria-tools"
    if not (tools_root / "missions").exists():
        return []
    candidates: list[dict[str, Any]] = []
    for mission in list_open_missions(base_dir=tools_root):
        # The gateway's constant, not a literal copy of it: this scanner is
        # the named consumer `mission_dispatch.GENERIC_PROJECTION_POINTERS`
        # cites for `triage_github_issue`, and a copy is how the router and
        # its reader come to disagree about what an issue mission is called.
        if str(mission.get("source_kind") or "") != ISSUE_MISSION_SOURCE_KIND:
            continue
        candidates.append({
            "source_type": PlanCandidateSource.GITHUB_ISSUE.value,
            "candidate_id": str(mission.get("mission_id")),
            "source_id": mission.get("source_id"),
            "mission_state": mission.get("state"),
            "priority": mission.get("priority") if isinstance(mission.get("priority"), int) else 1,
            "created_at": mission.get("opened_at"),
            "title_hint": str(mission.get("title") or "")[:200],
        })
    return candidates[:_MAX_CANDIDATES_PER_SOURCE]


def rank_candidate_sources(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    findings: Mapping[str, Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V9.4 — scan all 5 sources + return ranked candidates.

    Order: per-source priority (OPERATOR_FEEDBACK > FAILING_CI >
    ORPHAN > F_FINDING > GIT_DIFF) then within-source severity / age
    rank. Empty list when no source has candidates.

    Per-source scan timing emitted as ``plan_source_scan_slow``
    governance event when single source > 2s (perf HIGH-005).

    ``base_dir`` / ``cycle_id`` reach the operator-feedback scanner — its
    ingestion row is written to the tools store and stamped with the cycle
    so the provider can bind the synthesis it selects to that scan (V9.5
    check 12) — and the failing-CI scanner, which discloses each red
    workflow it excludes once per cycle in that store (ADR-0019).

    ``findings`` is the caller's finding fold, which the F_FINDING source
    reads instead of folding the ledger again (ARIA-MEDIUM-330; see
    :func:`scan_f_findings`). It is required, so no caller can rank F
    candidates from one view and judge them against another.
    """
    workspace = Path(workspace_root).resolve()
    all_candidates: list[dict[str, Any]] = []
    timings: dict[str, float] = {}

    def _scan_operator_feedback(root: Path) -> list[dict[str, Any]]:
        return scan_operator_feedback(root, base_dir=base_dir, cycle_id=cycle_id)

    def _scan_failing_ci(root: Path) -> list[dict[str, Any]]:
        return scan_failing_ci(root, base_dir=base_dir, cycle_id=cycle_id)

    def _scan_f_findings(_root: Path) -> list[dict[str, Any]]:
        return scan_f_findings(findings)

    for source_name, scanner in (
        (PlanCandidateSource.OPERATOR_FEEDBACK.value, _scan_operator_feedback),
        (PlanCandidateSource.FAILING_CI.value, _scan_failing_ci),
        (PlanCandidateSource.ORPHAN_FINDING.value, scan_orphan_findings),
        (PlanCandidateSource.F_FINDING.value, _scan_f_findings),
        (PlanCandidateSource.GITHUB_ISSUE.value, scan_github_issue_missions),
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


@dataclass(frozen=True)
class PlanEvidenceGround:
    """Where a plan's evidence is judged: the checkout, at the commit its planning envelopes name.

    ORPHAN-HIGH-519 — ``target_sha`` is resolved by the drainer's own resolver,
    the value every challenger request carries, so a ref admitted here is
    admitted again when the challenger cites it at the submit.
    """

    repo_root: Path
    target_sha: str | None

    @classmethod
    def of(cls, workspace_root: str | Path) -> "PlanEvidenceGround":
        from .convergence_drainer import _resolve_workspace_head_sha

        root = Path(workspace_root).resolve()
        return cls(root, _resolve_workspace_head_sha(root))


@dataclass(frozen=True)
class PlanCandidateConversion:
    """One candidate's conversion: the plan, or none and the named reason.

    ``refused_evidence_refs`` names every ref the challenger's rule refused
    (a plan that was minted carries it too); ``harness_fault`` is True when
    the only refusals were the harness failing to verify.
    """

    envelope: "CyclePlanEnvelope | None"
    skip_reason: str | None = None
    refused_evidence_refs: tuple[dict[str, Any], ...] = ()
    harness_fault: bool = False


_NO_PLAN = PlanCandidateConversion(None)
# ARIA-HIGH-369 — an F_FINDING candidate reached conversion without the seed
# ``finding_seed.admit_and_seed`` re-grounds it into; no template plan stands in.
F_FINDING_UNSEEDED = "f_finding_unseeded"


def _admit_plan_refs(refs: list[str], ground: PlanEvidenceGround) -> tuple[list[str], PlanCandidateConversion]:
    """(admitted refs, the no-plan conversion naming each refused ref), by the challenger's rule.

    The rule is ``evidence_validator.admissible_agent_evidence_refs`` — the
    function the submit path applies; there is no plan-side copy of it. A
    refused ref is named the way governance names one (``_ref_label``).
    """
    from .evidence_validator import PLAN_EVIDENCE_INADMISSIBLE, admissible_agent_evidence_refs
    from .finding_grounding import _ref_label

    verdict = admissible_agent_evidence_refs(refs, workspace_root=ground.repo_root, target_sha=ground.target_sha)
    refused = tuple({"ref": _ref_label(str(entry["ref"])), "codes": entry["codes"]} for entry in verdict.refused)
    return list(verdict.admitted), PlanCandidateConversion(
        None, PLAN_EVIDENCE_INADMISSIBLE, refused, verdict.harness_fault,
    )


def _finding_refs(references: list[Any]) -> list[str]:
    """An ORPHAN finding's registry references that name a path inside the checkout."""
    evidence_refs: list[str] = []
    for ref in references:
        if not isinstance(ref, str) or not ref.strip():
            continue
        ref = ref.strip()
        if _looks_unsafe_repo_path(ref) or ref in evidence_refs:
            continue
        evidence_refs.append(ref)
        if len(evidence_refs) >= _FINDING_EVIDENCE_CAP:
            break
    return evidence_refs


def _looks_unsafe_repo_path(value: str) -> bool:
    return value.startswith("/") or "\\" in value or value.startswith("../") or "/../" in value


def _named_line(lines: list[str], name: str, start: int) -> int | None:
    """1-based line at or after index ``start`` naming ``name``: a ``name:`` value or a mapping key.

    GitHub reports a job by its ``name:`` or, without one, its key; a matrix
    leg as ``job (a, b)``, so a trailing parenthesised group is dropped.
    """
    base = re.sub(r"\s*\([^()]*\)$", "", name).strip()
    if not base:
        return None
    wanted = {f"name: {base}", f'name: "{base}"', f"name: '{base}'", f"{base}:"}
    for index in range(start, len(lines)):
        text = lines[index].strip()
        if (text[2:].strip() if text.startswith("- ") else text) in wanted:
            return index + 1
    return None


def _workflow_evidence_refs(repo_root: Path, workflow_path: Any, failing_jobs: Any) -> list[str]:
    """``<workflow>:<line>`` of each failing step, then of its job, then the file itself.

    [] when ``workflow_path`` is not a workflow file of this checkout's shape
    (gh answered no path, or a dynamic workflow such as code scanning).
    """
    from .finding_grounding import safe_repo_ref

    if not (isinstance(workflow_path, str) and workflow_path.startswith(".github/workflows/")
            and safe_repo_ref(workflow_path)):
        return []
    try:
        lines = (repo_root / workflow_path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    jobs_at = next((i for i, line in enumerate(lines) if line.split("#", 1)[0].rstrip() == "jobs:"), None)
    refs: list[str] = []
    for job in failing_jobs if isinstance(failing_jobs, list) and jobs_at is not None else []:
        if not (isinstance(job, dict) and isinstance(job.get("name"), str)):
            continue
        job_line = _named_line(lines, job["name"], jobs_at + 1)
        if job_line is None:
            continue
        steps = job.get("failed_steps") if isinstance(job.get("failed_steps"), list) else []
        step_lines = [_named_line(lines, step, job_line) for step in steps if isinstance(step, str)]
        refs += [f"{workflow_path}:{line}" for line in step_lines if line is not None]
        refs.append(f"{workflow_path}:{job_line}")
    refs.append(workflow_path)
    return list(dict.fromkeys(refs))


def convert_candidate_to_plan_content(
    candidate: Mapping[str, Any],
    *,
    admission: "FindingAdmission | None" = None,
    ground: PlanEvidenceGround,
    seed: "FindingSeed | None" = None,
) -> PlanCandidateConversion:
    """Plan ARIA-V3.1-A — convert one ranked candidate into a
    CyclePlanEnvelope (closes 6-validator audit C-5 + H-2 + H-8).

    ``admission`` is the verdict of ``finding_grounding.admit_candidate``
    for the same candidate (ADR-0018 D5). A source that names an F finding
    (``f_finding``, ``operator_feedback``) converts ONLY on an admitted
    verdict for that finding, and its evidence and surfaces are the
    admission's — grounded in tracked files of the cycle's checkout, never a
    self-output path, never a readonly surface. Without one it converts to no plan.

    ORPHAN-HIGH-519 — every source's refs then pass the challenger's rule at
    ``ground`` (``_admit_plan_refs``): refused refs are dropped and named,
    and a candidate none of whose refs passes converts to no plan with
    ``skip_reason`` ``plan_evidence_inadmissible``. Where a plan came from
    (the operator's feedback row, the CI run) is ``provenance_refs``, never
    evidence: no challenger can cite either.

    ARIA-HIGH-369 — ``seed`` is ``finding_seed.seed_finding``'s re-grounding
    of the same finding at the anchor. An F_FINDING plan is built ONLY from
    it — its refs as they stand now, its subject's sides, its title, summary
    and one key change per surface — and converts to no plan
    (:data:`F_FINDING_UNSEEDED`) without one; there is no template F plan. An
    operator request cites the seed's refs when there is one (a moved line
    re-anchored) and the refs it signed otherwise.

    The caller iterates to the next ranked candidate when no plan results
    (V3.1-A-3 iterative fallback) and emits one
    ``plan_candidate_conversion_skipped`` governance event per skip.

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

    Candidate shapes (per source_type):

    * `operator_feedback` — { candidate_id, finding_id, priority,
      request, authored_at, signer, row_ledger_hash,
      ingestion_ledger_hash, title_hint } (admitted by
      ``operator_feedback_ingestion``)
    * `failing_ci` — { candidate_id, workflow_name, workflow_path,
      failing_jobs, head_sha, conclusion, created_at, title_hint }
    * `orphan_finding` — { candidate_id, severity, raw_id, heading_line,
      evidence, title_hint }
    * `f_finding` — { candidate_id, created_at, age_seconds,
      title_hint }
    * `git_diff` — synthesized by V7GitDiffProvider, not by this
      function.
    """
    if not isinstance(candidate, Mapping):
        return _NO_PLAN
    source_type = candidate.get("source_type")
    candidate_id = candidate.get("candidate_id")
    if not isinstance(source_type, str) or not isinstance(candidate_id, str):
        return _NO_PLAN
    if source_type not in {
        PlanCandidateSource.OPERATOR_FEEDBACK.value,
        PlanCandidateSource.FAILING_CI.value,
        PlanCandidateSource.ORPHAN_FINDING.value,
        PlanCandidateSource.F_FINDING.value,
    }:
        # GIT_DIFF goes through V7GitDiffProvider; unknown source
        # types skipped + caller falls back.
        return _NO_PLAN
    # Lazy imports — CyclePlanEnvelope + sanitizer live in modules
    # that import this module's helpers; avoid circular import at
    # module load.
    from .cycle_phases.plan_source import CyclePlanEnvelope
    from .operator_feedback_ingestion import PROVENANCE_REF_PREFIX
    from .plan_origin import ORPHAN_FINDINGS_DOCUMENT
    from .text_safety import sanitize_untrusted_text
    title_hint = sanitize_untrusted_text(
        candidate.get("title_hint") or f"Address {candidate_id}",
        max_len=200,
    )
    finding_sourced = source_type in {
        PlanCandidateSource.OPERATOR_FEEDBACK.value,
        PlanCandidateSource.F_FINDING.value,
    }
    if finding_sourced and (admission is None or not admission.admitted):
        return _NO_PLAN
    provenance_refs: list[str] = []
    key_changes: list[dict[str, Any]] | None = None
    signed_fallback: list[str] | None = None
    # Per-source content authoring. Each branch builds the same
    # canonical 7-field plan_content; only the textual hints differ.
    if source_type == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        # ADR-0018 D6 — the summary is fixed text naming the request, its
        # priority and the finding, plus the operator's own sanitized words.
        # No field of the finding BODY (title, claim summary, scope, risks,
        # recommendation) reaches the plan: the finding is ARIA's output, and
        # its prose is not the operator's instruction. The finding id comes
        # from the signed row, so the admission must be for that id.
        if admission.finding_id != candidate.get("finding_id"):
            return _NO_PLAN
        request = sanitize_untrusted_text(candidate.get("request") or "", max_len=1024)
        if not request:
            return _NO_PLAN
        priority = sanitize_untrusted_text(candidate.get("priority") or "", max_len=16)
        title_hint = sanitize_untrusted_text(
            f"Operator request {candidate_id}: remediate {admission.finding_id}", max_len=200,
        )
        summary = (
            f"Operator request {candidate_id} (priority {priority}) asks for a "
            f"root-cause remediation of finding {admission.finding_id}. "
            f"Operator text: {request}"
        )
        # The signed grounding is the evidence; the feedback row is provenance.
        # ARIA-HIGH-369 review M1 — a seed may only move a SIGNED ref to its
        # current line (never add a ref or a surface the operator did not
        # sign), and when the moved refs are refused the signed ones are
        # judged instead, so a seed can never get the request spent.
        evidence_refs = list(admission.evidence_refs)
        if seed is not None and seed.finding_id == admission.finding_id:
            moved_refs = list(seed.signed_refs_moved(admission.evidence_refs))
            signed_fallback = evidence_refs if moved_refs != evidence_refs else None
            evidence_refs = moved_refs
        provenance_refs = [f"{PROVENANCE_REF_PREFIX}{candidate_id}"]
        affected_surfaces = list(admission.affected_surfaces)
    elif source_type == PlanCandidateSource.FAILING_CI.value:
        workflow = sanitize_untrusted_text(
            candidate.get("workflow_name") or "unknown", max_len=200,
        )
        head_sha = sanitize_untrusted_text(
            candidate.get("head_sha") or "", max_len=64,
        )
        workflow_path = candidate.get("workflow_path")
        evidence_refs = _workflow_evidence_refs(ground.repo_root, workflow_path, candidate.get("failing_jobs"))
        affected_surfaces = [str(workflow_path)] if evidence_refs else []
        summary = (
            f"Failing CI workflow '{workflow}' ({', '.join(affected_surfaces)}) on head "
            f"{head_sha or 'unknown'}; diagnose root cause + land architectural fix."
        )
        provenance_refs = [f"gh-run-list:{candidate_id}"]
    elif source_type == PlanCandidateSource.ORPHAN_FINDING.value:
        severity = sanitize_untrusted_text(
            candidate.get("severity") or "MEDIUM", max_len=16,
        )
        raw_id = sanitize_untrusted_text(
            candidate.get("raw_id") or "000", max_len=16,
        )
        summary = (
            f"Address ORPHAN-{severity}-{raw_id} from "
            f"{ORPHAN_FINDINGS_DOCUMENT} (architectural root-cause fix)."
        )
        # ORPHAN-312 root fix — the registry's real ``evidence`` file list
        # (attached by scan_orphan_findings) points the plan at the code the
        # finding is about; the finding's heading line in the register is
        # cited after it, so the challenger can read the finding itself.
        registry_evidence = candidate.get("evidence")
        evidence_refs = _finding_refs(registry_evidence if isinstance(registry_evidence, list) else [])
        heading = candidate.get("heading_line")
        if isinstance(heading, int) and not isinstance(heading, bool) and heading > 0:
            evidence_refs.append(f"{ORPHAN_FINDINGS_DOCUMENT}:{heading}")
        affected_surfaces = []
    else:  # F_FINDING
        if admission.finding_id != candidate_id:
            return _NO_PLAN
        if seed is None or seed.finding_id != candidate_id:
            return PlanCandidateConversion(None, F_FINDING_UNSEEDED)
        # ORPHAN-312 / ARIA-HIGH-181 — grounded in the finding's REAL code
        # references, never the finding JSON. ARIA-HIGH-369 — and as they
        # stand at the anchor (the seed re-read every cited line, or asked the
        # finding's own detector), with the plan's text built from the seed's
        # ids, paths and side names instead of a template.
        title_hint, summary, key_changes = seed.plan_text()
        title_hint = sanitize_untrusted_text(title_hint, max_len=200)
        summary = sanitize_untrusted_text(summary, max_len=2048)
        key_changes = [{**change, "description": sanitize_untrusted_text(change["description"], max_len=1024)}
                       for change in key_changes]
        evidence_refs = list(seed.evidence_refs)
        affected_surfaces = list(seed.affected_surfaces)

    evidence_refs, refusal = _admit_plan_refs(evidence_refs, ground)
    if not evidence_refs and signed_fallback is not None:
        moved_refusal = refusal
        evidence_refs, refusal = _admit_plan_refs(signed_fallback, ground)
        refusal = replace(refusal, refused_evidence_refs=moved_refusal.refused_evidence_refs
                          + refusal.refused_evidence_refs)
    if not evidence_refs:
        return refusal
    if source_type == PlanCandidateSource.ORPHAN_FINDING.value:
        # ARIA-HIGH-211 — a surface is the path the fix touches (the line is
        # not part of it); the register is the surface only when no code ref
        # of the finding was admitted.
        cited = [parsed[0] for parsed in map(parse_evidence_ref, evidence_refs) if parsed is not None]
        affected_surfaces = [path for path in dict.fromkeys(cited) if path != ORPHAN_FINDINGS_DOCUMENT]
        affected_surfaces = affected_surfaces or [ORPHAN_FINDINGS_DOCUMENT]

    content: dict[str, Any] = {
        # schema_version 2 — coverage-gated (see synthesize_plan_content_from_cycle).
        "schema_version": 2,
        "title": title_hint,
        "summary": summary,
        "affected_surfaces": affected_surfaces,
        "key_changes": key_changes if key_changes is not None else [
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
    if provenance_refs:
        content["provenance_refs"] = provenance_refs
    # ARIA-HIGH-104 (4) — the plan's ORIGIN is a plan claim, recorded in the
    # body (hash-covered, revised and cross-reviewed like every other claim)
    # and not only in the sidecar metadata that never reaches the plan
    # ledger. Staging already read `plan_content.finding_id` onto the change
    # chain and fell back to `plan:<plan_id>` because no producer wrote it;
    # `plan_origin.commit_contract_for_plan` derives the commit trailer from
    # it. A finding-sourced candidate's id IS the finding id (ORPHAN-<SEV>-NNN
    # from the orphan register, F-NNN from aria-findings/); an operator
    # request carries the F finding it signed (ADR-0018), the admitted one.
    # The other sources have no finding, so the key is absent rather than
    # invented.
    if source_type in {
        PlanCandidateSource.ORPHAN_FINDING.value,
        PlanCandidateSource.F_FINDING.value,
    }:
        content["finding_id"] = candidate_id
    elif source_type == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        content["finding_id"] = admission.finding_id
    metadata: dict[str, Any] = {
        "_pressure_source_type": source_type,
        "_candidate_id": candidate_id,
    }
    return PlanCandidateConversion(
        CyclePlanEnvelope(content=content, metadata=metadata),
        refused_evidence_refs=refusal.refused_evidence_refs,
    )


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
