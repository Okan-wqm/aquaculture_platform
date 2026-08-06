"""Wave 3 Twin-lite — the repository map is built once and refreshed by diff.

The acceptance bar that matters (PLAN §43 test 9): an INCREMENTAL refresh must
equal a CLEAN rebuild at the same commit. A map that drifts from what a rebuild
would say is worse than no map — consumers would trust a stale picture with a
fresh timestamp.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.twin import (
    TWIN_MAP_RELPATH,
    build_twin_map,
    read_twin_map,
    refresh_twin_map,
    twin_context_for_files,
    twin_status,
)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True
    ).stdout


def _commit_all(repo: Path, message: str) -> str:
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=twin@test", "-c", "user.name=twin", "commit", "-m", message, "--no-verify")
    return _git(repo, "rev-parse", "HEAD").strip()


def _comparable(twin: dict) -> dict:
    return {
        key: twin[key]
        for key in ("indexed_sha", "projects", "tested_by", "churn", "co_change")
    }


class TwinMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.repo = Path(self._tmpdir.name) / "repo"
        self.tools = Path(self._tmpdir.name) / "aria-tools"
        (self.repo / "apps" / "alpha" / "src").mkdir(parents=True)
        (self.repo / "libs" / "core" / "src").mkdir(parents=True)
        _git(self.repo.parent, "init", "-q", self.repo.name)
        (self.repo / "libs" / "core" / "src" / "util.ts").write_text(
            "export const util = 1;\n", encoding="utf-8"
        )
        (self.repo / "apps" / "alpha" / "src" / "main.ts").write_text(
            "import { util } from '@aqua/core';\nexport const main = util;\n", encoding="utf-8"
        )
        (self.repo / "apps" / "alpha" / "src" / "main.spec.ts").write_text(
            "import { main } from './main';\nexport const spec = main;\n", encoding="utf-8"
        )
        self.first_sha = _commit_all(self.repo, "first: alpha imports core, main has a spec")

    def test_build_captures_all_four_layers(self) -> None:
        twin = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(twin["indexed_sha"], self.first_sha)
        self.assertIn("alpha", twin["projects"])
        self.assertIn("core", twin["projects"])
        self.assertIn("core", twin["projects"]["alpha"]["depends_on"])
        self.assertIn("alpha", twin["projects"]["core"]["dependents"])
        self.assertEqual(
            twin["tested_by"]["apps/alpha/src/main.ts"], ["apps/alpha/src/main.spec.ts"]
        )
        # RECURRENCE is the signal: a single commit is a one-off, so
        # neither churn nor co-change records it (both filter at count >= 2).
        self.assertNotIn("apps/alpha/src/main.ts", twin["churn"])
        pairs = {(a, b) for a, b, _ in twin["co_change"]}
        self.assertNotIn(("apps/alpha/src/main.spec.ts", "apps/alpha/src/main.ts"), pairs)
        self.assertTrue((self.tools / TWIN_MAP_RELPATH).exists())

    def test_incremental_refresh_equals_clean_rebuild(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        # Second commit: change main + spec together (co-change count → 2),
        # add a brand-new tested module in core.
        (self.repo / "apps" / "alpha" / "src" / "main.ts").write_text(
            "import { util } from '@aqua/core';\nexport const main = util + 1;\n", encoding="utf-8"
        )
        (self.repo / "apps" / "alpha" / "src" / "main.spec.ts").write_text(
            "import { main } from './main';\nexport const spec = main + 1;\n", encoding="utf-8"
        )
        (self.repo / "libs" / "core" / "src" / "extra.ts").write_text(
            "export const extra = 2;\n", encoding="utf-8"
        )
        (self.repo / "libs" / "core" / "src" / "extra.spec.ts").write_text(
            "import { extra } from './extra';\nexport const spec = extra;\n", encoding="utf-8"
        )
        _commit_all(self.repo, "second: main+spec together, new tested core module")

        incremental = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(incremental["refresh"]["mode"], "incremental")

        clean_tools = Path(self._tmpdir.name) / "clean-tools"
        rebuild = build_twin_map(workspace_root=self.repo, base_dir=clean_tools)

        self.assertEqual(_comparable(incremental), _comparable(rebuild))
        pair = ["apps/alpha/src/main.spec.ts", "apps/alpha/src/main.ts"]
        self.assertIn(pair + [2], rebuild["co_change"])
        self.assertEqual(rebuild["churn"]["apps/alpha/src/main.ts"], 2)

    def test_refresh_without_prior_map_is_a_full_build_and_says_so(self) -> None:
        twin = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(twin["refresh"], {"mode": "full", "reason": "no_prior_map"})

    def test_refresh_at_head_is_a_noop(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        twin = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(twin["refresh"]["mode"], "noop")

    def test_status_reports_staleness_in_commits(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        (self.repo / "libs" / "core" / "src" / "util.ts").write_text(
            "export const util = 9;\n", encoding="utf-8"
        )
        _commit_all(self.repo, "third: bump util")
        status = twin_status(workspace_root=self.repo, base_dir=self.tools)
        self.assertTrue(status["present"])
        self.assertFalse(status["fresh"])
        self.assertEqual(status["commits_behind"], 1)

    def test_context_is_read_from_the_map_not_the_repo(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        twin = read_twin_map(base_dir=self.tools)
        context = twin_context_for_files(twin, ["apps/alpha/src/main.ts"])
        entry = context["files"][0]
        self.assertEqual(entry["project"], "alpha")
        self.assertEqual(entry["tests"], ["apps/alpha/src/main.spec.ts"])
        impacted = dict(context["impacted_projects"])
        self.assertIn("alpha", impacted)

    def test_map_json_is_deterministic_bytes_for_same_tree(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        first = json.loads((self.tools / TWIN_MAP_RELPATH).read_text(encoding="utf-8"))
        second_tools = Path(self._tmpdir.name) / "tools2"
        build_twin_map(workspace_root=self.repo, base_dir=second_tools)
        second = json.loads((second_tools / TWIN_MAP_RELPATH).read_text(encoding="utf-8"))
        first.pop("generated_at")
        second.pop("generated_at")
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
