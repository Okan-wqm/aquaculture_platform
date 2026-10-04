"""The nightly drift scan gets HEAD's exact supergraph or none (ARIA-HIGH-333).

The scan judges UI option lists against GraphQL wire values read from the composed supergraph. The production host
does not compose one, so fetch_supergraph.py takes the artifact CI composed — only from a main run that contains the
newest schema-affecting commit and is itself contained in HEAD. A run older than the schema commit, or one off HEAD's
line, would hand the scan a different schema; those are refused.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fetch_supergraph as fs  # noqa: E402

WORKFLOW = """name: x
on:
  push:
    branches: [main]
    paths:
      - 'apps/**/*.resolver.ts'
      # comments between globs must not end the list
      - 'web/**/*.ts'
  pull_request:
    paths:
      - 'ignored/**'
jobs: {}
"""


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def _commit(repo: Path, path: str, text: str) -> str:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    _git(repo, "add", path)
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", path)
    return _git(repo, "rev-parse", "HEAD")


class PushPaths(unittest.TestCase):
    def test_reads_every_push_glob_across_comments_and_ignores_other_triggers(self) -> None:
        self.assertEqual(fs.push_paths(WORKFLOW), ["apps/**/*.resolver.ts", "web/**/*.ts"])

    def test_reads_the_real_workflow(self) -> None:
        real = Path(__file__).resolve().parents[3] / fs.WORKFLOW
        paths = fs.push_paths(real.read_text(encoding="utf-8"))
        self.assertIn("apps/**/*.resolver.ts", paths)
        self.assertIn("web/**/*.tsx", paths)


class PickRun(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-sg-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        _git(self.repo, "init", "-q", "-b", "main")
        self.before = _commit(self.repo, "apps/a/x.resolver.ts", "1")
        self.schema = _commit(self.repo, "apps/a/x.resolver.ts", "2")
        self.after = _commit(self.repo, "docs/readme.md", "3")

    def run_row(self, sha: str, created: str, conclusion: str = "success") -> dict:
        return {"databaseId": created, "headSha": sha, "conclusion": conclusion, "createdAt": created}

    def test_the_schema_commit_is_the_newest_one_touching_the_paths(self) -> None:
        self.assertEqual(fs.schema_commit(self.repo, ["apps/**/*.resolver.ts"]), self.schema)

    def test_a_run_on_the_schema_commit_or_a_later_main_commit_qualifies(self) -> None:
        runs = [self.run_row(self.schema, "1"), self.run_row(self.after, "2")]
        self.assertEqual(fs.pick_run(runs, self.schema, self.repo)["headSha"], self.after)

    def test_a_run_older_than_the_schema_commit_is_refused(self) -> None:
        self.assertIsNone(fs.pick_run([self.run_row(self.before, "9")], self.schema, self.repo))

    def test_a_failed_run_or_a_head_off_this_line_is_refused(self) -> None:
        _git(self.repo, "checkout", "-q", "-b", "side", self.schema)
        side = _commit(self.repo, "apps/a/x.resolver.ts", "side")
        _git(self.repo, "checkout", "-q", "main")
        runs = [self.run_row(self.after, "5", "failure"), self.run_row(side, "6")]
        self.assertIsNone(fs.pick_run(runs, self.schema, self.repo))


if __name__ == "__main__":
    unittest.main()
