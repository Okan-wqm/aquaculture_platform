"""ADR-0019 / ARIA-HIGH-256 — failing CI ranks only workflows whose verdict is about main.

Pre-fix ``scan_failing_ci`` supplied a candidate for every workflow red on
``main``, whatever that workflow judges, and failing_ci outranks every finding
source. On 2026-10-02 eight workflows were red; watchdogs that only echo other
runs and a pull-request verdict outranked every F finding ARIA holds. These
pins cover the role manifest's three roles, an undeclared workflow, the
manifest missing or malformed, the per-cycle disclosure of each exclusion, and
the anchored read (the manifest as committed on main, not the working tree).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import plan_synthesizer as _ps
from aria_kernel.tool_registry import ensure_tools_dir, load_jsonl
from tests._helpers.git_fixtures import make_local_git_repo

_REPO_ROOT = Path(__file__).resolve().parents[2]
_REAL_RUN = subprocess.run
_REAL_WHICH = shutil.which
_FAKE_GH = "/fake/bin/gh"

_OBSERVER = "Scheduled Workflow Watchdog"
_PR_VERDICT = "aria-readiness-claim"
_MAIN_VERDICT = "Database WAL Archive Freshness"


def _run(run_id: int, workflow_id: int, workflow: str, created_at: str) -> dict[str, Any]:
    return {
        "databaseId": run_id, "workflowDatabaseId": workflow_id, "workflowName": workflow,
        "headSha": f"sha{run_id}", "conclusion": "failure", "createdAt": created_at,
        "event": "schedule",
    }


_RED_ROWS = [
    _run(30, 3, _OBSERVER, "2026-10-02T09:15:00Z"),
    _run(20, 2, _PR_VERDICT, "2026-10-02T08:00:00Z"),
    _run(10, 1, _MAIN_VERDICT, "2026-10-02T07:00:00Z"),
]


def _manifest(roles: dict[str, str]) -> str:
    return json.dumps({"schemaVersion": 1, "workflows": [
        {"workflow": f"wf-{i}.yml", "name": name, "role": role, "reason": "test"}
        for i, (name, role) in enumerate(roles.items())
    ]}, indent=2)


_DECLARED = {_OBSERVER: "observer", _PR_VERDICT: "pr_verdict", _MAIN_VERDICT: "main_verdict"}


class _FailingCiFixture(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.tools = ensure_tools_dir(self.root / "tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_manifest(self, text: str, workspace: Path | None = None) -> None:
        path = (workspace or self.workspace) / _ps.WORKFLOW_ROLES_MANIFEST_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def scan(self, rows: list[dict[str, Any]], *, cycle_id: str,
             workspace: Path | None = None) -> list[dict[str, Any]]:
        """``gh`` is faked; every other command (git, for the anchor) is real.

        The scan is handed a gh path that exists nowhere, so a call the fake
        does not answer fails instead of reaching the real GitHub.
        """
        def fake_run(argv, *args, **kwargs):
            if argv and argv[0] == _FAKE_GH:
                return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(rows), stderr="")
            return _REAL_RUN(argv, *args, **kwargs)

        def fake_which(cmd, *args, **kwargs):
            return _FAKE_GH if cmd == _FAKE_GH else _REAL_WHICH(cmd, *args, **kwargs)

        with mock.patch.object(_ps.subprocess, "run", side_effect=fake_run), \
                mock.patch("shutil.which", side_effect=fake_which), \
                mock.patch.dict(os.environ, {"ARIA_DRY_RUN": ""}):
            return _ps.scan_failing_ci(
                workspace or self.workspace, cache_dir=self.root / "cache", gh_cli=_FAKE_GH,
                base_dir=self.tools, cycle_id=cycle_id,
            )

    def governance(self, kind: str) -> list[dict[str, Any]]:
        return [row["details"] for row in load_jsonl(self.tools / "governance.jsonl")
                if row.get("kind") == kind]


class RoleFilterTests(_FailingCiFixture):
    def setUp(self) -> None:
        super().setUp()
        self.write_manifest(_manifest(_DECLARED))

    def test_a_red_observer_is_excluded_and_logged_once_per_cycle(self) -> None:
        candidates = self.scan(_RED_ROWS, cycle_id="cyc-1")
        self.assertNotIn(_OBSERVER, [c["workflow_name"] for c in candidates])
        # The same cycle scanning again (here from the cache) says nothing new.
        self.scan(_RED_ROWS, cycle_id="cyc-1")
        excluded = [e for e in self.governance(_ps.FAILING_CI_WORKFLOW_EXCLUDED_EVENT)
                    if e["workflow_name"] == _OBSERVER]
        self.assertEqual(len(excluded), 1)
        self.assertEqual(
            {k: excluded[0][k] for k in ("cycle_id", "workflow_name", "role", "run_id")},
            {"cycle_id": "cyc-1", "workflow_name": _OBSERVER, "role": "observer", "run_id": 30},
        )
        self.assertEqual(excluded[0]["manifest_source"], "checkout")
        # The next cycle discloses its own exclusion.
        self.scan(_RED_ROWS, cycle_id="cyc-2")
        cycles = [e["cycle_id"] for e in self.governance(_ps.FAILING_CI_WORKFLOW_EXCLUDED_EVENT)
                  if e["workflow_name"] == _OBSERVER]
        self.assertEqual(cycles, ["cyc-1", "cyc-2"])

    def test_a_red_pr_verdict_is_excluded(self) -> None:
        candidates = self.scan(_RED_ROWS, cycle_id="cyc-1")
        self.assertNotIn(_PR_VERDICT, [c["workflow_name"] for c in candidates])
        excluded = [e for e in self.governance(_ps.FAILING_CI_WORKFLOW_EXCLUDED_EVENT)
                    if e["workflow_name"] == _PR_VERDICT]
        self.assertEqual([(e["role"], e["run_id"]) for e in excluded], [("pr_verdict", 20)])

    def test_a_red_main_verdict_is_a_candidate(self) -> None:
        candidates = self.scan(_RED_ROWS, cycle_id="cyc-1")
        self.assertEqual([c["candidate_id"] for c in candidates], ["ci-run-10"])
        self.assertEqual(candidates[0]["workflow_role"], "main_verdict")
        self.assertTrue(candidates[0]["workflow_role_declared"])
        self.assertEqual(self.governance(_ps.FAILING_CI_WORKFLOW_ROLES_UNAVAILABLE_EVENT), [])

    def test_an_undeclared_red_workflow_is_a_candidate(self) -> None:
        rows = [*_RED_ROWS, _run(40, 4, "Brand New Workflow", "2026-10-02T10:00:00Z")]
        candidates = self.scan(rows, cycle_id="cyc-1")
        self.assertEqual([c["candidate_id"] for c in candidates], ["ci-run-40", "ci-run-10"])
        self.assertEqual(candidates[0]["workflow_role"], "main_verdict")
        self.assertFalse(candidates[0]["workflow_role_declared"])


class ManifestUnavailableTests(_FailingCiFixture):
    def test_a_missing_manifest_keeps_every_red_with_a_governance_warning(self) -> None:
        candidates = self.scan(_RED_ROWS, cycle_id="cyc-1")
        self.scan(_RED_ROWS, cycle_id="cyc-1")
        self.assertEqual([c["candidate_id"] for c in candidates],
                         ["ci-run-30", "ci-run-20", "ci-run-10"])
        self.assertEqual(self.governance(_ps.FAILING_CI_WORKFLOW_EXCLUDED_EVENT), [])
        warnings = self.governance(_ps.FAILING_CI_WORKFLOW_ROLES_UNAVAILABLE_EVENT)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["reason"], "manifest_unavailable")
        self.assertEqual(warnings[0]["red_workflows"], sorted(_DECLARED))

    def test_a_malformed_manifest_excludes_nothing(self) -> None:
        self.write_manifest(_manifest({_OBSERVER: "watcher"}))
        candidates = self.scan(_RED_ROWS, cycle_id="cyc-1")
        self.assertEqual(len(candidates), 3)
        warnings = self.governance(_ps.FAILING_CI_WORKFLOW_ROLES_UNAVAILABLE_EVENT)
        self.assertEqual([w["reason"] for w in warnings], ["manifest_malformed"])


class AnchoredManifestTests(_FailingCiFixture):
    def test_the_manifest_committed_on_main_decides_not_the_working_tree(self) -> None:
        repo = make_local_git_repo(self.root, name="repo")
        self.write_manifest(_manifest(_DECLARED), workspace=repo)
        for argv in (["add", "--", _ps.WORKFLOW_ROLES_MANIFEST_PATH],
                     ["commit", "-q", "-m", "chore(test): roles"]):
            _REAL_RUN(["git", *argv], cwd=repo, check=True, capture_output=True)
        head = _REAL_RUN(["git", "rev-parse", "HEAD"], cwd=repo, check=True,
                         capture_output=True, text=True).stdout.strip()
        _REAL_RUN(["git", "update-ref", "refs/remotes/origin/main", head], cwd=repo, check=True)
        # An uncommitted edit that would re-admit the observer is not main's verdict.
        self.write_manifest(_manifest({**_DECLARED, _OBSERVER: "main_verdict"}), workspace=repo)
        candidates = self.scan(_RED_ROWS, cycle_id="cyc-1", workspace=repo)
        self.assertEqual([c["candidate_id"] for c in candidates], ["ci-run-10"])
        excluded = self.governance(_ps.FAILING_CI_WORKFLOW_EXCLUDED_EVENT)
        self.assertEqual({e["manifest_source"] for e in excluded}, {"main_anchor"})
        self.assertEqual({e["manifest_commit"] for e in excluded}, {head})


class RepositoryManifestTests(unittest.TestCase):
    def test_the_committed_manifest_parses_under_the_kernel_roles(self) -> None:
        raw = (_REPO_ROOT / _ps.WORKFLOW_ROLES_MANIFEST_PATH).read_bytes()
        roles = _ps._parse_workflow_roles(raw)
        self.assertIsNotNone(roles)
        self.assertEqual(roles[_OBSERVER], "observer")
        self.assertEqual(roles[_PR_VERDICT], "pr_verdict")
        # ADR-0019: a workflow_run-triggered lane still judges main. The post-deploy
        # "E2E Tests" lane this pinned was deleted with the E2E move off the
        # production host (68f120105); the executor is the live lane of that kind.
        self.assertEqual(roles["aria-agent-executor"], "main_verdict")
        self.assertNotIn("E2E Tests", roles)
        self.assertEqual(roles[_MAIN_VERDICT], "main_verdict")


if __name__ == "__main__":
    unittest.main()
