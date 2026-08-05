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
class DescentProof:
    """Whether the store's worktree IS the published tip, and both SHAs.

    Carried as a value rather than recomputed inside the assessor so the rule
    stays pure and testable: `assess_memory_continuity` decides what a proof
    means, `store_is_at_published_tip` decides what the proof is, and a test
    can supply either half without a git remote.
    """

    proven: bool
    head: str = ""
    tip: str = ""


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


def continuity_probe_roots(repo_root: Path, base_dir: Path) -> dict[str, Path]:
    """The roots a continuity probe must walk, which are the PUBLISHED roots.

    PLAN Wave 1 PR 2.6c. The probe used to walk the tools root alone, and that
    was correct for exactly as long as no reference carried a surface map: the
    committed anchors carry a `manifest_root` and nothing else, so the
    surface-loss half of the comparison never ran and the narrower probe never
    showed.

    The lane cutover made the published snapshot the reference, and a published
    snapshot covers all three roots. A tools-only probe compared against it
    reports every workspace and repo surface as LOST — sixteen declared
    surfaces, on a healthy tree, on the first cycle. `blocks_action` is true for
    `critical`, so the first real nightly would have frozen itself and called it
    memory loss.

    Derived from `store_roots` rather than assembled here, for the reason its
    own docstring gives: three roots have to agree, and a second copy of that
    mapping is how two of them end up right and the third silently wrong. When
    no store is bound the probe falls back to the tools root — that is the
    honest scope of an unbound run, and it is the shape every unit test uses.
    """
    from .state_store import STORE_DIRNAME

    store_dir = Path(repo_root) / STORE_DIRNAME
    if not store_dir.is_dir():
        return {"tools": Path(base_dir)}

    from .workspace import canonical_identity
    from .state_store import open_state_store, store_roots

    store = open_state_store(repo_root)
    return store_roots(store, canonical_identity(Path(repo_root)))


def store_is_at_published_tip(repo_root: Path) -> DescentProof:
    """Is the store's worktree the commit the remote branch actually points at?

    Both SHAs travel with the answer so a refusal can name them.

    THIS IS WHAT DESCENT MEANS AFTER THE CUTOVER, and saying so is the point.
    A probe snapshot is built fresh from the tree, so it has no
    `prev_manifest_root` and can never satisfy `snapshots_are_linked` — the
    chain-linkage test answers "no" for a perfectly healthy tree, every time.
    Passing the reference in as `previous` to make the test pass would be worse
    than useless: it would assert the very thing under examination.

    So descent is measured where it is actually decided. `publish_state` pushes
    fast-forward-only and `checkout_state_store` establishes the worktree AT the
    remote tip; a tree whose HEAD is that tip provably continues the published
    history, and a tree whose HEAD is not is exactly the divergence the gate
    exists to catch. One git comparison, no inference.
    """
    from .state_store import open_state_store, _remote_tip, _git

    store = open_state_store(repo_root)
    head = _git(store.root, "rev-parse", "HEAD").strip()
    tip = (_remote_tip(store) or "").strip()
    return DescentProof(proven=bool(tip) and head == tip, head=head, tip=tip)


def assess_memory_continuity(
    *,
    current: dict[str, Any],
    reference: dict[str, Any] | None,
    reference_kind: str | None,
    descent: DescentProof | None = None,
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
        if descent is not None:
            # The transport answers descent, so its verdict REPLACES the
            # chain-linkage half — see `store_is_at_published_tip` for why the
            # linkage test cannot answer it for a probe. The lost-surface half
            # is untouched: that is the question only a tree comparison can
            # answer, and it is the one the gate is really for.
            detail = {**detail, "linked": descent.proven}
            notes += ("descent_proven_by_transport",)
    else:
        # An anchor stub. It can answer descent and nothing else; the surface
        # half is UNAVAILABLE, which is recorded as a limitation rather than
        # silently passing as "nothing was lost". Descent itself goes through
        # `snapshots_are_linked` — the same predicate `snapshot_continuity`
        # uses — so the two reference kinds cannot come to disagree about what
        # "descends from" means.
        detail = {"linked": snapshots_are_linked(current, reference)}
        lost = ()
        notes = ("surface_comparison_unavailable_from_anchor",)

    # Status is DERIVED from the two halves here rather than read off
    # `snapshot_continuity`, because the transport can override one of them and
    # a status computed before that override describes the wrong question.
    linked = bool(detail.get("linked"))
    if not linked:
        status_from_detail = "chain_broken"
    elif lost:
        status_from_detail = "surfaces_lost"
    else:
        status_from_detail = "ok"

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
        if descent is not None:
            # Name both SHAs. "The chain is broken" is not actionable; "your
            # store is at X and the branch is at Y" is a fetch away from fixed.
            reasons.append(
                f"state_continuity_store_not_at_tip:head={descent.head or '<none>'} "
                f"tip={descent.tip or '<unreadable>'}"
            )
        else:
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


@dataclass(frozen=True)
class RecoveryResult:
    """What the recovery attempt did, and whether the gap is gone."""

    resolved: bool
    reason: str
    replayed: dict[str, int] = field(default_factory=dict)
    verdict_after: ContinuityVerdict | None = None

    def as_event(self) -> dict[str, Any]:
        return {
            "resolved": self.resolved,
            "reason": self.reason,
            "replayed": dict(self.replayed),
            "status_after": None if self.verdict_after is None else self.verdict_after.status,
            "reasons_after": [] if self.verdict_after is None else list(self.verdict_after.reasons),
        }


def restore_and_replay(
    repo_root: Path,
    verdict: ContinuityVerdict,
    *,
    base_dir: Path,
    cycle_id: str,
) -> RecoveryResult:
    """Adopt the published tree, re-apply this run's rows, and re-judge.

    PLAN Wave 1 §2.5 promised this and PR 2.6 deferred it, correctly: a restore
    primitive with no transport would have been a capability with no caller.
    The transport exists now.

    WHAT IT REPAIRS. Both shapes of a critical verdict resolve to the same
    operation. `store_not_at_tip` means this worktree is on a commit the branch
    has moved past; `surfaces_lost` with descent proven means the tree IS the
    tip's commit but files are missing from it. Resetting the worktree to the
    remote tip fixes both, and `rebase_store_onto_remote` carries this run's
    append-only rows across the reset rather than discarding them — the same
    primitive, the same three guarantees, as the publish race.

    IT RUNS BEFORE THE FREEZE, WHICH IS A DEVIATION FROM THE PLAN, and the
    reason is worth stating because the plan's ordering cannot be built. PLAN
    §2.5 says freeze, then restore, then `reset_breaker`. But `reset_breaker`
    requires an `operator_approval_ref` and TRUNCATES the failure ledger — it
    is the operator's "investigated, resolved, clean slate" signal. Calling it
    from automatic recovery would forge that signature and destroy unrelated
    failure evidence. So a freeze followed by a successful recovery would leave
    a failure row that only a human could clear, which is precisely the manual
    intervention the recovery exists to remove. Recovering first leaves no
    residue to clear; recovering last would guarantee residue.

    A RECOVERED GAP IS NOT A BREAKER EVENT. The breaker means "ARIA must stop".
    A tree that has been restored and re-judged continuous is not a tree that
    must stop, so the evidence goes to `governance.jsonl` — declared,
    hash-chained, and readable — instead. An UNRECOVERED gap still freezes.

    REFUSALS ARE VERDICTS, NOT FAILURES. Recovery declines rather than guesses
    when there is nothing to restore FROM (an anchor reference carries a
    manifest root and no tree) or nothing diagnosed to restore (any status but
    critical). Both return `resolved=False` with a reason, and the caller
    freezes exactly as it would have.
    """
    from .state_store import STORE_DIRNAME

    if verdict.status != GAP_CRITICAL:
        return RecoveryResult(False, f"recovery_requires_critical:{verdict.status}")
    if verdict.reference_kind != REFERENCE_STATE_BRANCH:
        # An anchor stub proves descent and carries no tree. There is nothing
        # to reset onto, and resetting onto a guess is how a recovery destroys
        # the state it was called to save.
        return RecoveryResult(
            False, f"recovery_requires_state_branch_reference:{verdict.reference_kind}"
        )
    repo_root = Path(repo_root)
    if not (repo_root / STORE_DIRNAME).is_dir():
        return RecoveryResult(False, "recovery_requires_a_checked_out_store")

    from .state_snapshot import build_snapshot
    from .state_store import (
        StateStoreError,
        open_state_store,
        read_published_snapshot,
        read_snapshot_at_worktree_head,
        rebase_store_onto_remote,
    )
    from .tool_registry import GovernanceError, append_tools_governance
    from .workspace import canonical_identity

    repo_hash = canonical_identity(repo_root)
    roots = continuity_probe_roots(repo_root, base_dir)

    try:
        store = open_state_store(repo_root)
        if read_published_snapshot(store) is None:
            return RecoveryResult(False, "recovery_has_no_published_tip_to_adopt")
        # The BASE is the snapshot this worktree's rows were appended to, which
        # is the worktree's own HEAD — not the remote tip. They differ exactly
        # when the store is behind, which is the case recovery exists for, and
        # passing the tip makes `append_only_suffix` refuse with
        # `replay_prefix_diverged`. That refusal is the guard working; getting
        # the base right is what stops it being asked the wrong question.
        base = read_snapshot_at_worktree_head(store)
        local = build_snapshot(
            snapshot_id=f"recovery-local-{cycle_id}",
            cycle_id=cycle_id,
            lane="recovery",
            roots=roots,
        )
        replayed = rebase_store_onto_remote(
            store, base=base, local=local, repo_hash=repo_hash
        )
    except (StateStoreError, GovernanceError) as exc:
        # A recovery that cannot complete must not report that it did. The
        # caller freezes, which is the correct outcome for a tree nobody could
        # repair.
        return RecoveryResult(False, f"recovery_failed:{type(exc).__name__}:{exc}")

    # RE-JUDGED, not assumed. The whole defect class this module exists for is
    # a control that reports on a state it did not re-read.
    after_reference, after_kind = resolve_continuity_reference(repo_root)
    after = assess_memory_continuity(
        current=build_snapshot(
            snapshot_id=f"recovery-after-{cycle_id}",
            cycle_id=cycle_id,
            lane="recovery",
            roots=continuity_probe_roots(repo_root, base_dir),
        ),
        reference=after_reference,
        reference_kind=after_kind,
        descent=(
            store_is_at_published_tip(repo_root)
            if after_kind == REFERENCE_STATE_BRANCH
            else None
        ),
    )
    result = RecoveryResult(
        resolved=after.status in {GAP_OK, GAP_GENESIS},
        reason="recovered" if after.status in {GAP_OK, GAP_GENESIS} else "recovery_incomplete",
        replayed=replayed,
        verdict_after=after,
    )
    try:
        append_tools_governance(
            base_dir,
            "memory_gap_recovery_attempted",
            {
                "cycle_id": cycle_id,
                "gap_reasons": list(verdict.reasons),
                "lost_surfaces": list(verdict.lost_surfaces),
                **result.as_event(),
            },
        )
    except GovernanceError:
        # A profile that forbids the write does not make the repair untrue, but
        # an unrecorded repair is one nobody can audit — so it is reported as
        # unresolved and the caller freezes.
        return RecoveryResult(False, "recovery_unrecordable_under_profile", replayed, after)
    return result


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
