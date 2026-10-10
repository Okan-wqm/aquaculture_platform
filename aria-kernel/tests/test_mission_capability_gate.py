"""ORPHAN-HIGH-573 (require_capability_resolution) — the mission gate.

The control "refuses a mission step whose required capability is
unresolved" existed with no caller: the CAPABILITY_REQUIRED waiting
state blocks missions the pipeline ITSELF declared capability-less,
but a mission minted with a `capability` could walk into IMPLEMENTING
with nobody asking the capability-resolution ledger whether that
capability is decided. This pins the gate at the one throat every
step passes: transition_mission into IMPLEMENTING.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.capability_resolver import resolve_capability
from aria_kernel.mission import (
    open_mission,
    transition_mission,
)
from aria_kernel.tool_registry import GovernanceError

REPO_HASH = "sha256:test-repo-hash-mission-gate"


def _open(base: Path, source_id: str, capability: str | None) -> str:
    mission = open_mission(
        source_kind="finding",
        source_id=source_id,
        repo_hash=REPO_HASH,
        title=f"close {source_id}",
        next_action=f"close {source_id}",
        wake_condition={"kind": "evidence", "key": f"finding:{source_id}"},
        capability=capability,
        base_dir=base,
    )
    return str(mission["mission_id"])


class MissionCapabilityGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _to_implementing(self, mission_id: str) -> dict:
        return transition_mission(
            mission_id=mission_id,
            to_state="IMPLEMENTING",
            reason_code="coarse_observation",
            step_id="step-gate-1",
            next_action="implement the fix",
            wake_condition={"kind": "ci_status", "key": "checks"},
            base_dir=self.base,
        )

    def test_mission_without_capability_transitions_unchanged(self) -> None:
        mission_id = _open(self.base, "ORPHAN-HIGH-1", capability=None)
        result = self._to_implementing(mission_id)
        self.assertEqual(result["event"]["to_state"], "IMPLEMENTING")

    def test_mission_with_undecided_capability_is_refused(self) -> None:
        mission_id = _open(self.base, "ORPHAN-HIGH-2", capability="rust-drift-vocab")
        with self.assertRaises(GovernanceError) as ctx:
            self._to_implementing(mission_id)
        self.assertIn("capability_resolution_required", str(ctx.exception))

    def test_decided_capability_passes_the_gate(self) -> None:
        resolve_capability(
            capability_key="rust-drift-vocab",
            requested_kind="skill",
            title="Rust drift vocabulary",
            base_dir=self.base,
        )
        mission_id = _open(self.base, "ORPHAN-HIGH-3", capability="rust-drift-vocab")
        result = self._to_implementing(mission_id)
        self.assertEqual(result["event"]["to_state"], "IMPLEMENTING")

    def test_rejected_decision_still_refuses(self) -> None:
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now

        append_declared_jsonl(
            ensure_tools_dir(self.base) / "capability-resolution" / "decisions.jsonl",
            {
                "schema_version": 1, "recorded_at": utc_now(),
                "row_id": "capability-resolution:denied", "row_type": "capability_resolution_decision",
                "capability_key": "denied-cap", "requested_kind": "agent", "title": "Denied capability",
                "decision": "reject_duplicate", "existing_capabilities": [],
            },
            expected_surface="capability_resolution_decisions",
        )
        mission_id = _open(self.base, "ORPHAN-HIGH-4", capability="denied-cap")
        with self.assertRaises(GovernanceError) as ctx:
            self._to_implementing(mission_id)
        self.assertIn("capability_resolution_decision_rejected:reject_duplicate", str(ctx.exception))

    def test_kernel_native_service_missions_pass_with_no_ledger_row(self) -> None:
        """The live shape (runner store, 2026-10-09): 56 missions minted with
        capability=service_hardening and no ledger decision keyed to it. The
        kernel provides that capability itself, so its declaration is the
        resolution; each mission still reaches IMPLEMENTING."""
        from aria_kernel.capability_resolver import SERVICE_HARDENING_CAPABILITY

        ledger = self.base / "capability-resolution" / "decisions.jsonl"
        for index in range(56):
            mission_id = _open(self.base, f"service-{index:02d}", capability=SERVICE_HARDENING_CAPABILITY)
            result = self._to_implementing(mission_id)
            self.assertEqual(result["event"]["to_state"], "IMPLEMENTING")
        self.assertFalse(ledger.exists() and ledger.read_text(encoding="utf-8").strip())

    def test_an_unknown_capability_is_still_blocked_beside_a_native_one(self) -> None:
        mission_id = _open(self.base, "ORPHAN-HIGH-5", capability="service_hardening_v2")
        with self.assertRaises(GovernanceError) as ctx:
            self._to_implementing(mission_id)
        self.assertIn("capability_resolution_required_for_mission_step", str(ctx.exception))

    def test_the_service_minter_and_the_native_set_share_one_constant(self) -> None:
        import ast

        from aria_kernel.capability_resolver import KERNEL_NATIVE_CAPABILITIES, SERVICE_HARDENING_CAPABILITY

        tree = ast.parse((Path(__file__).resolve().parents[1] / "aria_kernel" / "cycle.py").read_text(encoding="utf-8"))
        service_mints = [
            call for call in ast.walk(tree)
            if isinstance(call, ast.Call) and getattr(call.func, "id", None) == "open_mission"
            and any(k.arg == "source_kind" and isinstance(k.value, ast.Constant) and k.value.value == "service_hardening"
                    for k in call.keywords)
        ]
        self.assertEqual(len(service_mints), 1)
        capability = next(k.value for k in service_mints[0].keywords if k.arg == "capability")
        # The minter names the constant, never a literal that could drift from the native set.
        self.assertIsInstance(capability, ast.Name)
        self.assertEqual(capability.id, "SERVICE_HARDENING_CAPABILITY")
        self.assertIn(SERVICE_HARDENING_CAPABILITY, KERNEL_NATIVE_CAPABILITIES)

if __name__ == "__main__":  # pragma: no cover
    unittest.main()
