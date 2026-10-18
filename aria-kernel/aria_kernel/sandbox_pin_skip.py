"""The one name a skipped real-sandbox pin carries (ARIA-MEDIUM-130, ARIA-LOW-599).

A real-sandbox pin (the git containment, the executor identity, the egress
boundary, the rooms) skips on a host whose bwrap cannot confine, through
``tests/_helpers/sandbox_pins.py``, with this marker first in its reason. The
kernel lane proves and provisions the backend before its suite runs, so on
that lane such a skip is a containment proof that did not run, and both
halves of the suite partition refuse it by this one predicate:

* the unittest half: ``tests/_helpers/suite_shards.py`` lists the skips in
  each shard report and ``suite_shards verify`` refuses a report with any;
* the pytest half: ``aria_kernel.pytest_native_only`` refuses the run when the
  lane passes ``--refuse-sandbox-skips`` (``scripts/ci/aria-suite-run.sh
  --pytest-native``).

It lives in the package, not under ``tests/``, so the pytest plugin the lane
loads (``-p aria_kernel.pytest_native_only``) reads it without importing test
code. Standard library only, so the shard runner imports it without pytest.
"""

from __future__ import annotations

SANDBOX_SKIP_MARKER = "sandbox_pin_skipped"


def is_sandbox_pin_skip(reason: str) -> bool:
    """Whether a skip ``reason`` is a real-sandbox pin's (the marker leads it)."""
    return reason.startswith(SANDBOX_SKIP_MARKER)


__all__ = ["SANDBOX_SKIP_MARKER", "is_sandbox_pin_skip"]
