"""ARIA-HIGH-138 — the lane half of the seam contract: a marked test skips only off the lane.

WHY. A real-process seam test that skips on a missing host capability is
green without proving the seam — exactly the HIGH-117/123/124/MEDIUM-134
class that ARIA-HIGH-138 made structural. The registry half of the contract
lives in ``tests/invariants/seam_registry.py`` (which seams exist, which
real-process test proves each one); this helper is the one way a test marked
``REAL_PROCESS_SEAMS`` yields to a missing host capability. Off the kernel
lane it skips (a laptop without ``ssh-agent`` should not fail); with
``ARIA_REQUIRE_REAL_SEAMS=1`` — set on the aria-kernel CI jobs, whose
``ensure-sandbox-backend`` step has provisioned the host — the same
condition FAILS, so a green lane is never a skipped lane.

Sandbox-backend skips are NOT owned here: ``tests/_helpers/sandbox_pins.py``
already refuses those on the lane (ARIA-MEDIUM-130, via the shard runner and
``suite_shards verify``), and this helper must not become a second owner of
that rule. Use it for host capabilities the sandbox backend does not
provision (ssh tooling, a non-loopback route, a provider CLI).
"""
from __future__ import annotations

import os
import unittest

REQUIRE_REAL_SEAMS_ENV = "ARIA_REQUIRE_REAL_SEAMS"


def require_host_capability(test: unittest.TestCase, capability: str, present: bool) -> None:
    """Yield to a missing host capability: skip off the lane, fail on it.

    ``present`` is the caller's probe of the capability (a ``shutil.which``
    check, a route lookup). On the lane (``ARIA_REQUIRE_REAL_SEAMS=1``) a
    missing capability fails the test by name instead of skipping it.
    """
    if present:
        return
    if os.environ.get(REQUIRE_REAL_SEAMS_ENV) == "1":
        test.fail(
            f"real-process seam required on this lane, but the host lacks {capability} "
            f"({REQUIRE_REAL_SEAMS_ENV}=1)"
        )
    test.skipTest(f"host capability missing; the real-process seam runs only where it exists: {capability}")


__all__ = ["REQUIRE_REAL_SEAMS_ENV", "require_host_capability"]
