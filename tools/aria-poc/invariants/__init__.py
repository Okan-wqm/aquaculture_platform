"""Plan ARIA-V2 §3.6 + ORPHAN-MEDIUM-075 — invariant tests for the
ARIA Phase-1 PoC.

Subpackage NAME chosen as ``invariants/`` rather than ``tests/`` so it
cannot shadow the kernel's ``aria-kernel/tests/`` package on the
``sys.path`` of spawn'd subprocesses. Pre-existing kernel tests
(``test_outbox_cqrs_adapters.py``, ``test_agent_harness_security.py``)
insert ``tools/aria-poc/`` at ``sys.path[0]`` at module-import time,
which multiprocessing.spawn captures and replays in children. Had
this subpackage been named ``tests`` it would have shadowed the
kernel's tests package in child interpreters, causing
``ModuleNotFoundError`` on the kernel's own test modules. Plan-026R
discipline: load-bearing invariant tests stay visible AND uniquely
named.

CI dispatches ``unittest discover tools/aria-poc/invariants``
independently of the kernel suite (aria-kernel.yml; aria-kernel-fast.yml
carries the PR-early copy of the same dispatch).
"""
