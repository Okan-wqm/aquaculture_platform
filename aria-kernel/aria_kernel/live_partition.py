"""The suite's live-partition declaration — its one owner (ARIA-HIGH-602).

WHY THIS EXISTS. A kernel test module that reads the LIVE checkout outside the
kernel surface declares the module constant ``READS_LIVE_CHECKOUT = "<the live
property it asserts>"``; such modules run in aria-kernel.yml's always-run
``workspace`` job and never in the skippable lanes. Two collectors partition the
suite by that declaration: the unittest shards
(``tests/_helpers/suite_shards.py``) and the pytest plugin
(``aria_kernel.pytest_native_only``). The plugin is production code, which may
not import from ``tests/_helpers`` (test_readiness_merge_eval_static_invariants),
so the declaration and its validation live here and both collectors read them.

Standard library only.
"""

from __future__ import annotations

from types import ModuleType

# The module constant a test module sets to the live property it asserts.
LIVE_DECLARATION = "READS_LIVE_CHECKOUT"


class LiveDeclarationError(ValueError):
    """A module declares ``READS_LIVE_CHECKOUT`` without naming what it reads live."""


def live_declaration(module: ModuleType) -> str | None:
    """The live property ``module`` declares it asserts, or None for a hermetic module.

    The declaration is the reason the module runs in the always-run job: an
    empty or non-text one would move a module out of the shards with nothing
    saying why, so it is refused by name.
    """
    if not hasattr(module, LIVE_DECLARATION):
        return None
    reason = getattr(module, LIVE_DECLARATION)
    if not isinstance(reason, str) or not reason.strip():
        raise LiveDeclarationError(
            f"{module.__name__} declares {LIVE_DECLARATION} without naming the live property it asserts "
            f"(got {reason!r}); set it to that property, or make the module hermetic"
        )
    return reason.strip()


__all__ = ["LIVE_DECLARATION", "LiveDeclarationError", "live_declaration"]
