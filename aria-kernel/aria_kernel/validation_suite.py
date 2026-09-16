"""The canonical validation suite — the ONE list every gate reads.

WHY a module of its own. ``implementation_safety`` owned the suite and
imported ``command_policy`` for its Bash allowlist, so the allowlist could
not read the suite back without an import cycle — and it did not: the
policy admitted ``npm run format`` (which WRITES) and a bare ``nx``, while
the suite's executable spelling (``npx nx …``, ``npm run format:check``) was
refused by the very gate the implementer runs under. ARIA-HIGH-104 (2): the
suite lives here, below both modules, and ``command_policy`` DERIVES an
allow rule per executable spelling from it, so the commands an envelope
tells the implementer to run are commands its allowlist admits, by
construction (``tests/test_validation_suite_ssot.py``).

WHAT. :data:`CANONICAL_VALIDATION_COMMANDS` (the declared form),
:func:`executable_spelling` and :data:`CANONICAL_VALIDATION_COMMANDS_EXECUTABLE`
(the form a lane runs), and :func:`canonical_command_satisfied_by` (the one
whole-entry matching rule). ``implementation_safety`` re-exports all four
under the names its importers have always used.
"""
from __future__ import annotations

import re
from typing import Any

# The canonical validation suite an implementation MUST declare.
#
# CLAUDE.md mandates `nx affected --target=test` + `nx affected
# --target=lint` before any commit, and `npm run type-check` is the
# platform-wide type gate. The registry description for this check also
# named "mutation" and "coverage"; this repository has no mutation-
# testing and no coverage target (there is no such npm script and no nx
# target), so requiring them would make the gate permanently
# unsatisfiable and S0 unexitable. Requiring what does not exist is not
# strictness, it is a gate that can only ever be bypassed.
#
# The absence is tracked as ORPHAN-MEDIUM-436 (owner okan, deadline
# 2026-09-06) rather than silently dropped, and the registry description
# is corrected to match what is enforced.
#
# ARIA-HIGH-104 (2) — `npm run format:check` joined the suite. The merge
# gate (`auto_merge._hygiene_battery_result`, ORPHAN-717 operator directive:
# format + typecheck + tests) demanded a verified exit-0 run of it, while
# this tuple — what the plan contract admits, what staging runs as
# baseline, what the implementer is told to run and what the pre-PR-open
# perimeter requires — did not name it. A change that ran exactly the suite
# every contract stated could therefore never merge. This tuple is now the
# ONE list every gate reads; `auto_merge` derives its dimensions from it
# (`canonical_command_satisfied_by` is the shared matching rule), pinned by
# tests/test_validation_suite_ssot.py.
#
# ARIA-HIGH-149 — the format entry is the repository's ENFORCED format gate,
# `node tools/quality/quality.mjs format check-changed` (the managed files
# changed since the base, what `ci-full.yml` runs against the PR base and
# the pre-commit hook runs as `check-staged`), not `npm run format:check`:
# that script is prettier over every `**/*.{ts,tsx,js,jsx,json,md}` in the
# tree, which fails on `main` itself (4,957 unmanaged files on 2026-09-16)
# and is enforced by no workflow. Under `require_worktree_ok` a canonical
# command that fails on the base makes every delivery
# `candidate_validation_not_green`: the first implementation ARIA committed
# (trial eleven, 2026-09-16 21:57Z, seven files, its own suites green)
# was refused at the apply gate on that line alone.
CANONICAL_VALIDATION_COMMANDS: tuple[str, ...] = (
    "nx affected --target=test",
    "nx affected --target=lint",
    "npm run type-check",
    "node tools/quality/quality.mjs format check-changed",
)

# Runner prefixes under which a canonical command is the same invocation.
_CANONICAL_RUNNER_PREFIXES: tuple[str, ...] = ("npx ", "npm exec ")


def canonical_command_satisfied_by(entry: Any, required: str) -> bool:
    """Whether one declared or recorded command IS ``required``.

    ORPHAN-CRITICAL-461 — whole-entry membership, never substring over a
    concatenation: an ``echo`` that mentions the suite is not a run of it. A
    leading ``npx``/``npm exec`` is the same invocation and a trailing
    argument narrows the suite legitimately; anything else is a different
    command. One rule for the pre-PR-open perimeter and the merge gate's
    hygiene battery (ARIA-HIGH-104 (2)), so the two cannot judge the same
    validation run differently.
    """
    collapsed = " ".join(str(entry).split())
    for prefix in _CANONICAL_RUNNER_PREFIXES:
        if collapsed.startswith(prefix):
            collapsed = collapsed[len(prefix):]
            break
    return collapsed == required or collapsed.startswith(required + " ")

# ORPHAN-CRITICAL-727 — the same suite, spelled the way a lane can RUN it.
#
# Two gates read the suite and they disagreed on the spelling. The
# pre-PR-open perimeter accepts the bare `nx ...` form above (or that form
# behind an `npx` prefix); `validation.parse_allowed_command` admits
# `npx nx` and refuses a bare `nx`, because argv-0 is what it pins. A lane
# that staged the perimeter's spelling therefore declared a suite its own
# validation runner would refuse to execute — the change would carry a
# declaration nobody could produce evidence for.
#
# Derived rather than retyped so the two tuples cannot drift: the executable
# form IS the canonical form with the runner prefix the allowlist requires.


def executable_spelling(command: str) -> str:
    """The spelling under which a declared command is RUN.

    One rule, owned here beside the canonical tuple it derives: whitespace
    collapsed, and the bare ``nx`` form the plan synthesizer emits given the
    ``npx`` prefix ``parse_allowed_command`` pins argv-0 on. Staging
    (``apply_engine``) and the plan contract (``plan_contract``) both read a
    plan's ``validation_commands`` through this function, so the two cannot
    disagree about whether a spelling is the canonical suite.
    """
    collapsed = " ".join(str(command).split())
    return f"npx {collapsed}" if collapsed.startswith("nx ") else collapsed


CANONICAL_VALIDATION_COMMANDS_EXECUTABLE: tuple[str, ...] = tuple(
    executable_spelling(command) for command in CANONICAL_VALIDATION_COMMANDS
)


# The shape of the Bash allow rule ``command_policy`` derives for one
# executable spelling: that exact invocation, optionally narrowed by
# trailing arguments (``--projects=farm-service``), nothing else — the same
# admission ``canonical_command_satisfied_by`` grants a recorded run. The
# pattern is rendered here, beside the suite it admits, so the policy cannot
# spell the suite a second way.
_TRAILING_ARGUMENTS = r"(\s+\S+)*\s*$"


def bash_allow_pattern_for(spelling: str) -> str:
    """The anchored regex admitting ``spelling`` and its narrowed forms."""
    return "^" + r"\s+".join(re.escape(token) for token in spelling.split()) + _TRAILING_ARGUMENTS


__all__ = [
    "CANONICAL_VALIDATION_COMMANDS",
    "CANONICAL_VALIDATION_COMMANDS_EXECUTABLE",
    "bash_allow_pattern_for",
    "canonical_command_satisfied_by",
    "executable_spelling",
]
