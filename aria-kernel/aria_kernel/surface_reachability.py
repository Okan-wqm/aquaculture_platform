"""Which members of ARIA's closed vocabularies anything actually writes.

`control_reachability` closed half of a defect class: a control that is
correct, tested, exported — and called by nobody. This module closes the
other half, which cost this programme roughly nineteen defects in a single
session under four different names:

    writer with no reader      a surface written that nothing loads
    reader with no writer      a field read that nothing populates
    unsatisfiable predicate    a refusal branch no production input can reach
    unread tunable             a policy key nothing consults

Underneath the four names sits one shape: **a closed set declares a member,
the kernel validates it, the tests exercise it, and no production path ever
produces it.** ORPHAN-HIGH-577 is the canonical instance —
`enforce_separation_of_duties` runs on every agent submit and can never
refuse, because the field its refusal reads has no writer. `control_
reachability`'s docstring names that gap explicitly and declines to guess at
it; this module is the part that can be measured without guessing.

WHAT IS ENUMERATED, and why these four sets. A surface qualifies when it is
(a) a closed set of string members declared in one place, and (b) written
through one named function whose argument carries the member. That pair is
what makes the question decidable — without (b) there is no argument to walk
backwards from, and the check degenerates into grepping for common words.
The four surfaces below satisfy both; sets that do not are deliberately
absent rather than approximated.

The member lists are IMPORTED from the modules that declare them, never
copied here. ORPHAN-HIGH-569 was a hardcoded roster that was true when it was
written and silently stopped describing the repo; a gate against dead
declarations must not carry its own.

WHAT COUNTS AS A WRITE. A production callsite of the writer function whose
member-carrying argument statically resolves to that member — see
`literal_provenance` for the walk and for why an unresolvable argument proves
nothing. The consequence worth stating plainly: `cli.py` can mint an agent
request with any `--role` the operator types, and this gate does not let that
passthrough vouch for a single role. It is the reason a role with no
programmatic minter is visible here at all.

WHAT THIS DOES NOT MEASURE. That a written member is ever written *at
runtime*. A branch guarded by a config flag nobody enables still counts as
written. This gate raises the floor from "declared" to "producible by some
production path"; it does not reach "produced".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .agent_surface import INVOCATION_ROLES
from .genesis_lifecycle import GENESIS_LIFECYCLE_STATES
from .literal_provenance import ProductionIndex, literals_reaching
from .plan_convergence import EVENT_TYPES
from .pressure import SOURCE_WEIGHTS
from .tool_registry import TOOL_STATUSES


@dataclass(frozen=True)
class WriterBinding:
    """A function whose ``field`` argument carries a surface member.

    ``position`` is required whenever the kernel calls the writer positionally
    — ``transition_tool(tool_id, target_status, ...)`` passes the member as
    argument 1, and a keyword-only lookup finds nothing and silently reports
    the whole tool lifecycle as dead.
    """

    function: str
    field: str
    position: int | None = None


@dataclass(frozen=True)
class DeclaredSurface:
    surface_id: str
    declared_in: str
    members: tuple[str, ...]
    writers: tuple[WriterBinding, ...]
    why: str


# The refusal arm of the genesis ladder is not a forward transition:
# ALLOWED_TRANSITIONS lets almost every state reject, so demanding a distinct
# producer for that edge would measure error handling rather than progress —
# and the defect being hunted is a FORWARD rung no path can climb.
#
# Deliberately NOT applied to the tool lifecycle: QUARANTINED and ARCHIVED are
# ordinary transition targets there, driven by quarantine.py and
# tool_health.py, and excluding them would hide a real gap behind a word.
_GENESIS_REFUSAL_STATE = "REJECTED"


def declared_surfaces() -> tuple[DeclaredSurface, ...]:
    """The enumerable write-surfaces, built from the live declarations."""
    return (
        DeclaredSurface(
            surface_id="genesis_lifecycle_forward_transition",
            declared_in="aria_kernel/genesis_lifecycle.py",
            members=tuple(sorted(set(GENESIS_LIFECYCLE_STATES) - {_GENESIS_REFUSAL_STATE})),
            writers=(WriterBinding("record_transition", "to_state"),),
            why=(
                "A genesis state with no producer is a promotion rung the "
                "ladder cannot reach: validate_transition guards it, the "
                "tests drive it directly, and no agent ever arrives there."
            ),
        ),
        DeclaredSurface(
            surface_id="plan_convergence_event_type",
            declared_in="aria_kernel/plan_convergence.py",
            members=tuple(sorted(EVENT_TYPES)),
            writers=(WriterBinding("_append_event", "event_type"),),
            why=(
                "EVENT_TYPES is documented as a one-way door — every row is "
                "content-hashed, so a kind cannot be renamed later. An event "
                "type with a validator arm and no emitter is dead weight "
                "behind a door that cannot be reopened."
            ),
        ),
        DeclaredSurface(
            surface_id="tool_registry_status",
            declared_in="aria_kernel/tool_registry.py",
            members=tuple(sorted(TOOL_STATUSES)),
            writers=(WriterBinding("transition_tool", "target_status", position=1),),
            why=(
                "The tool lifecycle is the autonomy ladder's spine. A status "
                "nothing transitions into is a rung that exists only in the "
                "promotion matrix. `transition_tool` is the sole audited "
                "writer by construction — `_update_tool_internal` refuses a "
                "bare status change and tells the caller to route here."
            ),
        ),
        DeclaredSurface(
            surface_id="pressure_source",
            declared_in="aria_kernel/pressure.py",
            members=tuple(sorted(SOURCE_WEIGHTS)),
            writers=(WriterBinding("_pressure", "source"),),
            why=(
                "ORPHAN-CRITICAL-733 was a source in SOURCE_WEIGHTS but not "
                "DRIFT_CLASS_BY_SOURCE, and it killed a cycle. The parity "
                "test that followed pins the two tables to EACH OTHER; "
                "neither is pinned to the producers. This surface binds the "
                "vocabulary to the code that emits it — in BOTH directions, "
                "which is the direction that outage actually came from."
            ),
        ),
        DeclaredSurface(
            surface_id="agent_surface_request_role",
            declared_in="aria_kernel/agent_surface.py",
            # INVOCATION_ROLES, not REQUEST_ROLES. The writer bound below is
            # governed by `agent_invocations.ROLES`, which IS
            # INVOCATION_ROLES (`role not in ROLES` -> GovernanceError), and
            # that set is `{*REQUEST_ROLES, "specialist_domain_review"}`.
            # Binding the narrower vocabulary made the surface describe a
            # rule the writer does not obey — invisible while only the
            # forward direction ran, and the first thing
            # `undeclared_written_members` reported when it did.
            members=tuple(sorted(INVOCATION_ROLES)),
            writers=(WriterBinding("create_agent_invocation_request", "role"),),
            why=(
                "ORPHAN-MEDIUM-571/572 were exactly this: a request "
                "vocabulary nothing consults. A role in REQUEST_ROLES with no "
                "programmatic minter passes every validator and is never "
                "asked for."
            ),
        ),
    )


def written_members(surface: DeclaredSurface, index: ProductionIndex) -> dict[str, list[str]]:
    """Members some production path can produce, with ``path:line`` evidence."""
    evidence: dict[str, list[str]] = {}
    for writer in surface.writers:
        for member, locations in literals_reaching(
            index, function_name=writer.function, field=writer.field, position=writer.position
        ).items():
            if member in surface.members:
                evidence.setdefault(member, []).extend(locations)
    return evidence


def undeclared_written_members(
    surface: DeclaredSurface, index: ProductionIndex,
) -> dict[str, list[str]]:
    """Literals a production writer emits that the vocabulary does NOT declare.

    The inverse of `written_members`, and the direction every defence in this
    file was missing. `written_members` already resolves every literal
    reaching a writer's field and then drops the unrecognised ones one line
    before they could be reported — so a producer emitting a value no
    registry knows was, until this function existed, structurally invisible
    to the gate that exists to catch exactly that.

    That is not a hypothetical. ORPHAN-CRITICAL-733 (a cycle killed by an
    unregistered pressure source) was this direction, and the defences built
    afterwards — a boundary raise, a parity test between the two tables, this
    reachability gate — all answer "is a DECLARED member reachable?". None
    answered "is a WRITTEN value declared?", and a second instance
    (`post_merge_ci`, pressure.py) was sitting in the tree while they passed.
    """
    undeclared: dict[str, list[str]] = {}
    for writer in surface.writers:
        for member, locations in literals_reaching(
            index, function_name=writer.function, field=writer.field, position=writer.position
        ).items():
            if member not in surface.members:
                undeclared.setdefault(member, []).extend(locations)
    return undeclared


def unwritten_members(surface: DeclaredSurface, index: ProductionIndex) -> tuple[str, ...]:
    written = written_members(surface, index)
    return tuple(member for member in surface.members if member not in written)


def survey(repo_root: str | Any) -> dict[str, dict[str, Any]]:
    """Every surface's written/unwritten split in one pass over the repo."""
    index = ProductionIndex(repo_root)
    report: dict[str, dict[str, Any]] = {}
    for surface in declared_surfaces():
        written = written_members(surface, index)
        report[surface.surface_id] = {
            "declared_in": surface.declared_in,
            "members": surface.members,
            "written": written,
            "unwritten": tuple(m for m in surface.members if m not in written),
            "writers": tuple(f"{w.function}({w.field}=)" for w in surface.writers),
        }
    return report


__all__ = [
    "DeclaredSurface",
    "WriterBinding",
    "declared_surfaces",
    "survey",
    "unwritten_members",
    "written_members",
]
