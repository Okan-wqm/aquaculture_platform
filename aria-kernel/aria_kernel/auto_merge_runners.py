"""Plan ARIA-V3 §A1 — required-injection auto-merge runners.

GAP-2 closure: pre-V3 ``run_autonomy_orchestrator`` accepted
``auto_merge_runner: Callable | None = None`` with a default ``None``
that silently skipped auto-merge. The docstring promised auto-merge
was part of the loop; the default contradicted the promise. V3 makes
the parameter REQUIRED (no ``Optional``, no default) and supplies two
typed runners selected by runtime profile:

* :class:`NoOpAutoMergeRunner` — accepts the call, emits a
  ``skipped`` result row, never invokes ``auto_merge.merge_if_green``.
  Used for ``observe`` / ``standard`` / ``frozen`` profiles where
  auto-merge is structurally not permitted.
* :class:`RealAutoMergeRunner` — wraps ``auto_merge.merge_if_green``.
  Used for ``strict`` (shadow / dry_run=True observation) and
  ``autonomous`` (Phase B2; real merge with dry_run=False on the L3
  snowball lane only).

The factory :func:`select_auto_merge_runner` does the profile →
runner mapping. Adding a new profile requires explicit code change
here + a matching update to ``runtime_profile.PROFILES`` (Plan
ARIA-V3 Phase B2 adds ``autonomous``).

Plan-026R discipline: invariant tests I-V3-01..03 lock the contract.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Protocol

# Plan ARIA-V3 §A1 — supported profiles for auto-merge runner
# selection. ``autonomous`` is Phase B2; the factory currently maps
# it to ``RealAutoMergeRunner`` so B2 only needs to add the profile
# to ``runtime_profile.PROFILES`` and flip dry_run.
_REAL_RUNNER_PROFILES: frozenset[str] = frozenset({"strict", "autonomous"})
_NOOP_RUNNER_PROFILES: frozenset[str] = frozenset({"observe", "standard", "frozen"})


class AutoMergeRunner(Protocol):
    """Plan ARIA-V3 §A1 — call shape consumed by autonomy_orchestrator.

    The orchestrator invokes ``runner(base_dir=..., workspace_root=...)``
    and expects a dict result carrying at minimum ``status`` +
    ``merges_completed``.
    """

    profile: str

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]: ...


class NoOpAutoMergeRunner:
    """Plan ARIA-V3 §A1 — null-object runner for non-permitted profiles.

    Returns a structured ``skipped`` result so the orchestrator's
    counter accumulation stays well-defined (no special-casing of a
    ``None`` runner anywhere in the loop). Audit-visible: the
    governance row carries ``reason`` = ``profile_<name>_does_not_permit_auto_merge``
    so an auditor can reconstruct the profile state from the audit
    chain alone.
    """

    def __init__(self, *, profile: str) -> None:
        self.profile = profile

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "status": "skipped",
            "reason": f"profile_{self.profile}_does_not_permit_auto_merge",
            "merges_completed": 0,
            "candidates_evaluated": 0,
            "profile": self.profile,
        }


class RealAutoMergeRunner:
    """Plan ARIA-V3 §A1 + §B2 — wraps ``auto_merge.merge_if_green``.

    Under ``strict`` profile this runner dispatches to merge_if_green
    with ``dry_run=True`` so the evaluation chain runs (decision
    logged, eligibility checked, audit emitted) but no actual ``gh pr
    merge --squash`` fires. Phase B2 introduces the ``autonomous``
    profile, at which point this runner flips ``dry_run=False`` for
    the L3-snowball lane (and ONLY that lane, via the lane classifier).

    The runner depends on a :class:`GitHubAdapter` factory plumbed
    through from Phase A2. Until A2 lands its factory, this runner
    returns ``no_adapter_configured`` so the orchestrator's loop
    progresses without crashing (Tier-2: missing infrastructure
    surfaces as a structured no-op, not a runtime exception).
    """

    def __init__(
        self,
        *,
        profile: str,
        adapter_factory: Callable[[], Any] | None = None,
        pr_enumerator: Callable[[Any], list[int]] | None = None,
    ) -> None:
        self.profile = profile
        self.adapter_factory = adapter_factory
        self.pr_enumerator = pr_enumerator

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]:
        if self.adapter_factory is None:
            return {
                "schema_version": 1,
                "status": "no_adapter_configured",
                "reason": (
                    "real_auto_merge_runner_requires_github_adapter_factory"
                    " (Plan ARIA-V3 Phase A2 plumbs this through)"
                ),
                "merges_completed": 0,
                "candidates_evaluated": 0,
                "profile": self.profile,
            }
        from .auto_merge import merge_if_green

        adapter = self.adapter_factory()
        candidate_prs = (
            self.pr_enumerator(adapter)
            if self.pr_enumerator is not None
            else []
        )
        # Plan ARIA-V3 §B2 — under ``autonomous`` profile + lane=L3-snowball
        # this MUST be False. Until B2 lands, strict observes (dry_run=True).
        dry_run = self.profile != "autonomous"
        merges_completed = 0
        decisions: list[dict[str, Any]] = []
        for pr_number in candidate_prs:
            decision = merge_if_green(
                adapter=adapter,
                pr_number=pr_number,
                base_dir=base_dir,
                dry_run=dry_run,
            )
            decisions.append(decision)
            if decision.get("decision") == "merged":
                merges_completed += 1
        return {
            "schema_version": 1,
            "status": "ok",
            "merges_completed": merges_completed,
            "candidates_evaluated": len(candidate_prs),
            "decisions": decisions,
            "dry_run": dry_run,
            "profile": self.profile,
        }


def select_auto_merge_runner(
    *,
    profile: str,
    adapter_factory: Callable[[], Any] | None = None,
    pr_enumerator: Callable[[Any], list[int]] | None = None,
) -> AutoMergeRunner:
    """Plan ARIA-V3 §A1 — profile-derived runner factory.

    Adding a new profile to either set requires updating the
    constants at the top of this module AND ``runtime_profile.PROFILES``
    AND the V3 invariant tests I-V3-02 + I-V3-03 (or a new I-V3-XX
    for the new profile). Untyped insertion raises ``ValueError``.
    """
    if profile in _REAL_RUNNER_PROFILES:
        return RealAutoMergeRunner(
            profile=profile,
            adapter_factory=adapter_factory,
            pr_enumerator=pr_enumerator,
        )
    if profile in _NOOP_RUNNER_PROFILES:
        return NoOpAutoMergeRunner(profile=profile)
    raise ValueError(
        f"unknown profile for auto_merge_runner selection: {profile!r}; "
        f"known: {sorted(_REAL_RUNNER_PROFILES | _NOOP_RUNNER_PROFILES)}"
    )


__all__ = [
    "AutoMergeRunner",
    "NoOpAutoMergeRunner",
    "RealAutoMergeRunner",
    "select_auto_merge_runner",
]
