"""One probe for the one fact every history reader in the kernel depends on:
does this checkout hold its whole history?

WHY one module: the twin's churn/co-change layers and the executor's anchor
gate both read git history, and until 2026-09-12 each carried its own copy of
the shallow-clone probe — and the two copies drew opposite conclusions from
the same clone (the twin refused it; the gate softened around it and wrote
its guess as a terminal fact). Two probes is how two readers come to disagree
about one repository. One probe, one answer, and each reader refuses by its
own name so the failure is grep-able end to end.

WHAT: ``is_shallow_checkout`` reads ``git rev-parse --is-shallow-repository``
as a fact, and ``refuse_shallow_checkout`` turns a ``true`` into a
``GovernanceError`` carrying the caller's reason code and the operator's
remedy. Every ARIA lane checks the code repository out with
``fetch-depth: 0`` (pinned by
``tests/invariants/test_kernel_lanes_check_out_full_history.py``), so in
production neither fires; they exist for the clone the lane invariant cannot
reach — an operator clone, a re-shallowed persistent workspace — where the
alternative is a judgement that looks like a fact and is a guess.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .tool_registry import GovernanceError


def is_shallow_checkout(root: Path) -> bool:
    """``git rev-parse --is-shallow-repository`` as a fact, never a guess.

    Only a literal ``true`` counts. A probe that cannot run (no git binary,
    a directory that is not a repository) is not evidence of shallowness
    and is not mistaken for it: the twin's next read, ``git log``, fails by
    its own name (``twin.HISTORY_UNAVAILABLE``), and the anchor gate only
    reaches this probe from a directory ``_anchor_repo_root`` has already
    validated as a repository.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--is-shallow-repository"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return False
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def refuse_shallow_checkout(
    root: Path, *, reason: str, needs: str, observed: bool | None = None,
) -> None:
    """Raise ``GovernanceError`` named ``reason`` when ``root`` is a shallow clone.

    ``reason`` is the caller's stable reason code (the first token of the
    message, what an outcome row or an operator log shows); ``needs`` says
    what the caller reads from history and why a partial clone cannot
    supply it. The remedy is the same for every reader and is stated once.
    ``observed`` is the fact a caller has already read through its own
    bounded probe (the anchor gate's ``GitProbeSession``): the refusal is
    then spelled from that answer and no second git call is made.
    """
    if is_shallow_checkout(root) if observed is None else observed:
        raise GovernanceError(
            f"{reason}: {root} is a shallow clone "
            f"(git rev-parse --is-shallow-repository = true); {needs}. "
            "Fetch the full history (git fetch --unshallow) and run again."
        )


__all__ = ["is_shallow_checkout", "refuse_shallow_checkout"]
