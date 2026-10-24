"""The operator's live stop, faked, for merge-path tests (ARIA-HIGH-765, B0 corrective R1) — never the network.

The merge authority reads the operator's LIVE ``vars.ARIA_STOP`` right before
the merge call through an ``OperatorStopSource`` its caller hands it, and it
FAILS CLOSED: no source, or one that cannot read the variable, makes no merge
call. Production hands it ``preflight.repository_operator_stop()``; a test
that exercises what happens after the stop is read clear hands it
:func:`operator_stop_clear`, the source that read the variable and found it
unset. The stop itself is tested in ``tests/test_aria_stop_operator_variable.py``
against a fake ``gh`` that answers the repository-variables listing.
"""

from __future__ import annotations

from aria_kernel.preflight import OperatorStopSource


def operator_stop_clear() -> OperatorStopSource:
    """A source whose live ``vars.ARIA_STOP`` is read and unset: the operator has not stopped ARIA."""

    def read() -> str:
        return ""

    return read
