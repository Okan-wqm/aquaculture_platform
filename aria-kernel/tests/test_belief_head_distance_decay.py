"""M6/E6 — ARIA remembers what OTHERS did to the repo.

Pre-E6 the only belief-staleness triggers were the FATES-hash cycle-diff
(discovery-run only) and the wall-clock TTL. Neither notices when someone
ELSE merges a change to a file a belief depends on: live, 3 beliefs sat
`supported` at confidence 1.0 anchored 102 commits behind HEAD. This pins
the head-distance trigger: a belief whose evidence file was changed by any
commit since its anchor is revalidated, regardless of who changed it.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.memory import decay_beliefs_by_head_distance
from aria_kernel.tool_registry import ensure_tools_dir


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


class BeliefHeadDistanceDecayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "apps" / "svc").mkdir(parents=True)
        (self.repo / "apps" / "svc" / "a.ts").write_text("export const a = 1;\n")
        (self.repo / "apps" / "svc" / "b.ts").write_text("export const b = 1;\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        _git(self.repo, "config", "user.email", "t@t")
        _git(self.repo, "config", "user.name", "t")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "seed")
        self.anchor = _git(self.repo, "rev-parse", "HEAD")
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed_belief(self, belief_id: str, evidence: list[str], base_sha: str, status: str = "supported") -> None:
        from aria_kernel.memory import append_jsonl
        append_jsonl(
            self.tools / "memory" / "beliefs.jsonl",
            {
                "schema_version": 1,
                "belief_id": belief_id,
                "claim": f"{belief_id} claim",
                "evidence_refs": evidence,
                "confidence": 1.0,
                "status": status,
                "base_commit_sha": base_sha,
                "verified_at": "2026-08-05T00:00:00Z",
                "needs_revalidation_cycles": 0,
            },
        )

    def _latest(self, belief_id: str) -> dict:
        from aria_kernel.memory import latest_beliefs, load_jsonl
        rows = latest_beliefs(load_jsonl(self.tools / "memory" / "beliefs.jsonl"))
        return next(b for b in rows if b.get("belief_id") == belief_id)

    def test_belief_revalidated_when_others_change_its_evidence(self) -> None:
        self._seed_belief("B-touched", ["apps/svc/a.ts"], self.anchor)
        # Someone else advances the repo, changing a.ts.
        (self.repo / "apps" / "svc" / "a.ts").write_text("export const a = 2;\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "someone-else touches a.ts")

        result = decay_beliefs_by_head_distance(
            cycle_id="cyc-1", repo_root=self.repo, base_dir=self.tools
        )
        self.assertEqual(result["revalidated_count"], 1)
        self.assertEqual(self._latest("B-touched")["status"], "needs_revalidation")

    def test_belief_untouched_stays_supported(self) -> None:
        self._seed_belief("B-stable", ["apps/svc/b.ts"], self.anchor)
        # Change a DIFFERENT file — b.ts is untouched.
        (self.repo / "apps" / "svc" / "a.ts").write_text("export const a = 3;\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "change a.ts only")

        result = decay_beliefs_by_head_distance(
            cycle_id="cyc-1", repo_root=self.repo, base_dir=self.tools
        )
        self.assertEqual(result["revalidated_count"], 0)
        self.assertEqual(self._latest("B-stable")["status"], "supported")

    def test_glob_belief_revalidated_when_any_member_changes(self) -> None:
        self._seed_belief("B-glob", ["apps/svc/*.ts"], self.anchor)
        (self.repo / "apps" / "svc" / "b.ts").write_text("export const b = 99;\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "change a class member")

        result = decay_beliefs_by_head_distance(
            cycle_id="cyc-1", repo_root=self.repo, base_dir=self.tools
        )
        self.assertEqual(result["revalidated_count"], 1)

    def test_no_movement_no_revalidation(self) -> None:
        # Anchor == HEAD; nothing changed.
        self._seed_belief("B-fresh", ["apps/svc/a.ts"], self.anchor)
        result = decay_beliefs_by_head_distance(
            cycle_id="cyc-1", repo_root=self.repo, base_dir=self.tools
        )
        self.assertEqual(result["revalidated_count"], 0)


if __name__ == "__main__":
    unittest.main()
