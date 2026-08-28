"""Y5 (ORPHAN-706) — the judge output contract, enforced before accept.

Second sealed night: 12 judge results were ACCEPTED with no readable
verdict block; every one became a sealed row the bridge could never fold
("judge bridge expected verdict ..., got None"), burning bridge retries
toward permanent_fail while operator-feedback stayed empty and
judged_judges stayed 0.

Deliberate-breakage pins:
- one contract, two consumers: the executor's pre-submit gate and the
  bridge check the SAME validator, so they can never disagree;
- a verdictless judge envelope is released harness-class (never burns the
  request's requeue budget);
- the bridge-status ledger gains its first reader (report section).
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    HARNESS_FAULT_RELEASE_REASONS,
    _is_harness_fault_reason,
)
from aria_kernel.judgment_bridge import (
    record_judge_verdict_from_response,
    validate_judge_response,
)
from aria_kernel.tool_registry import GovernanceError

_REPO = Path(__file__).resolve().parents[2]
_POC = _REPO / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


def _request() -> dict:
    return {
        "tool_id": "tool-a", "run_id": "run-1", "finding_id": "F-1",
        "judgment_group_id": "judge:tool-a:fp1",
    }


def _response(verdict_block: dict | None) -> dict:
    details: dict = {"agent_subagent_type": "aria-evidence-judge"}
    if verdict_block is not None:
        details["verdict"] = verdict_block
    return {"role": "evidence_judgment", "details": details}


class ValidateJudgeResponseTests(unittest.TestCase):
    def test_valid_envelope_passes(self) -> None:
        response = _response({"verdict": "true_positive", "rationale": "seen at file:1"})
        self.assertEqual(validate_judge_response(request=_request(), response=response), [])

    def test_missing_verdict_block_is_the_measured_defect(self) -> None:
        errors = validate_judge_response(request=_request(), response=_response(None))
        self.assertEqual(errors, ["judge_verdict:absent"])

    def test_invalid_verdict_value_rejected(self) -> None:
        response = _response({"verdict": "maybe"})
        errors = validate_judge_response(request=_request(), response=response)
        self.assertTrue(any(e.startswith("judge_verdict.verdict:invalid") for e in errors))

    def test_executor_shaped_identity_rejected(self) -> None:
        response = _response({"verdict": "true_positive"})
        response["details"].pop("agent_subagent_type")
        response["details"]["verdict"]["judge_id"] = "ci-executor:gha-1"
        errors = validate_judge_response(request=_request(), response=response)
        self.assertIn("judge_verdict:executor_shaped_judge_identity", errors)

    def test_non_judge_roles_are_unbound(self) -> None:
        self.assertEqual(
            validate_judge_response(
                request={}, response={"role": "maintenance_utility", "details": {}},
            ),
            [],
        )

    def test_bridge_raises_on_the_same_contract(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            record_judge_verdict_from_response(
                request=_request(), response=_response(None),
            )
        self.assertIn("judge bridge contract violation", str(ctx.exception))

    def test_release_reason_is_harness_class(self) -> None:
        self.assertIn("judge_verdict_contract_violation", HARNESS_FAULT_RELEASE_REASONS)
        self.assertTrue(_is_harness_fault_reason("judge_verdict_contract_violation"))


class ExecutorPreSubmitGateTests(unittest.TestCase):
    def test_executor_gate_uses_the_kernel_validator(self) -> None:
        import ci_executor

        errors = ci_executor._pre_submit_validate_envelope(
            {"details": {}}, role="evidence_judgment", request=_request(),
        )
        self.assertEqual(errors, ["judge_verdict:absent"])
        ok = ci_executor._pre_submit_validate_envelope(
            {"details": {
                "agent_subagent_type": "aria-evidence-judge",
                "verdict": {"verdict": "false_positive"},
            }},
            role="adversarial_judgment", request=_request(),
        )
        self.assertEqual(ok, [])


class GateReadsTheLedgerRowTests(unittest.TestCase):
    def test_trimmed_claim_payload_is_enriched_from_the_request_row(self) -> None:
        """Restart follow-through: the drain child's claim payload never
        carried tool/run/finding, so the gate refused perfectly-identified
        envelopes. The gate now reads the SAME ledger row the bridge reads."""
        import os as _os
        import tempfile as _tf
        from unittest.mock import patch as _patch

        import ci_executor
        from aria_kernel.tool_registry import ensure_tools_dir as _etd
        from tests._helpers.declared_fixtures import append_declared_fixture

        with _tf.TemporaryDirectory() as tmp:
            tools = _etd(Path(tmp) / "aria-tools")
            append_declared_fixture(
                tools / "agent-invocations" / "requests.jsonl",
                {
                    "$schema": "aria/agent-invocation-request/v1",
                    "schema_version": 1,
                    "request_id": "AIR-judge-full-1",
                    "role": "evidence_judgment",
                    "target_agent": "aria-evidence-judge",
                    "suggested_prompt": "judge",
                    "must_satisfy": [{"id": "S1"}],
                    "evidence_refs": [],
                    "allowed_scope": ["**"],
                    "expected_output_path": str(Path(tmp) / "o.json"),
                    "state": "pending",
                    "created_at": "2026-08-17T00:00:00Z",
                    "tool_id": "tool-a", "run_id": "run-1", "finding_id": "F-9",
                    "judgment_group_id": "judge:tool-a:fp9",
                },
                expected_surface="agent_invocation_requests",
            )
            trimmed = {"request_id": "AIR-judge-full-1", "role": "evidence_judgment"}
            envelope = {"request_id": "AIR-judge-full-1", "details": {
                "agent_subagent_type": "aria-evidence-judge",
                "verdict": {"verdict": "true_positive"},
            }}
            with _patch.dict(_os.environ, {"ARIA_TOOLS_DIR": str(tools)}):
                errors = ci_executor._pre_submit_validate_envelope(
                    envelope, role="evidence_judgment", request=trimmed,
                )
            self.assertEqual(errors, [])


class LedgerPointerEvidenceTests(unittest.TestCase):
    def test_human_required_refs_are_admitted_ledger_pointers(self) -> None:
        """The kernel's own adjudication mint issues human-required:<id>
        refs; the law admitting them is what stops every panel opinion
        dying submit_rejected. Load-bearing verification stays at fold."""
        import tempfile as _tf

        from aria_kernel.evidence_validator import _check_agent_ref

        with _tf.TemporaryDirectory() as tmp:
            errors: list = []
            checked: list = []
            _check_agent_ref(
                "human-required:AIR-aria-challenger-planner-abc123",
                root=Path(tmp), errors=errors, checked=checked,
            )
            self.assertEqual(errors, [])
            self.assertEqual(len(checked), 1)


class LedgerPointerAllLayersTests(unittest.TestCase):
    def test_panel_shaped_response_passes_every_law_layer(self) -> None:
        """Z2 — the smoke run proved layer-by-layer whack-a-mole: malformed
        fixed, then repo-verified rejected, then allowed-scope rejected the
        SAME pointer. This drives the full validator with a mint-shaped
        request + agent echo, so all layers answer the one predicate."""
        import tempfile as _tf

        from aria_kernel.evidence_validator import validate_agent_response_evidence

        pointer = "human-required:AIR-aria-challenger-planner-abc123"
        with _tf.TemporaryDirectory() as tmp:
            request = {
                "request_id": "AIR-arb-1",
                "allowed_scope": [pointer],
                "evidence_refs": [pointer],
                "target_sha": None,
            }
            response = {
                "evidence_refs": [pointer],
                "satisfaction_matrix": [{
                    "id": "S1", "verdict": "satisfied",
                    "evidence_refs": [pointer],
                }],
            }
            result = validate_agent_response_evidence(
                response=response, workspace_root=Path(tmp), request=request,
            )
            self.assertEqual(result["errors"], [])
            self.assertTrue(result["valid"])


class BridgeHealthSectionTests(unittest.TestCase):
    def test_troubled_roles_render_and_clean_ledgers_stay_silent(self) -> None:
        from aria_kernel.reflection import _compute_bridge_health, _render_bridge_health_section

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = root / "agent-invocations" / "agent-result-bridge-status.jsonl"
            ledger.parent.mkdir(parents=True)
            rows = [
                {"role": "evidence_judgment", "transition": "ok"},
                {"role": "adversarial_judgment", "transition": "pending_retry",
                 "error_detail": "judge_bridge: judge bridge expected verdict"},
                {"role": "adversarial_judgment", "transition": "permanent_fail",
                 "error_detail": "replay_output_envelope_unreadable: /gone.md"},
            ]
            ledger.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            health = _compute_bridge_health(root)
            self.assertEqual(health["matrix"]["adversarial_judgment"]["permanent_fail"], 1)
            lines = _render_bridge_health_section({"bridge_health": health})
            self.assertIn("## Bridge Health", lines)
            self.assertTrue(any("adversarial_judgment" in l for l in lines))
            # evidence_judgment is all-ok → not listed
            self.assertFalse(any(l.startswith("- evidence_judgment") for l in lines))
            # all-ok ledger renders nothing (empty-heading rule)
            clean = {"bridge_health": {"matrix": {"evidence_judgment": {"ok": 3}}}}
            self.assertEqual(_render_bridge_health_section(clean), [])


if __name__ == "__main__":
    unittest.main()
