"""ARIA-HIGH-022 — the evidence-target override contract.

Implementer agents cite the POST-FIX lines of files they changed. Graded
against the request's base SHA, every genuine fix classified
worktree_candidate and the submit was rejected — 13/13 challenger envelopes
died exactly there. The override grounds verification at the agent's
committed HEAD, and these tests pin the three properties that make it
honest:

* a ref to an agent-CHANGED file verifies at the agent HEAD (repo_verified);
* a ref to an UNTOUCHED file still verifies (identical blob, descendant);
* an override that does not descend from the request base is refused
  loudly at submit — never silently downgraded to a weaker anchor.
"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

import sys
_PARENT = Path(__file__).resolve().parents[1]
if str(_PARENT.parent) not in sys.path:
    sys.path.insert(0, str(_PARENT.parent))

from aria_kernel.evidence_validator import (  # noqa: E402
    _request_target_sha,
    validate_agent_response_evidence,
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def _repo(base: tempfile.TemporaryDirectory, tag: str) -> tuple[Path, str, str, str]:
    """root -> base -> agent-fix. Returns (repo, root_sha, base_sha, head_sha).

    root exists so a NOT-descendant case is provable IN the same repo: the
    root commit precedes base, so base is not its ancestor.
    """
    repo = Path(base.name) / f"repo-{tag}"
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "--initial-branch=main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "test")
    (repo / "root.txt").write_text(f"root {tag}\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "root")
    root_sha = _git(repo, "rev-parse", "HEAD")
    (repo / "touched.py").write_text("BASE = 1\n", encoding="utf-8")
    (repo / "untouched.py").write_text("SAME = 1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    base_sha = _git(repo, "rev-parse", "HEAD")
    (repo / "touched.py").write_text("BASE = 1\nFIX = 2\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "agent fix")
    head_sha = _git(repo, "rev-parse", "HEAD")
    return repo, root_sha, base_sha, head_sha


class EvidenceTargetOverride(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo, _, self.base_sha, self.head_sha = _repo(self._tmp, "a")
        self.addCleanup(self._tmp.cleanup)

    def _response(self, ref: str) -> dict:
        return {"evidence_refs": [ref], "satisfaction_matrix": [{"id": "x", "verdict": "satisfied"}]}

    def test_changed_file_against_base_is_worktree_candidate(self) -> None:
        """The pre-fix behaviour, pinned: post-edit content cannot match the
        pre-edit blob — this is the rejection 13/13 envelopes died on."""
        out = validate_agent_response_evidence(
            response=self._response("touched.py:2"),
            workspace_root=self.repo,
            request={"target_sha": self.base_sha, "must_satisfy": ["x"], "allowed_scope": ["*.py"]},
        )
        self.assertFalse(out["valid"])

    def test_changed_file_verifies_at_agent_head(self) -> None:
        out = validate_agent_response_evidence(
            response=self._response("touched.py:2"),
            workspace_root=self.repo,
            request={
                "target_sha": self.base_sha,
                "evidence_target_sha": self.head_sha,
                "must_satisfy": ["x"],
                "allowed_scope": ["*.py"],
            },
        )
        self.assertEqual(out["errors"], [])
        self.assertTrue(out["valid"])

    def test_untouched_file_still_verifies_at_agent_head(self) -> None:
        out = validate_agent_response_evidence(
            response=self._response("untouched.py:1"),
            workspace_root=self.repo,
            request={
                "target_sha": self.base_sha,
                "evidence_target_sha": self.head_sha,
                "must_satisfy": ["x"],
                "allowed_scope": ["*.py"],
            },
        )
        self.assertEqual(out["errors"], [])
        self.assertTrue(out["valid"])

    def test_override_wins_over_base_in_resolver(self) -> None:
        self.assertEqual(
            _request_target_sha({"target_sha": "b" * 40, "evidence_target_sha": "a" * 40}),
            "a" * 40,
        )
        self.assertEqual(_request_target_sha({"target_sha": "b" * 40}), "b" * 40)
        self.assertIsNone(_request_target_sha(None))


class DescentProof(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo, self.root_sha, self.base_sha, self.head_sha = _repo(self._tmp, "a")
        self.addCleanup(self._tmp.cleanup)

    def _call(self, override: str):
        from aria_kernel.agent_invocations import _verified_evidence_target_sha
        return _verified_evidence_target_sha(
            workspace_root=self.repo,
            request={"target_sha": self.base_sha},
            override=override,
        )

    def test_descendant_passes(self) -> None:
        self.assertEqual(self._call(self.head_sha), self.head_sha)

    def test_unknown_commit_refused(self) -> None:
        from aria_kernel.tool_registry import GovernanceError
        with self.assertRaises(GovernanceError) as ctx:
            self._call("f" * 40)
        self.assertIn("unknown_commit", str(ctx.exception))

    def test_non_descendant_commit_refused(self) -> None:
        """The root commit EXISTS in this repo but base is not its ancestor —
        a submitter trying to grade evidence against a tree the request's
        history never reached."""
        from aria_kernel.tool_registry import GovernanceError
        with self.assertRaises(GovernanceError) as ctx:
            self._call(self.root_sha)
        self.assertIn("not_descendant_of_base", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
