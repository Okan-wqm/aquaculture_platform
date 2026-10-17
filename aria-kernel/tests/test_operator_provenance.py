"""C4-a (ORPHAN-674) — the operator-approval ledger gets its writer.

`operator-provenance/events.jsonl` had promotion-critical READERS
(`verify_shadow_eval_proof` set-membership match) and zero writers
outside tests — the genesis proof chain dead-ended at a ledger nothing
could mint.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.operator_provenance import (
    list_operator_approvals,
    record_operator_approval,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_FUTURE = "2999-01-01T00:00:00Z"


class RecordTests(unittest.TestCase):
    def test_minted_row_satisfies_the_verifier_membership_match(self) -> None:
        # verify_shadow_eval_proof collects {operator_provenance_ref,
        # provenance_ref, event_id, ref} off the resolved row and demands
        # the proof's ref be a member — the minted row must carry the ref
        # on those exact fields.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            row = record_operator_approval(
                ref="operator:approval:e2e-1",
                expires_at=_FUTURE,
                target_agent="aria-svc-farm-auditor",
                base_dir=root,
            )
            listed = list_operator_approvals(base_dir=root)
        self.assertEqual(row["operator_provenance_ref"], "operator:approval:e2e-1")
        self.assertEqual(row["event_id"], "operator:approval:e2e-1")
        self.assertEqual(row["row_type"], "operator_approval")
        self.assertIn("ledger_hash", row)
        self.assertEqual(len(listed), 1)

    def test_expired_at_mint_is_refused(self) -> None:
        # Deliberate-break: minting an already-expired approval would only
        # defer the refusal to the consume path.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with self.assertRaises(GovernanceError) as ctx:
                record_operator_approval(
                    ref="operator:approval:old",
                    expires_at="2001-01-01T00:00:00Z",
                    target_agent="aria-svc-farm-auditor",
                    base_dir=root,
                )
        self.assertIn("operator_approval_expired_at_mint", str(ctx.exception))

    def test_blank_ref_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with self.assertRaises(GovernanceError):
                record_operator_approval(ref="  ", expires_at=_FUTURE, target_agent="aria-x", base_dir=root)

    def test_an_approval_names_the_agent_it_promotes(self) -> None:
        # ARIA-MEDIUM-512 — an approval with no target_agent was stored as
        # None and the shadow bridge compared the scope only when it was
        # non-empty, so leaving the flag out minted a wildcard that promoted
        # any agent. The mint refuses it; nothing is written.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            for target_agent in (None, "", "   "):
                with self.subTest(target_agent=target_agent), \
                        self.assertRaisesRegex(GovernanceError, "^operator_approval_target_agent_required$"):
                    record_operator_approval(
                        ref="operator:approval:unscoped", expires_at=_FUTURE,
                        target_agent=target_agent, base_dir=root,
                    )
            self.assertEqual(list_operator_approvals(base_dir=root), [])

    def test_the_cli_requires_the_target_agent(self) -> None:
        import contextlib
        import io

        from aria_kernel.cli import main

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                main([
                    "operator-provenance", "record",
                    "--ref", "operator:approval:cli-unscoped",
                    "--expires-at", _FUTURE,
                    "--tools-dir", str(root),
                ])
            self.assertEqual(ctx.exception.code, 2)
            self.assertEqual(list_operator_approvals(base_dir=root), [])

    def test_cli_routes_record_and_list(self) -> None:
        from aria_kernel.cli import main

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            rc = main([
                "operator-provenance", "record",
                "--ref", "operator:approval:cli-1",
                "--expires-at", _FUTURE,
                "--target-agent", "aria-svc-farm-auditor",
                "--tools-dir", str(root),
            ])
            self.assertEqual(rc, 0)
            rows = list_operator_approvals(base_dir=root)
        self.assertEqual([r["event_id"] for r in rows], ["operator:approval:cli-1"])


if __name__ == "__main__":
    unittest.main()
