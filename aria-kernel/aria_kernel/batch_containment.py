"""One bad item costs that item, never the batch.

ORPHAN-HIGH-575 measured what the alternative costs. ``plan_downstream_impact``
raised ``TypeError`` on this repository's most ordinary commit shape — code plus
its own review document — and ``learning._impact_graph_compute`` contained only
``GovernanceError``. The exception escaped the loop over EVERY pending dispatch
and surfaced upstream as one generic ``learning_hook_failed``: a single pressure
event disabled impact-graph computation for the whole cycle, under a name
identifying neither the item that failed nor the stage it failed in.

Fixing that ``TypeError`` removed the instance. This module removes the
amplifier, and it lives here rather than in ``learning`` because the shape was
measured across TWELVE of the sixteen cycle learning hooks, in seven modules —
``learning`` imports six of them, so the primitive cannot live in the module
that consumes them.

THE SHAPE, stated once so it is recognisable on sight. A hook iterates items and
commits as it goes: a ledger row, a governance event, an archived file. Item k
raises. Items 1..k-1 are already on disk; items k+1..n never run; and the hook's
entire report is replaced by one wholesale failure. The writes happened and
nothing says so — worse than either clean outcome, because a partial state is
now indistinguishable from a total failure.

WHAT IS DELIBERATELY NOT CONTAINED. ``LedgerIntegrityError`` is re-raised. A
corrupt ledger is not one item's problem; ``learning._run_learning_hooks``
re-raises it so the cycle aborts, and containing it here would silently demote
the one failure the cycle must stop for into a line in a report.

WHAT THIS DOES NOT PREVENT, stated so a clean report is not read as more than it
is. This makes containment the zero-effort default; it does not make a bare loop
impossible. A hook written tomorrow can still commit inside an unguarded loop and
inherit the old blast radius — which is why
``aria-kernel/tests/test_batch_containment_gate.py`` fails on exactly that, with
declared waivers for the loops where fail-fast is the deliberate choice.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from .ledger import LedgerIntegrityError

_ItemResult = TypeVar("_ItemResult")

# How many failed items a single governance event carries. The hook's own
# payload keeps every failure; only the audit row is sampled, so one
# pathological cycle cannot flood the workspace governance ledger.
BATCH_FAILURE_SAMPLE_CAP = 20


def guard_item(
    failures: list[dict[str, Any]],
    *,
    item_kind: str,
    item_id: str,
    work: Callable[[], _ItemResult],
) -> tuple[bool, _ItemResult | None]:
    """Run one item's work, recording a failure instead of losing the batch.

    The ``(ok, value)`` pair exists so a legitimate ``None`` result can never be
    read as a failure. Returning a bare ``None`` would work for today's callers
    and rot the first time a hook's work returns nothing on purpose.
    """
    try:
        return True, work()
    except LedgerIntegrityError:
        raise
    except Exception as exc:
        failures.append(
            {
                "item_kind": item_kind,
                "item_id": item_id,
                "error_class": exc.__class__.__name__,
                "error_message": str(exc),
            },
        )
        return False, None


def with_item_failures(payload: dict[str, Any], failures: list[dict[str, Any]]) -> dict[str, Any]:
    """Attach failure accounting to a hook payload, and only when there is any.

    An always-present empty list would make ``partial`` meaningless upstream:
    every healthy cycle would carry the field, so its presence would stop being
    a signal. Absence means the batch lost nothing.
    """
    if failures:
        payload["item_failures"] = failures
    return payload


__all__ = ["BATCH_FAILURE_SAMPLE_CAP", "guard_item", "with_item_failures"]
