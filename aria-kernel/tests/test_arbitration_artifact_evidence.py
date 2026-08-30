"""ORPHAN-CRITICAL-734 — an arbiter may cite the verdicts it arbitrates.

Measured live (drain 32212069072, 2026-08-19 06:22): the consensus
arbiter's entire job is to weigh two judge envelopes, the kernel hands it
their artifact paths, and every submit died
`evidence_ref_not_repo_verified: …:worktree_candidate` — the third
mint-vs-law contradiction of this class (ORPHAN-708 pointer, ORPHAN-719
compliance grader, now the artifact).

"Agent output is untrusted" survives intact for ordinary claims. What the
law now says is narrower and true: a role whose SUBJECT is another
agent's verdict may cite that verdict, and admissibility is decided by
the strongest available proof — the artifact must be a kernel-RECORDED
result whose bytes still hash to the ledger row.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import evidence_validator as ev


class _ArtifactCase(unittest.TestCase):
    def setUp(self) -> None:
        # A REAL store, built the way the kernel builds it: the results
        # ledger is a declared surface, and a hand-made directory is not
        # one — the loader is right to refuse it, so the fixture must be
        # production-shaped rather than the loader made lenient.
        from aria_kernel.tool_registry import ensure_tools_dir

        self._tmp = tempfile.TemporaryDirectory(prefix="aria-734-")
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        (self.tools / "agent-invocations" / "outputs" / "general").mkdir(parents=True)
        self.artifact = (
            self.tools / "agent-invocations" / "outputs" / "general" / "judge.md"
        )
        self.artifact.write_text("verdict: true_positive\n", encoding="utf-8")
        self.rel = str(self.artifact.relative_to(self.root))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _record(self, *, digest: str | None = None, output_path: str | None = None) -> None:
        real = "sha256:" + hashlib.sha256(self.artifact.read_bytes()).hexdigest()
        row = {
            "schema_version": 1,
            "$schema": "aria/agent-claim-result/v1",
            "request_id": "AIR-judge-1",
            "output_path": output_path or str(self.artifact),
            "output_hash": digest or real,
            "status": "accepted",
        }
        from aria_kernel.ledger import append_declared_jsonl

        append_declared_jsonl(
            self.tools / "agent-invocations" / "results.jsonl",
            row,
            expected_surface="agent_invocation_results",
        )

    def _verdict(self, role: str) -> dict:
        return ev.validate_agent_response_evidence(
            response={
                "evidence_refs": [self.rel],
                "satisfaction_matrix": [],
            },
            workspace_root=self.root,
            request={
                "role": role,
                "allowed_scope": ["**"],
                "must_satisfy": [{"id": "x", "criterion": "y"}],
                "allow_empty_satisfaction_matrix": True,
                "evidence_refs": [self.rel],
            },
        )


class ArbitrationMayCiteWhatItArbitrates(_ArtifactCase):
    def test_recorded_artifact_is_admissible_for_an_arbitration_role(self) -> None:
        self._record()
        result = self._verdict("consensus_arbitration")
        self.assertTrue(result["valid"], result["errors"])

    def test_the_same_ref_is_still_inadmissible_for_an_ordinary_role(self) -> None:
        # The old law, unchanged where it was right: an adapter or judge
        # may not cite ARIA's own output as proof of a repo fact.
        self._record()
        result = self._verdict("evidence_judgment")
        self.assertFalse(result["valid"])

    def test_an_unrecorded_artifact_is_refused(self) -> None:
        # No results row vouches for it — inventing a path under outputs/
        # must not become a way to fabricate evidence.
        result = self._verdict("consensus_arbitration")
        self.assertFalse(result["valid"])

    def test_a_tampered_artifact_is_refused_by_name(self) -> None:
        self._record()
        self.artifact.write_text("verdict: false_positive\n", encoding="utf-8")
        result = self._verdict("consensus_arbitration")
        self.assertFalse(result["valid"])
        codes = {error.get("code") for error in result["errors"]}
        reasons = {error.get("reason") for error in result["errors"]}
        self.assertIn("agent_evidence_artifact_unverifiable", codes)
        self.assertIn("artifact_hash_mismatch", reasons)

    def test_arbitration_roles_are_a_closed_set(self) -> None:
        # Widening this set widens who may cite agent output; the closed
        # spelling is what makes that a visible decision.
        self.assertEqual(
            ev.ARBITRATION_ROLES,
            frozenset({"consensus_arbitration", "human_required_adjudication"}),
        )


if __name__ == "__main__":
    unittest.main()
