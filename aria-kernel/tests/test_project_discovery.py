"""The project graph must describe the repository it is actually in.

``_discover_projects`` enumerated six hardcoded parent directories — ``apps``,
``libs``, ``platform/libs``, ``web/modules``, and the two ``web`` singletons.
That list was true when it was written. The repository then grew ``crates/``,
``mcp/``, ``tests/``, ``tools/executors/``, ``e2e/``, ``scripts/``, a Rust edge
gateway, and ARIA's own Python kernel, and the list did not grow with it: a
control that stayed correct only while its input stopped changing.

The consequence is not a wrong answer, it is a withheld capability. A path the
graph cannot place lands in ``unknown_files``, which makes ``validation_scope``
``blocked_unknown_graph``, which makes ``plan_impact`` return
``blocked_by: ['impact_graph_unknown']``. Measured on this repository before
the fix: of the distinct files touched by the last 200 commits, 4,282 of 11,041
(38%) were unplaceable — 655 of them ARIA's own ``aria-kernel/``. ARIA was
structurally blocked from planning a change to the kernel it edits most.

The fix makes discovery MARKER-driven: a directory is a project when it carries
one of a closed set of markers (``project.json`` — nx's own SSoT — plus
``Cargo.toml`` and ``pyproject.toml`` for the roots nx does not model). A new
project therefore enters the graph the moment it acquires a marker, with no
list to remember to edit.

Two structural rules keep the sweep honest, and both are pinned below: a marker
at the WORKSPACE ROOT describes the workspace and must never become a project
(its root is the empty prefix, so it would match every path and swallow the
graph — this repository has a root ``Cargo.toml``, so the case is live, not
hypothetical), and a marker NESTED under an already-discovered project belongs
to that project (``sens-api-gateway/fuzz`` is part of the gateway).
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.impact import plan_impact
from aria_kernel.impact_graph import _discover_projects, _project_for_path

REPO_ROOT = Path(__file__).resolve().parents[2]


class RealRepositoryDiscoveryTests(unittest.TestCase):
    """Against the real tree — the claim is about THIS repository."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.projects = _discover_projects(REPO_ROOT)

    def _project_of(self, path: str) -> str | None:
        return _project_for_path(path, self.projects)

    def test_arias_own_kernel_is_on_the_map(self) -> None:
        # The headline case: the tree ARIA edits most was invisible to the
        # graph ARIA plans with.
        self.assertEqual(self._project_of("aria-kernel/aria_kernel/ledger.py"), "aria-kernel")

    def test_the_rust_edge_gateway_is_on_the_map(self) -> None:
        self.assertEqual(
            self._project_of("sens-api-gateway/src/main.rs"), "sens-api-gateway"
        )

    def test_nx_projects_outside_the_hardcoded_parents_are_found(self) -> None:
        # Each of these carries a project.json and was invisible: nx knows
        # them, the graph did not.
        self.assertEqual(self._project_of("crates/nats-client/src/lib.rs"), "nats-client")
        self.assertEqual(self._project_of("tests/invariants/foo.spec.ts"), "invariants")
        self.assertEqual(self._project_of("e2e/tests/x.spec.ts"), "@aquaculture/e2e-tests")

    def test_a_root_marker_never_becomes_a_project(self) -> None:
        # This repository HAS a root Cargo.toml. A project rooted at "" matches
        # every path, so `_project_for_path` would return it for everything and
        # the graph would claim total knowledge while holding none.
        roots = {meta["root"] for meta in self.projects.values()}
        self.assertNotIn("", roots)
        self.assertNotIn(".", roots)
        # Proof by consequence rather than by shape: a path belonging to no
        # project must still resolve to None.
        self.assertIsNone(self._project_of("README.md"))

    def test_a_nested_marker_belongs_to_its_parent_project(self) -> None:
        # sens-api-gateway/fuzz has its own Cargo.toml. It is part of the
        # gateway, not a sibling of it.
        self.assertEqual(
            self._project_of("sens-api-gateway/fuzz/fuzz_targets/a.rs"), "sens-api-gateway"
        )

    def test_the_names_existing_consumers_key_on_did_not_move(self) -> None:
        # Agent routing, validation matrix and the twin all key on these
        # names. Discovery is ADDITIVE: it may only add projects.
        for name, root in (
            ("farm-service", "apps/farm-service"),
            ("backend-common", "libs/backend-common"),
            ("platform-cqrs", "platform/libs/cqrs"),
            ("web-dashboard", "web/modules/dashboard"),
            ("web-shared-ui", "web/shared-ui"),
            ("web-shell", "web/shell"),
        ):
            with self.subTest(project=name):
                self.assertEqual(self.projects.get(name, {}).get("root"), root)

    def test_the_blind_spot_actually_shrank(self) -> None:
        # A regression bound, not a vanity metric: the directories below were
        # each measured unplaceable before the fix.
        for path in (
            "aria-kernel/aria_kernel/mission.py",
            "crates/protocol-codec/src/lib.rs",
            "mcp/farm-management/src/index.ts",
            "scripts/ci/x.mjs",
            "tools/executors/cargo/index.ts",
        ):
            with self.subTest(path=path):
                self.assertIsNotNone(self._project_of(path))


class SyntheticDiscoveryTests(unittest.TestCase):
    """The mechanism, on a tree small enough to state completely."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def _write(self, rel: str, content: str = "") -> None:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_an_nx_project_is_named_by_its_declared_name(self) -> None:
        # project.json's `name` is nx's identity for the project; the path is
        # not. Inventing a second name would put the same project under two
        # identities in two consumers.
        self._write("packages/thing/project.json", json.dumps({"name": "@scope/thing"}))
        projects = _discover_projects(self.repo)
        self.assertEqual(projects["@scope/thing"]["root"], "packages/thing")

    def test_a_marker_without_a_declared_name_is_named_by_its_path(self) -> None:
        # Cargo/pyproject names are PUBLISH identities (this repo's root crate
        # publishes as "suderra-agent"), so the repo-relative path is the
        # stabler in-graph name.
        self._write("edge/gateway/Cargo.toml", '[package]\nname = "published-elsewhere"\n')
        projects = _discover_projects(self.repo)
        self.assertIn("edge-gateway", projects)
        self.assertEqual(projects["edge-gateway"]["root"], "edge/gateway")

    def test_a_root_marker_is_the_workspace_not_a_project(self) -> None:
        self._write("Cargo.toml", "[workspace]\n")
        self._write("apps/svc/project.json", json.dumps({"name": "svc"}))
        projects = _discover_projects(self.repo)
        self.assertEqual(sorted(projects), ["svc"])

    def test_the_shallower_marker_wins(self) -> None:
        # Order matters: if the nested marker were visited first it would
        # become a project and the parent would then be skipped as "covered",
        # inverting the containment.
        self._write("edge/Cargo.toml", "[package]\n")
        self._write("edge/fuzz/Cargo.toml", "[package]\n")
        projects = _discover_projects(self.repo)
        self.assertEqual(sorted(projects), ["edge"])
        self.assertEqual(_project_for_path("edge/fuzz/a.rs", projects), "edge")

    def test_vendored_and_build_output_is_not_the_repository(self) -> None:
        # Each of these sits OUTSIDE any discovered project, so the walk really
        # reaches it and the exclusion is what stops it — not an earlier prune.
        for rel in (
            "node_modules/dep/package.json",
            "pkg/dist/project.json",
            "pkg/node_modules/dep/Cargo.toml",
            "target/debug/build/Cargo.toml",
            "tools/vendor/forked-thing/package.json",
        ):
            self._write(rel, "{}")
        self.assertEqual(_discover_projects(self.repo), {})

    def test_a_name_collision_keeps_the_first_and_does_not_overwrite(self) -> None:
        # Two SIBLING trees declaring one name — neither contains the other, so
        # the walk visits both and the guard is the only thing deciding. Silent
        # overwriting would move a project's root under a consumer's feet.
        self._write("a/thing/project.json", json.dumps({"name": "dup"}))
        self._write("b/thing/project.json", json.dumps({"name": "dup"}))
        projects = _discover_projects(self.repo)
        self.assertEqual(projects["dup"]["root"], "a/thing")
        self.assertEqual([root["root"] for root in projects.values()].count("b/thing"), 0)


class ImpactPlanningUnblockedTests(unittest.TestCase):
    """The consequence, end to end: the plan is no longer refused."""

    def test_a_python_package_change_is_no_longer_blocked_as_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / "kernel" / "pkg").mkdir(parents=True)
            (repo / "kernel" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
            (repo / "kernel" / "pkg" / "ledger.py").write_text("x = 1\n", encoding="utf-8")

            plan = plan_impact(
                changed_files=["kernel/pkg/ledger.py"],
                action_class="code_change",
                workspace_root=repo,
                base_dir=Path(tmp) / "aria-tools",
            )
            self.assertNotIn("impact_graph_unknown", plan["blocked_by"])
            self.assertEqual(plan["direct_projects"], ["kernel"])


if __name__ == "__main__":
    unittest.main()
