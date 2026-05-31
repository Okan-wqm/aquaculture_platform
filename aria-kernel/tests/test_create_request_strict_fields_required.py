"""Plan 024 §B-2 — create_agent_invocation_request strict-fields tests.

The pre-fix signature accepted no must_satisfy / allowed_scope / evidence_refs
kwargs; the resulting request row carried none of them, and
_strict_request_view silently defaulted both to []. evidence_validator.py:291
only enforced allowed_scope when non-empty, so a judge response with
satisfaction_matrix=[] passed consensus uncontested.

Plan 024 §B-2 closes the bypass at three layers:
1. Write-side: create_agent_invocation_request requires must_satisfy +
   allowed_scope (or explicit legacy_strict_fields_optional=True opt-out
   with governance event).
2. Read-side: _strict_request_view rejects empty must_satisfy /
   allowed_scope with GovernanceError so claim_request fails-loud
   instead of silently bypassing.
3. evidence_validator: rejects satisfaction_matrix=[] (unless request
   carries allow_empty_satisfaction_matrix=True) and rejects
   request lacking allowed_scope key.

Tests:
1. Full strict fields → row carries them; request claimable.
2. must_satisfy=[] → reject create_agent_invocation_request_strict_fields_required.
3. allowed_scope=[] → reject.
4. Both missing → reject lists both.
5. legacy_strict_fields_optional=True with empty fields → row written
   + governance event emitted; subsequent claim_request raises
   legacy_request_view_missing_required_strict_fields.
6. evidence_refs with non-string element → reject as list_of_strings.
7. validate_agent_response_evidence with empty satisfaction_matrix
   AND request lacking allow_empty_satisfaction_matrix → error
   evidence_satisfaction_matrix_must_be_non_empty.
8. validate_agent_response_evidence with empty matrix BUT request
   carries allow_empty_satisfaction_matrix=True → pass.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
)
from aria_kernel.evidence_validator import validate_agent_response_evidence
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class CreateRequestStrictFieldsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_full_strict_fields_persisted_and_claimable(self) -> None:
        """Plan 024 §B-2 acceptance (1)."""
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="validate a thing",
            must_satisfy=[
                {"id": "c1", "criterion": "thing is valid"},
            ],
            allowed_scope=["aria-kernel/**"],
            evidence_refs=["aria-kernel/aria_kernel/agent_contract.py:1"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(request["must_satisfy"][0]["id"], "c1")
        self.assertEqual(request["allowed_scope"], ["aria-kernel/**"])
        self.assertEqual(request["evidence_refs"],
                         ["aria-kernel/aria_kernel/agent_contract.py:1"])
        # Request should be claimable end-to-end.
        claim = claim_request(
            request_id=request["request_id"],
            agent_id="judge-worker-001",
            base_dir=self.tools_dir,
        )
        self.assertIn("claim_id", claim)

    def test_empty_must_satisfy_rejected(self) -> None:
        """Plan 024 §B-2 acceptance (2)."""
        with self.assertRaises(GovernanceError) as ctx:
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt="x",
                must_satisfy=[],
                allowed_scope=["aria-kernel/**"],
                base_dir=self.tools_dir,
            )
        self.assertIn("create_agent_invocation_request_strict_fields_required",
                      str(ctx.exception))
        self.assertIn("must_satisfy", str(ctx.exception))

    def test_empty_allowed_scope_rejected(self) -> None:
        """Plan 024 §B-2 acceptance (3)."""
        with self.assertRaises(GovernanceError) as ctx:
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt="x",
                must_satisfy=[{"id": "c", "criterion": "ok"}],
                allowed_scope=[],
                base_dir=self.tools_dir,
            )
        self.assertIn("allowed_scope", str(ctx.exception))

    def test_both_strict_fields_missing_rejected(self) -> None:
        """Plan 024 §B-2 acceptance (4): both fields named in the error."""
        with self.assertRaises(GovernanceError) as ctx:
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt="x",
                base_dir=self.tools_dir,
            )
        msg = str(ctx.exception)
        self.assertIn("must_satisfy", msg)
        self.assertIn("allowed_scope", msg)

    def test_legacy_strict_fields_optional_emits_governance_event(self) -> None:
        """Plan 024 §B-2 acceptance (5): operator escape hatch emits the
        legacy_request_creation_without_strict_fields event AND the
        request becomes unclaimable via the strict path."""
        gov = self.tools_dir / "governance.jsonl"
        before_rows = load_jsonl(gov) if gov.exists() else []
        request = create_agent_invocation_request(
            target_agent="aria-primary-planner",
            role="primary_plan",
            suggested_prompt="legacy escape test",
            legacy_strict_fields_optional=True,
            base_dir=self.tools_dir,
        )
        self.assertEqual(request["must_satisfy"], [])
        self.assertEqual(request["allowed_scope"], [])
        after_rows = load_jsonl(gov)
        new_rows = after_rows[len(before_rows):]
        legacy_events = [
            r for r in new_rows
            if r.get("kind") == "legacy_request_creation_without_strict_fields"
        ]
        self.assertEqual(len(legacy_events), 1,
            f"expected 1 legacy_request_creation_without_strict_fields event, got {legacy_events!r}")
        details = legacy_events[0].get("details") or {}
        self.assertIn("must_satisfy", details.get("missing", []))
        self.assertIn("allowed_scope", details.get("missing", []))
        # claim_request now goes through _strict_request_view which raises
        # legacy_request_view_missing_required_strict_fields.
        with self.assertRaises(GovernanceError) as claim_ctx:
            claim_request(
                request_id=request["request_id"],
                agent_id="worker-strict-test",
                base_dir=self.tools_dir,
            )
        self.assertIn(
            "legacy_request_view_missing_required_strict_fields",
            str(claim_ctx.exception),
        )

    def test_role_target_pairing_rejected_at_write_boundary(self) -> None:
        """Enterprise hardening: bound roles cannot target arbitrary agents."""
        with self.assertRaises(GovernanceError) as ctx:
            create_agent_invocation_request(
                target_agent="farm-expert",
                role="implementation",
                suggested_prompt="x",
                must_satisfy=[{"id": "c", "criterion": "ok"}],
                allowed_scope=["aria-kernel/**"],
                base_dir=self.tools_dir,
            )
        self.assertIn("role_target_pairing_violation", str(ctx.exception))

    def test_evidence_refs_must_be_list_of_strings(self) -> None:
        """Plan 024 §B-2 acceptance (6)."""
        with self.assertRaises(GovernanceError) as ctx:
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt="x",
                must_satisfy=[{"id": "c", "criterion": "ok"}],
                allowed_scope=["aria-kernel/**"],
                evidence_refs=["valid-string", 123],
                base_dir=self.tools_dir,
            )
        self.assertIn(
            "create_agent_invocation_request_evidence_refs_must_be_list_of_strings",
            str(ctx.exception),
        )

    def test_evidence_validator_rejects_empty_satisfaction_matrix(self) -> None:
        """Plan 024 §B-2 acceptance (7)."""
        request = {
            "request_id": "REQ-X",
            "must_satisfy": [{"id": "c", "criterion": "ok"}],
            "allowed_scope": ["aria-kernel/**"],
            "role": "evidence_judgment",
        }
        response = {
            "satisfaction_matrix": [],
            "evidence_refs": [],
        }
        result = validate_agent_response_evidence(
            response=response,
            request=request,
            workspace_root=self.tools_dir,
        )
        codes = [e.get("code") for e in result["errors"]]
        self.assertIn("evidence_satisfaction_matrix_must_be_non_empty", codes,
            f"expected matrix-empty error, got {codes!r}")

    def test_evidence_validator_allow_empty_matrix_opt_in(self) -> None:
        """Plan 024 §B-2 acceptance (8)."""
        request = {
            "request_id": "REQ-Y",
            "must_satisfy": [{"id": "c", "criterion": "ok"}],
            "allowed_scope": ["aria-kernel/**"],
            "allow_empty_satisfaction_matrix": True,
        }
        response = {
            "satisfaction_matrix": [],
            "evidence_refs": [],
        }
        result = validate_agent_response_evidence(
            response=response,
            request=request,
            workspace_root=self.tools_dir,
        )
        codes = [e.get("code") for e in result["errors"]]
        self.assertNotIn("evidence_satisfaction_matrix_must_be_non_empty", codes)


if __name__ == "__main__":
    unittest.main()
