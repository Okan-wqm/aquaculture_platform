"""Plan ARIA-V2 §Phase 1 invariants I-28, I-29, I-33, I-34 — end-to-end + edge cases.

* I-28 — workspace_paths honors ``ARIA_WORKSPACE_BASE`` env override
* I-29 — v2→v3 migration preserves pre-seeded workspace ledger content
* I-33 — fresh-clone → migrate → discovery e2e completes cleanly
* I-34 — frozen profile blocks migrate-tools-bootstrap

Each test isolates state under ``tempfile.TemporaryDirectory`` and
sets ``ARIA_WORKSPACE_BASE`` explicitly so it does not write to
``~/.aria/``.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import append_jsonl, read_jsonl, verify_jsonl
from aria_kernel.migration import migrate_tools_bootstrap, migrate_workspace_v1_to_v2
from aria_kernel.tool_registry import GovernanceError, tools_contract_version
from aria_kernel.workspace import canonical_identity, workspace_paths


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


class WorkspaceBindHonoursAriaWorkspaceBaseTests(unittest.TestCase):
    """Plan ARIA-V2 I-28 — ``ARIA_WORKSPACE_BASE`` env override honored.

    Verifies that workspace identity writes never escape to ``~/.aria/``
    when the env var is set. Critical for CI hermeticity (``.aria-ci/``)
    and for cross-environment binding stability.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, name="repo", remote_url="https://github.com/test-owner/i28.git"
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_env_var_overrides_default_home_base(self) -> None:
        custom_base = self.tmp / "custom-workspace-root"
        os.environ["ARIA_WORKSPACE_BASE"] = str(custom_base)
        paths = workspace_paths(self.repo)
        self.assertTrue(
            str(paths.workspace_root).startswith(str(custom_base)),
            f"Plan ARIA-V2 I-28 violation: workspace_root={paths.workspace_root} did not honor "
            f"ARIA_WORKSPACE_BASE={custom_base}",
        )
        # And the dir hash is the canonical identity (path-independent)
        self.assertEqual(paths.workspace_root.name, canonical_identity(self.repo))

    def test_explicit_kwarg_overrides_env(self) -> None:
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.tmp / "from-env")
        explicit_base = self.tmp / "from-kwarg"
        paths = workspace_paths(self.repo, workspace_base=explicit_base)
        self.assertTrue(str(paths.workspace_root).startswith(str(explicit_base)))


class V2ToV3MigrationPreservesWorkspaceLedgersTests(unittest.TestCase):
    """Plan ARIA-V2 I-29 — pre-seeded workspace ledgers survive v2→v3 migration."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, name="repo", remote_url="https://github.com/test-owner/i29.git"
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            acknowledge=True,
            reason="Plan ARIA-V2 I-29 workspace bootstrap for ledger preservation test",
        )
        # Seed governance.jsonl with a row so migration has something
        # to potentially clobber + assert preserved.
        paths = workspace_paths(self.repo, workspace_base=self.workspace_base)
        from aria_kernel.workspace import record_workspace_governance
        record_workspace_governance(paths, "test_seed", {"seed_id": "i29-row-1"})
        self.seeded_paths = paths
        self.tools_dir = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_workspace_ledger_chain_remains_valid_after_migration(self) -> None:
        pre_rows = read_jsonl(self.seeded_paths.ledgers["governance"])
        self.assertGreater(len(pre_rows), 0)
        pre_chain = verify_jsonl(self.seeded_paths.ledgers["governance"])
        self.assertEqual(pre_chain.get("valid"), True)
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 I-29 migration preserves workspace ledger chain",
        )
        post_rows = read_jsonl(self.seeded_paths.ledgers["governance"])
        post_chain = verify_jsonl(self.seeded_paths.ledgers["governance"])
        self.assertEqual(post_chain.get("valid"), True)
        # Pre-existing test_seed row survives (chain may have additional
        # workspace_repo_bound + migration events appended).
        seed_rows = [r for r in post_rows if r.get("details", {}).get("seed_id") == "i29-row-1"]
        self.assertEqual(len(seed_rows), 1, "test_seed row not preserved across migration")


class FreshCloneFullCycleE2ETests(unittest.TestCase):
    """Plan ARIA-V2 I-33 — fresh clone → migrate → discovery e2e success."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        # Simulate a fresh clone: a repo with a configured remote URL,
        # no aria-tools/ binding, no workspace state.
        self.clone = git_fixtures.make_local_git_repo(
            self.tmp, name="fresh-clone", remote_url="https://github.com/test-owner/i33.git"
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        # Bootstrap workspace (single-shot — this is the operator path
        # post-Phase-1: migrate-tools-bootstrap handles tools but
        # workspace bootstrap is still its own command).
        migrate_workspace_v1_to_v2(
            workspace_root=self.clone,
            workspace_base=self.workspace_base,
            acknowledge=True,
            reason="Plan ARIA-V2 I-33 fresh-clone workspace bootstrap",
        )
        self.tools_dir = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_bootstrap_then_binding_succeeds(self) -> None:
        result = migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.clone,
            acknowledge=True,
            reason="Plan ARIA-V2 I-33 fresh-clone tools migration to v3",
        )
        self.assertEqual(result["final_version"], 3)
        # Identity file now carries v3 schema + canonical binding
        identity = json.loads((self.tools_dir / "repo_identity.json").read_text())
        self.assertEqual(identity["aria_tools_contract_version"], 3)
        self.assertEqual(identity["bound_canonical_identity"], canonical_identity(self.clone))
        # Re-running cycle binding (the discovery surface entry point)
        # MUST be a no-op success because canonical_identity is stable
        from aria_kernel.tool_registry import ensure_tools_binding
        result2 = ensure_tools_binding(self.tools_dir, workspace_root=self.clone)
        self.assertEqual(result2, self.tools_dir)


class MigrateToolsBlockedInFrozenProfileTests(unittest.TestCase):
    """Plan ARIA-V2 I-34 — frozen profile rejects migrate-tools-bootstrap.

    Migration is a high-impact write. If a frozen profile were to allow
    it, the no-write invariant would silently break. Plan ARIA-V2 §3.8
    enforces the gate at the kernel surface.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, name="repo", remote_url="https://github.com/test-owner/i34.git"
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            acknowledge=True,
            reason="Plan ARIA-V2 I-34 workspace bootstrap for frozen profile test",
        )
        self.tools_dir = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        os.environ.pop("ARIA_RUNTIME_PROFILE", None)
        self._tmpdir.cleanup()

    def test_frozen_profile_blocks_migration(self) -> None:
        """Plan ARIA-V2 I-34 — frozen runtime profile rejects migration.

        Migration is a high-impact write to ``aria-tools/repo_identity.json``
        + ``governance.jsonl``. The tool_governance profile gate fires
        on every PLAN_020_WRITE_SURFACES surface under ``frozen``.
        """
        from aria_kernel.runtime_profile import set_profile
        # First bootstrap to v3 under standard profile (the gate-under-test
        # is "rejection of FURTHER migration writes under frozen"; the
        # initial bootstrap is allowed under standard).
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 I-34 setup bootstrap before freeze",
        )
        # Transition to frozen.
        set_profile(
            "frozen",
            operator_approval_ref="OPR-i34-test",
            base_dir=str(self.tools_dir),
        )
        # Now ANY migrate call must reject under frozen.
        with self.assertRaises((GovernanceError, RuntimeError)) as cm:
            migrate_tools_bootstrap(
                tools_dir=self.tools_dir,
                workspace_root=self.repo,
                acknowledge=True,
                reason="Plan ARIA-V2 I-34 frozen profile should reject this",
            )
        msg = str(cm.exception).lower()
        self.assertTrue(
            any(token in msg for token in ("frozen", "profile", "no-write", "rejected", "violation")),
            f"expected frozen-profile rejection, got: {cm.exception}",
        )


if __name__ == "__main__":
    unittest.main()
