"""The measured-fitness gate of the autonomous promotion lanes, stood in (ARIA-HIGH-125).

``role_fitness.adapter_fitness_blocker`` refuses an autonomous promotion (the
panel lane, the auto-promote token) of an adapter its newest fitness report
does not measure against a promoted gold corpus at or above its floor. A test
whose subject is another gate of those lanes (the panel ref, the veto window,
the token's MAC) stands the measurement in with :func:`stand_in_measured_fitness`,
as it stands in the readiness verdict; the gate itself is proven against real
ledgers in ``tests/test_role_fitness.py``.
"""
from __future__ import annotations

import unittest
from unittest import mock


def stand_in_measured_fitness(case: unittest.TestCase) -> mock.MagicMock:
    """Every adapter reads as measured at or above its floor for the rest of ``case``."""
    patcher = mock.patch("aria_kernel.role_fitness.adapter_fitness_blocker", return_value=None)
    gate = patcher.start()
    case.addCleanup(patcher.stop)
    return gate
