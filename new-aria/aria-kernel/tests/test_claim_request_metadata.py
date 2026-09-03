"""Plan 026R §B.3 — claim_request fused-return + ledger-hash anchors.

5 tests:

* claim_request return has 5 envelope fields + 2 ledger_hash anchors.
* Persisted claim row in claims.jsonl stays minimal (no envelope).
* Mid-lock mutation safe: appending to claims.jsonl during the same
  lock window does not change the return value.
* ci_executor main() no longer subprocess-fetches the envelope via
  ``agent-invocations list --request-id`` (double-fetch fallback
  removed).
* ci_executor argv preserves the §B.1 SSoT shape (--agent-id +
  --lease-token-from-env).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile


ARIA_KERNEL = Path(__file__).resolve().parent.parent
ARIA_POC = ARIA_KERNEL.parent / "tools" / "aria-poc"


class ClaimRequestFusedReturnTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-b3-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        self.req = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="prove docs/a.md",
            expected_output_path="docs/b3-out.md",
            must_satisfy=[{"id": "proof", "description": "prove"}],
            allowed_scope=["docs/"],
            evidence_refs=["docs/a.md"],
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_claim_return_has_envelope_plus_ledger_hash_fields(self) -> None:
        result = claim_request(
            request_id=self.req["request_id"],
            agent_id="test-agent",
            base_dir=self.base,
        )
        # 5 envelope fields per plan §B.3:
        self.assertEqual(result["expected_output_path"], "docs/b3-out.md")
        self.assertEqual(result["role"], "evidence_judgment")
        self.assertEqual(
            result["must_satisfy"],
            [{"id": "proof", "description": "prove"}],
        )
        self.assertEqual(result["allowed_scope"], ["docs/"])
        self.assertEqual(result["evidence_refs"], ["docs/a.md"])
        # 2 ledger-hash anchors per plan §B.3 + §B.5:
        self.assertTrue(
            result["claim_ledger_hash"].startswith("sha256:"),
            result["claim_ledger_hash"],
        )
        self.assertTrue(
            result["request_ledger_hash"].startswith("sha256:"),
            result["request_ledger_hash"],
        )
        # Original lease fields still present:
        self.assertTrue(result["lease_token"])
        self.assertTrue(result["claim_id"])

    def test_persisted_claim_row_stays_minimal(self) -> None:
        result = claim_request(
            request_id=self.req["request_id"],
            agent_id="test-agent",
            base_dir=self.base,
        )
        claims = load_jsonl(self.base / "agent-invocations" / "claims.jsonl")
        claim_event = next(
            row for row in claims if row.get("claim_id") == result["claim_id"]
        )
        # The persisted row carries ONLY the lease-event minimum fields.
        # Envelope fields MUST NOT have leaked into the claim ledger.
        for envelope_field in (
            "expected_output_path", "role", "must_satisfy",
            "allowed_scope", "evidence_refs",
        ):
            self.assertNotIn(
                envelope_field, claim_event,
                f"persisted claim leaked envelope field {envelope_field!r}",
            )
        # Ledger-hash anchors are likewise IN-MEMORY-ONLY — they would
        # be self-referential if persisted.
        for anchor in ("claim_ledger_hash", "request_ledger_hash"):
            self.assertNotIn(anchor, claim_event)

    def test_mid_lock_mutation_safe(self) -> None:
        # The fused envelope is loaded INSIDE the same lock window that
        # writes the claim row. A second concurrent claim attempt on a
        # different request must not alter the first claim's return.
        other_req = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="other",
            expected_output_path="docs/other.md",
            must_satisfy=[{"id": "p", "description": "p"}],
            allowed_scope=["docs/"],
            evidence_refs=["docs/x.md"],
            base_dir=self.base,
        )
        r1 = claim_request(
            request_id=self.req["request_id"], agent_id="agent-1",
            base_dir=self.base,
        )
        r2 = claim_request(
            request_id=other_req["request_id"], agent_id="agent-2",
            base_dir=self.base,
        )
        # r1's envelope is unaffected by r2's later claim.
        self.assertEqual(r1["expected_output_path"], "docs/b3-out.md")
        self.assertEqual(r2["expected_output_path"], "docs/other.md")
        self.assertNotEqual(r1["claim_ledger_hash"], r2["claim_ledger_hash"])
        self.assertNotEqual(r1["request_ledger_hash"], r2["request_ledger_hash"])


class CiExecutorFusedConsumerTests(unittest.TestCase):
    """AST scan: ci_executor main() reads the fused envelope from the
    claim response and no longer subprocess-fetches via
    ``agent-invocations list --request-id``."""

    def _ci_src(self) -> str:
        return (ARIA_POC / "ci_executor.py").read_text(encoding="utf-8")

    def test_executor_does_not_subprocess_fetch_envelope(self) -> None:
        src = self._ci_src()
        # The pre-§B.3 ``REQUEST_ENVELOPE_LIST_ARGV`` subprocess.run line
        # is gone from ``main``. The constant may still exist as a
        # legacy import (unused) but no main()-level subprocess call
        # should reference it after the §B.3 fusion.
        self.assertNotIn(
            "*REQUEST_ENVELOPE_LIST_ARGV", src,
            "ci_executor.main() still spawns the pre-§B.3 envelope-list "
            "subprocess — fused-return migration incomplete",
        )
        # Fused-read markers. These pinned the hand-copied `claim.get(...)`
        # lines as source text — and that hand copy is exactly what broke the
        # prompt binding a second time (ORPHAN-CRITICAL-601), so its absence
        # is now the correct state. The properties they cared about survive:
        # the envelope reads from the fused response (via the kernel's
        # fuse_prompt_envelope, which carries expected_output_path) and the
        # §B.5 anchor is still propagated in main.
        self.assertIn(
            "_fuse_prompt_envelope(claim)", src,
            "ci_executor.main() must build the envelope from the fused "
            "claim response via the kernel projection",
        )
        self.assertIn(
            '"claim_ledger_hash"', src,
            "ci_executor.main() must propagate the §B.5 ledger-hash "
            "anchor from the fused claim response",
        )

    def test_executor_claim_argv_preserves_b1_ssot(self) -> None:
        src = self._ci_src()
        # The claim subprocess argv includes --agent-id (B.1 SSoT) and
        # the new fused-return is parsed via json.loads(claim_proc.stdout).
        self.assertIn('"--agent-id", agent_id', src)
        self.assertIn("claim = json.loads(claim_proc.stdout)", src)


if __name__ == "__main__":
    unittest.main()
