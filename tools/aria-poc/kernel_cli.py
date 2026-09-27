"""The ONE spelling of a kernel CLI subprocess an ARIA executor runs.

WHY this module exists (ARIA-HIGH-124, round 2)
----------------------------------------------
Every kernel command an executor runs after the spawn — the human-required
record, the claim release, the result submit — inherits the process cwd,
which in the drain's lane is the REQUEST WORKTREE the agent just wrote to.
``python -m`` puts that cwd FIRST on ``sys.path``, ahead of ``PYTHONPATH``,
so an ``aria_kernel/__main__.py`` (or a ``json.py``) the agent planted at
its worktree root — one Write call; the hook admits any workspace path
outside READONLY_PATHS — ran AS the executor's ``human-required record``
and ``agent release``, with the lease token, GH_TOKEN and the store binding
in its environment, outside the sandbox (reproduced under real bwrap by the
round-1 verifier). The CONTRACTS.md claim that kernel authority is
exercised outside the agent's sandbox was untrue: the executor's kernel CLI
could be the agent's code.

WHAT it does
------------
``kernel_cli_argv`` spells the interpreter (this process's own, never a
PATH lookup), ``-P`` (``PYTHONSAFEPATH``, Python 3.11+: the cwd and the
script directory stay OFF ``sys.path``), then ``-m aria_kernel`` and the
command. The kernel package resolves from the ``PYTHONPATH`` the caller
sets — the code root — and from nowhere else. Every executor
(``ci_executor``, ``ci_executor_drain``, ``worker_executor``) imports this
one function; a kernel argv spelled anywhere else is refused by
``tests/test_executor_kernel_cli_argv.py``.
"""
from __future__ import annotations

import sys

# The interpreter flags every kernel subprocess carries. `-P` is the whole
# point; it is a tuple so the pin (and a reader) sees the flag by name.
KERNEL_CLI_INTERPRETER_FLAGS: tuple[str, ...] = ("-P",)
KERNEL_CLI_MODULE = "aria_kernel"


def kernel_cli_argv(*command: str) -> list[str]:
    """``[<this interpreter>, -P, -m, aria_kernel, *command]``."""
    return [sys.executable, *KERNEL_CLI_INTERPRETER_FLAGS, "-m", KERNEL_CLI_MODULE, *command]


__all__ = ["KERNEL_CLI_INTERPRETER_FLAGS", "KERNEL_CLI_MODULE", "kernel_cli_argv"]
