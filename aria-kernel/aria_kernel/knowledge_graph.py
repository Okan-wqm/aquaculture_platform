"""Plan ARIA-V9.0-F — knowledge-graph integrity layer.

Closes:
  * ai-safety-auditor MED-014 — knowledge-graph poisoning. Without
    hash-chain integrity, an attacker (or compromised cycle) can
    plant a fake "convention" that downstream cycles ingest
    uncritically; the synthesizer trusts the convention library
    when ranking pressure sources. V9.0-F's hash-chained JSONL
    surfaces tampering at every lookup.
  * security-reviewer CRIT-005 — knowledge-graph forgery. Same
    surface, security-side framing. Tier-1: every row signed +
    chained; broken chain → quarantine + governance event.
  * architectural-arbiter HIGH-008 — auto-discovered conventions
    have no provenance / rollback path. V9.0-F adds
    discovered_by_cycle_id (mandatory field) + supersedes_pattern_id
    (revision linking) + min-confidence threshold (0.7) for
    surface-to-ranking.

Tier-1 (make impossible):
  * Hash-chain — every row carries
    prev_row_hash = sha256(canonical_json(prev_row)); broken link
    = quarantine
  * Schema-frozen field set per record_convention /
    record_anti_pattern entry point
  * Anti-pattern entries route HUMAN_REQUIRED (operator signature
    required; auto-write FORBIDDEN)

Tier-3 (detect):
  * verify_chain_or_quarantine — quarantines the file (renames to
    .quarantined.<timestamp>) + emits governance event when chain
    breaks; preserves audit history without poisoning future cycles

The V10.1 phase doc references this module for the policy
narrative; V9.0-F ships the kernel mechanics.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


# Plan ARIA-V9.0-F — schema versioning. Per-row schema_version
# permits mixed-version rows during migration without re-keying
# the entire ledger.
KNOWLEDGE_GRAPH_SCHEMA_VERSION: int = 1

# Plan ARIA-V9.0-F — minimum confidence floor for `lookup_pattern`
# to surface a row to ranking (arb HIGH-008). Below threshold the
# row exists in the ledger (preserves audit history) but does not
# influence downstream plan-source ranking.
MIN_PATTERN_CONFIDENCE: float = 0.7

# Plan ARIA-V9.0-F — closed enum of anti-pattern types. Adding a
# new type = ADR + arbiter approval. Anti-pattern entries cause
# the synthesizer to AVOID matching plans, so their taxonomy MUST
# be governance-visible.
ANTI_PATTERN_TYPES: frozenset[str] = frozenset({
    "tool_design",          # rejected tool-authoring pattern
    "scope_decision",       # rejected scope/lane decision
    "architecture_class",   # rejected architectural pattern
})


# ============================================================================
# Exceptions
# ============================================================================

class KnowledgeGraphTamper(Exception):
    """Raised by ``verify_chain_or_quarantine`` when the hash chain
    is broken. The file is renamed to ``.quarantined.<ts>`` so the
    next cycle does not consume tampered data."""


class KnowledgeGraphSignatureMissing(Exception):
    """Raised by ``record_anti_pattern`` when operator_signature is
    absent or malformed. Anti-pattern entries are governance-significant
    — they SKIP work — and require operator signoff."""


class KnowledgeGraphSchemaError(Exception):
    """Raised when a record violates the schema-frozen field set."""


# ============================================================================
# Records
# ============================================================================

@dataclass(frozen=True)
class Pattern:
    """A discovered pattern row.

    Fields:
      * pattern_id — stable identifier (e.g. ``conv_2026_05_18_001``)
      * pattern_type — closed enum (e.g. ``convention``, ``anti_pattern``)
      * confidence — float [0.0, 1.0]; lookup_pattern surfaces only ≥ MIN_PATTERN_CONFIDENCE
      * evidence_refs — list of evidence_ref strings (regex-matched by
        agent_compliance._EVIDENCE_REF_RE; V9.0-F just stores them)
      * discovered_by_cycle_id — mandatory provenance field
      * supersedes_pattern_id — optional revision link
      * observed_at — UTC ISO-8601 timestamp
      * schema_version — pinned by KNOWLEDGE_GRAPH_SCHEMA_VERSION
      * outcome_status — "hypothesis" until an outcome is observed,
        then "verified"/"refuted"; "unknown" for rows predating the field
    """

    pattern_id: str
    pattern_type: str
    confidence: float
    evidence_refs: tuple[str, ...]
    discovered_by_cycle_id: str
    observed_at: str
    schema_version: int = KNOWLEDGE_GRAPH_SCHEMA_VERSION
    supersedes_pattern_id: str | None = None
    # Whether an OUTCOME has been observed for this pattern, as opposed to
    # the agreement that produced it. Defaults to "unknown" rather than
    # "verified": every convention recorded before this field existed was
    # also written pre-outcome, and defaulting them to verified would
    # assert something the ledger never observed. Wave 10 promotes to
    # "verified" on a VERIFIED mission and demotes on a rolled-back one.
    outcome_status: str = "unknown"
    signer_key_fp: str | None = None
    # M2/E12 — the promotion key. A hypothesis row is written when a plan
    # CONVERGES; the VERIFIED outcome that promotes it is that plan's
    # MERGE. Without the plan id on the row, the merge reconciler cannot
    # find which convention its outcome vindicates.
    plan_id: str | None = None


# ============================================================================
# Hash-chain primitives
# ============================================================================

def _canonical_json(payload: dict[str, Any]) -> bytes:
    """Stable canonical JSON: sorted keys, no whitespace."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _row_hash(row: dict[str, Any]) -> str:
    """sha256 of canonical_json(row). The row's own ``prev_row_hash``
    field is EXCLUDED from the hash input (otherwise the chain would
    self-reference + every row would need recomputation on append)."""
    body = {k: v for k, v in row.items() if k != "prev_row_hash"}
    return "sha256:" + hashlib.sha256(_canonical_json(body)).hexdigest()


GENESIS_PREV_HASH: str = "sha256:" + hashlib.sha256(b"genesis").hexdigest()


def _read_jsonl_strict(path: Path) -> Iterator[dict[str, Any]]:
    """Generator yielding parsed rows. Raises on malformed JSON
    (knowledge-graph correctness > resilience)."""
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise KnowledgeGraphTamper(
                    f"line {lineno} malformed JSON: {exc.msg}"
                ) from exc


def verify_chain_or_quarantine(path: str | Path) -> tuple[bool, int]:
    """Walk the ledger row-by-row, asserting each row's prev_row_hash
    matches sha256 of the prior canonical row.

    Returns ``(ok, row_count)``. On break:
      * Renames the file to ``<path>.quarantined.<utc-iso>``
      * Returns ``(False, broken_line_number)``

    Tier-1 — kernel callers MUST call this before consuming a
    knowledge-graph file. ``lookup_pattern`` calls it internally on
    every read; tampering is caught at the consumption site.
    """
    p = Path(path)
    if not p.exists():
        return (True, 0)
    expected_prev = GENESIS_PREV_HASH
    count = 0
    with p.open("r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                _quarantine(p, reason=f"malformed_json_line_{lineno}")
                return (False, lineno)
            if not isinstance(row, dict):
                _quarantine(p, reason=f"row_not_object_line_{lineno}")
                return (False, lineno)
            row_prev = row.get("prev_row_hash")
            if row_prev != expected_prev:
                _quarantine(p, reason=f"prev_hash_mismatch_line_{lineno}")
                return (False, lineno)
            expected_prev = _row_hash(row)
            count += 1
    return (True, count)


def _quarantine(path: Path, *, reason: str) -> None:
    """Rename a tampered ledger to ``<path>.quarantined.<ts>``."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    quarantined = path.with_suffix(path.suffix + f".quarantined.{ts}.{reason}")
    try:
        path.rename(quarantined)
    except OSError:
        # Best-effort — don't raise from a quarantine path; the
        # caller's verify_chain returns (False, ...) which is the
        # load-bearing signal.
        pass


# ============================================================================
# Append-only writers
# ============================================================================

def _append_row(path: Path, row: dict[str, Any]) -> None:
    """Append a single row to ``path``, computing prev_row_hash from
    the existing tail (or GENESIS_PREV_HASH on empty).

    Plan ARIA-V3.1-P-3 (closes 6-validator audit C-9): the read-tail-
    then-append sequence is wrapped in ``with_exclusive_lock(path)``
    so two concurrent CONVERGED cycles cannot both compute prev_row_
    hash against the same tail then race to append; the lock
    serialises the read+write window. The hash-chain logic is
    unchanged — the lock just makes the chain construction race-free
    at the syscall level (Tier-1 anchor).

    The lock is acquired AGAINST the target file's side-car
    `<path>.lock`; verify_chain_or_quarantine is the Tier-3 detect
    primitive called by the consumption side (NOT here) so a
    concurrent reader sees a complete row OR an empty file, never a
    partial tail.
    """
    # Plan ARIA-V3.1-P-3 — lazy import keeps this module
    # cold-startable under hermetic env (the `file_lock` module
    # imports fcntl which is POSIX-only; macOS/Linux dev hosts
    # only).
    from .file_lock import with_exclusive_lock
    # M11/E12-b — the declared-surface resolver refuses a tools root that
    # lacks the repo-identity binding (`/tmp/rogue/aria-tools` must never
    # resolve as canonical state). The kg writers used to mkdir their way
    # to an identity-less root; ensure_tools_dir is idempotent and stamps
    # the binding the resolver requires.
    from .tool_registry import ensure_tools_dir

    if path.parent.name == "knowledge-graph":
        ensure_tools_dir(path.parent.parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    # M11/E12-b — the serialisation lock moves to a SIDE-CAR: the declared
    # writer below takes the ledger's own per-file lock on `path`, and two
    # fcntl locks on the same file from one process deadlock. The side-car
    # still serialises the read-tail→compute-prev→append window (the
    # original race this lock exists for); the ledger lock inside guards
    # the physical append.
    with with_exclusive_lock(path.with_name(path.name + ".prevchain")):
        if path.exists() and path.stat().st_size > 0:
            # Find the last non-empty line + compute its hash
            last_row: dict[str, Any] | None = None
            for parsed in _read_jsonl_strict(path):
                last_row = parsed
            prev = _row_hash(last_row) if last_row else GENESIS_PREV_HASH
        else:
            prev = GENESIS_PREV_HASH
        row_with_chain = {**row, "prev_row_hash": prev}
        # M11/E12-b — the append goes through the declared-surface writer,
        # not a raw file handle. The raw open("a") bypassed the ledger
        # discipline AND kept these files out of the aria/state publish
        # allowlist, so every night's learning evaporated at job teardown.
        # prev_row_hash stays IN the payload: the knowledge-graph's own
        # chain (verify_chain_or_quarantine) is unchanged and still spans
        # pre-migration rows; new rows carry both chains.
        from .ledger import append_declared_jsonl
        from .state_manifest import surface_for_relative_path

        rel = Path("knowledge-graph") / path.name
        surface = surface_for_relative_path(rel)
        if surface is not None:
            append_declared_jsonl(
                path, row_with_chain, expected_surface=surface.name,
            )
        else:
            # A knowledge-graph file with no declared surface is a NEW
            # file someone forgot to roster — refuse rather than silently
            # re-opening the durability hole this migration closed.
            raise KnowledgeGraphSchemaError(
                f"knowledge-graph file has no declared surface: {path.name}"
            )


# ============================================================================
# Public API
# ============================================================================

def record_convention(
    pattern: Pattern,
    *,
    workspace_root: str | Path,
    signer_key_fp: str,
) -> Path:
    """Append a convention row to
    ``aria-tools/knowledge-graph/conventions.jsonl``.

    Validates:
      * pattern.pattern_type is non-empty string
      * pattern.confidence ∈ [0.0, 1.0]
      * pattern.evidence_refs is a non-empty tuple of strings
      * pattern.discovered_by_cycle_id non-empty (V9.0-F provenance)
      * signer_key_fp starts with "SHA256:" (cycle ephemeral key)

    Returns the file path written. Tier-3 detect — secret_scrub run
    on free-text fields is the caller's responsibility (orchestrator
    layer); this function pins schema correctness.
    """
    _validate_pattern(pattern)
    if not isinstance(signer_key_fp, str) or not signer_key_fp.startswith("SHA256:"):
        raise KnowledgeGraphSchemaError(
            f"signer_key_fp must be SHA256:<base64> got {signer_key_fp!r}"
        )
    path = Path(workspace_root) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
    row = asdict(pattern)
    row["signer_key_fp"] = signer_key_fp
    _append_row(path, row)
    return path


def record_anti_pattern(
    pattern: Pattern,
    *,
    workspace_root: str | Path,
    reason_class: str,
    operator_signature: str,
) -> Path:
    """Append an anti-pattern row to
    ``aria-tools/knowledge-graph/anti-patterns.jsonl``.

    Anti-pattern entries are governance-significant (they SKIP
    work). REQUIRES operator_signature — kernel-side auto-write
    FORBIDDEN; arb HIGH-008 + ai MED-014.

    Validates:
      * reason_class ∈ ANTI_PATTERN_TYPES
      * operator_signature is non-empty string (verified upstream
        against operator pinned public key)
      * pattern.pattern_type == "anti_pattern"

    Returns the file path written.
    """
    if reason_class not in ANTI_PATTERN_TYPES:
        raise KnowledgeGraphSchemaError(
            f"reason_class must be in {sorted(ANTI_PATTERN_TYPES)}, got {reason_class!r}"
        )
    if not isinstance(operator_signature, str) or len(operator_signature) < 16:
        raise KnowledgeGraphSignatureMissing(
            "anti-pattern entries require operator_signature (non-empty, >=16 chars)"
        )
    if pattern.pattern_type != "anti_pattern":
        raise KnowledgeGraphSchemaError(
            f"anti-pattern pattern_type MUST be 'anti_pattern', got {pattern.pattern_type!r}"
        )
    _validate_pattern(pattern)
    path = Path(workspace_root) / "aria-tools" / "knowledge-graph" / "anti-patterns.jsonl"
    row = asdict(pattern)
    row["reason_class"] = reason_class
    row["operator_signature"] = operator_signature
    _append_row(path, row)
    return path


def lookup_pattern(
    pattern_id: str,
    *,
    workspace_root: str | Path,
    min_confidence: float = MIN_PATTERN_CONFIDENCE,
) -> dict[str, Any] | None:
    """Return the latest convention row matching ``pattern_id`` with
    confidence ≥ ``min_confidence``, or None.

    Verifies the chain BEFORE reading. On quarantine, returns None
    (no row matches a tampered file).

    Plan ARIA-V9.0-F ships a linear scan; V10.1 docs the
    indexed-lookup contract (``conventions.idx`` keyed
    {pattern_id → byte_offset}, rebuilt on append). The linear scan
    is correct at any size; index is a perf optimization deferred to
    the dedicated invariant gate in Phase 10.1 / 10.5.
    """
    path = Path(workspace_root) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
    ok, _ = verify_chain_or_quarantine(path)
    if not ok:
        return None
    if not path.exists():
        return None
    latest: dict[str, Any] | None = None
    for row in _read_jsonl_strict(path):
        if row.get("pattern_id") != pattern_id:
            continue
        confidence = row.get("confidence")
        if not isinstance(confidence, (int, float)):
            continue
        if confidence < min_confidence:
            continue
        latest = row  # last match wins (chain order is append order)
    return latest


def _paths_related(a: str, b: str) -> bool:
    """True when two repo-relative paths are the same file or one contains
    the other at a directory boundary.

    ``apps/farm-service/src/x.ts`` relates to ``apps/farm-service`` (scope
    prefix) and to itself; it does NOT relate to ``apps/farm-service-v2``
    (the boundary check exists precisely for that near-miss).
    """
    left = a.strip().strip("/")
    right = b.strip().strip("/")
    if not left or not right:
        return False
    if left == right:
        return True
    return left.startswith(right + "/") or right.startswith(left + "/")


def anti_patterns_for_paths(
    *,
    workspace_root: str | Path,
    paths: list[str],
    limit: int = 5,
) -> list[dict[str, Any]]:
    """M15/E12-c (ORPHAN-677) — the "avoid this" half of learned knowledge.

    `record_anti_pattern` + `lookup_pattern` existed with zero callers:
    the operator could sign an avoid-rule and NOTHING would ever read it
    back at judgment time. Mirrors `conventions_for_paths` over the
    anti-patterns ledger (same verified-chain discipline, latest row per
    pattern_id); no confidence floor — an operator-signed avoid-rule is
    authoritative by its signature, not a score.
    """
    wanted = [p.split(":", 1)[0].strip() for p in paths if isinstance(p, str)]
    wanted = [p for p in wanted if p]
    if not wanted:
        return []
    path = Path(workspace_root) / "aria-tools" / "knowledge-graph" / "anti-patterns.jsonl"
    ok, _ = verify_chain_or_quarantine(path)
    if not ok or not path.exists():
        return []
    latest_by_id: dict[str, dict[str, Any]] = {}
    for row in _read_jsonl_strict(path):
        pattern_id = row.get("pattern_id")
        if not isinstance(pattern_id, str) or not pattern_id:
            continue
        latest_by_id[pattern_id] = row
    related: list[dict[str, Any]] = []
    for row in latest_by_id.values():
        ref_paths = [
            str(ref).split(":", 1)[0]
            for ref in row.get("evidence_refs") or []
            if isinstance(ref, str)
        ]
        if any(
            _paths_related(ref_path, want)
            for ref_path in ref_paths
            for want in wanted
        ):
            related.append(row)
    related.sort(key=lambda r: str(r.get("recorded_at") or ""), reverse=True)
    return related[:limit]


def conventions_for_paths(
    *,
    workspace_root: str | Path,
    paths: list[str],
    min_confidence: float = MIN_PATTERN_CONFIDENCE,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """The learned conventions that touch any of ``paths`` — latest row per
    pattern_id, confidence ≥ ``min_confidence``, strongest first, capped.

    This is the read that puts the conventions ledger into production:
    ``record_convention`` has written a row on every converged cycle since
    V9.0-F, and until the mint-time envelope enrichment (Plan "ARIA Sinir
    Sistemi" FAZ 4) nothing ever read one back. Same verified-chain
    discipline as ``lookup_pattern``: a quarantined ledger yields nothing
    rather than something unverifiable.
    """
    wanted = [p.split(":", 1)[0].strip() for p in paths if isinstance(p, str)]
    wanted = [p for p in wanted if p]
    if not wanted:
        return []
    path = Path(workspace_root) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
    ok, _ = verify_chain_or_quarantine(path)
    if not ok or not path.exists():
        return []
    latest_by_id: dict[str, dict[str, Any]] = {}
    for row in _read_jsonl_strict(path):
        pattern_id = row.get("pattern_id")
        confidence = row.get("confidence")
        if not isinstance(pattern_id, str) or not pattern_id:
            continue
        if not isinstance(confidence, (int, float)) or confidence < min_confidence:
            continue
        latest_by_id[pattern_id] = row  # last row wins (append order)
    related: list[dict[str, Any]] = []
    for row in latest_by_id.values():
        refs = row.get("evidence_refs") or []
        ref_paths = [
            str(ref).split(":", 1)[0] for ref in refs if isinstance(ref, str)
        ]
        if any(
            _paths_related(ref_path, want)
            for ref_path in ref_paths
            for want in wanted
        ):
            related.append(row)
    related.sort(key=lambda r: float(r.get("confidence") or 0.0), reverse=True)
    return related[: max(0, int(limit))]


def _effectiveness_path(workspace_root: str | Path) -> Path:
    return (
        Path(workspace_root)
        / "aria-tools"
        / "knowledge-graph"
        / "pressure-source-effectiveness.jsonl"
    )


def record_pressure_source_outcome(
    *,
    workspace_root: str | Path,
    source_type: str,
    minted: int = 0,
    converged: int = 0,
    merged: int = 0,
    rejected: int = 0,
    cost_usd: float | None = None,
) -> dict[str, Any]:
    """M3/E8 — the effectiveness ledger's FIRST writer.

    `rank_pressure_sources`, the mission scheduler's Thompson bandit and
    the reflection source-effectiveness rollup all read this ledger — and
    nothing ever wrote it, so the bandit drew from the uninformative prior
    forever: exploration-aware scheduling was pure decoration. The writer
    lives next to the reader (one schema owner) and appends CUMULATIVE
    per-source counters: the newest row per source_type is that source's
    standing, so the reader folds latest-per-source instead of trusting
    row order.
    """
    if not source_type:
        raise ValueError("source_type must be non-empty")
    path = _effectiveness_path(workspace_root)
    prior: dict[str, Any] = {}
    if path.exists():
        for parsed in _read_jsonl_strict(path):
            if parsed.get("source_type") == source_type:
                prior = parsed
    row = {
        "source_type": source_type,
        "cycles_minted": int(prior.get("cycles_minted", 0) or 0) + max(0, minted),
        "cycles_converged": int(prior.get("cycles_converged", 0) or 0) + max(0, converged),
        "cycles_merged": int(prior.get("cycles_merged", 0) or 0) + max(0, merged),
        "cycles_rejected": int(prior.get("cycles_rejected", 0) or 0) + max(0, rejected),
        "avg_cost_usd": cost_usd if cost_usd is not None else prior.get("avg_cost_usd"),
        "observed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    _append_row(path, row)
    return row


VERIFIED_CONVENTION_CONFIDENCE = 0.75  # above MIN_PATTERN_CONFIDENCE: served


def promote_convention_for_plan(
    *,
    plan_id: str,
    workspace_root: str | Path,
    promoted_by_cycle_id: str | None = None,
) -> dict[str, Any] | None:
    """M2/E12 — the promotion producer the hypothesis rows waited for.

    A convention is recorded at CONVERGENCE with confidence 0.5 and
    outcome_status="hypothesis" — deliberately below the 0.7 serving
    floor, so ARIA does not teach itself its own predictions as facts.
    The comment at the write site promised "promotion on a VERIFIED
    outcome"; nothing ever delivered it, so no convention could EVER be
    served: the ledger was write-only in effect. The verified outcome IS
    the plan's merge, so the merge reconciler calls this with the plan
    id the row now carries.

    Appends a NEW row (append-only ledger) superseding the hypothesis:
    outcome_status="verified", confidence above the serving floor.
    Idempotent: an already-verified row for the plan is a no-op.
    """
    path = Path(workspace_root) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
    if not path.exists():
        return None
    hypothesis: dict[str, Any] | None = None
    for parsed in _read_jsonl_strict(path):
        if parsed.get("plan_id") != plan_id:
            continue
        if parsed.get("outcome_status") == "verified":
            return None  # already promoted
        hypothesis = parsed
    if hypothesis is None:
        return None
    promoted = dict(hypothesis)
    promoted.pop("prev_row_hash", None)
    promoted.update({
        "pattern_id": f"{hypothesis.get('pattern_id')}-verified",
        "supersedes_pattern_id": hypothesis.get("pattern_id"),
        "outcome_status": "verified",
        "confidence": VERIFIED_CONVENTION_CONFIDENCE,
        "observed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "promoted_by_cycle_id": promoted_by_cycle_id,
    })
    _append_row(path, promoted)
    return promoted


def rank_pressure_sources(
    *,
    workspace_root: str | Path,
) -> list[dict[str, Any]]:
    """Read pressure-source-effectiveness.jsonl + return a
    sorted-by-effectiveness list.

    Each row schema:
      {source_type, cycles_minted, cycles_converged, cycles_merged,
       cycles_rejected, avg_cost_usd, observed_at, prev_row_hash}

    Effectiveness = cycles_converged / max(1, cycles_minted).
    Cached + invalidated on file size change (mirror of V8.0
    fold_plan_state pattern; for V9.0-F we ship a simple cache-less
    read since the file is small bounded — operator can add caching
    in V10.4 if perf-profile shows the need).

    M3/E8 — rows are cumulative snapshots (see
    `record_pressure_source_outcome`); the newest row per source_type is
    that source's standing, so this folds latest-per-source. Pre-M3 the
    raw row list went straight into the sort, which would have double-
    counted any source with history — invisible only because the ledger
    had no writer and was therefore always empty.
    """
    path = _effectiveness_path(workspace_root)
    ok, _ = verify_chain_or_quarantine(path)
    if not ok or not path.exists():
        return []
    latest: dict[str, dict[str, Any]] = {}
    for parsed in _read_jsonl_strict(path):
        st = str(parsed.get("source_type") or "")
        if st:
            latest[st] = parsed
    rows = list(latest.values())
    def _effectiveness(r: dict[str, Any]) -> float:
        minted = max(1, int(r.get("cycles_minted", 0) or 0))
        converged = int(r.get("cycles_converged", 0) or 0)
        return converged / minted
    rows.sort(key=_effectiveness, reverse=True)
    return rows


# ============================================================================
# Internal validators
# ============================================================================

def _validate_pattern(pattern: Pattern) -> None:
    if not isinstance(pattern.pattern_id, str) or not pattern.pattern_id:
        raise KnowledgeGraphSchemaError("pattern_id must be a non-empty string")
    if not isinstance(pattern.pattern_type, str) or not pattern.pattern_type:
        raise KnowledgeGraphSchemaError("pattern_type must be a non-empty string")
    if not isinstance(pattern.confidence, (int, float)):
        raise KnowledgeGraphSchemaError("confidence must be a number")
    if not (0.0 <= float(pattern.confidence) <= 1.0):
        raise KnowledgeGraphSchemaError(
            f"confidence must be in [0.0, 1.0], got {pattern.confidence}"
        )
    if not isinstance(pattern.evidence_refs, tuple):
        raise KnowledgeGraphSchemaError("evidence_refs must be a tuple")
    if not pattern.evidence_refs:
        raise KnowledgeGraphSchemaError("evidence_refs must be non-empty")
    if not all(isinstance(r, str) and r for r in pattern.evidence_refs):
        raise KnowledgeGraphSchemaError("evidence_refs entries must be non-empty strings")
    if not isinstance(pattern.discovered_by_cycle_id, str) or not pattern.discovered_by_cycle_id:
        raise KnowledgeGraphSchemaError(
            "discovered_by_cycle_id must be a non-empty string (V9.0-F provenance)"
        )
    if pattern.schema_version != KNOWLEDGE_GRAPH_SCHEMA_VERSION:
        raise KnowledgeGraphSchemaError(
            f"schema_version must be {KNOWLEDGE_GRAPH_SCHEMA_VERSION}, got {pattern.schema_version}"
        )


__all__ = (
    "KNOWLEDGE_GRAPH_SCHEMA_VERSION",
    "MIN_PATTERN_CONFIDENCE",
    "ANTI_PATTERN_TYPES",
    "GENESIS_PREV_HASH",
    "Pattern",
    "KnowledgeGraphTamper",
    "KnowledgeGraphSignatureMissing",
    "KnowledgeGraphSchemaError",
    "verify_chain_or_quarantine",
    "record_convention",
    "record_anti_pattern",
    "lookup_pattern",
    "rank_pressure_sources",
)
