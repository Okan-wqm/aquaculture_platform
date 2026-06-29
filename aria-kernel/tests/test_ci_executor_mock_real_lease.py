"""Plan 024 v3 §B-8 — CI executor mock envelope reads real lease identity.

Pre-fix tools/aria-poc/ci_executor.py invoke_claude_cli mock path
(line 118-122) hardcoded claim_id="claim_mock" and
agent_id="ci-executor:mock". Plan 023 §A-5 lease binding rejects
those literals; the "end-to-end mock" was broken at submit. Plus
the role was string-manipulated from subagent_type rather than read
from the request row — Plan 024 §H-4 envelope.role-vs-request.role
match would have rejected mismatched roles too.

Plan 024 §B-8 fix:
* invoke_claude_cli now takes claim_id, agent_id, role,
  must_satisfy as kwargs.
* Mock envelope uses the passed claim_id + agent_id (real lease
  identity), the passed role (request row), and synthesizes a
  satisfaction matrix that satisfies must_satisfy so Plan 024 §B-2
  evidence_validator does not reject the mock at submit.
* main() reads role + must_satisfy from request_envelope (already
  loaded for cost-cap eval) and forwards to invoke_claude_cli
  along with the claim_id from claim_request output.

Tests:
1. invoke_claude_cli mock without claim_id raises
   ci_executor_mock_missing_lease_identity.
2. Mock envelope contains the passed claim_id + agent_id + role.
3. Mock envelope's satisfaction_matrix has one entry per
   must_satisfy criterion with verdict='satisfied'.
4. Source regression — `claim_mock` and `ci-executor:mock`
   literals are absent from ci_executor.py.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Importing tools/aria-poc/ci_executor.py from a test under
# aria-kernel/tests/ requires the tools dir to be on sys.path.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_CI_EXEC_DIR = _REPO_ROOT / "tools" / "aria-poc"
sys.path.insert(0, str(_CI_EXEC_DIR))


class CiExecutorMockRealLeaseTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["CLAUDE_CLI_MOCK"] = "1"

    def tearDown(self) -> None:
        os.environ.pop("CLAUDE_CLI_MOCK", None)

    def test_mock_without_claim_id_raises(self) -> None:
        """Plan 024 §B-8 acceptance (1)."""
        from ci_executor import invoke_claude_cli  # type: ignore[import-not-found]
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            with self.assertRaises(ValueError) as ctx:
                invoke_claude_cli(
                    request_id="REQ-1",
                    subagent_type="aria-evidence-judge",
                    prompt_file=Path(td) / "prompt.md",
                    output_path=out,
                    timeout_seconds=60,
                    # Plan 025 §B — role is now a required keyword
                    # argument. This test asserts the LEASE-IDENTITY
                    # ValueError surface, so role is supplied to step
                    # past the role precondition; claim_id + agent_id
                    # intentionally missing.
                    role="evidence_judgment",
                )
            self.assertIn("ci_executor_mock_missing_lease_identity",
                          str(ctx.exception))

    def test_mock_envelope_contains_real_lease_identity(self) -> None:
        """Plan 024 §B-8 acceptance (2)."""
        from ci_executor import invoke_claude_cli  # type: ignore[import-not-found]
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            invoke_claude_cli(
                request_id="REQ-1",
                subagent_type="aria-evidence-judge",
                prompt_file=Path(td) / "prompt.md",
                output_path=out,
                timeout_seconds=60,
                claim_id="claim_real_aaaaaaaa",
                agent_id="ci-executor:gha-12345",
                role="evidence_judgment",
                must_satisfy=[],
            )
            envelope = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(envelope["claim_id"], "claim_real_aaaaaaaa")
            self.assertEqual(envelope["agent_id"], "ci-executor:gha-12345")
            self.assertEqual(envelope["role"], "evidence_judgment")
            # Plan 024 §A-5 + §H-4 invariants: literals absent.
            self.assertNotEqual(envelope["claim_id"], "claim_mock")
            self.assertNotEqual(envelope["agent_id"], "ci-executor:mock")

    def test_mock_envelope_satisfies_must_satisfy(self) -> None:
        """Plan 024 §B-8 acceptance (3)."""
        from ci_executor import invoke_claude_cli  # type: ignore[import-not-found]
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            invoke_claude_cli(
                request_id="REQ-1",
                subagent_type="aria-evidence-judge",
                prompt_file=Path(td) / "prompt.md",
                output_path=out,
                timeout_seconds=60,
                claim_id="claim_real_aaaaaaaa",
                agent_id="ci-executor:gha-12345",
                role="evidence_judgment",
                must_satisfy=[
                    {"id": "c-1", "criterion": "first"},
                    {"id": "c-2", "criterion": "second"},
                ],
            )
            envelope = json.loads(out.read_text(encoding="utf-8"))
            ids = {e.get("id") for e in envelope["satisfaction_matrix"]}
            self.assertEqual(ids, {"c-1", "c-2"})
            for entry in envelope["satisfaction_matrix"]:
                self.assertEqual(entry["verdict"], "satisfied")

    def test_source_does_not_carry_legacy_literals_as_envelope_values(self) -> None:
        """Plan 024 §B-8 acceptance (4): regression guard against the
        literals re-appearing as ENVELOPE field values. The docstring
        + comment may legitimately mention the literals while
        explaining what was removed; the regression target is the
        envelope construction site (a JSON literal pair like
        '"claim_id": "claim_mock"' or '"agent_id": "ci-executor:mock"')."""
        src = (_CI_EXEC_DIR / "ci_executor.py").read_text(encoding="utf-8")
        self.assertNotIn('"claim_id": "claim_mock"', src,
            "Plan 024 §B-8 — claim_id=claim_mock envelope literal must not re-appear")
        self.assertNotIn('"agent_id": "ci-executor:mock"', src,
            "Plan 024 §B-8 — agent_id=ci-executor:mock envelope literal must not re-appear")


if __name__ == "__main__":
    unittest.main()
