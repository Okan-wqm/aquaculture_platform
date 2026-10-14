"""Direct tests for ``evidence_collector.collect_evidence_pack``.

Phase 0's evidence floor had no direct test. These cases run the real
scanner over a one-commit fixture repository: observations must be real
file:line captures tagged with a declared claim class, and the HARD
floor must reject a pack that cannot reach ``min_observations``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_collector import (
    InsufficientEvidenceError,
    collect_evidence_pack,
)
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit


class CollectEvidencePackBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-evidence-")
        self.addCleanup(self._tmp.cleanup)
        # The pack is sealed against a sha that must be reachable from the
        # workspace HEAD, so the fixture is a real committed repository.
        self.workspace = make_repo_with_initial_commit(
            Path(self._tmp.name),
            {"adapter.py": "claim_x = 1\nother = 2\nclaim_x_again = 3\n"},
            name="workspace",
        )
        self.head_sha = _git(["rev-parse", "HEAD"], cwd=self.workspace).stdout.strip()
        self.base_dir = Path(self._tmp.name) / "aria-tools"

    def _collect(self, *, min_observations: int):
        return collect_evidence_pack(
            seed_id="seed-direct-test",
            declared_scope=["."],
            claim_types=["claim_x"],
            workspace_root=self.workspace,
            base_dir=self.base_dir,
            base_commit_sha=self.head_sha,
            min_observations=min_observations,
            persist=False,
        )

    def test_real_scan_produces_tagged_observations(self) -> None:
        pack = self._collect(min_observations=1)
        self.assertEqual(pack["seed_id"], "seed-direct-test")
        self.assertEqual(pack["base_commit_sha"], self.head_sha)
        # The default claim pattern is word-bounded: ``claim_x_again`` on
        # line 3 is a different identifier and must not be captured.
        self.assertEqual(
            pack["observations"],
            [{
                "file_path": "adapter.py",
                "line": 1,
                "snippet": "claim_x = 1",
                "claim_class": "claim_x",
                "discovered_by": "regex",
            }],
        )
        self.assertTrue(pack["observation_hash"])

    def test_insufficient_evidence_floor_is_a_hard_reject(self) -> None:
        with self.assertRaises(InsufficientEvidenceError) as ctx:
            self._collect(min_observations=99)
        self.assertIn("found=1 required=99", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
