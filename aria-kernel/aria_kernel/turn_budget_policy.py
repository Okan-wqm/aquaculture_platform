"""implementer_turn_budget — the implementer turn cap as operator policy.

WHY: the seventh pre-merge predicate (``cycle_and_turn_budget_cap``, policy
§14) bounds an implementer request to N budgeted Edit/Write/Bash turns, and N
was the literal ``turn_budget.IMPLEMENTER_TURN_BUDGET = 10``. Every Edit call
is one turn and every test run is one Bash turn, so a root-cause
implementation of the kind this repository demands spends 20–40 turns: at 10
the cap was a wall, not a cap. The number is a POLICY decision (operator
decision 2026-09-12: the cap exists to stop a runaway loop — perf CRIT-001 /
ai HIGH-013 — while the run's wall clock, the job deadline, is the real
budget under the managed-subscription policy), and a policy value belongs in
``genesis_policy`` where the operator can read and override it, the way
ARIA-MEDIUM-082 moved the source-qualification deadline there.

WHAT this module owns:

* the block's defaults (``budgeted_turns`` = 60) and its ceiling,
  :data:`IMPLEMENTER_TURN_BUDGET_MAX_TURNS`;
* the typed accessor :func:`implementer_turn_budget_policy` — the accessor is
  what makes the block real configuration (a key absent from
  ``genesis_policy.POLICY_KEYS`` is dropped by the merge; a block nobody reads
  is dead JSON) — with ONE validation gate over the block's SHAPE and its
  VALUE: the block is an object whose configuration keys are exactly the
  ones this module knows, and ``budgeted_turns`` is a positive whole number
  of turns at most the ceiling. Anything else is refused with the offending
  key or number and the bound named (RC-4 discipline: silently correcting an
  operator's number — or silently running on the default because their key
  was misspelled or their block was a bare number — teaches them something
  false about their own system). Keys starting with ``_`` (``_doc`` in the
  shipped default, ``_comment`` in the operator template) are prose for the
  operator, the convention both policy files already follow, and are never
  configuration;
* :func:`implementer_turn_budget_for_store` — which workspace's policy binds
  a spawn or a merge. ``tool_registry.bound_workspace_root`` owns that
  question (ARIA-HIGH-079): the store records the workspace it is bound to,
  and a legacy store's parent is its workspace. The store is a REQUIRED
  argument: the cap is never read for "the current process" — not from the
  cwd, not from ``ARIA_TOOLS_DIR`` — because the spawn and the merge each
  name the store they act on, and a cap read for any other store is the
  ARIA-HIGH-079 class. Every reader of the cap goes through this function,
  so the settings the executor compiles, the cap the sandboxed hook receives
  through ``--turn-budget``, and the value the pre-merge evidence is
  compared against are one policy read.

The default file ``aria_kernel/data/genesis_policy_default.json`` carries the
block; ``<workspace>/aria-config/genesis_policy.json`` overrides it.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .genesis_policy import default_policy, load_policy
from .plan_convergence import MAX_AFFECTED_PATHS

POLICY_BLOCK: str = "implementer_turn_budget"
# Both policy files annotate every block with prose under an underscore-
# prefixed key (``_doc`` in genesis_policy_default.json, ``_comment`` in
# aria-config/genesis_policy.json.template). Such keys are for the operator's
# eyes and are never configuration, so the unknown-key refusal below does
# not read them; every other key must be one this module knows.
ANNOTATION_KEY_PREFIX: str = "_"
IMPLEMENTER_TURN_BUDGET_DEFAULTS: dict[str, Any] = {
    # 60: the operator decision of 2026-09-12. A root-cause implementation
    # spends 20–40 turns (one Edit per change, one Bash per test run, a few
    # for git); 60 leaves headroom for a wide plan while a loop that re-edits
    # and re-runs the same test is still stopped between turns.
    "budgeted_turns": 60,
}
# The ceiling keeps the cap a CAP: a policy cannot switch it off by writing a
# number no run could reach. It is derived from the widest plan the kernel
# converges — ``plan_convergence.MAX_AFFECTED_PATHS`` — as one Edit and one
# validating Bash turn per affected path: no admissible plan can argue for
# more turns than that from its own size, and past it the turn count stops
# binding before the job's wall clock does, which is the failure mode the cap
# exists to prevent (a runaway loop of cheap turns that the clock alone would
# let run for the whole job).
IMPLEMENTER_TURN_BUDGET_MAX_TURNS: int = 2 * MAX_AFFECTED_PATHS


def implementer_turn_budget_policy(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Typed accessor for the ``implementer_turn_budget`` block.

    ``budgeted_turns`` is returned as an int. The policy merge is shallow per
    block, so an operator block that omits the key takes the default. A
    block that is not an object, a configuration key this module does not
    know (a misspelled ``budgeted_turns`` would otherwise run on the default
    and tell the operator nothing — the circuit_breaker renamed-key
    precedent), and a non-integer, non-positive or above-ceiling value are
    each REFUSED with the key or the value and the bound named: the operator
    learns the contract from the error itself, never from a silently
    corrected number or a silently ignored key.
    """
    merged = load_policy(repo_root) if repo_root is not None else default_policy()
    block = dict(IMPLEMENTER_TURN_BUDGET_DEFAULTS)
    if POLICY_BLOCK in merged:
        raw_block = _validated_block_shape(merged[POLICY_BLOCK])
        block.update({k: raw_block[k] for k in IMPLEMENTER_TURN_BUDGET_DEFAULTS if k in raw_block})
    block["budgeted_turns"] = _validated_budgeted_turns(block["budgeted_turns"])
    return block


def _validated_block_shape(raw_block: Any) -> dict[str, Any]:
    """One gate for the block's shape: an object whose configuration keys are the known ones."""
    from .tool_registry import GovernanceError

    known = ", ".join(sorted(IMPLEMENTER_TURN_BUDGET_DEFAULTS))
    if not isinstance(raw_block, dict):
        # ``"implementer_turn_budget": 30`` is the number the operator meant
        # to write under ``budgeted_turns``; running on 60 instead would tell
        # them their cap is 30 while the hook admits 60.
        raise GovernanceError(
            f"genesis_policy_implementer_turn_budget_block_not_an_object: {POLICY_BLOCK}={raw_block!r}. "
            f"Write an object with the key(s) {known}, e.g. "
            f'{{"{POLICY_BLOCK}": {{"budgeted_turns": {IMPLEMENTER_TURN_BUDGET_DEFAULTS["budgeted_turns"]}}}}}.'
        )
    unknown = sorted(
        str(key) for key in raw_block
        if key not in IMPLEMENTER_TURN_BUDGET_DEFAULTS and not str(key).startswith(ANNOTATION_KEY_PREFIX)
    )
    if unknown:
        raise GovernanceError(
            f"genesis_policy_implementer_turn_budget_unknown_key: {', '.join(unknown)}. "
            f"The {POLICY_BLOCK} block knows only {known}; a value under any other key is NOT "
            "applied, so the cap would silently run on the default. Rename or remove the key in "
            f"your genesis_policy.json override (keys starting with {ANNOTATION_KEY_PREFIX!r} are "
            "annotations for the operator and are not read)."
        )
    return raw_block


def _validated_budgeted_turns(raw: Any) -> int:
    """One gate for the cap: a whole number of turns in [1, ceiling]."""
    from .tool_registry import GovernanceError

    contract = (
        f"Write a whole number of turns between 1 and {IMPLEMENTER_TURN_BUDGET_MAX_TURNS}."
    )
    # bool is an int subclass; ``true`` is not a number of turns. A float is
    # not one either — turns are counted, and 60.0 in a policy file is a
    # category error the operator should see, not a value to round.
    if isinstance(raw, bool) or type(raw) is not int:
        raise GovernanceError(
            f"genesis_policy_implementer_turn_budget_not_an_integer: budgeted_turns={raw!r}. {contract}"
        )
    if raw < 1:
        # A cap of zero refuses an implementer's FIRST turn: that switches
        # implementers off, it does not budget them. Stopping write-capable
        # spawns is the runtime profile's and the executor's decision, never
        # a budget of nothing.
        raise GovernanceError(
            f"genesis_policy_implementer_turn_budget_not_positive: budgeted_turns={raw!r}. "
            f"A cap below 1 refuses every implementation before its first turn. {contract}"
        )
    if raw > IMPLEMENTER_TURN_BUDGET_MAX_TURNS:
        raise GovernanceError(
            f"genesis_policy_implementer_turn_budget_above_ceiling: budgeted_turns={raw!r} exceeds "
            f"{IMPLEMENTER_TURN_BUDGET_MAX_TURNS} (one Edit and one validating Bash turn per affected "
            f"path of the widest plan the kernel converges, MAX_AFFECTED_PATHS={MAX_AFFECTED_PATHS}). "
            "The ceiling keeps the cap a cap; lower the value to at most the ceiling."
        )
    return raw


def implementer_turn_budget_for_store(base_dir: str | os.PathLike[str]) -> int:
    """The cap that binds a spawn or a merge whose store is at ``base_dir``.

    The policy is the one of the workspace the store is BOUND to
    (``tool_registry.bound_workspace_root``): a bound store names it in
    ``repo_identity.json``, a legacy store's parent is its workspace. Reading
    the cap any other way — from the process cwd, from the kernel default, or
    from a workspace the store is not bound to — is how trial eight read the
    shipped cost caps for a workspace whose own policy said otherwise
    (ARIA-HIGH-079). ``base_dir`` is therefore required and never ``None``:
    ``tools_dir(None)`` resolves through ``ARIA_TOOLS_DIR`` and a walk up
    from the cwd, which is a store the CALLER did not name, so an explicit
    ``None`` is refused here instead of resolved. Raises ``GovernanceError``
    on an invalid policy: a spawn is not budgeted under a number the policy
    refuses, and a merge names it.
    """
    from .tool_registry import GovernanceError, bound_workspace_root

    if base_dir is None:
        raise GovernanceError(
            "implementer_turn_budget_store_unnamed: the implementer turn cap is read for the "
            "store a spawn journals into or a merge judges, never for the process cwd or "
            "ARIA_TOOLS_DIR. Pass that store's directory."
        )
    return int(implementer_turn_budget_policy(bound_workspace_root(base_dir))["budgeted_turns"])


__all__ = [
    "ANNOTATION_KEY_PREFIX",
    "IMPLEMENTER_TURN_BUDGET_DEFAULTS",
    "IMPLEMENTER_TURN_BUDGET_MAX_TURNS",
    "POLICY_BLOCK",
    "implementer_turn_budget_for_store",
    "implementer_turn_budget_policy",
]
