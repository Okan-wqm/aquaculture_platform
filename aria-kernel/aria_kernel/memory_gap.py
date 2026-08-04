"""Tell a tree that was RESTORED from a tree that merely started EMPTY.

PLAN Wave 1 §2.5. `aria-auto-cycle.yml` ran `integrity migrate-tools-bootstrap
--acknowledge` unconditionally, so a restore that failed produced exactly the
starting state a genuine first run produces. An empty tree then passes
`integrity verify` — an empty tree is trivially consistent — and ARIA went on
to plan, learn and act with every surviving file still verifying and its whole
history gone.

THE EVIDENCE MUST COME FROM OUTSIDE THE TREE. A tree that lost its history also
lost any record that it had one, so nothing inside `aria-tools/` can be asked.
Two references live outside it:

  * the ``aria/state`` branch tip (``state_store.read_published_snapshot``) —
    carries the full surface map, so it answers both "does this descend from
    that?" and "did a surface vanish?";
  * the daily anchors committed into the repository under
    ``aria-tools/reports/daily/`` — carry ``state_manifest_root`` and no
    surface map, so they answer the first question only.

THREE OUTCOMES, AND THE THIRD IS THE LOAD-BEARING ONE. ``unknown`` is not
``ok`` and not ``critical``: it is the honest answer when no reference is
available, and the gate gives it rather than guessing. Guessing continuous
re-opens the hole this module exists to close. Guessing amnesiac would degrade
every cycle on this repository today, whose committed anchors all predate the
``state_manifest_root`` field. Same discipline as an empty acceptance ledger
not being a broken chain, and ``outcome_status`` defaulting to ``unknown``
rather than ``verified``.

Restore-and-replay is NOT here. Restoring needs a transport — the state-store
lane cutover — and the plan puts that in PR 2.6. A restore primitive with no
lane to carry it would be a capability with no caller, which is the defect
class this file is closing one instance of.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .state_snapshot import snapshot_continuity, snapshots_are_linked

# Verdict vocabulary. Closed on purpose: a fourth status invented at a callsite
# is a fourth branch every consumer has to learn about from the wild.
GAP_OK = "ok"
GAP_GENESIS = "genesis"
GAP_UNKNOWN = "unknown"
GAP_CRITICAL = "critical"

# Where a reference came from, so a refusal names the authority that issued it.
REFERENCE_STATE_BRANCH = "state_branch"
REFERENCE_DAILY_ANCHOR = "daily_anchor"

DAILY_ANCHOR_RELATIVE_DIR = Path("aria-tools") / "reports" / "daily"


@dataclass(frozen=True)
class ContinuityVerdict:
    """What is known about this tree's descent, and on whose authority."""

    status: str
    reference_kind: str | None
    reasons: tuple[str, ...] = ()
    # Facts the gate could NOT establish, kept apart from `reasons` so a
    # limitation never reads as a finding. An anchor reference cannot see
    # surface loss; saying so is not the same as saying none occurred.
    notes: tuple[str, ...] = ()
    lost_surfaces: tuple[str, ...] = ()
    current_manifest_root: str | None = None
    reference_manifest_root: str | None = None

    @property
    def blocks_action(self) -> bool:
        """Only a positive finding of amnesia stops the cycle acting.

        ``unknown`` deliberately does not: it is the absence of evidence, and a
        gate that treats absence as proof is a gate that fires on a repository
        that has simply not published a reference yet.
        """
        return self.status == GAP_CRITICAL


@dataclass(frozen=True)
class EquivalenceResult:
    equivalent: bool
    differences: tuple[str, ...] = field(default=())


def reference_from_committed_anchors(repo_root: Path) -> dict[str, Any] | None:
    """The newest committed daily anchor THAT CARRIES a manifest root.

    Newest-with-a-root rather than newest-then-check, because the anchors this
    repository has committed so far carry neither field — they predate it, and
    two of them are hand-written prose with no frontmatter at all. Stopping at
    the newest file and reporting "no root" would blind the gate to the last
    good reference the moment one malformed anchor lands on top of it.

    Filenames are ISO dates, so lexical descending IS chronological descending.
    """
    directory = Path(repo_root) / DAILY_ANCHOR_RELATIVE_DIR
    if not directory.is_dir():
        return None
    for path in sorted(directory.glob("*.md"), key=lambda p: p.name, reverse=True):
        front = _frontmatter(path)
        if front is None:
            continue
        manifest_root = front.get("state_manifest_root")
        if not manifest_root:
            continue
        return {
            "snapshot_id": front.get("state_snapshot_id"),
            "manifest_root": manifest_root,
        }
    return None


def resolve_continuity_reference(repo_root: Path) -> tuple[dict[str, Any] | None, str | None]:
    """The strongest available reference, and the name of where it came from.

    Precedence is by STRENGTH, not convenience: the state branch carries the
    full surface map and can answer both questions; a committed anchor carries
    the manifest root alone and can answer only descent.

    ABSENCE AND DAMAGE ARE NOT THE SAME THING, and the split is the point. No
    store checked out is the ordinary state on every lane today, so it falls
    through to the anchors in silence. A store that IS present and cannot be
    read raises: `read_published_snapshot` refuses a truncated snapshot and a
    HEAD carrying neither snapshot nor GENESIS, and those refusals are evidence
    about the very thing this module exists to judge. Catching them here would
    downgrade a damaged store to a weaker reference and call the result an
    answer — the same fail-soft that let a bootstrap-empty tree pass for a
    restored one.
    """
    repo_root = Path(repo_root)
    from .state_store import STORE_DIRNAME

    if (repo_root / STORE_DIRNAME).is_dir():
        from .state_store import open_state_store, read_published_snapshot

        published = read_published_snapshot(open_state_store(repo_root))
        if published is not None:
            return published, REFERENCE_STATE_BRANCH
        # A store that has never published is a genuine newborn, not a reason
        # to go looking for an older authority: the anchors describe a state
        # this store does not claim to continue.
        return None, None

    anchor = reference_from_committed_anchors(repo_root)
    return (anchor, REFERENCE_DAILY_ANCHOR) if anchor is not None else (None, None)


def assess_memory_continuity(
    *,
    current: dict[str, Any],
    reference: dict[str, Any] | None,
    reference_kind: str | None,
) -> ContinuityVerdict:
    """Does ``current`` descend from the last state anyone can still attest to?

    ``current`` is a snapshot manifest of the tree about to be acted on.
    ``reference`` is a snapshot (state branch) or an anchor-derived stub
    (``snapshot_id`` + ``manifest_root``, no surfaces).
    """
    current_root = current.get("manifest_root")
    surfaces = current.get("surfaces") or {}

    if reference is None:
        if not surfaces:
            # Nothing here, and nothing anywhere remembers otherwise. A newborn
            # ARIA must be able to start — and this is the ONLY shape that may.
            return ContinuityVerdict(
                status=GAP_GENESIS,
                reference_kind=None,
                notes=("no_reference_available",),
                current_manifest_root=current_root,
            )
        # State exists but nothing can vouch for where it came from. Not a first
        # run, and not a verified one either.
        return ContinuityVerdict(
            status=GAP_UNKNOWN,
            reference_kind=None,
            reasons=("state_continuity_reference_unavailable",),
            notes=("no_reference_available",),
            current_manifest_root=current_root,
        )

    reference_root = reference.get("manifest_root")

    if reference.get("surfaces") is not None:
        # A full snapshot: `snapshot_continuity` already owns this comparison,
        # including the lost-surface half. Reimplementing it here would be the
        # second copy of a rule, which is how the two diverge.
        detail = snapshot_continuity(current, reference)
        lost = tuple(detail.get("lost_surfaces") or ())
        notes: tuple[str, ...] = ()
    else:
        # An anchor stub. It can answer descent and nothing else; the surface
        # half is UNAVAILABLE, which is recorded as a limitation rather than
        # silently passing as "nothing was lost". Descent itself goes through
        # `snapshots_are_linked` — the same predicate `snapshot_continuity`
        # uses — so the two reference kinds cannot come to disagree about what
        # "descends from" means.
        detail = {"status": "ok" if snapshots_are_linked(current, reference) else "chain_broken"}
        lost = ()
        notes = ("surface_comparison_unavailable_from_anchor",)

    status_from_detail = str(detail.get("status"))
    if status_from_detail == "ok":
        return ContinuityVerdict(
            status=GAP_OK,
            reference_kind=reference_kind,
            notes=notes,
            current_manifest_root=current_root,
            reference_manifest_root=reference_root,
        )

    reasons: list[str] = []
    if status_from_detail == "chain_broken":
        reasons.append(
            "state_continuity_chain_broken:"
            f"expected_prev={reference_root} got_prev={current.get('prev_manifest_root')}"
        )
    if lost:
        reasons.append(f"state_continuity_surfaces_lost:{','.join(lost)}")
    if not reasons:
        # `snapshot_continuity` returned a status this function does not map.
        # Naming it beats defaulting to ok, which would drop a real refusal.
        reasons.append(f"state_continuity_unmapped_status:{status_from_detail}")
    return ContinuityVerdict(
        status=GAP_CRITICAL,
        reference_kind=reference_kind,
        reasons=tuple(reasons),
        notes=notes,
        lost_surfaces=lost,
        current_manifest_root=current_root,
        reference_manifest_root=reference_root,
    )


def equivalence_check(expected: dict[str, Any], actual: dict[str, Any]) -> EquivalenceResult:
    """Per-surface equality of ``tail_ledger_hash`` and ``row_count``.

    The union of both surface sets is walked, not the intersection: a restore
    that dropped a surface must be a difference, not a surface the loop never
    visited. That asymmetry is the whole reason tree-level comparison exists.
    """
    expected_surfaces = expected.get("surfaces") or {}
    actual_surfaces = actual.get("surfaces") or {}
    differences: list[str] = []
    for name in sorted(set(expected_surfaces) | set(actual_surfaces)):
        want = expected_surfaces.get(name)
        got = actual_surfaces.get(name)
        if want is None:
            differences.append(f"{name}:unexpected_surface")
            continue
        if got is None:
            differences.append(f"{name}:missing_surface")
            continue
        for attribute in ("tail_ledger_hash", "row_count"):
            if want.get(attribute) != got.get(attribute):
                differences.append(
                    f"{name}:{attribute}:expected={want.get(attribute)}:got={got.get(attribute)}"
                )
    return EquivalenceResult(equivalent=not differences, differences=tuple(differences))


def freeze_autonomous_writes(
    verdict: ContinuityVerdict,
    *,
    base_dir: Path,
    cycle_id: str,
) -> dict[str, Any]:
    """Record a positive finding of amnesia where everything that acts reads it.

    ONE mechanism, deliberately. `record_failure(kind="state_integrity_gap")`
    trips the circuit breaker, and `_cycle_preflight` already consults that
    breaker for every profile in `PROFILES_WITH_ACTION_AUTHORITY` — so the
    next cycle is stopped by the same route every other failure kind stops it.
    A separate "frozen" flag would be a second answer to *how does ARIA stop*,
    and ORPHAN-CRITICAL-513 is what two answers cost the last time.

    Called only for `GAP_CRITICAL`. `unknown` must not trip a breaker: a gate
    that cannot see is not a gate that saw something.
    """
    if verdict.status != GAP_CRITICAL:
        raise ValueError(
            f"freeze_autonomous_writes_requires_critical: got {verdict.status!r}; "
            "an unproven gap must not trip the breaker"
        )
    from .circuit_breaker import record_failure

    return record_failure(
        kind="state_integrity_gap",
        base_dir=base_dir,
        # The cycle that observed the gap. Every other kind identifies the
        # unit of work that failed (a claim id, a request id); here the unit
        # is the cycle, because the gap is a property of the tree it opened
        # on rather than of anything it went on to attempt.
        materialize_event_id=cycle_id,
        extra={
            "cycle_id": cycle_id,
            "reference_kind": verdict.reference_kind,
            "reasons": list(verdict.reasons),
            "lost_surfaces": list(verdict.lost_surfaces),
            "current_manifest_root": verdict.current_manifest_root,
            "reference_manifest_root": verdict.reference_manifest_root,
        },
    )


def _frontmatter(path: Path) -> dict[str, Any] | None:
    """The YAML frontmatter of a rendered anchor, or None.

    Returns None — never raises — for a file with no frontmatter, unreadable
    bytes or unparseable YAML. A gate that dies on a malformed input file takes
    the cycle down instead of reporting on it, and the pre-workflow reports on
    `main` are hand-written markdown with no frontmatter at all.
    """
    import yaml  # type: ignore[import-untyped]

    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    try:
        parsed = yaml.safe_load(text[4:end])
    except yaml.YAMLError:
        return None
    return parsed if isinstance(parsed, dict) else None


__all__ = [
    "GAP_CRITICAL",
    "GAP_GENESIS",
    "GAP_OK",
    "GAP_UNKNOWN",
    "REFERENCE_DAILY_ANCHOR",
    "REFERENCE_STATE_BRANCH",
    "ContinuityVerdict",
    "EquivalenceResult",
    "assess_memory_continuity",
    "equivalence_check",
    "freeze_autonomous_writes",
    "reference_from_committed_anchors",
    "resolve_continuity_reference",
]
