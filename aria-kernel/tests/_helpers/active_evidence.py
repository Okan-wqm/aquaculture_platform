"""SHADOW -> ACTIVE evidence, for tests whose subject is another gate (ARIA-HIGH-004).

``tool_registry.transition_tool`` verifies the evidence a SHADOW -> ACTIVE
transition stands on (``adapter_calibration.verify_active_transition_
evidence``: the calibration report, the readiness verdict it holds, the
fixture run that verdict read, the tool version and the commit) among its
structural gates, before any authority resolves. A test that pins the
authority gates, the lifecycle matrix or a caller's wiring stands those
ledgers in with :func:`active_evidence_verified` (or
:func:`stand_in_active_evidence` for a whole test case), exactly as it stands
in the operator's GitHub act; the evidence gate's own behaviour is proven
against real ledgers in ``tests/test_promotion_funnel_e2e.py``.
"""
from __future__ import annotations

import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel.adapter_calibration import ACTIVE_EVIDENCE_FIELDS

TARGET_SHA = "c0" * 20


def active_evidence(tool_id: str, *, version: str = "1.0.0") -> dict[str, Any]:
    """An evidence record in the shape ``active_transition_evidence`` builds."""
    evidence = {
        "calibration_report_ref": f"acal-{tool_id}",
        "calibration_report_hash": "sha256:" + "a" * 64,
        "readiness_verdict_hash": "sha256:" + "b" * 64,
        "fixture_run_refs": [f"exec-{tool_id}"],
        "tool_version": version,
        "target_sha": TARGET_SHA,
    }
    assert set(evidence) == set(ACTIVE_EVIDENCE_FIELDS)
    return evidence


@contextmanager
def active_evidence_verified() -> Iterator[mock.MagicMock]:
    """The evidence gate passes whatever evidence it is handed (built or not),
    so the gate under test is the one that decides."""

    def verified(tool_id: str, evidence: Any, *, base_dir: Any = None) -> dict[str, Any]:
        return dict(evidence) if isinstance(evidence, dict) else active_evidence(tool_id)

    def built(tool_id: str, *, base_dir: Any = None) -> dict[str, Any]:
        return active_evidence(tool_id)

    with mock.patch("aria_kernel.adapter_calibration.verify_active_transition_evidence", side_effect=verified) as gate, \
         mock.patch("aria_kernel.adapter_calibration.active_transition_evidence", side_effect=built):
        yield gate


def stand_in_active_evidence(case: unittest.TestCase) -> mock.MagicMock:
    """:func:`active_evidence_verified` for the rest of ``case`` (its test and
    cleanups): for a ``setUp`` whose class pins another gate."""
    context = active_evidence_verified()
    gate = context.__enter__()
    case.addCleanup(context.__exit__, None, None, None)
    return gate


def register_active_for_test(tool: dict[str, Any], base_dir: str | Path) -> dict[str, Any]:
    """Plan 023 v3 §C-3 — a tool at the status its definition names, through
    the lifecycle (the one test-side owner of this route).

    register_tool rejects first-time registrations at ACTIVE / CALIBRATE /
    QUARANTINED, so the tool is registered SHADOW and then moved: QUARANTINED
    through quarantine_tool, ACTIVE / CALIBRATE through transition_tool with
    synthetic gate values, the operator's GitHub act faked
    (ARIA-CRITICAL-216) and the ACTIVE evidence stood in (ARIA-HIGH-004).
    Production callers cannot reach it: it lives in the test namespace.

    SHADOW, and statuses register_tool itself refuses (BROKEN, ...), go to
    register_tool unchanged so a rejection-path probe keeps its intent.
    """
    from aria_kernel.tool_registry import register_tool, transition_tool

    target = tool.get("status", "ACTIVE")
    if target not in ("ACTIVE", "CALIBRATE", "QUARANTINED"):
        return register_tool(tool, base_dir=base_dir)
    register_tool({**tool, "status": "SHADOW"}, base_dir=base_dir)
    if target == "QUARANTINED":
        from aria_kernel.quarantine import quarantine_tool

        return quarantine_tool(tool["tool_id"], "test fixture quarantine", base_dir=base_dir)
    from tests._helpers.operator_acts import github_operator_acts

    with github_operator_acts() as github, active_evidence_verified():
        return transition_tool(
            tool["tool_id"],
            target_status=target,
            reason="test fixture promotion",
            precision=1.0,
            critical_false_positives=0,
            evidence_chains_valid=True,
            operator_approval_ref=github.approve(
                "tool_promote", {"tool": tool["tool_id"], "target": target},
            ),
            base_dir=base_dir,
        )
