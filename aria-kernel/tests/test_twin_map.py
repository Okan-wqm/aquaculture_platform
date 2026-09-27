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

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.twin import (
    HISTORY_UNAVAILABLE,
    SHALLOW_CHECKOUT_REFUSAL,
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

    def test_changed_surviving_test_replaces_previous_source_association(self) -> None:
        source_a = "apps/alpha/src/main.ts"
        source_b = "apps/alpha/src/other.ts"
        test_rel = "apps/alpha/src/routing.spec.ts"
        (self.repo / source_b).write_text("export const other = 2;\n", encoding="utf-8")
        (self.repo / test_rel).write_text(
            "import { main } from './main';\nexport const spec = main;\n", encoding="utf-8"
        )
        _commit_all(self.repo, "fixture: neutral spec initially imports main")
        initial = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertIn(test_rel, initial["tested_by"][source_a])
        self.assertNotIn(test_rel, initial["tested_by"].get(source_b, []))

        (self.repo / test_rel).write_text(
            "import { other } from './other';\nexport const spec = other;\n", encoding="utf-8"
        )
        _commit_all(self.repo, "fixture: surviving spec switches its source import")
        incremental = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        persisted = read_twin_map(base_dir=self.tools)
        rebuilt = build_twin_map(
            workspace_root=self.repo, base_dir=Path(self._tmpdir.name) / "clean-tools"
        )
        self.assertEqual(incremental["refresh"]["mode"], "incremental")
        self.assertEqual(incremental["tested_by"][source_b], [test_rel])
        self.assertIn("apps/alpha/src/main.spec.ts", incremental["tested_by"][source_a])
        self.assertNotIn(test_rel, incremental["tested_by"][source_a])
        self.assertEqual(persisted, incremental)
        self.assertEqual(_comparable(incremental), _comparable(rebuilt))

    def test_source_addition_re_resolves_an_unchanged_importing_test(self) -> None:
        test_rel = "apps/alpha/src/routing.spec.ts"
        old_source = "apps/alpha/src/target.tsx"
        new_source = "apps/alpha/src/target.ts"
        test_body = "import { target } from './target';\nexport const spec = target;\n"
        (self.repo / old_source).write_text("export const target = 1;\n", encoding="utf-8")
        (self.repo / test_rel).write_text(test_body, encoding="utf-8")
        _commit_all(self.repo, "fixture: import resolves to existing tsx source")
        initial = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(initial["tested_by"][old_source], [test_rel])

        (self.repo / new_source).write_text("export const target = 2;\n", encoding="utf-8")
        _commit_all(self.repo, "fixture: add higher precedence ts source")
        incremental = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        persisted = read_twin_map(base_dir=self.tools)
        rebuilt = build_twin_map(
            workspace_root=self.repo, base_dir=Path(self._tmpdir.name) / "clean-tools"
        )
        self.assertEqual((self.repo / test_rel).read_text(encoding="utf-8"), test_body)
        self.assertEqual(incremental["refresh"]["changed_files"], 1)
        self.assertEqual(rebuilt["tested_by"].get(new_source), [test_rel])
        self.assertNotIn(test_rel, rebuilt["tested_by"].get(old_source, []))
        self.assertEqual(incremental["tested_by"].get(new_source), [test_rel])
        self.assertNotIn(test_rel, incremental["tested_by"].get(old_source, []))
        self.assertEqual(incremental["tested_by"]["apps/alpha/src/main.ts"],
                         ["apps/alpha/src/main.spec.ts"])
        self.assertEqual(persisted, incremental)
        self.assertEqual(_comparable(incremental), _comparable(rebuilt))

    def test_source_deletion_re_resolves_an_unchanged_importing_test(self) -> None:
        test_rel = "apps/alpha/src/routing.spec.ts"
        old_source = "apps/alpha/src/target.ts"
        surviving_source = "apps/alpha/src/target.tsx"
        test_body = "import { target } from './target';\nexport const spec = target;\n"
        for rel in (old_source, surviving_source):
            (self.repo / rel).write_text("export const target = 1;\n", encoding="utf-8")
        (self.repo / test_rel).write_text(test_body, encoding="utf-8")
        _commit_all(self.repo, "fixture: import has two resolvable source candidates")
        initial = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(initial["tested_by"][old_source], [test_rel])

        (self.repo / old_source).unlink()
        _commit_all(self.repo, "fixture: remove higher precedence ts source")
        incremental = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        persisted = read_twin_map(base_dir=self.tools)
        rebuilt = build_twin_map(
            workspace_root=self.repo, base_dir=Path(self._tmpdir.name) / "clean-tools"
        )
        self.assertEqual((self.repo / test_rel).read_text(encoding="utf-8"), test_body)
        self.assertEqual(incremental["refresh"]["changed_files"], 1)
        self.assertEqual(rebuilt["tested_by"].get(surviving_source), [test_rel])
        self.assertNotIn(old_source, rebuilt["tested_by"])
        self.assertEqual(incremental["tested_by"].get(surviving_source), [test_rel])
        self.assertNotIn(old_source, incremental["tested_by"])
        self.assertEqual(incremental["tested_by"]["apps/alpha/src/main.ts"],
                         ["apps/alpha/src/main.spec.ts"])
        self.assertEqual(persisted, incremental)
        self.assertEqual(_comparable(incremental), _comparable(rebuilt))

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


class ShallowCheckoutTests(unittest.TestCase):
    """A partial clone cannot say what recurred, so the twin refuses it.

    The live shape (2026-09-12): the nightly lane's actions/checkout defaulted
    to depth 1, ``git log -n400`` saw one commit, churn and co-change never
    reached their recurrence thresholds, and the map was published as healthy
    with an empty history layer. The refusal below is what replaces that
    silence; the full-clone test beside it is the same repository read whole.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        base = Path(self._tmpdir.name)
        self.origin = base / "origin"
        (self.origin / "apps" / "alpha" / "src").mkdir(parents=True)
        _git(base, "init", "-q", self.origin.name)
        main = self.origin / "apps" / "alpha" / "src" / "main.ts"
        spec = self.origin / "apps" / "alpha" / "src" / "main.spec.ts"
        # Two commits touching the SAME pair, so a whole history recurs
        # (count 2 = both thresholds) and a one-commit history cannot.
        main.write_text("export const main = 1;\n", encoding="utf-8")
        spec.write_text("import { main } from './main';\nexport const spec = main;\n", encoding="utf-8")
        _commit_all(self.origin, "first: main + spec")
        main.write_text("export const main = 2;\n", encoding="utf-8")
        spec.write_text("import { main } from './main';\nexport const spec = main + 1;\n", encoding="utf-8")
        self.head = _commit_all(self.origin, "second: main + spec again")

    def _clone(self, name: str, *flags: str) -> Path:
        target = Path(self._tmpdir.name) / name
        _git(Path(self._tmpdir.name), "clone", "-q", *flags, f"file://{self.origin}", str(target))
        return target

    def test_shallow_checkout_is_refused_by_name_and_nothing_is_written(self) -> None:
        shallow = self._clone("shallow", "--depth", "1")
        self.assertEqual(_git(shallow, "rev-parse", "--is-shallow-repository").strip(), "true")
        tools = Path(self._tmpdir.name) / "shallow-tools"

        with self.assertRaises(GovernanceError) as built:
            build_twin_map(workspace_root=shallow, base_dir=tools)
        self.assertIn(SHALLOW_CHECKOUT_REFUSAL, str(built.exception))
        with self.assertRaises(GovernanceError) as refreshed:
            refresh_twin_map(workspace_root=shallow, base_dir=tools)
        self.assertIn(SHALLOW_CHECKOUT_REFUSAL, str(refreshed.exception))
        # Refusal, not a degraded publish: no map at all is the honest state.
        self.assertFalse((tools / TWIN_MAP_RELPATH).exists())

    def test_shallow_checkout_refresh_leaves_a_prior_map_untouched(self) -> None:
        # A map built from the whole history is valid for its indexed_sha. A
        # later refresh from a partial clone at that SAME sha would take the
        # noop path; it is refused at the entry instead, and the prior map
        # keeps its history layer byte for byte.
        full = self._clone("full")
        tools = Path(self._tmpdir.name) / "shared-tools"
        build_twin_map(workspace_root=full, base_dir=tools)
        before = (tools / TWIN_MAP_RELPATH).read_bytes()
        self.assertTrue(json.loads(before)["churn"], "fixture precondition: the full map has churn")

        shallow = self._clone("shallow", "--depth", "1")
        self.assertEqual(_git(shallow, "rev-parse", "HEAD").strip(), self.head)
        with self.assertRaises(GovernanceError) as refused:
            refresh_twin_map(workspace_root=shallow, base_dir=tools)
        self.assertIn(SHALLOW_CHECKOUT_REFUSAL, str(refused.exception))
        self.assertEqual((tools / TWIN_MAP_RELPATH).read_bytes(), before)

    def test_full_clone_of_the_same_repository_yields_churn_and_co_change(self) -> None:
        full = self._clone("full")
        self.assertEqual(_git(full, "rev-parse", "--is-shallow-repository").strip(), "false")
        twin = build_twin_map(workspace_root=full, base_dir=Path(self._tmpdir.name) / "full-tools")
        self.assertEqual(twin["stats"]["history_commits"], 2)
        self.assertEqual(twin["churn"]["apps/alpha/src/main.ts"], 2)
        self.assertEqual(twin["churn"]["apps/alpha/src/main.spec.ts"], 2)
        self.assertIn(["apps/alpha/src/main.spec.ts", "apps/alpha/src/main.ts", 2], twin["co_change"])


class HistoryUnavailableTests(unittest.TestCase):
    """A workspace whose history cannot be read is refused, not mapped.

    ``_history_layers`` used to swallow a failed ``git log`` and hand back
    ``churn={}`` / ``co_change=[]`` / ``commit_count=0``; the build then
    published that under ``indexed_sha ''`` — a map that looked healthy and
    described nothing, and that no consumer could tell from a repository
    whose files genuinely never recur. A directory that is not a repository
    is not shallow either, so the shallow probe must not catch it: it is
    refused by its own name (``HISTORY_UNAVAILABLE``).
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.plain = Path(self._tmpdir.name) / "plain"
        # A plausible workspace tree with no `.git` at all: the parse layers
        # would happily map it, which is exactly what must not happen.
        (self.plain / "apps" / "alpha" / "src").mkdir(parents=True)
        (self.plain / "apps" / "alpha" / "project.json").write_text('{"name":"alpha"}', encoding="utf-8")
        (self.plain / "apps" / "alpha" / "src" / "main.ts").write_text("export const main = 1;\n", encoding="utf-8")
        self.tools = Path(self._tmpdir.name) / "plain-tools"

    def _assert_refused_by_name(self, refused: GovernanceError) -> None:
        message = str(refused)
        self.assertTrue(message.startswith(f"{HISTORY_UNAVAILABLE}: "), message)
        self.assertNotIn(SHALLOW_CHECKOUT_REFUSAL, message)
        self.assertIn("git log failed", message)

    def test_a_directory_that_is_not_a_repository_is_refused_and_no_map_is_written(self) -> None:
        with self.assertRaises(GovernanceError) as built:
            build_twin_map(workspace_root=self.plain, base_dir=self.tools)
        self._assert_refused_by_name(built.exception)
        with self.assertRaises(GovernanceError) as refreshed:
            refresh_twin_map(workspace_root=self.plain, base_dir=self.tools)
        self._assert_refused_by_name(refreshed.exception)
        self.assertFalse((self.tools / TWIN_MAP_RELPATH).exists())

    def test_an_unborn_repository_is_refused_the_same_way(self) -> None:
        # `git init` with no commit: HEAD is unborn, `git log` fails, and the
        # history layer has nothing to count. Not shallow, not mappable.
        _git(self.plain.parent, "init", "-q", self.plain.name)
        self.assertEqual(_git(self.plain, "rev-parse", "--is-shallow-repository").strip(), "false")
        with self.assertRaises(GovernanceError) as built:
            build_twin_map(workspace_root=self.plain, base_dir=self.tools)
        self._assert_refused_by_name(built.exception)
        self.assertFalse((self.tools / TWIN_MAP_RELPATH).exists())

    def test_a_refused_refresh_leaves_the_prior_map_untouched(self) -> None:
        # A valid map from a real repository, then a refresh pointed at a
        # workspace with no history: the refusal must not degrade the prior
        # map into the empty-layer shape it replaces.
        repo = Path(self._tmpdir.name) / "repo"
        (repo / "apps" / "alpha" / "src").mkdir(parents=True)
        _git(repo.parent, "init", "-q", repo.name)
        main = repo / "apps" / "alpha" / "src" / "main.ts"
        main.write_text("export const main = 1;\n", encoding="utf-8")
        _commit_all(repo, "first")
        main.write_text("export const main = 2;\n", encoding="utf-8")
        _commit_all(repo, "second")
        build_twin_map(workspace_root=repo, base_dir=self.tools)
        before = (self.tools / TWIN_MAP_RELPATH).read_bytes()
        self.assertTrue(json.loads(before)["churn"], "fixture precondition: the real map has churn")

        with self.assertRaises(GovernanceError) as refused:
            refresh_twin_map(workspace_root=self.plain, base_dir=self.tools)
        self._assert_refused_by_name(refused.exception)
        self.assertEqual((self.tools / TWIN_MAP_RELPATH).read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
