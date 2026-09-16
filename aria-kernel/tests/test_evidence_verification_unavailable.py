"""A verification that could not run is its own grade, not the agent's fault.

`classify_evidence_ref` proves a ref against the committed tree with
`git show <sha>:<path>` (files), `git cat-file -t` (directories) and, for a
glob, one `git show` per match. Each call is bounded. Until this change a
git that did not answer inside the bound — `TimeoutExpired`, or `OSError`
because the binary could not be spawned — was graded exactly like a blob
that does not match: `worktree_candidate`, whose documented meaning is "the
agent's evidence disagrees with the committed tree". That is a claim about
the AGENT, and nothing had been compared.

Observed on the third pre-push suite run of 2026-09-12 (load 6-20 on 4
CPUs): `test_glob_evidence_ref_is_unresolvable_documents_the_bug` graded
`apps/*/src/database/migrations/*.ts` on the live repo `worktree_candidate`
because one of its `git show` calls did not answer in 5 s; green in isolation
on the same code. On the live executor lane the same bound turns a genuine
result into `agent_evidence_not_repo_verified` and burns the request's
requeue budget — the 2026-08-09 `baseline_unavailable` class again (the
harness's gap reported as the agent's fault), one layer down.

Pinned here: the git probes are tri-state (True / False / None = could not
verify), `None` grades `verification_unavailable` for a file, a directory
and a glob, the grade is never resolvable, and the validator names it with
its own codes so the acceptance seam can tell "could not verify" from "did
not match". The probe's own retry, clock and once-per-decision baseline
live in `evidence_probe` and are pinned in `test_evidence_probe_session`.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import evidence_trust
from aria_kernel.evidence_probe import GitProbeSession
from aria_kernel.evidence_trust import (
    REPO_OR_GLOB_VERIFIED_GRADES,
    EvidencePolicy,
    classify_evidence_ref,
)
from aria_kernel.evidence_validator import (
    EVIDENCE_VERIFICATION_UNAVAILABLE_CODES,
    validate_agent_response_evidence,
    validate_tool_output_evidence,
)
from aria_kernel.tool_registry import GovernanceError


# The fake git answers nothing for longer than the bound the test passes.
# `exec` so the sleeping process IS the child `subprocess.run` kills on
# timeout; a shell wrapper left behind would hold the pipes open.
_STALLED_GIT = "#!/bin/sh\nexec sleep 5\n"
# Small, and a REAL parameter of the classifier: the production bounds stay
# what they are, the test only shortens how long a probe waits for the
# stall and how often it retries.
_TEST_GIT_TIMEOUT_SECONDS = 0.2


def _short_session() -> GitProbeSession:
    """A probe session that gives up on a stall quickly — the seam a test
    sizes instead of patching the production bounds."""
    return GitProbeSession(
        attempt_timeout_seconds=_TEST_GIT_TIMEOUT_SECONDS,
        attempts=2,
        backoff_seconds=(0.01,),
        liveness_seconds=5.0,
    )


def _repo_with_one_commit(root: Path) -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=str(root), text=True, capture_output=True, check=True,
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (root / "kept.py").write_text("line one\nline two\n", encoding="utf-8")
    (root / "pkg").mkdir()
    (root / "pkg" / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    (root / "pkg" / "b.ts").write_text("export const b = 2;\n", encoding="utf-8")
    git("add", "kept.py", "pkg/a.ts", "pkg/b.ts")
    git("commit", "-qm", "seed")
    return git("rev-parse", "HEAD")


class _StalledGit:
    """A `git` on PATH that never answers — the host is that slow."""

    def __enter__(self) -> "_StalledGit":
        self._dir = Path(tempfile.mkdtemp(prefix="aria-stalled-git-"))
        fake = self._dir / "git"
        fake.write_text(_STALLED_GIT, encoding="utf-8")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self._env = mock.patch.dict(
            os.environ, {"PATH": f"{self._dir}{os.pathsep}{os.environ.get('PATH', '')}"},
        )
        self._env.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._env.stop()
        shutil.rmtree(self._dir, ignore_errors=True)


class GitProbesAreTriState(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-tristate-"))
        self.sha = _repo_with_one_commit(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_matching_blob_is_true_and_a_changed_one_is_false(self) -> None:
        session = GitProbeSession()
        content_hash = evidence_trust._file_sha256(self.root / "kept.py")
        self.assertIs(
            evidence_trust._git_blob_matches(
                self.root, "kept.py", self.sha, content_hash, session=session,
            ),
            True,
        )
        self.assertIs(
            evidence_trust._git_blob_matches(
                self.root, "kept.py", self.sha, "sha256:" + "0" * 64, session=session,
            ),
            False,
        )
        self.assertIs(
            evidence_trust._git_tree_exists(self.root, "pkg", self.sha, session=session),
            True,
        )
        self.assertIs(
            evidence_trust._git_tree_exists(self.root, "kept.py", self.sha, session=session),
            False,
        )

    def test_a_git_that_does_not_answer_is_none_not_false(self) -> None:
        content_hash = evidence_trust._file_sha256(self.root / "kept.py")
        with _StalledGit():
            blob = evidence_trust._git_blob_matches(
                self.root, "kept.py", self.sha, content_hash, session=_short_session(),
            )
            tree = evidence_trust._git_tree_exists(
                self.root, "pkg", self.sha, session=_short_session(),
            )
        self.assertIsNone(blob)
        self.assertIsNone(tree)


class VerificationUnavailableGrade(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-unavailable-"))
        self.sha = _repo_with_one_commit(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def _grade(self, ref: str) -> str:
        return classify_evidence_ref(
            ref,
            workspace_root=self.root,
            target_sha=self.sha,
            probe_session=_short_session(),
        ).trust_grade

    def test_a_file_a_directory_and_a_glob_grade_verification_unavailable(self) -> None:
        with _StalledGit():
            grades = {
                "file": self._grade("kept.py:1"),
                "directory": self._grade("pkg"),
                "glob": self._grade("pkg/*.ts"),
            }
        self.assertEqual(
            grades,
            {
                "file": "verification_unavailable",
                "directory": "verification_unavailable",
                "glob": "verification_unavailable",
            },
        )

    def test_the_same_refs_verify_when_git_answers(self) -> None:
        # The grade is about the PROBE, not the refs: with git answering the
        # very same refs are the committed tree.
        self.assertEqual(self._grade("kept.py:1"), "repo_verified")
        self.assertEqual(self._grade("pkg"), "repo_verified")
        self.assertEqual(self._grade("pkg/*.ts"), "repo_glob_verified")

    def test_a_genuinely_modified_file_is_still_worktree_candidate(self) -> None:
        # The distinction must not swallow the case it was carved out of.
        (self.root / "kept.py").write_text("line one\nCHANGED\n", encoding="utf-8")
        self.assertEqual(self._grade("kept.py:2"), "worktree_candidate")

    def test_it_is_never_resolvable(self) -> None:
        with _StalledGit():
            envelope = classify_evidence_ref(
                "kept.py:1",
                workspace_root=self.root,
                target_sha=self.sha,
                probe_session=_short_session(),
            )
        self.assertNotIn("verification_unavailable", REPO_OR_GLOB_VERIFIED_GRADES)
        with self.assertRaisesRegex(GovernanceError, "verification_unavailable"):
            EvidencePolicy.require_repo_verified(envelope)
        with self.assertRaisesRegex(GovernanceError, "verification_unavailable"):
            EvidencePolicy.require_repo_or_glob_verified(envelope)

    def test_the_envelope_hash_covers_the_grade(self) -> None:
        # Two envelopes for one ref that differ only in whether the probe
        # ran must not hash alike: the grade is part of the sealed claim.
        verified = classify_evidence_ref("kept.py:1", workspace_root=self.root, target_sha=self.sha)
        with _StalledGit():
            unavailable = classify_evidence_ref(
                "kept.py:1",
                workspace_root=self.root,
                target_sha=self.sha,
                probe_session=_short_session(),
            )
        self.assertNotEqual(verified.envelope_hash, unavailable.envelope_hash)


class TheValidatorNamesIt(unittest.TestCase):
    """The validator maps the grade to its own codes on both evidence
    sources, mirroring the `baseline_unavailable` split: a rejection still
    happens (nothing was verified), under a name that says whose gap it is.
    The seam under test is the tri-state probe, so it is stubbed at that
    seam rather than through a stalled binary — the classifier tests above
    already prove the binary path."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-validator-unavailable-"))
        self.sha = _repo_with_one_commit(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_the_code_set_is_exactly_the_two_sources(self) -> None:
        self.assertEqual(
            EVIDENCE_VERIFICATION_UNAVAILABLE_CODES,
            frozenset({
                "tool_output_evidence_verification_unavailable",
                "agent_evidence_verification_unavailable",
            }),
        )

    def test_tool_output_evidence_gets_its_own_code(self) -> None:
        tool = {
            "tool_id": "fake",
            "kind": "adapter",
            "version": "0.1.0",
            "status": "SHADOW",
            "declared_scope": ["**/*.py"],
            "allowed_read_globs": ["**/*.py"],
            "forbidden_read_globs": [".git/**"],
        }
        output = {
            "observations": [],
            "findings": [{"id": "f1", "evidence": [{"path": "kept.py", "line": 1}]}],
            "read_paths": ["kept.py"],
            "evidence_sources": ["kept.py"],
        }
        with mock.patch.object(evidence_trust, "_git_blob_matches", return_value=None):
            result = validate_tool_output_evidence(
                tool,
                output,
                self.root,
                repo_snapshot={
                    "snapshot_mode": "committed",
                    "base_commit_sha": self.sha,
                    "allowed_paths": ["kept.py"],
                },
            )
        codes = [e.get("code") for e in result["errors"]]
        self.assertIn("tool_output_evidence_verification_unavailable", codes)
        self.assertNotIn("tool_output_evidence_not_repo_verified", codes)
        self.assertNotIn("tool_output_evidence_baseline_unavailable", codes)

    def test_agent_evidence_gets_its_own_code(self) -> None:
        response = {
            "evidence_refs": ["kept.py:1"],
            "satisfaction_matrix": [{"id": "S1", "evidence_refs": ["kept.py:2"]}],
        }
        request = {"target_sha": self.sha, "allowed_scope": ["**"]}
        with mock.patch.object(evidence_trust, "_git_blob_matches", return_value=None):
            result = validate_agent_response_evidence(
                response=response, workspace_root=self.root, request=request,
            )
        codes = [e.get("code") for e in result["errors"]]
        self.assertFalse(result["valid"])
        self.assertEqual(
            codes,
            [
                "agent_evidence_verification_unavailable",
                "agent_evidence_verification_unavailable",
            ],
        )
        for error in result["errors"]:
            self.assertIn("verification_unavailable", error["reason"])

    def test_a_missing_baseline_on_the_agent_side_has_the_mirrored_name(self) -> None:
        # The split the tool side already had, completed on the side the
        # 2026-08-09 incident actually came from.
        response = {
            "evidence_refs": ["kept.py:1"],
            "satisfaction_matrix": [{"id": "S1", "evidence_refs": ["kept.py:1"]}],
        }
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.root, request={"allowed_scope": ["**"]},
        )
        codes = {e.get("code") for e in result["errors"]}
        self.assertEqual(codes, {"agent_evidence_baseline_unavailable"})

    def test_a_disagreeing_file_keeps_the_agent_fault_code(self) -> None:
        (self.root / "kept.py").write_text("line one\nCHANGED\n", encoding="utf-8")
        response = {
            "evidence_refs": ["kept.py:2"],
            "satisfaction_matrix": [{"id": "S1", "evidence_refs": ["kept.py:2"]}],
        }
        request = {"target_sha": self.sha, "allowed_scope": ["**"]}
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.root, request=request,
        )
        codes = {e.get("code") for e in result["errors"]}
        self.assertEqual(codes, {"agent_evidence_not_repo_verified"})


if __name__ == "__main__":
    unittest.main()
