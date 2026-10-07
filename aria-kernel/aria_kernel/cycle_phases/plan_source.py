"""Plan ARIA-V3.1-0 — PlanContentProvider Protocol (V3.1-A consumes).

The orchestrator's V7 `plan_synthesizer` kwarg returned a bare
`dict | None`, which let `_pressure_source_type` leak into the
plan_content schema (HIGH-008). v3.1-A introduces the envelope
split: `content` (canonical 7-field plan_content; passes
`_validate_plan_content`) + `metadata` (`_pressure_source_type`,
candidate_id, ranking ordinal, etc.).

V3.1-A installs `V9PressureSourceProvider(fallback=V7GitDiffProvider())`
as the production implementation: iterates the 5-source ranked
candidate list (OPERATOR_FEEDBACK > FAILING_CI > ORPHAN_FINDING >
F_FINDING > GIT_DIFF), invokes `convert_candidate_to_plan_content`
on each, and only falls back to the V7 git-diff synthesizer when
ALL ranked candidates yield None. Under `profile == "autonomous"`
the fallback raises (fail-fast); under `strict`/`standard` it
soft-falls to V7.

V3.1-0 ships ONLY the Protocol + NoOp/V7-shim variant; the
V9PressureSourceProvider lands in V3.1-A.

Tier-1 anchor: `CyclePlanEnvelope` is a frozen dataclass with
distinct `content` and `metadata` fields — a future caller that
tries to fold `_pressure_source_type` into plan_content gets a
KeyError at the validator, not a silent schema drift.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping, Protocol

if TYPE_CHECKING:  # pragma: no cover
    pass


@dataclass(frozen=True)
class CyclePlanEnvelope:
    """Plan ARIA-V3.1-A — envelope/content split for plan source.

    Fields:

    * ``content`` — canonical plan_content (7-field schema validated by
      ``plan_convergence._validate_plan_content``). MUST NOT carry
      `_pressure_source_type` or other metadata fields.
    * ``metadata`` — sidecar metadata threading. ``_pressure_source_type``
      flows through here to ``cycle_phases.cost_telemetry`` without
      polluting `content_hash`.

    Frozen dataclass: prevents mutation between mint site and downstream
    consumers (convergence_runner + cost_telemetry).
    """

    content: dict[str, Any]
    metadata: dict[str, Any] = field(default_factory=dict)


class PlanContentProvider(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for plan source.

    Concrete variants (lands in V3.1-A):

    * ``V9PressureSourceProvider`` — production; iterates 5 ranked
      candidate sources via ``plan_synthesizer.rank_candidate_sources``.
    * ``V7GitDiffProvider`` — fallback; wraps
      ``plan_synthesizer.synthesize_plan_content_from_cycle``.

    NoOp variant (this file): returns None unconditionally.
    """

    def synthesize(
        self,
        *,
        cycle_id: str,
        workspace_root: Path,
        base_dir: Path,
        profile: str,
    ) -> CyclePlanEnvelope | None:
        ...


class NoOpPlanContentProvider:
    """Plan ARIA-V3.1-0 — default. Returns None so the orchestrator
    enters its V7 ``cycle_runner_no_pressure`` branch exactly as it did
    pre-v3.1 when injection is absent."""

    def synthesize(
        self,
        *,
        cycle_id: str,
        workspace_root: Path,
        base_dir: Path,
        profile: str,
    ) -> CyclePlanEnvelope | None:
        return None


class V7GitDiffProvider:
    """Plan ARIA-V3.1-A — fallback provider. Wraps the legacy V7
    `synthesize_plan_content_from_cycle` and lifts its return value
    into a CyclePlanEnvelope with `_pressure_source_type=git_diff`
    metadata (closes I-V31-A-07 — V7 fallback path attributes its
    pressure source correctly so V10.4 cost-attribution rollup
    receives the right rollup key).
    """

    def synthesize(
        self,
        *,
        cycle_id: str,
        workspace_root: Path,
        base_dir: Path,
        profile: str,
    ) -> CyclePlanEnvelope | None:
        from ..plan_synthesizer import synthesize_plan_content_from_cycle
        content = synthesize_plan_content_from_cycle(
            cycle_id=cycle_id,
            workspace_root=workspace_root,
            base_dir=base_dir,
        )
        if content is None:
            return None
        return CyclePlanEnvelope(
            content=dict(content),
            metadata={"_pressure_source_type": "git_diff"},
        )


class V9PressureSourceProvider:
    """Plan ARIA-V3.1-A — production provider. Iterates the V9.4
    5-source ranked candidate list (OPERATOR_FEEDBACK > FAILING_CI
    > ORPHAN_FINDING > F_FINDING > GIT_DIFF) and converts the first
    successfully-yielding candidate to a CyclePlanEnvelope.

    Iterative fallback (closes H-2): if `convert_candidate_to_plan_content`
    yields no plan for the first candidate, the provider continues
    through ALL ranked candidates before delegating to the V7
    git_diff fallback. Pre-V3.1-A, the synthesizer fell back to V7
    immediately on the first None — operator feedback was silently
    bypassed when ORPHAN/F-finding ranking pulled it down + the
    operator's high-priority row missed a content field.

    Authority-aware fail-fast (closes H-14, ORPHAN-HIGH-728): when ALL
    V9.4 candidates fail conversion, a profile that can LAND its own work
    unattended — one holding ``pr_merge`` in
    ``runtime_profile.ACTION_PERMISSIONS``, i.e. the merge-class authority,
    read from the table rather than compared against the name
    ``"autonomous"`` — raises GovernanceError. Nothing downstream would see
    that the plan it implements and merges was synthesised from a git diff
    instead of the pressure candidate that was selected, and there is no
    reviewer between it and `main` to notice.

    A profile that can only PROPOSE falls through to the V7 git_diff
    fallback, and the fall is DECLARED: `plan_source_v7_fallback_engaged`
    lands before the delegation. The substitution then reaches a human on
    the pull request the profile is limited to opening, which is the whole
    difference between the two cases. Silence was the defect —
    `strict` began implementing under ORPHAN-HIGH-728 and a soft-fall that
    emits nothing is indistinguishable from a candidate that converted.

    Tier-1 anchor: the per-candidate `plan_candidate_conversion_skipped`
    governance event lands EVERY skip, so the operator audit trail
    captures the iteration history.
    """

    def __init__(self, *, fallback: "PlanContentProvider | None" = None) -> None:
        self._fallback = fallback or V7GitDiffProvider()

    def synthesize(
        self,
        *,
        cycle_id: str,
        workspace_root: Path,
        base_dir: Path,
        profile: str,
    ) -> CyclePlanEnvelope | None:
        from ..finding_grounding import load_grounding_context
        from ..finding_seed import SubjectProbe, admit_and_seed
        from ..plan_convergence import in_flight_plan_id
        from ..plan_slot_policy import SLOT_POLICY_EVENT, order_for_slot
        from ..operator_feedback_ingestion import bind_plan_synthesis, record_request_refused
        from ..admission_lessons import RECURRING_FAILURE_PROBE, AdmissionHistory, admission_verdict, record_probe
        from ..operator_request_spend import REQUEST_TEXT_UNUSABLE
        from ..plan_candidate_source import PlanCandidateSource
        from ..plan_synthesizer import (
            PlanEvidenceGround,
            convert_candidate_to_plan_content,
            rank_candidate_sources,
        )
        from ..tool_registry import (
            GovernanceError, append_tools_governance,
        )
        # V9.5 check 12 — the tools store and cycle reach the operator-feedback
        # scanner so its ingestion row lands in the store the merge owner reads
        # and carries the cycle the binding below joins on.
        candidates = rank_candidate_sources(
            workspace_root=workspace_root, base_dir=base_dir, cycle_id=cycle_id,
        )
        attempted = 0
        # ADR-0018 D5 — the anchor commit and the finding fold are read ONCE
        # per synthesis (arbiter ruling iv), then every finding-naming
        # candidate is judged against the same view. ARIA-HIGH-260 — the
        # store's plan, binding and self-revert ledgers are folded into that
        # view too: the aging F_FINDING source carries ADR-0003's loop guards.
        grounding_context = load_grounding_context(workspace_root, tools_root=base_dir)
        # ORPHAN-HIGH-519 — and every candidate's refs are judged at the one
        # commit the challenger request will name.
        ground = PlanEvidenceGround.of(workspace_root)
        # ARIA-HIGH-369 — the one slot is offered in the slot policy's order
        # (operator first, ARIA's own red workflows and cooling ones dropped,
        # F collapsed by subject, F and the other automated sources taking
        # turns), and what it dropped is disclosed once per synthesis.
        slot = order_for_slot(candidates, findings=grounding_context.findings,
                              history=grounding_context.loop_history)
        # Review M4 — while a plan is in flight the orchestrator adopts it and
        # this envelope only seeds a plan that does not exist, so it is never
        # started: no detector scan (a worktree + a full drift scan) is spent
        # on it. Seeds fall back to the diff line map, which costs one git
        # diff per cited path, and the mode is disclosed.
        # A plan ledger the fold refuses is disclosed and the detectors stay
        # on: not knowing whether a plan is in flight costs a scan, never a
        # stale plan. (The orchestrator's own adoption read raises on such a
        # ledger before this provider runs.)
        try:
            in_flight, ledger_fault = in_flight_plan_id(base_dir=base_dir), None
        except GovernanceError as exc:
            in_flight, ledger_fault = None, str(exc)[:200]
        append_tools_governance(base_dir, SLOT_POLICY_EVENT, {
            "cycle_id": cycle_id, "plan_in_flight": in_flight, "plan_ledger_fault": ledger_fault,
            "seed_detectors": "skipped_plan_in_flight" if in_flight else "on", **slot.disclosure(),
        })
        candidates = list(slot.ordered)
        probe = SubjectProbe({}) if in_flight else SubjectProbe()
        # ARIA-HIGH-370 — the recorded lessons, read once for every candidate
        # (review of #1829, M: the plan and procedural ledgers per candidate).
        lessons = AdmissionHistory.load(base_dir, findings=grounding_context.findings)
        for candidate in candidates:
            # One admission for every source that names an F finding (aging
            # F findings and operator requests alike), then its seed: the
            # finding's evidence re-grounded at the anchor (ARIA-HIGH-369);
            # None, None for sources that name none.
            admission, seeded = admit_and_seed(candidate, grounding_context, probe)
            conversion = convert_candidate_to_plan_content(
                candidate, admission=admission, ground=ground,
                seed=seeded.seed if seeded is not None else None,
            )
            envelope = conversion.envelope
            attempted += 1
            grounding: dict[str, Any] = {}
            if conversion.refused_evidence_refs:
                # A ref the challenger's rule refused is named, whether or
                # not the candidate still converted.
                grounding["refused_evidence_refs"] = list(conversion.refused_evidence_refs)
            if admission is not None:
                # Refused surfaces and refs are named in the conversion
                # event, never dropped silently; a ref that failed the safe
                # charset is named by its hash, never echoed.
                grounding.update({
                    "finding_id": admission.finding_id,
                    "anchor_commit": admission.anchor_commit,
                    "refused_surfaces": admission.refused_surface_records(),
                    "refused_refs": admission.refused_ref_records(),
                })
                if seeded is not None:
                    grounding["seed"] = seeded.disclosure()
                if admission.loop_guard is not None:
                    # The loop guard's evidence rides on the one skip event
                    # the candidate gets this cycle (ARIA-HIGH-260).
                    grounding["loop_guard"] = dict(admission.loop_guard)
            if envelope is not None and candidate.get("source_type") != PlanCandidateSource.OPERATOR_FEEDBACK.value:
                # ARIA-HIGH-370 — after the slot policy (#1826) ordered and
                # cooled the candidates: an identity whose last attributed
                # attempts all failed in one mode is refused unchanged until
                # the breaker's half-open probe (``admission_lessons``). An
                # operator request outranks this brake as it outranks the
                # loop guards.
                lesson = admission_verdict(lessons, envelope.content)
                if lesson is not None and lesson["reason"] != RECURRING_FAILURE_PROBE:
                    envelope = None
                    grounding.update({"reason": lesson["reason"], "runner_fault": False, "lesson": lesson})
                elif lesson is not None:
                    grounding["lesson_probe"] = lesson
                    # One probe is one probe (second review of #1829, M5);
                    # while a plan is in flight this envelope starts nothing
                    # and the probe is not spent.
                    if not in_flight:
                        record_probe(base_dir=base_dir, lesson=lesson, cycle_id=cycle_id)
            if envelope is not None:
                # Bind BEFORE announcing the selection: the synthesized content
                # hash is what plan_started will record, and the pre-merge
                # perimeter proves the signature rule was applied by walking
                # from that hash to this row and on to the ingestion it names.
                binding = bind_plan_synthesis(
                    base_dir=base_dir, cycle_id=cycle_id,
                    plan_content=envelope.content, candidate=candidate,
                )
                append_tools_governance(
                    base_dir, "plan_candidate_source_selected",
                    {
                        "cycle_id": cycle_id,
                        "candidate_id": envelope.metadata.get("_candidate_id"),
                        "source_type": envelope.metadata.get("_pressure_source_type"),
                        "attempted": attempted,
                        "operator_feedback_binding_hash": binding.get("ledger_hash"),
                        "operator_feedback_ingestion_hash": binding.get("ingestion_ledger_hash"),
                        **grounding,
                    },
                )
                return envelope
            if conversion.skip_reason is not None and "lesson" not in grounding:
                grounding["reason"] = conversion.skip_reason
                grounding["runner_fault"] = conversion.harness_fault
            elif admission is not None and "lesson" not in grounding:
                grounding["reason"] = admission.reason or REQUEST_TEXT_UNUSABLE
                grounding["runner_fault"] = admission.runner_fault
            append_tools_governance(
                base_dir, "plan_candidate_conversion_skipped",
                {
                    "cycle_id": cycle_id,
                    "candidate_id": candidate.get("candidate_id"),
                    "source_type": candidate.get("source_type"),
                    **grounding,
                },
            )
            if (candidate.get("source_type") == PlanCandidateSource.OPERATOR_FEEDBACK.value
                    and not grounding.get("runner_fault")):
                # ADR-0018 I4 — the request's target is not a plan ground: the
                # refusal is recorded once on the ingestion ledger and spends
                # the request, so it does not hold priority 0 forever. A
                # runner fault (no anchor, no finding store) is only the skip
                # event above: the request is judged again next cycle.
                record_request_refused(
                    base_dir=base_dir, cycle_id=cycle_id,
                    request_id=candidate.get("candidate_id"),
                    request_ledger_hash=candidate.get("row_ledger_hash"),
                    subject_digest=candidate.get("subject_digest"),
                    finding_id=candidate.get("finding_id"),
                    reason=grounding["reason"],
                    refused_surfaces=grounding["refused_surfaces"],
                )
        # All V9.4 candidates failed conversion. Merge-class authority is
        # read from the SSoT table: a second copy of "which profiles are
        # dangerous" is the ORPHAN-HIGH-728 defect class, and this branch is
        # one of the copies it left behind.
        from ..runtime_profile import ACTION_PERMISSIONS

        if profile in ACTION_PERMISSIONS["pr_merge"]:
            append_tools_governance(
                base_dir, "autonomy_orchestrator_refused",
                {
                    "reason": "v9_4_source_conversion_failed_for_all_candidates",
                    "attempted": attempted,
                },
                bypass_profile_gate=True,
            )
            raise GovernanceError(
                f"v9_4_source_conversion_failed_for_all_candidates: "
                f"{attempted} attempted"
            )
        # Proposal-class authority: soft-fall to V7 git_diff (preserves V8
        # behaviour), DECLARED so the substitution is auditable and visible
        # to the reviewer of the PR this cycle may open.
        append_tools_governance(
            base_dir, "plan_source_v7_fallback_engaged",
            {
                "cycle_id": cycle_id,
                "profile": profile,
                "attempted": attempted,
                "reason": "v9_4_source_conversion_failed_for_all_candidates",
            },
        )
        return self._fallback.synthesize(
            cycle_id=cycle_id,
            workspace_root=workspace_root,
            base_dir=base_dir,
            profile=profile,
        )


def envelope_from_plan_content(
    plan_content: Mapping[str, Any] | None,
    *,
    pressure_source_type: str | None = None,
) -> CyclePlanEnvelope | None:
    """V3.1-A helper — lift a plain plan_content dict into an envelope.

    Used by the V7 fallback adapter that wraps the legacy
    ``synthesize_plan_content_from_cycle`` (which returns a flat dict).
    Sets ``metadata['_pressure_source_type'] = pressure_source_type or
    'git_diff'`` so cost telemetry attribution holds (I-V31-A-07).
    """
    if plan_content is None:
        return None
    metadata: dict[str, Any] = {
        "_pressure_source_type": pressure_source_type or "git_diff",
    }
    return CyclePlanEnvelope(
        content=dict(plan_content), metadata=metadata,
    )


__all__ = [
    "CyclePlanEnvelope",
    "NoOpPlanContentProvider",
    "PlanContentProvider",
    "V7GitDiffProvider",
    "V9PressureSourceProvider",
    "envelope_from_plan_content",
]
