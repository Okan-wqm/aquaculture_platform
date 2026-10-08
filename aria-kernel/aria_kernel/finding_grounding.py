"""ADR-0018 D5 — the one admission rule for a plan candidate that names an F finding.

WHY. Two candidate sources name one of ARIA's own F findings: the aging
F_FINDING scan, and an operator request that names a finding id (ADR-0018).
Before this module each judged "is this finding a plan ground" its own way,
and the operator path did not judge at all: its plan cited only
``aria-tools/operator-feedback.jsonl`` (ARIA's own output), so the planner
mint refused it. Review round 2 (ai-safety AISAFETY-HIGH-002, security
GSEC-MEDIUM-002/LOW-007/LOW-008) found the first version still read the
finding's refs from the plain ``F-*.json`` while the event fold is the
authority, filtered only one of the two ref shapes, trusted the index for
"tracked", let a malformed ref fail the whole admission, and bound nothing
of the grounding into the operator's signature.

WHAT. :func:`load_grounding_context` resolves the trusted anchor commit
(:mod:`main_anchor`) and folds the finding ledger ONCE per synthesis;
:func:`admit_finding` judges one finding against it, with no source-specific
fork:

* status AND evidence come from the fold record (``finding.fold_findings``);
* both ref shapes (``evidences[].evidence_envelope`` and
  ``evidence_chain[].reference``) pass the same trust and self-output filter;
* every ref must match a closed safe path charset — a bad ref is a per-ref
  refusal named in the verdict (by hash, never echoed), not a crash;
* a ref must name a file in the anchor commit's TREE (``git ls-tree``);
* the grounded surfaces split into the WRITE set and the EVIDENCE set
  (:func:`plan_write_scope.split_surfaces`, ARIA-HIGH-381): the operator's
  signed ``write_roots`` when the request carries them, else the finding's
  own fix target (a drift's copy side and its module); a cited surface
  outside the write set is evidence the plan reads and never writes;
* at least one WRITE surface must be writable
  (``implementation_safety.classify_declared_surface`` is None);
* :func:`grounding_digest` hashes the admitted ref list; an operator request
  signs it at record time and admission refuses a mismatch, so refs that
  changed after signing never ground the request.

Refusals split in two (ADR-0018, arbiter ruling iii): request-intrinsic
reasons spend an operator request; :data:`RUNNER_FAULT_REASONS` (no anchor,
no finding store) never do. No field of the finding body (title, claim
summary, scope, risks, recommendation, facts) leaves this module: only ids,
refs and paths do (ADR-0018 D6).

ARIA-HIGH-260 — grounding alone let the aging F_FINDING source turn one of
ARIA's own findings into a plan unattended, with none of the loop guards
ADR-0003 (prerequisites 3-5) requires of a source that plans ARIA's own
findings. :func:`admit_candidate` now runs :func:`judge_loop_guards` on every
admitted F_FINDING candidate, and on nothing else: an operator request is
the operator's act and outranks every automated brake. The guards judge a
:class:`LoopHistory` folded once per synthesis from the existing ledgers
(plan events, ``synthesis_bound`` rows, self-reverts, finding events) and the
``f_finding_loop_guards`` policy block; a context without that history
refuses the candidate (:data:`LOOP_HISTORY_UNAVAILABLE`), so no caller can
convert an aging F finding past the guards by omitting them.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from .finding import EXTERNAL_ORIGINATING_SKILLS, FINDING_ID_RE
from .main_anchor import MainAnchor

FINDING_ID_MISSING = "finding_id_missing"
FINDING_ID_INVALID = "finding_id_invalid"
FINDING_STORE_UNAVAILABLE = "finding_store_unavailable"
FINDING_STORE_UNREADABLE = "finding_store_unreadable"
FINDING_UNKNOWN = "finding_unknown"
FINDING_NOT_OPEN = "finding_not_open"
FINDING_EVIDENCE_UNAVAILABLE = "finding_evidence_unavailable"
FINDING_EVIDENCE_UNSAFE = "finding_evidence_unsafe"
FINDING_EVIDENCE_SELF_OUTPUT_ONLY = "finding_evidence_self_output_only"
CHECKOUT_UNAVAILABLE = "checkout_unavailable"
FINDING_EVIDENCE_UNTRACKED = "finding_evidence_untracked"
FINDING_SURFACES_READONLY = "finding_surfaces_readonly"
# ARIA-HIGH-381 — no grounded surface lies in the write set (the declared
# roots, or the fix target's module): the request names nothing to change.
FINDING_WRITE_SCOPE_EMPTY = "finding_write_scope_empty"
GROUNDING_DIGEST_MISMATCH = "grounding_digest_mismatch"
ADMISSION_REASONS: tuple[str, ...] = (
    FINDING_ID_MISSING, FINDING_ID_INVALID, FINDING_STORE_UNAVAILABLE, FINDING_STORE_UNREADABLE,
    FINDING_UNKNOWN, FINDING_NOT_OPEN, FINDING_EVIDENCE_UNAVAILABLE, FINDING_EVIDENCE_UNSAFE,
    FINDING_EVIDENCE_SELF_OUTPUT_ONLY, CHECKOUT_UNAVAILABLE, FINDING_EVIDENCE_UNTRACKED,
    FINDING_SURFACES_READONLY, FINDING_WRITE_SCOPE_EMPTY, GROUNDING_DIGEST_MISMATCH,
)
# The runner, not the request, failed: never spends an operator request.
RUNNER_FAULT_REASONS: frozenset[str] = frozenset({
    FINDING_STORE_UNAVAILABLE, FINDING_STORE_UNREADABLE, CHECKOUT_UNAVAILABLE,
})
INTRINSIC_ADMISSION_REASONS: tuple[str, ...] = tuple(
    reason for reason in ADMISSION_REASONS if reason not in RUNNER_FAULT_REASONS
)

REF_UNSAFE = "ref_unsafe"
REF_SELF_OUTPUT = "ref_self_output"
REF_UNTRACKED = "ref_untracked"
_MAX_REF_CHARS = 512
_FINDING_REF_CAP = 50
# A closed path charset: no NUL, no whitespace, no control or bidi code
# points, no glob or shell metacharacters, no absolute path, optional
# ``:<line>``. ``.``/``..`` segments are refused separately.
_SAFE_REF_RE = re.compile(r"^(?P<path>[A-Za-z0-9._@+\-]+(?:/[A-Za-z0-9._@+\-]+)*)(?::[0-9]{1,7})?$")

# ARIA-HIGH-260 — the loop-guard refusals of an aging F finding. They are not
# ADMISSION_REASONS: an operator request never carries one, so none of them
# can spend a request.
LOOP_HISTORY_UNAVAILABLE = "f_finding_loop_history_unavailable"
SELF_LOOP_ORIGIN_SURFACE = "f_finding_self_loop_origin_surface"
SELF_LOOP_OWN_CHANGE = "f_finding_self_loop_own_change"
SELF_LOOP_WATCHDOG_RECENT = "f_finding_self_loop_watchdog_recent"
GLOBAL_CAP_EXCEEDED = "f_finding_global_cap_exceeded"
SUBJECT_QUARANTINED = "f_finding_subject_quarantined"
SUBJECT_COOL_OFF = "f_finding_subject_cool_off"
WATCHDOG_RESOLUTION_STREAK = "f_finding_watchdog_resolution_streak"
LOOP_GUARD_REASONS: tuple[str, ...] = (
    LOOP_HISTORY_UNAVAILABLE, SELF_LOOP_ORIGIN_SURFACE, SELF_LOOP_OWN_CHANGE, SELF_LOOP_WATCHDOG_RECENT,
    GLOBAL_CAP_EXCEEDED, SUBJECT_QUARANTINED, SUBJECT_COOL_OFF, WATCHDOG_RESOLUTION_STREAK,
)
# ADR-0003 prerequisites 3 and 5 name the watchdog's origin family and "the
# last 3" closed / RESOLVED findings; both are the ADR's own terms.
WATCHDOG_ORIGIN_PREFIX = "aria-watchdog:"
ADR_0003_RECENT_CLOSURES = 3
# The cap's unit (prerequisite 4: "per-24h"); its size is policy.
_CAP_WINDOW = timedelta(hours=24)
LOOP_POLICY_BLOCK = "f_finding_loop_guards"
# Inclusive bounds: a cap of 0 switches the source off; above one plan an hour is no cap.
_LOOP_POLICY_BOUNDS: dict[str, tuple[int, int]] = {"max_plans_per_24h": (0, 24), "cool_off_days": (1, 365)}
_FAILED_PLAN_EVENTS = frozenset({"implementation_rejected", "plan_abandoned"})
# ARIA-HIGH-388 (re-review N3) — an implementation that ended with a fault the
# kernel cannot attribute (`implementation_rejections`: `harness`,
# `unclassified`) cools nothing off on its own: one such ending can be the
# host's (on 2026-10-08 a missing git identity). But nothing else bounded the
# re-plans, so a finding whose implementation always ends that way took the
# daily F-finding slot (`max_plans_per_24h`) forever, a full P+C+CR debate
# each time. The SECOND consecutive such ending of one subject is evidence
# about the subject: it cools off like a failure (`SUBJECT_COOL_OFF`, cause
# `repeated_unverified_failure`), disclosed by the guard's own refusal row.
UNVERIFIED_FAULT_DOMAINS = frozenset({"harness", "unclassified"})
UNVERIFIED_FAILURE_STREAK = 2


@dataclass(frozen=True)
class PlanRecord:
    """A started plan folded from the plan ledger; every time is a ledger stamp."""

    plan_id: str
    finding_id: str | None
    operator_sourced: bool
    started_at: datetime
    surfaces: frozenset[str]
    merged_at: datetime | None = None
    merge_sha: str | None = None
    failed_at: datetime | None = None
    # ARIA-HIGH-388 — the plan's implementation ended with a SETTLED fault the
    # kernel could not attribute to the work (`harness`, `unclassified`): not a
    # failure of the finding, but counted (`UNVERIFIED_FAILURE_STREAK`).
    unverified_failed_at: datetime | None = None

    @property
    def f_sourced(self) -> bool:
        """An F-origin plan no operator request bound: the unattended source's (fail-closed)."""
        return (not self.operator_sourced and isinstance(self.finding_id, str)
                and FINDING_ID_RE.fullmatch(self.finding_id) is not None)


@dataclass(frozen=True)
class LoopHistory:
    """What the loop guards judge, folded once per synthesis from the existing ledgers."""

    now: datetime
    plans: tuple[PlanRecord, ...]
    reverted_at: Mapping[str, datetime]
    closures: tuple[tuple[str, str], ...]
    max_plans_per_24h: int
    cool_off: timedelta


@dataclass(frozen=True)
class GroundingContext:
    """One synthesis' view: the trusted commit and the finding fold, each read once."""

    repo_root: Path
    anchor: MainAnchor
    findings: Mapping[str, dict[str, Any]] | None
    fold_fault: str | None
    loop_history: LoopHistory | None = None
    loop_fault: str | None = None


@dataclass(frozen=True)
class FindingAdmission:
    """What :func:`admit_finding` decided. ``reason`` is None exactly when admitted."""

    finding_id: str | None
    reason: str | None
    evidence_refs: tuple[str, ...] = ()
    affected_surfaces: tuple[str, ...] = ()
    # ARIA-HIGH-381 — cited, read-only: the grounded surfaces outside the
    # write set, and the basis the split was made on (plan_write_scope).
    evidence_surfaces: tuple[str, ...] = ()
    write_basis: str | None = None
    refused_surfaces: tuple[tuple[str, str], ...] = ()
    refused_refs: tuple[tuple[str, str], ...] = ()
    grounding_digest: str | None = None
    anchor_commit: str | None = None
    # ARIA-HIGH-260 — what a loop guard refused on, named in the skip event.
    loop_guard: Mapping[str, Any] | None = None

    @property
    def admitted(self) -> bool:
        return self.reason is None

    @property
    def runner_fault(self) -> bool:
        return self.reason in RUNNER_FAULT_REASONS

    def refused_surface_records(self) -> list[dict[str, str]]:
        return [{"surface": surface, "reason": reason} for surface, reason in self.refused_surfaces]

    def refused_ref_records(self) -> list[dict[str, str]]:
        return [{"ref": ref, "reason": reason} for ref, reason in self.refused_refs]


def safe_repo_ref(ref: Any) -> bool:
    """True when ``ref`` is a repository path (optionally ``:line``) in the closed charset."""
    if not isinstance(ref, str) or not ref or len(ref) > _MAX_REF_CHARS:
        return False
    match = _SAFE_REF_RE.fullmatch(ref)
    if match is None:
        return False
    return all(segment not in {".", ".."} for segment in match.group("path").split("/"))


def _ref_path(ref: str) -> str:
    return ref.rsplit(":", 1)[0] if re.search(r":[0-9]+$", ref) else ref


def _ref_label(ref: str) -> str:
    """How a refused ref is named in governance: itself when safe, else its hash.

    A ref that fails the charset may carry delimiter, bidi or control
    payloads; it is never echoed into a ledger a prompt may later read.
    """
    if safe_repo_ref(ref):
        return ref
    return "sha256:" + hashlib.sha256(ref.encode("utf-8", errors="replace")).hexdigest()


def _trusted_entry(entry: Mapping[str, Any]) -> bool:
    envelope = entry.get("evidence_envelope") if isinstance(entry.get("evidence_envelope"), dict) else entry
    return envelope.get("trust_grade") in (None, "repo_verified") and not envelope.get("self_output_class")


def refs_from_finding_record(record: Mapping[str, Any]) -> list[str]:
    """The code references a finding record cites, both shapes through one trust filter.

    ``evidence_chain[].reference`` (the adapter-era shape) and
    ``evidences[].evidence_envelope`` (``aria/finding/v1``, ARIA-HIGH-183)
    both carry ``path[:line]`` refs; an entry graded other than
    ``repo_verified`` or classed as self-output is skipped in either shape.
    """
    refs: list[str] = []
    chain = record.get("evidence_chain")
    for entry in chain if isinstance(chain, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get("reference"), str) and _trusted_entry(entry):
            refs.append(entry["reference"].strip())
    evidences = record.get("evidences")
    for entry in evidences if isinstance(evidences, list) else []:
        if not isinstance(entry, dict) or not _trusted_entry(entry):
            continue
        envelope = entry.get("evidence_envelope") if isinstance(entry.get("evidence_envelope"), dict) else {}
        canonical = envelope.get("canonical_ref") or entry.get("ref")
        if not isinstance(canonical, str) or not canonical.strip():
            continue
        canonical = canonical.strip()
        line = envelope.get("line")
        if isinstance(line, int) and not isinstance(line, bool) and line > 0 and not re.search(r":[0-9]+$", canonical):
            canonical = f"{canonical}:{line}"
        refs.append(canonical)
    return list(dict.fromkeys(ref for ref in refs if ref))[:_FINDING_REF_CAP]


def grounding_digest(evidence_refs: tuple[str, ...] | list[str]) -> str:
    """``sha256:`` of the admitted ref list as canonical JSON — what an operator signs."""
    encoded = json.dumps(list(evidence_refs), separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(encoded.encode("ascii")).hexdigest()


def load_grounding_context(
    repo_root: str | Path, *, tools_root: str | Path | None = None, now: datetime | None = None,
) -> GroundingContext:
    """Resolve the anchor and fold the finding ledger once for a whole synthesis.

    ``tools_root`` names the store whose ledgers the F_FINDING loop guards
    read (ARIA-HIGH-260); without it the context carries no loop history and
    every aging F finding is refused, never admitted unguarded.
    """
    from .finding import fold_findings
    from .main_anchor import resolve_main_anchor
    from .tool_registry import GovernanceError

    root = Path(repo_root).resolve()
    try:
        findings = fold_findings(root)
    except (GovernanceError, OSError, ValueError):
        return GroundingContext(root, resolve_main_anchor(root), None, FINDING_STORE_UNREADABLE)
    fault = FINDING_STORE_UNAVAILABLE if findings is None else None
    history, loop_fault = (None, "tools_root_not_given") if tools_root is None else _load_loop_history(
        root, Path(tools_root), now or datetime.now(timezone.utc))
    return GroundingContext(root, resolve_main_anchor(root), findings, fault, history, loop_fault)


def f_finding_loop_policy(repo_root: str | Path) -> dict[str, int]:
    """The ``f_finding_loop_guards`` block: shipped defaults, then the operator's override, by key.

    The values live only in the policy files (``genesis_policy_default.json``
    and ``aria-config/genesis_policy.json``, which the implementer cannot
    write). A block that is not an object, an unknown key, or a value outside
    its bounds is refused by name, never corrected.
    """
    from .genesis_policy import default_policy, load_policy
    from .tool_registry import GovernanceError

    shipped, override = default_policy().get(LOOP_POLICY_BLOCK), load_policy(repo_root).get(LOOP_POLICY_BLOCK)
    if not isinstance(shipped, dict) or not isinstance(override, dict):
        raise GovernanceError(f"{LOOP_POLICY_BLOCK} must be an object in the genesis policy")
    block = {**shipped, **override}
    unknown = sorted(key for key in block if not key.startswith("_") and key not in _LOOP_POLICY_BOUNDS)
    if unknown:
        raise GovernanceError(f"{LOOP_POLICY_BLOCK} has unknown keys {unknown}")
    values: dict[str, int] = {}
    for key, (low, high) in _LOOP_POLICY_BOUNDS.items():
        value = block.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise GovernanceError(f"{LOOP_POLICY_BLOCK}.{key}={value!r} must be an integer in [{low}, {high}]")
        values[key] = value
    return values


def _stamp(raw: Any, now: datetime) -> datetime:
    """A ledger stamp; an undateable row is as recent as ``now``, so it can only refuse."""
    from .tool_registry import parse_utc_stamp

    parsed = parse_utc_stamp(raw) if isinstance(raw, str) else None
    return parsed if parsed is not None else now


def _declared_rows(path: Path, surface: str) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl

    return load_declared_jsonl(path, expected_surface=surface) if path.exists() else []


def _fold_plans(tools_root: Path, now: datetime) -> tuple[PlanRecord, ...]:
    """Every started plan, its source and its outcome, from the plan ledger and the bindings.

    A plan is operator-sourced when an operator ``synthesis_bound`` row names
    its ``plan_started`` content hash (the join ``operator_request_spend``
    uses); read the way ``request_history_for`` reads it, never mutating.
    """
    from .operator_feedback_ingestion import INGESTION_SURFACE, ingestion_ledger_path
    from .operator_request_spend import SYNTHESIS_BOUND_ROW_TYPE
    from .plan_candidate_source import PlanCandidateSource

    operator_hashes = {
        row.get("plan_content_hash")
        for row in _declared_rows(ingestion_ledger_path(tools_root), INGESTION_SURFACE)
        if row.get("row_type") == SYNTHESIS_BOUND_ROW_TYPE
        and row.get("source_type") == PlanCandidateSource.OPERATOR_FEEDBACK.value
    }
    from .outage_attribution import failure_is_lane_fault
    from .provider_clock import provider_clock

    clock = provider_clock(tools_root)
    plans: dict[str, dict[str, Any]] = {}
    previous_at: dict[str, datetime] = {}
    for event in _declared_rows(tools_root / "plans" / "events.jsonl", "plan_convergence_events"):
        plan_id, kind = event.get("plan_id"), event.get("event_type")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if not isinstance(plan_id, str):
            continue
        at = _stamp(event.get("recorded_at"), now)
        waited_since = previous_at.get(plan_id)
        previous_at[plan_id] = at
        if kind == "plan_started":
            content = payload.get("plan_content") if isinstance(payload.get("plan_content"), dict) else {}
            surfaces = content.get("affected_surfaces") if isinstance(content.get("affected_surfaces"), list) else []
            finding_id = content.get("finding_id")
            plans[plan_id] = {
                "plan_id": plan_id, "finding_id": finding_id if isinstance(finding_id, str) else None,
                "operator_sourced": payload.get("content_hash") in operator_hashes, "started_at": at,
                "surfaces": frozenset(s for s in surfaces if isinstance(s, str) and s),
            }
        elif plan_id not in plans:
            continue
        elif kind == "implementation_merged":
            sha = payload.get("merge_sha")
            plans[plan_id].update(merged_at=at, merge_sha=sha if isinstance(sha, str) and sha else None)
        elif kind in _FAILED_PLAN_EVENTS or (
                kind == "plan_evaluated" and payload.get("terminal_state") == "HUMAN_REQUIRED"):
            # ARIA-HIGH-367 — a plan the LANE killed (a provider outage, a
            # harness-class stall) says nothing about its finding: the finding
            # is re-planned once the provider is back, not after a 7-day cool-off.
            if not failure_is_lane_fault(event, waited_since=waited_since, at=at, clock=clock):
                plans[plan_id]["failed_at"] = at
            elif kind == "implementation_rejected" and payload.get("fault_domain") in UNVERIFIED_FAULT_DOMAINS:
                plans[plan_id]["unverified_failed_at"] = at
    return tuple(PlanRecord(**fields) for fields in plans.values())


def _load_loop_history(repo_root: Path, tools_root: Path, now: datetime) -> tuple[LoopHistory | None, str | None]:
    """(history, None), or (None, fault) when the policy or a ledger cannot be read."""
    from .finding import _events_path
    from .self_revert import DECISION_NOT_ATTRIBUTABLE, SELF_REVERTS_RELPATH, SELF_REVERTS_SURFACE
    from .tool_registry import GovernanceError

    try:
        policy = f_finding_loop_policy(repo_root)
    except GovernanceError:
        return None, "loop_policy_invalid"
    try:
        plans = _fold_plans(tools_root, now)
        # A merge the self-revert producer attributed a bad outcome to (any
        # decision but "not attributable"): the merge went bad, reverted or not.
        reverted: dict[str, datetime] = {}
        for row in _declared_rows(tools_root.joinpath(*SELF_REVERTS_RELPATH), SELF_REVERTS_SURFACE):
            sha = row.get("merge_sha")
            if isinstance(sha, str) and sha and row.get("decision") != DECISION_NOT_ATTRIBUTABLE:
                reverted.setdefault(sha, _stamp(row.get("recorded_at"), now))
        closures = tuple(
            (str(event.get("finding_id")), "RESOLVED" if event.get("event") == "finding_fix_verified"
             else str(event.get("to_status")))
            for event in _declared_rows(_events_path(repo_root), "repo_finding_events")
            if event.get("event") == "finding_fix_verified"
            or (event.get("event") == "finding_status_changed" and event.get("to_status") in ("RESOLVED", "WITHDRAWN"))
        )
    except (GovernanceError, OSError, ValueError):
        return None, "loop_ledger_unreadable"
    return LoopHistory(now, plans, reverted, closures, policy["max_plans_per_24h"],
                       timedelta(days=policy["cool_off_days"])), None


def admit_finding(
    context: GroundingContext, finding_id: Any, *, expected_digest: str | None = None,
    write_roots: list[str] | None = None,
) -> FindingAdmission:
    """Judge one F finding as a plan ground at the context's anchor commit.

    ``write_roots`` is the operator's signed boundary (ARIA-HIGH-381); None
    derives the write set from the finding's own fix target.
    """
    return _judge_finding(context, finding_id, frozenset({"OPEN"}), expected_digest, write_roots, False)


def admit_unattended_finding(context: GroundingContext, finding_id: Any) -> FindingAdmission:
    """:func:`admit_finding` for ARIA's own lane, which may defer a moved copy side to the seed.

    ARIA-HIGH-381 review MEDIUM-3 — a drift whose copy file was renamed
    grounds only its contract here, and the contract is never the write set.
    The unattended F source re-grounds the copy through the finding's
    detector (``finding_seed``), so the admission is not the place to refuse
    it: it admits with an empty write set and ``WRITE_BASIS_DEFERRED``, and the
    seed splits (or says the subject is unverifiable). An operator request
    cannot follow a moved file (its signed refs bound the plan), so it never
    takes this path.
    """
    return _judge_finding(context, finding_id, frozenset({"OPEN"}), None, None, True)


def closure_blocker(context: GroundingContext, finding_id: str) -> str | None:
    """Wall #7 — why ARIA's own plan lane could not close this backlog finding; None when it could.

    The ONE closability rule, and it is this module's admission: the same
    refs, trust filter, anchor tree and writable-surface test
    (``implementation_safety.classify_declared_surface``) a plan candidate
    must pass, with the status gate widened from OPEN to the whole backlog
    (``finding.BACKLOG_STATUSES``) — an IN_PROGRESS finding is unfinished
    work too, and whether ARIA can finish it is a property of its evidence
    and surfaces, not of who started it. A reason in RUNNER_FAULT_REASONS
    means the runner could not judge: undecided, never operator-only.
    """
    from .finding import BACKLOG_STATUSES

    # Closability is ARIA's own lane's question, so a moved copy side defers to the seed.
    return _judge_finding(context, finding_id, BACKLOG_STATUSES, None, None, True).reason


def _judge_finding(
    context: GroundingContext, finding_id: Any, statuses: frozenset[str], expected_digest: str | None,
    write_roots: list[str] | None, defer_moved_fix_target: bool,
) -> FindingAdmission:
    from .evidence_trust import is_self_output_ref
    from .implementation_safety import classify_declared_surface
    from .main_anchor import tracked_files_at
    from .plan_write_scope import WRITE_BASIS_DEFERRED, split_surfaces

    if not isinstance(finding_id, str) or not finding_id.strip():
        return FindingAdmission(None, FINDING_ID_MISSING)
    if FINDING_ID_RE.fullmatch(finding_id) is None:
        return FindingAdmission(None, FINDING_ID_INVALID)
    if context.fold_fault is not None or context.findings is None:
        return FindingAdmission(finding_id, context.fold_fault or FINDING_STORE_UNAVAILABLE)
    record = context.findings.get(finding_id)
    if record is None:
        return FindingAdmission(finding_id, FINDING_UNKNOWN)
    if record.get("status") not in statuses:
        return FindingAdmission(finding_id, FINDING_NOT_OPEN)
    refs = refs_from_finding_record(record)
    if not refs:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_UNAVAILABLE)
    refused_refs: list[tuple[str, str]] = []
    candidates: list[str] = []
    for ref in refs:
        if not safe_repo_ref(ref):
            refused_refs.append((_ref_label(ref), REF_UNSAFE))
        elif is_self_output_ref(ref):
            refused_refs.append((ref, REF_SELF_OUTPUT))
        else:
            candidates.append(ref)
    if not candidates:
        reason = (FINDING_EVIDENCE_SELF_OUTPUT_ONLY
                  if any(why == REF_SELF_OUTPUT for _ref, why in refused_refs) else FINDING_EVIDENCE_UNSAFE)
        return FindingAdmission(finding_id, reason, refused_refs=tuple(refused_refs))
    commit = context.anchor.commit
    tracked = (tracked_files_at(context.repo_root, commit=commit, paths=sorted({_ref_path(r) for r in candidates}))
               if commit is not None else None)
    if tracked is None:
        return FindingAdmission(finding_id, CHECKOUT_UNAVAILABLE, refused_refs=tuple(refused_refs))
    grounded = []
    for ref in candidates:
        if _ref_path(ref) in tracked:
            grounded.append(ref)
        else:
            refused_refs.append((ref, REF_UNTRACKED))
    if not grounded:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_UNTRACKED,
                                refused_refs=tuple(refused_refs), anchor_commit=commit)
    # ARIA-HIGH-381 — only the write set is held to the writable test; an
    # evidence surface is cited, never written, whatever its path.
    split = split_surfaces([_ref_path(ref) for ref in grounded], record=record,
                           write_roots=write_roots, repo_root=context.repo_root)
    writable: list[str] = []
    refused_surfaces: list[tuple[str, str]] = []
    for surface in split.write:
        why = classify_declared_surface(surface)
        if why is None:
            writable.append(surface)
        else:
            refused_surfaces.append((surface, why))
    digest = grounding_digest(grounded)
    verdict = dict(
        evidence_refs=tuple(grounded), refused_surfaces=tuple(refused_surfaces),
        refused_refs=tuple(refused_refs), grounding_digest=digest, anchor_commit=commit,
        evidence_surfaces=split.evidence, write_basis=split.basis,
    )
    if split.basis == WRITE_BASIS_DEFERRED and defer_moved_fix_target:
        return FindingAdmission(finding_id, None, **verdict)
    if not split.write:
        return FindingAdmission(finding_id, FINDING_WRITE_SCOPE_EMPTY, **verdict)
    if not writable:
        return FindingAdmission(finding_id, FINDING_SURFACES_READONLY, **verdict)
    if expected_digest is not None and expected_digest != digest:
        return FindingAdmission(finding_id, GROUNDING_DIGEST_MISMATCH, **verdict)
    return FindingAdmission(finding_id, None, affected_surfaces=tuple(writable), **verdict)


def _overlap(surfaces: frozenset[str], paths: set[str]) -> list[str]:
    """The ``paths`` a plan's surfaces cover; a surface may name a directory."""
    return sorted(path for path in paths
                  if any(path == s or path.startswith(s.rstrip("/") + "/") for s in surfaces))


def _subject_outcomes(
    plan: PlanRecord, finding_id: str, findings: Mapping[str, dict[str, Any]], now: datetime,
) -> list[tuple[dict[str, Any], datetime]]:
    """Guard 5 causes of one earlier plan for the subject: it failed, or after it
    merged another finding was emitted on the surfaces it changed."""
    causes: list[tuple[dict[str, Any], datetime]] = []
    if plan.failed_at is not None:
        causes.append(({"cause": "plan_failed"}, plan.failed_at))
    if plan.merged_at is not None:
        for other, record in findings.items():
            created = _stamp(record.get("created_at"), now)
            paths = {_ref_path(ref) for ref in refs_from_finding_record(record)}
            if other != finding_id and created > plan.merged_at and _overlap(plan.surfaces, paths):
                causes.append(({"cause": "new_finding_on_subject", "finding": other}, created))
    return causes


def _unverified_failure_streak(own: list[PlanRecord]) -> list[PlanRecord]:
    """The subject's most recent ENDED plans, oldest first, back to the last
    one that ended any other way (merged, a verified failure): the consecutive
    unattributable implementation endings."""
    def ended_at(plan: PlanRecord) -> datetime | None:
        return plan.unverified_failed_at or plan.failed_at or plan.merged_at

    ended = sorted((plan for plan in own if ended_at(plan) is not None), key=ended_at)
    streak: list[PlanRecord] = []
    for plan in reversed(ended):
        if plan.unverified_failed_at is None:
            break
        streak.insert(0, plan)
    return streak


def _subject_ids(finding_id: str, findings: Mapping[str, dict[str, Any]]) -> frozenset[str]:
    """``finding_id`` and every finding sharing its subject key (itself alone without one)."""
    from .finding_subject import finding_subject_key

    key = finding_subject_key(findings.get(finding_id) or {})
    if key is None:
        return frozenset({finding_id})
    return frozenset({finding_id, *(fid for fid, record in findings.items() if finding_subject_key(record) == key)})


def _loop_refusal(
    history: LoopHistory, admission: FindingAdmission, findings: Mapping[str, dict[str, Any]],
) -> tuple[str, dict[str, Any]] | None:
    """The first loop guard an admitted aging F finding trips, with what it tripped on."""
    from .self_improvement import SELF_CHANGE_ALLOWED_PREFIXES

    def origin(fid: str) -> str:
        return str((findings.get(fid) or {}).get("originating_skill") or "")

    now, finding_id = history.now, str(admission.finding_id)
    recent = ADR_0003_RECENT_CLOSURES
    # ADR-0003 prerequisite 5 — the last 3 RESOLVED findings all came from the watchdog.
    resolved = [fid for fid, status in history.closures if status == "RESOLVED"][-recent:]
    if len(resolved) == recent and all(origin(fid).startswith(WATCHDOG_ORIGIN_PREFIX) for fid in resolved):
        return WATCHDOG_RESOLUTION_STREAK, {"resolved": resolved}
    # Guard 4 — at most N F_FINDING-sourced plans START in any rolling 24h (plan_started stamps).
    started = sorted(p.plan_id for p in history.plans if p.f_sourced and now - p.started_at < _CAP_WINDOW)
    if len(started) >= history.max_plans_per_24h:
        return GLOBAL_CAP_EXCEEDED, {"plans_started_24h": started, "limit": history.max_plans_per_24h}
    # Guard 5 — cycle detection on the subject (the finding id). An attributed revert
    # quarantines it until an operator-sourced plan for it MERGES after the revert: a
    # started operator plan can still be abandoned or rejected, and the subject must not
    # fall back to the unattended source until the operator's resolution is on main
    # (ADR-0003 amendment 2026-10-02). A failure or a new finding on what an earlier
    # plan changed cools it off.
    # ARIA-HIGH-369 review M3 — the subject is the finding's ARIA-HIGH-363
    # subject (every finding deriving its key), not its id: duplicates of one
    # subject are offered in turn, and a sibling must not re-plan what another
    # sibling's failed or reverted plan cooled off or quarantined.
    own = [plan for plan in history.plans if plan.finding_id in _subject_ids(finding_id, findings)]
    for plan in own:
        reverted = history.reverted_at.get(plan.merge_sha or "")
        if reverted is not None and not any(o.operator_sourced and o.merged_at is not None
                                            and o.merged_at > reverted for o in own):
            return SUBJECT_QUARANTINED, {"plan_id": plan.plan_id, "merge_sha": plan.merge_sha,
                                         "reverted_at": reverted.isoformat()}
    streak = _unverified_failure_streak(own)
    if len(streak) >= UNVERIFIED_FAILURE_STREAK and now - streak[-1].unverified_failed_at < history.cool_off:
        return SUBJECT_COOL_OFF, {"plan_id": streak[-1].plan_id, "cause": "repeated_unverified_failure",
                                  "plans": [plan.plan_id for plan in streak],
                                  "until": (streak[-1].unverified_failed_at + history.cool_off).isoformat()}
    for plan in own:
        for cause, at in _subject_outcomes(plan, finding_id, findings, now):
            if now - at < history.cool_off:
                return SUBJECT_COOL_OFF, {"plan_id": plan.plan_id, **cause,
                                          "until": (at + history.cool_off).isoformat()}
    # Guard 3 — originating-skill self-loop: an ARIA-originated finding whose plan would
    # modify ARIA's own code, or a finding emitted after ARIA merged a change on its evidence.
    # A deferred write set (ARIA-HIGH-381) is not yet known, so every grounded surface counts.
    from .plan_write_scope import WRITE_BASIS_DEFERRED

    candidates = (admission.evidence_surfaces if admission.write_basis == WRITE_BASIS_DEFERRED
                  else admission.affected_surfaces)
    aria_surfaces = sorted(s for s in candidates if s.startswith(SELF_CHANGE_ALLOWED_PREFIXES))
    if origin(finding_id) not in EXTERNAL_ORIGINATING_SKILLS and aria_surfaces:
        return SELF_LOOP_ORIGIN_SURFACE, {"originating_skill": origin(finding_id) or None, "surfaces": aria_surfaces}
    created = _stamp((findings.get(finding_id) or {}).get("created_at"), now)
    evidence = {_ref_path(ref) for ref in admission.evidence_refs}
    for plan in history.plans:
        if plan.merged_at is not None and plan.merged_at < created and _overlap(plan.surfaces, evidence):
            return SELF_LOOP_OWN_CHANGE, {"plan_id": plan.plan_id, "surfaces": _overlap(plan.surfaces, evidence)}
    # ADR-0003 prerequisite 3 — a watchdog finding while one of the last 3 closed was the watchdog's.
    closed = [fid for fid, _status in history.closures[-recent:]]
    if origin(finding_id).startswith(WATCHDOG_ORIGIN_PREFIX) and any(
            origin(fid).startswith(WATCHDOG_ORIGIN_PREFIX) for fid in closed):
        return SELF_LOOP_WATCHDOG_RECENT, {"closed": closed}
    return None


def judge_loop_guards(context: GroundingContext, admission: FindingAdmission) -> FindingAdmission:
    """ARIA-HIGH-260 — refuse an admitted aging F finding that would feed a self-loop.

    Called for the unattended F_FINDING source only; the verdict keeps the
    admission's refs and digest, so the skip event names what was judged.
    """
    if context.loop_history is None:
        return replace(admission, reason=LOOP_HISTORY_UNAVAILABLE, affected_surfaces=(),
                       loop_guard={"fault": context.loop_fault})
    refusal = _loop_refusal(context.loop_history, admission, context.findings or {})
    if refusal is None:
        return admission
    return replace(admission, reason=refusal[0], affected_surfaces=(), loop_guard=refusal[1])


def admit_candidate(candidate: Mapping[str, Any], context: GroundingContext) -> FindingAdmission | None:
    """The admission a ranked candidate needs, or None for a source that names no F finding.

    An F_FINDING candidate's id IS the finding id; an operator request
    carries the finding id and the grounding digest it signed. Both go
    through :func:`admit_finding`; only the unattended F_FINDING source then
    passes ADR-0003's loop guards (ARIA-HIGH-260).
    """
    from .plan_candidate_source import PlanCandidateSource

    source_type = candidate.get("source_type")
    if source_type == PlanCandidateSource.F_FINDING.value:
        admission = admit_unattended_finding(context, candidate.get("candidate_id"))
        return judge_loop_guards(context, admission) if admission.admitted else admission
    if source_type == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        digest = candidate.get("grounding_digest")
        roots = candidate.get("write_roots")
        return admit_finding(context, candidate.get("finding_id"),
                             expected_digest=digest if isinstance(digest, str) else "",
                             write_roots=list(roots) if isinstance(roots, (list, tuple)) else None)
    return None


__all__ = [
    "ADMISSION_REASONS",
    "CHECKOUT_UNAVAILABLE",
    "FINDING_EVIDENCE_SELF_OUTPUT_ONLY",
    "FINDING_EVIDENCE_UNAVAILABLE",
    "FINDING_EVIDENCE_UNSAFE",
    "FINDING_EVIDENCE_UNTRACKED",
    "FINDING_ID_INVALID",
    "FINDING_ID_MISSING",
    "FINDING_NOT_OPEN",
    "FINDING_STORE_UNAVAILABLE",
    "FINDING_STORE_UNREADABLE",
    "FINDING_SURFACES_READONLY",
    "FINDING_UNKNOWN",
    "FINDING_WRITE_SCOPE_EMPTY",
    "GLOBAL_CAP_EXCEEDED",
    "GROUNDING_DIGEST_MISMATCH",
    "INTRINSIC_ADMISSION_REASONS",
    "LOOP_GUARD_REASONS",
    "LOOP_HISTORY_UNAVAILABLE",
    "LOOP_POLICY_BLOCK",
    "REF_SELF_OUTPUT",
    "REF_UNSAFE",
    "REF_UNTRACKED",
    "RUNNER_FAULT_REASONS",
    "SELF_LOOP_ORIGIN_SURFACE",
    "SELF_LOOP_OWN_CHANGE",
    "SELF_LOOP_WATCHDOG_RECENT",
    "SUBJECT_COOL_OFF",
    "UNVERIFIED_FAILURE_STREAK",
    "SUBJECT_QUARANTINED",
    "WATCHDOG_RESOLUTION_STREAK",
    "FindingAdmission",
    "GroundingContext",
    "LoopHistory",
    "PlanRecord",
    "admit_candidate",
    "admit_finding",
    "admit_unattended_finding",
    "closure_blocker",
    "f_finding_loop_policy",
    "grounding_digest",
    "judge_loop_guards",
    "load_grounding_context",
    "refs_from_finding_record",
    "safe_repo_ref",
]
