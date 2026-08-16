"""F5-b (ORPHAN-694) — branch-protection proof producer.

The proof family the claim verifier demands had no production caller and
no resolvable source row. Battery: measured fields (never asserted), the
honest weak-protection path, fail-closed probe, source-ref resolution,
and the single-probe İ1 pin (verify_branch_protection is a projection of
probe_branch_protection).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.enterprise_readiness import REQUIRED_MERGE_STATUS_CHECKS
from aria_kernel.ledger_refs import find_row_by_source_ledger_ref
from aria_kernel.readiness_proofs import (
    BP_SNAPSHOTS_LEDGER_PATH,
    produce_branch_protection_proof,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _strong_payload() -> dict:
    return {
        "required_status_checks": {"contexts": list(REQUIRED_MERGE_STATUS_CHECKS)},
        "required_signatures": {"enabled": True},
        "required_pull_request_reviews": {"required_approving_review_count": 1},
        "required_conversation_resolution": {"enabled": True},
        "allow_force_pushes": {"enabled": False},
        "allow_deletions": {"enabled": False},
        "enforce_admins": {"enabled": True},
    }


def _probe_for(payload, ok=True, reasons=()):
    def probe(*, branch, repo):
        return ok, tuple(reasons), payload

    return probe


def _rules(ruleset_ids=(101,), bypass_actors=()):
    def rules_probe(*, repo, branch):
        return list(ruleset_ids), list(bypass_actors)

    return rules_probe


class BranchProtectionProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.binding = dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40, base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_strong_protection_yields_valid_proof_with_resolvable_source(self) -> None:
        report = produce_branch_protection_proof(
            **self.binding,
            probe=_probe_for(_strong_payload()),
            rules_probe=_rules(),
        )
        proof = report["proof"]
        self.assertTrue(proof["valid"])
        self.assertEqual(sorted(proof["required_checks"]), sorted(REQUIRED_MERGE_STATUS_CHECKS))
        self.assertTrue(proof["signed_commits_required"])
        self.assertTrue(proof["force_push_disabled"])
        self.assertEqual(proof["bypass_actors"], [])
        self.assertEqual(proof["ruleset_ids"], [101])
        # the source ref RESOLVES to the snapshot row
        resolved = find_row_by_source_ledger_ref(
            self.tools, proof["source_ledger_ref"],
        )
        self.assertEqual(resolved["payload_hash"], proof["snapshot_hash"])
        self.assertTrue((self.tools / BP_SNAPSHOTS_LEDGER_PATH).exists())

    def test_weak_protection_is_recorded_honestly_not_hidden(self) -> None:
        weak = _strong_payload()
        weak["allow_force_pushes"] = {"enabled": True}
        weak["required_status_checks"] = {"contexts": ["merge-gate"]}
        report = produce_branch_protection_proof(
            **self.binding,
            probe=_probe_for(weak, ok=False, reasons=("force_pushes_enabled",)),
            rules_probe=_rules(),
        )
        proof = report["proof"]
        self.assertFalse(proof["valid"])
        self.assertFalse(proof["force_push_disabled"])
        self.assertEqual(proof["required_checks"], ["merge-gate"])
        self.assertIn("force_pushes_enabled", proof["probe_reasons"])

    def test_bypass_actors_are_recorded_verbatim(self) -> None:
        report = produce_branch_protection_proof(
            **self.binding,
            probe=_probe_for(_strong_payload()),
            rules_probe=_rules(bypass_actors=({"actor_id": 9, "actor_type": "Team"},)),
        )
        self.assertEqual(report["proof"]["bypass_actors"], [{"actor_id": 9, "actor_type": "Team"}])

    def test_probe_without_payload_fails_closed(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "probe_no_payload"):
            produce_branch_protection_proof(
                **self.binding,
                probe=_probe_for(None, ok=False, reasons=("gh_token_absent",)),
                rules_probe=_rules(),
            )

    def test_binding_fields_are_required(self) -> None:
        bad = dict(self.binding)
        bad["head_sha"] = " "
        with self.assertRaisesRegex(GovernanceError, "binding_required:head_sha"):
            produce_branch_protection_proof(
                **bad, probe=_probe_for(_strong_payload()), rules_probe=_rules(),
            )

    def test_single_probe_invariant(self) -> None:
        # İ1 — verify_branch_protection must be a projection of
        # probe_branch_protection, not a second gh-api implementation.
        import inspect

        from aria_kernel import preflight

        source = inspect.getsource(preflight.verify_branch_protection)
        self.assertIn("probe_branch_protection", source)
        self.assertNotIn("subprocess.run", source)


if __name__ == "__main__":
    unittest.main()
