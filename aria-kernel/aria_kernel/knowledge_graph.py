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
from dataclasses import MISSING, asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:
    from .ledger import StateTransaction


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


class KnowledgeGraphObservationConflict(KnowledgeGraphSchemaError):
    """An existing Pattern identity has different immutable content."""


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
    from .ledger import LedgerIntegrityError, read_jsonl

    try:
        yield from read_jsonl(path)
    except (LedgerIntegrityError, OSError, UnicodeError) as exc:
        raise KnowledgeGraphTamper(str(exc)) from exc


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
    try:
        rows = list(_read_jsonl_strict(p))
    except KnowledgeGraphTamper:
        _quarantine(p, reason="malformed_or_transport_invalid")
        return (False, 1)
    for lineno, row in enumerate(rows, start=1):
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

def _prepare_append(path: Path) -> str:
    """Bind the tools root and resolve the canonical append surface."""
    from .tool_registry import ensure_tools_dir
    from .state_manifest import surface_for_relative_path

    if path.parent.name == "knowledge-graph":
        ensure_tools_dir(path.parent.parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    surface = surface_for_relative_path(Path("knowledge-graph") / path.name)
    if surface is None:
        raise KnowledgeGraphSchemaError(
            f"knowledge-graph file has no declared surface: {path.name}"
        )
    return surface.name


def _append_row_locked(
    transaction: StateTransaction,
    path: Path,
    row: dict[str, Any],
    surface: str,
    previous: dict[str, Any] | None,
) -> None:
    """Continue the native chain through the declared writer under its lock."""
    transaction.append_declared_jsonl(
        path,
        {**row, "prev_row_hash": _row_hash(previous) if previous else GENESIS_PREV_HASH},
        expected_surface=surface,
    )


def _append_row(path: Path, row: dict[str, Any]) -> None:
    """Intentionally append, sharing replay/recovery's state-transaction lock."""
    from .ledger import state_transaction

    surface = _prepare_append(path)
    with state_transaction([path]) as transaction:
        previous = None
        for parsed in _read_jsonl_strict(path):
            previous = parsed
        _append_row_locked(transaction, path, row, surface, previous)


def _observation_rows(path: Path) -> list[dict[str, Any]]:
    """Verify both chains before an observation decision, including a no-op.

    read_jsonl verifies transport envelopes, but plain dual-chain rows need
    explicit outer verification. Native-only history remains valid; any outer
    links present must follow the stored predecessor, including replay wrappers.
    No quarantine/rewrite is performed by this writer.
    """
    from .ledger import LedgerIntegrityError, _read_jsonl_stored, _record_hash

    rows = list(_read_jsonl_strict(path))
    previous_native = GENESIS_PREV_HASH
    for row in rows:
        if not isinstance(row, dict) or row.get("prev_row_hash") != previous_native:
            raise KnowledgeGraphTamper("observation native chain mismatch")
        previous_native = _row_hash(row)
    try:
        previous_outer = None
        for row in _read_jsonl_stored(path):
            if "ledger_hash" in row or "previous_ledger_hash" in row:
                if (row.get("previous_ledger_hash") != previous_outer
                        or row.get("ledger_hash") != _record_hash(row, previous_outer)):
                    raise KnowledgeGraphTamper("observation outer chain mismatch")
            elif previous_outer is not None:
                raise KnowledgeGraphTamper("observation outer chain missing")
            previous_outer = row.get("ledger_hash")
    except (LedgerIntegrityError, OSError, UnicodeError) as exc:
        raise KnowledgeGraphTamper(str(exc)) from exc
    return rows


def _observation_content(row: dict[str, Any]) -> dict[str, Any]:
    """Project immutable Pattern fields using schema defaults, never wildcards."""
    content = {}
    for definition in fields(Pattern):
        if definition.name in {"observed_at", "signer_key_fp"}:
            continue
        value = row.get(definition.name, definition.default)
        if value is MISSING:
            raise KnowledgeGraphObservationConflict(
                f"observation conflict: missing {definition.name}"
            )
        if definition.name == "evidence_refs" and isinstance(value, (tuple, list)):
            value = list(value)
        content[definition.name] = value
    return content


# ============================================================================
# Public API
# ============================================================================

def _knowledge_tools_root(
    *, base_dir: str | Path | None, workspace_root: str | Path | None,
) -> Path:
    """Select storage through its owner, preserving workspace-only callers."""
    from .tool_registry import tools_dir

    if base_dir is not None:
        return tools_dir(base_dir)
    if workspace_root is not None:
        return tools_dir(Path(workspace_root) / "aria-tools")
    return tools_dir()


def record_convention(
    pattern: Pattern,
    *,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    signer_key_fp: str,
) -> Path:
    """Record a persisted Pattern observation, or return its path on exact retry.

    Identity is pattern_id; immutable Pattern content must match every existing
    row with that ID. Timestamp and signer metadata retain their first values.
    Signer validation checks the fingerprint format, not authentication.

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
    path = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root) / "knowledge-graph/conventions.jsonl"
    row = asdict(pattern)
    row["signer_key_fp"] = signer_key_fp
    from .ledger import state_transaction

    surface = _prepare_append(path)
    with state_transaction([path]) as transaction:
        rows = _observation_rows(path)
        content = _observation_content(row)
        found = False
        for existing in rows:
            if existing.get("pattern_id") != pattern.pattern_id:
                continue
            if _observation_content(existing) != content:
                raise KnowledgeGraphObservationConflict(
                    f"observation conflict: {pattern.pattern_id}"
                )
            found = True
        if not found:
            _append_row_locked(transaction, path, row, surface, rows[-1] if rows else None)
    return path


def _has_recorded_convention(
    pattern: Pattern, *, base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
) -> bool:
    """Verify an immutable original observation, regardless of serving status.

    This lookup cannot reserve an append; record_convention remains the
    serialized check-and-append owner if another callback wins the race.
    """
    _validate_pattern(pattern)
    path = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root) / "knowledge-graph/conventions.jsonl"
    try:
        path.stat()
    except FileNotFoundError:
        return False
    from .ledger import state_transaction

    with state_transaction([path]):
        rows = _observation_rows(path)
        content = _observation_content(asdict(pattern))
        found = False
        for row in rows:
            if row.get("pattern_id") != pattern.pattern_id:
                continue
            if _observation_content(row) != content:
                raise KnowledgeGraphObservationConflict(f"observation conflict: {pattern.pattern_id}")
            found = True
        return found


def record_anti_pattern(
    pattern: Pattern,
    *,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
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
    if not isinstance(operator_signature, str) or not operator_signature.strip():
        raise KnowledgeGraphSignatureMissing(
            "anti-pattern entries require operator_signature"
        )
    # ARIA-AUDIT-015: length was never authority. The signature must be a
    # resolvable operator reference (gov:<event>, review:<path>#<id>, or
    # ack-env:<VAR>); a plausible-looking bare string refuses.
    from .operator_approval import OperatorApprovalUnrecorded, verify_operator_approval_ref

    root = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root)
    try:
        verify_operator_approval_ref(
            operator_signature,
            base_dir=root,
            surface="knowledge_graph_anti_pattern",
        )
    except OperatorApprovalUnrecorded as exc:
        raise KnowledgeGraphSignatureMissing(str(exc)) from exc
    if pattern.pattern_type != "anti_pattern":
        raise KnowledgeGraphSchemaError(
            f"anti-pattern pattern_type MUST be 'anti_pattern', got {pattern.pattern_type!r}"
        )
    _validate_pattern(pattern)
    path = root / "knowledge-graph/anti-patterns.jsonl"
    row = asdict(pattern)
    row["reason_class"] = reason_class
    row["operator_signature"] = operator_signature
    _append_row(path, row)
    return path


def lookup_pattern(
    pattern_id: str,
    *,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
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
    path = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root) / "knowledge-graph/conventions.jsonl"
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
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
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
    path = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root) / "knowledge-graph/anti-patterns.jsonl"
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
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
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
    path = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root) / "knowledge-graph/conventions.jsonl"
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


def effectiveness_ledger_path(*, base_dir: str | Path) -> Path:
    """Where the effectiveness ledger lives: under the TOOLS root, named.

    ``state_manifest`` declares ``kg_pressure_source_effectiveness`` a
    tools-root surface, exactly like ``conventions.jsonl``. Until 2026-09-12
    this helper resolved ``<workspace_root>/aria-tools/...`` only, which is
    the tools root on a developer checkout and nowhere else: the live lane
    binds ``ARIA_TOOLS_DIR=<store>/tools`` and passes the checkout as
    workspace root, so a row written there would have landed in the
    checkout that dies with the runner. The readers split between two
    paths — ``<checkout>/aria-tools`` (doctor, cycle phase, MCP server,
    self-improvement) and ``<store>/aria-tools`` (pressure, mission
    scheduler, via ``root.parent``) — and neither was the store's
    ``<store>/tools``. No row was lost on the live lane: the orchestrator's
    writer sat on the converged path and no cycle had converged, so it had
    never fired — the layout was wrong before the first row existed, and
    origin/aria/state never carried the ledger for both reasons at once.

    ``base_dir`` is the tools root and is REQUIRED. Every production caller
    holds it (the orchestrator's ``root``, ``PhaseContext.base_dir``, the
    scheduler's and pressure's ``root``, the doctor's ``tools_dir``, the MCP
    server's ``self.root``); a workspace-derived fallback would only ever
    re-open the shadow path above, so the signature does not offer one.
    """
    from .tool_registry import tools_dir

    return (
        tools_dir(base_dir)
        / "knowledge-graph"
        / "pressure-source-effectiveness.jsonl"
    )


def effectiveness_reader_faults() -> tuple[type[BaseException], ...]:
    """The closed set a ``rank_pressure_sources`` caller may treat as a runtime fault.

    WHY (B1, 2026-09-12): the readers in ``pressure.run_pressure`` and
    ``cycle._phase_calibration_recommendation`` wrapped this read in
    ``except Exception`` / ``except (OSError, ValueError, KeyError,
    TypeError)`` and substituted ``[]`` — the same laundering the
    orchestrator's memory-hook guard did, where a caller/callee signature
    drift (TypeError) read as an unreadable ledger for weeks. A programming
    error must raise; only a fault outside the code is a fault to absorb.

    WHAT: ``KnowledgeGraphTamper`` — the strict row reader, and a chain break
    the quarantine could not rename away; ``OSError`` — the file system and
    the lock; ``LedgerIntegrityError`` and ``KnowledgeGraphSchemaError`` —
    the ledger primitives underneath (``_read_jsonl_strict`` folds the first
    into a Tamper today; the append side raises the second for an undeclared
    surface). ``TypeError``, ``KeyError``, ``ValueError``, ``AttributeError``
    are defects in the kernel and are deliberately absent. Resolved lazily:
    ``ledger`` imports are late everywhere in this module.
    """
    from .ledger import LedgerIntegrityError

    return (
        KnowledgeGraphTamper,
        KnowledgeGraphSchemaError,
        LedgerIntegrityError,
        OSError,
    )


def effectiveness_writer_faults() -> tuple[type[BaseException], ...]:
    """The reader's set plus what binding the tools root for an append can raise.

    ``record_pressure_source_outcome`` goes through ``ensure_tools_dir`` and
    the state transaction, which refuse an ambiguous or locked tools root
    with ``GovernanceError``. That is a fault of the store, not of the code,
    so a writer's guard absorbs it the way it absorbs a corrupt ledger.
    """
    from .tool_registry import GovernanceError

    return (GovernanceError, *effectiveness_reader_faults())


def record_pressure_source_outcome(
    *,
    base_dir: str | Path,
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
    row order. One call records one funnel fact (a mint, a rejection, a
    convergence, a merge) as it becomes true; the orchestrator therefore
    appends more than one row per cycle, and the fold makes that free.

    ``base_dir`` is the tools root (see ``effectiveness_ledger_path``).
    """
    if not source_type:
        raise ValueError("source_type must be non-empty")
    path = effectiveness_ledger_path(base_dir=base_dir)
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


def reconcile_convention_promotion(
    *,
    plan_id: str,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    promoted_by_cycle_id: str | None = None,
) -> dict[str, Any]:
    """Reconcile a convention after the caller verifies the plan's merge.

    Promotion records merge-backed evidence, not measured improvement.
    It appends a superseding row with outcome_status="verified" and
    confidence 0.75. History validation, the existing-success check and
    append share one transaction so concurrent retries cannot duplicate
    promotion. Missing hypotheses remain retryable on a later cycle.

    Returns status "promoted", "already_verified" or "no_hypothesis".
    Only "promoted" includes the appended convention row.
    """
    from .ledger import state_transaction

    path = _knowledge_tools_root(base_dir=base_dir, workspace_root=workspace_root) / "knowledge-graph/conventions.jsonl"
    if not path.exists():
        return {"status": "no_hypothesis"}
    surface = _prepare_append(path)
    with state_transaction([path]) as transaction:
        rows = _observation_rows(path)
        hypothesis: dict[str, Any] | None = None
        verified: dict[str, Any] | None = None
        pattern_fields = {item.name for item in fields(Pattern)}
        for parsed in rows:
            if parsed.get("plan_id") != plan_id:
                continue
            values = {key: value for key, value in parsed.items() if key in pattern_fields}
            if isinstance(values.get("evidence_refs"), list):
                values["evidence_refs"] = tuple(values["evidence_refs"])
            try:
                pattern = Pattern(**values)
            except TypeError as exc:
                raise KnowledgeGraphSchemaError(f"invalid convention Pattern: {exc}") from exc
            _validate_pattern(pattern)
            if parsed.get("outcome_status") == "verified" and verified is None:
                verified = parsed
            hypothesis = parsed
        # Validate every matching row before acknowledging an earlier success.
        if verified is not None:
            return {"status": "already_verified", "pattern_id": verified["pattern_id"]}
        if hypothesis is None:
            return {"status": "no_hypothesis"}
        promoted = dict(hypothesis)
        promoted.pop("prev_row_hash", None)
        promoted.update({
            "pattern_id": f"{hypothesis['pattern_id']}-verified",
            "supersedes_pattern_id": hypothesis["pattern_id"],
            "outcome_status": "verified",
            "confidence": VERIFIED_CONVENTION_CONFIDENCE,
            "observed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "promoted_by_cycle_id": promoted_by_cycle_id,
        })
        _append_row_locked(transaction, path, promoted, surface, rows[-1] if rows else None)
        return {"status": "promoted", "pattern_id": promoted["pattern_id"], "convention": promoted}


def promote_convention_for_plan(
    *,
    plan_id: str,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    promoted_by_cycle_id: str | None = None,
) -> dict[str, Any] | None:
    """Return the newly appended convention, or None when no append was needed."""
    result = reconcile_convention_promotion(
        plan_id=plan_id,
        workspace_root=workspace_root,
        base_dir=base_dir,
        promoted_by_cycle_id=promoted_by_cycle_id,
    )
    return result.get("convention")


def rank_pressure_sources(*, base_dir: str | Path) -> list[dict[str, Any]]:
    """Read pressure-source-effectiveness.jsonl + return a
    sorted-by-effectiveness list.

    ``base_dir`` is the tools root (see ``effectiveness_ledger_path``).

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
    path = effectiveness_ledger_path(base_dir=base_dir)
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
    "KnowledgeGraphObservationConflict",
    "verify_chain_or_quarantine",
    "record_convention",
    "record_anti_pattern",
    "lookup_pattern",
    "rank_pressure_sources",
)
