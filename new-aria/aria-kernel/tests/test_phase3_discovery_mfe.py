"""Plan ARIA-V2 §Phase 3 invariants I-14, I-15, I-16, I-17, I-18, I-37, I-38.

Locks the architectural decisions:
  * Recursive MFE-aware ``_project_rows`` via ``is_leaf_project`` predicate
  * SERVICE_MAP.json schema v1 → v2 (typed ``web`` buckets)
  * Legacy ``web_module_count`` deprecation event single-fire per cycle
  * ``web-modules-missing-project-json`` belief surfaces concrete evidence
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.discovery import (
    _MFE_NAME_ALLOWLIST,
    _project_rows,
    _service_map,
    is_leaf_project,
    run_discovery,
)
from aria_kernel.ledger import read_jsonl
from aria_kernel.memory import update_memory
from aria_kernel.migration import migrate_tools_bootstrap, migrate_workspace_v1_to_v2
from aria_kernel.upcasters import service_map_v1_to_v2


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


# ----- Plan ARIA-V2 I-17 — predicate idempotency -----


class IsLeafProjectPredicateTests(unittest.TestCase):
    """Plan ARIA-V2 I-17 — ``is_leaf_project`` decides solely on locally
    observable markers; never inspects descendants. Subtree state has
    no effect on the predicate's output.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_project_json_marker_returns_true(self) -> None:
        child = self.tmp / "with-project-json"
        child.mkdir()
        (child / "project.json").write_text("{}", encoding="utf-8")
        self.assertTrue(is_leaf_project(child))

    def test_cargo_toml_marker_returns_true(self) -> None:
        child = self.tmp / "rust-crate"
        child.mkdir()
        (child / "Cargo.toml").write_text("", encoding="utf-8")
        self.assertTrue(is_leaf_project(child))

    def test_mfe_allowlist_returns_true(self) -> None:
        for name in _MFE_NAME_ALLOWLIST:
            child = self.tmp / name
            child.mkdir()
            self.assertTrue(is_leaf_project(child), f"allowlist {name} not recognised")

    def test_unmarked_dir_returns_false(self) -> None:
        child = self.tmp / "random-dir"
        child.mkdir()
        self.assertFalse(is_leaf_project(child))

    def test_predicate_ignores_subtree_state(self) -> None:
        """Adding/removing nested files does NOT flip the predicate."""
        child = self.tmp / "with-project-json"
        child.mkdir()
        (child / "project.json").write_text("{}", encoding="utf-8")
        first = is_leaf_project(child)
        # Deep nested structure should not affect output
        deep = child / "subdir" / "deep" / "nested"
        deep.mkdir(parents=True)
        (deep / "another-project.json").write_text("{}", encoding="utf-8")
        second = is_leaf_project(child)
        self.assertEqual(first, second)


# ----- Plan ARIA-V2 I-14 — relational web_mfe_count -----


class WebMfeCountRelationalTests(unittest.TestCase):
    """Plan ARIA-V2 I-14 — ``web_mfe_count`` equals the number of
    directories under ``web/modules/`` (relational assertion, NOT a
    hard-coded 7).
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def _fingerprint_for(self, mfe_names: list[str]) -> dict:
        from aria_kernel.discovery import _repo_fingerprint
        web_modules = self.tmp / "web" / "modules"
        web_modules.mkdir(parents=True)
        for name in mfe_names:
            (web_modules / name).mkdir()
            (web_modules / name / "project.json").write_text("{}", encoding="utf-8")
        return _repo_fingerprint(self.tmp, fates=[], file_counts={
            "git_tracked": 0, "working_tree": 0, "allowed": 0,
            "generated": 0, "unknown": 0, "fated": 0,
        })

    def test_count_equals_children_under_modules(self) -> None:
        for mfe_count in [0, 1, 3, 7, 12]:
            with self.subTest(mfe_count=mfe_count):
                fp = self._fingerprint_for([f"mfe-{i}" for i in range(mfe_count)])
                self.assertEqual(fp["web_mfe_count"], mfe_count)
                self.assertEqual(fp["web_module_count"], mfe_count,
                                 "legacy web_module_count must mirror web_mfe_count for backward-compat")
                # Re-clean for next subtest iteration
                import shutil
                shutil.rmtree(self.tmp / "web")


# ----- Plan ARIA-V2 I-15 — typed buckets -----


class ServiceMapV2TypedBucketsTests(unittest.TestCase):
    """Plan ARIA-V2 I-15 — SERVICE_MAP.web is a typed dict with
    ``modules``/``apps``/``shared_ui``/``shell`` keys.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        # Build a minimal web/ tree with all 4 buckets populated
        for sub in ["modules/dashboard", "modules/farm-module", "apps/aquamobil", "shared-ui", "shell"]:
            target = self.tmp / "web" / sub
            target.mkdir(parents=True)
            (target / "project.json").write_text(json.dumps({"name": Path(sub).name}), encoding="utf-8")

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_service_map_web_is_typed_dict(self) -> None:
        sm = _service_map(self.tmp)
        self.assertEqual(sm["schema_version"], 2)
        self.assertIsInstance(sm["web"], dict)
        for key in ("modules", "apps", "shared_ui", "shell"):
            self.assertIn(key, sm["web"], f"missing typed bucket: {key}")
            self.assertIsInstance(sm["web"][key], list)

    def test_modules_bucket_enumerates_mfes(self) -> None:
        sm = _service_map(self.tmp)
        names = sorted(row["name"] for row in sm["web"]["modules"])
        self.assertEqual(names, ["dashboard", "farm-module"])

    def test_shared_ui_and_shell_each_have_single_row(self) -> None:
        sm = _service_map(self.tmp)
        self.assertEqual(len(sm["web"]["shared_ui"]), 1)
        self.assertEqual(sm["web"]["shared_ui"][0]["name"], "shared-ui")
        self.assertEqual(len(sm["web"]["shell"]), 1)
        self.assertEqual(sm["web"]["shell"][0]["name"], "shell")


# ----- Plan ARIA-V2 I-18 — upcaster v1 ↔ v2 -----


class ServiceMapUpcasterTests(unittest.TestCase):
    """Plan ARIA-V2 I-18 — v1→v2 forward + v2→v1 reverse + roundtrip
    preserves v1 representable subset.
    """

    def test_upcast_collapses_placeholder_parent_dirs(self) -> None:
        v1 = {
            "schema_version": 1,
            "web": [
                {"name": "apps", "path": "web/apps"},
                {"name": "modules", "path": "web/modules"},
                {"name": "shared-ui", "path": "web/shared-ui"},
                {"name": "shell", "path": "web/shell"},
            ],
        }
        v2 = service_map_v1_to_v2.upcast(v1)
        self.assertEqual(v2["schema_version"], 2)
        # web/modules and web/apps are placeholder parent rows; they
        # don't translate to v2 leaf rows. shared-ui and shell are real
        # leaf projects in v2.
        self.assertEqual(v2["web"]["modules"], [])
        self.assertEqual(v2["web"]["apps"], [])
        self.assertEqual(len(v2["web"]["shared_ui"]), 1)
        self.assertEqual(len(v2["web"]["shell"]), 1)

    def test_downcast_flattens_to_v1_list(self) -> None:
        v2 = {
            "schema_version": 2,
            "web": {
                "modules": [{"name": "dashboard", "path": "web/modules/dashboard"}],
                "apps": [{"name": "aquamobil", "path": "web/apps/aquamobil"}],
                "shared_ui": [{"name": "shared-ui", "path": "web/shared-ui"}],
                "shell": [{"name": "shell", "path": "web/shell"}],
            },
        }
        v1 = service_map_v1_to_v2.downcast(v2)
        self.assertEqual(v1["schema_version"], 1)
        self.assertIsInstance(v1["web"], list)
        names = [row["name"] for row in v1["web"]]
        # Deterministic order: modules → apps → shared_ui → shell
        self.assertEqual(names, ["dashboard", "aquamobil", "shared-ui", "shell"])

    def test_roundtrip_preserves_real_leaf_rows(self) -> None:
        """Round-trip is value-preserving for rows that route to a
        real v2 bucket (i.e. not placeholder parent dirs).
        """
        v1 = {
            "schema_version": 1,
            "web": [
                {"name": "shared-ui", "path": "web/shared-ui"},
                {"name": "shell", "path": "web/shell"},
            ],
        }
        roundtripped = service_map_v1_to_v2.downcast(service_map_v1_to_v2.upcast(v1))
        roundtripped_names = sorted(r["name"] for r in roundtripped["web"])
        v1_names = sorted(r["name"] for r in v1["web"])
        self.assertEqual(roundtripped_names, v1_names)

    def test_unrouted_rows_preserved_in_upcast(self) -> None:
        v1 = {
            "schema_version": 1,
            "web": [{"name": "weird", "path": "web/unknown-bucket-name"}],
        }
        v2 = service_map_v1_to_v2.upcast(v1)
        self.assertIn("_unrouted", v2["web"])
        self.assertEqual(len(v2["web"]["_unrouted"]), 1)
        # Downcast restores them
        v1_back = service_map_v1_to_v2.downcast(v2)
        self.assertEqual(len(v1_back["web"]), 1)


# ----- Plan ARIA-V2 I-37 + I-38 — legacy field deprecation event -----


class LegacyFieldDeprecationEventTests(unittest.TestCase):
    """Plan ARIA-V2 I-37 — ``discovery_legacy_field_emitted`` fires
    exactly once per cycle when ``web_module_count`` is computed.
    Plan ARIA-V2 I-38 — event has ``severity`` and ``removal_target``.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={
                "package.json": "{}",
                "web/modules/dashboard/project.json": "{}",
                "web/modules/farm-module/project.json": "{}",
            },
            remote_url="https://github.com/test-owner/i37.git",
            name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-37 workspace bootstrap",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-37 tools bootstrap",
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_deprecation_event_fires_once_per_cycle(self) -> None:
        run_discovery(
            workspace_root=self.repo, cycle_id="i37-cycle",
            base_dir=self.tools_dir, snapshot_mode="committed",
        )
        gov = read_jsonl(self.tools_dir / "governance.jsonl")
        events = [r for r in gov if r.get("kind") == "discovery_legacy_field_emitted"
                  and r.get("details", {}).get("cycle_id") == "i37-cycle"]
        self.assertEqual(len(events), 1, "Plan ARIA-V2 I-37 violation: deprecation event must fire exactly once per cycle")

    def test_deprecation_event_has_removal_target(self) -> None:
        run_discovery(
            workspace_root=self.repo, cycle_id="i38-cycle",
            base_dir=self.tools_dir, snapshot_mode="committed",
        )
        gov = read_jsonl(self.tools_dir / "governance.jsonl")
        event = next(r for r in gov if r.get("kind") == "discovery_legacy_field_emitted"
                     and r.get("details", {}).get("cycle_id") == "i38-cycle")
        details = event["details"]
        self.assertEqual(details["legacy_field"], "web_module_count")
        self.assertEqual(details["canonical_successor"], "web_mfe_count")
        self.assertEqual(details["severity"], "deprecation")
        self.assertIn("removal_target", details)


# ----- Plan ARIA-V2 I-16 — missing-project-json belief -----


class WebModulesMissingProjectJsonBeliefTests(unittest.TestCase):
    """Plan ARIA-V2 I-16 — when web/modules/<x> lacks project.json,
    discovery surfaces the gap in REPO_FINGERPRINT.web_modules_missing_project_json
    and memory emits the ``web-modules-missing-project-json`` belief
    with concrete evidence_refs.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        # 2 MFEs missing project.json, 1 MFE has it.
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={
                "package.json": "{}",
                "web/modules/has-project/project.json": "{}",
                "web/modules/missing-a/index.html": "",
                "web/modules/missing-b/index.html": "",
            },
            remote_url="https://github.com/test-owner/i16.git",
            name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-16 workspace bootstrap",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-16 tools bootstrap",
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_belief_emitted_with_concrete_evidence(self) -> None:
        cycle_id = "i16-cycle"
        run_discovery(
            workspace_root=self.repo, cycle_id=cycle_id,
            base_dir=self.tools_dir, snapshot_mode="committed",
        )
        # Inspect REPO_FINGERPRINT first
        fp = json.loads((self.tools_dir / "discovery" / cycle_id / "REPO_FINGERPRINT.json").read_text())
        missing = fp["web_modules_missing_project_json"]
        self.assertEqual(sorted(missing), ["web/modules/missing-a", "web/modules/missing-b"])
        # Now update memory and verify belief landed
        update_memory(
            cycle_id=cycle_id, base_dir=self.tools_dir,
            workspace_root=self.repo, include_discovery_beliefs=True,
            include_tool_candidates=False,
        )
        beliefs = read_jsonl(self.tools_dir / "memory" / "beliefs.jsonl")
        target_beliefs = [b for b in beliefs if b.get("belief_id") == "web-modules-missing-project-json"]
        self.assertGreaterEqual(len(target_beliefs), 1)
        latest = target_beliefs[-1]
        self.assertEqual(sorted(latest["evidence_refs"]),
                         ["web/modules/missing-a", "web/modules/missing-b"])
        # Confidence may be attenuated by ``_record_belief`` (e.g. via
        # the staleness curve / freshness coefficient applied at record
        # time). The architectural invariant is "belief emits with
        # concrete evidence", not the absolute confidence value — we
        # assert a high-confidence floor rather than exact equality so
        # legitimate attenuation does not flip the test red.
        self.assertGreater(latest["confidence"], 0.7)


if __name__ == "__main__":
    unittest.main()
