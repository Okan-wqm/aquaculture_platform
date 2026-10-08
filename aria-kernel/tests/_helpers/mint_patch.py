"""One way to stand in for the request mint around ``autonomy_orchestrator._drain_next_cycle_queue``.

WHY (re-review of PR #1863). Four suites patched
``aria_kernel.agent_invocations.create_agent_invocation_request`` and then
ran the drain. The drain lazily imports ``convergence_drainer``, which imports
``cross_review_bridge`` and ``convergent_planning_bridge``; both bind
``create_agent_invocation_request`` BY NAME at import. When the first import of
that graph in a process happened inside the patch, both modules kept the fake
for the rest of the process. Every later suite that minted through them (the
implementation-delivery suite's ``production_implementation_request``) got the
fake's ``AIR-x`` and died ``unknown request_id: AIR-x`` — 15 failures, in
whichever order put a drain suite first, on main as well as on the branch.

``patched_mint`` imports that graph BEFORE patching, so nothing first-binds
the fake, and on exit it fails the test that leaked if any ``aria_kernel``
module still holds the fake: a new lazy import that captures it is caught by
the suite that caused it, not by an unrelated suite later in the run.
"""
from __future__ import annotations

import importlib
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

MINT_TARGET = "aria_kernel.agent_invocations.create_agent_invocation_request"

# Modules the drain imports lazily that bind the mint by name at import time.
DRAIN_IMPORT_GRAPH: tuple[str, ...] = (
    "aria_kernel.autonomy_orchestrator",
    "aria_kernel.convergence_drainer",
)


def modules_holding(fake: object) -> list[str]:
    """Every loaded ``aria_kernel`` module that has ``fake`` bound to a global."""
    return sorted(
        name for name, module in list(sys.modules.items())
        if name.startswith("aria_kernel") and module is not None
        and any(value is fake for value in vars(module).values())
    )


@contextmanager
def patched_mint(fake: Callable[..., Any] | None = None) -> Iterator[Any]:
    """Patch the mint at its source for the block; yield the stand-in."""
    for module in DRAIN_IMPORT_GRAPH:
        importlib.import_module(module)
    stand_in = fake if fake is not None else MagicMock(name="create_agent_invocation_request")
    with patch(MINT_TARGET, stand_in):
        yield stand_in
    leaked = modules_holding(stand_in)
    if leaked:
        raise AssertionError(
            f"the patched mint leaked into {leaked}: a module first imported inside the patch "
            "bound it by name; add it to DRAIN_IMPORT_GRAPH"
        )
