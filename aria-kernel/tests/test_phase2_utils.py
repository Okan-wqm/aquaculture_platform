"""Direct tests for ``phase2_utils``.

Six production modules import this carrier (agent_satisfaction, feedback,
report_ingestion, reverify, trailer_scan, trust) and no test imported it.
These cases pin the git boundary — a repository's real HEAD, and None
outside one — and the timestamp writer's shape. Both git cases build their
own ground: a fixture repository, and a plain directory with a git ceiling
above it, so the verdict never depends on where the suite happens to run.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.phase2_utils import git_head, utc_now_iso
from tests._helpers.git_fixtures import _git, make_local_git_repo


class GitHeadBehavior(unittest.TestCase):
    def test_repository_returns_its_head_sha(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-phase2-repo-") as tmp:
            repo = make_local_git_repo(Path(tmp))
            expected = _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()
            self.assertRegex(expected, r"^[0-9a-f]{40}$")
            self.assertEqual(git_head(repo), expected)

    def test_non_repo_returns_none(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-phase2-plain-") as tmp:
            plain = Path(tmp) / "plain"
            plain.mkdir()
            # The ceiling stops git from discovering a repository that merely
            # encloses the temp directory.
            with mock.patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": tmp}):
                self.assertIsNone(git_head(plain))


class UtcNowIsoBehavior(unittest.TestCase):
    def test_shape_is_seconds_precision_z_suffixed(self) -> None:
        stamp = utc_now_iso()
        self.assertRegex(stamp, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        self.assertEqual(parsed.utcoffset(), timezone.utc.utcoffset(None))
        self.assertEqual(parsed.microsecond, 0)


if __name__ == "__main__":
    unittest.main()
