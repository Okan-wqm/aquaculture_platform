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
    "envelope_from_plan_content",
]
