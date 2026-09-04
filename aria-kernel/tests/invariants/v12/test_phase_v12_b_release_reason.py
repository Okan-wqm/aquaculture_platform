"""Plan 032 Faz 032b-3 — release reasons are a closed envelope on the row.

Invariants:
  I-V12-REASON-01  every literal and prefixed reason the executor emits maps
                   to a code in RELEASE_REASON_CODES with the same fault
                   domain `classify_release_reason` assigns; unknown → UNCLASSIFIED.
  I-V12-REASON-02  `release_claim` writes reason_code / reason_detail /
                   fault_domain next to the legacy string on both the release
                   and the requeue rows.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel.agent_invocations import (
    HARNESS_FAULT_RELEASE_REASONS,
    REQUEST_FAULT_RELEASE_REASONS,
    claim_request,
    classify_release_reason,
    create_agent_invocation_request,
    release_claim,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.release_reason import FAULT_DOMAINS, RELEASE_REASON_CODES, parse_release_reason
from aria_kernel.tool_registry import ensure_tools_dir


class TheEnvelopeIsClosed(unittest.TestCase):
    def test_I_V12_REASON_01_every_known_reason_maps_with_the_same_ownership(self) -> None:
        for reason in HARNESS_FAULT_RELEASE_REASONS | REQUEST_FAULT_RELEASE_REASONS:
            parsed = parse_release_reason(reason)
            self.assertIn(parsed.reason_code, RELEASE_REASON_CODES, reason)
            self.assertNotEqual(parsed.reason_code, "UNCLASSIFIED", reason)
            self.assertEqual(parsed.fault_domain, classify_release_reason(reason), reason)
        for text, code, domain, detail in (
            ("submit_timeout_120s", "SUBMIT_TIMEOUT", "harness", "120s"),
            ("claude_cli_exit_1", "CLAUDE_CLI_EXIT", "harness", "1"),
            ("plan_content_invalid:plan_content:absent", "PLAN_CONTENT_INVALID", "request", "plan_content:absent"),
            ("agent_refused:scope", "AGENT_REFUSED", "request", "scope"),
            ("operator_cancelled", "OPERATOR_CANCELLED", "operator", ""),
            ("nobody_named_this", "UNCLASSIFIED", "unclassified", "nobody_named_this"),
        ):
            parsed = parse_release_reason(text)
            self.assertEqual((parsed.reason_code, parsed.fault_domain, parsed.reason_detail), (code, domain, detail), text)
        for domain in FAULT_DOMAINS:
            self.assertIn(domain, ("harness", "request", "operator", "unclassified"))


class RowsCarryTheEnvelope(unittest.TestCase):
    def test_I_V12_REASON_02_release_and_requeue_rows_are_structured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            req = create_agent_invocation_request(
                target_agent="aria-challenger-planner", role="challenger_plan",
                suggested_prompt="p", must_satisfy=[{"id": "r", "criterion": "c"}],
                allowed_scope=["aria-kernel/**"], convergence_id="conv-1", base_dir=tools,
            )
            claim = claim_request(request_id=req["request_id"], agent_id="w", base_dir=tools)
            release_claim(claim_id=claim["claim_id"], agent_id="w", lease_token=claim["lease_token"],
                          reason="submit_timeout_120s", base_dir=tools)
            rows = load_declared_jsonl(tools / "agent-invocations" / "claims.jsonl", expected_surface="agent_invocation_claims")
        released = [r for r in rows if r.get("event") == "released"][-1]
        requeued = [r for r in rows if r.get("event") == "requeued"][-1]
        for row in (released, requeued):
            self.assertEqual(row["reason"], "submit_timeout_120s")
            self.assertEqual(row["reason_code"], "SUBMIT_TIMEOUT")
            self.assertEqual(row["reason_detail"], "120s")
            self.assertEqual(row["fault_domain"], "harness")


if __name__ == "__main__":
    unittest.main()
