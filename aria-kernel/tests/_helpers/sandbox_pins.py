"""The one way a test needs the real sandbox, and the one name its skip carries (ARIA-MEDIUM-130).

WHY. A real-sandbox pin (the git containment, the executor identity, the
egress boundary, the rooms) skips on a host whose bwrap cannot confine, and a
skipped test is green. The kernel lane proves and provisions the backend
before its suite runs (``.github/actions/ensure-sandbox-backend``), so on that
lane a skipped pin is a containment proof that did not run. Each such skip
raises here, with ``suite_shards.SANDBOX_SKIP_MARKER`` first in its reason; the
shard runner lists those skips in its report and ``suite_shards verify``
refuses a run that has any. ``tests/test_suite_shards.py`` refuses a sandbox
skip whose reason is spelled anywhere but here.

Off the lane (a laptop, a host without user namespaces) the pins still skip,
which is the sandbox's own fail-closed contract: it refuses rather than
degrading.
"""

from __future__ import annotations

import shutil
import unittest
from typing import NoReturn

from tests._helpers.suite_shards import SANDBOX_SKIP_MARKER


def skip_sandbox_pin(detail: str) -> NoReturn:
    """Skip the running test as a real-sandbox pin this host cannot run."""
    raise unittest.SkipTest(f"{SANDBOX_SKIP_MARKER}: {detail}")


def require_sandbox_backend(*, fresh_probe: bool = False) -> None:
    """Skip unless ``sandbox_backend()`` verifies a backend (namespaces and git containment).

    ``fresh_probe`` drops the cached verdict first, for a caller that runs
    after tests which patch the probe's collaborators.
    """
    from aria_kernel import implementation_safety as impl

    if fresh_probe:
        impl._bwrap_available.cache_clear()
    if impl.sandbox_backend() is None:
        skip_sandbox_pin(f"no verified sandbox backend on this host: {impl.sandbox_unavailable_detail()}")


def require_bwrap_namespaces() -> None:
    """Skip unless bwrap builds the namespaces the wrapper uses.

    For the tests of the containment probe itself, which must run whether or
    not that probe passes on this host.
    """
    from aria_kernel import implementation_safety as impl

    if not impl._sandbox_probe_succeeds(impl._bwrap_probe_argv()):
        skip_sandbox_pin("bwrap cannot build its namespaces on this host")


def require_bwrap_installed() -> str:
    """The ``bwrap`` executable PATH resolves; skip when there is none."""
    found = shutil.which("bwrap")
    if found is None:
        skip_sandbox_pin("bwrap is not installed on this host")
    return found
