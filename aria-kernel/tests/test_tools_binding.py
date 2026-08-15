"""Binding a restored tools root must not be a migration (ORPHAN-HIGH-556).

These drive the REAL publish-then-restore path from ``test_state_store`` rather
than a hand-built tree, because the whole defect lives in what the restore
actually produces: a tools root full of covered state whose contract version
was unreadable.

The cost assertions are the gate. A regression here does not look like a crash
— it looks like a nightly that works, and quietly rewrites every ledger in
ARIA's memory on the way.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from aria_kernel import state_store
from aria_kernel.state_store import checkout_state_store, publish_state, tools_root
from aria_kernel.tool_registry import (
    SCHEMA_VERSION,
    GovernanceError,
    TOOLS_CONTRACT_FILENAME,
    covered_tool_ledgers,
    tools_contract_version,
)
from aria_kernel.tools_binding import bind_tools_root

from tests.test_state_store import REPO_HASH, StateStoreTestCase, _EnvPatch


def _governance_rows(root: Path) -> list[dict]:
    path = root / "governance.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def _backup_names(root: Path) -> list[str]:
    backups = root / ".backups"
    return sorted(p.name for p in backups.glob("*")) if backups.exists() else []


def _ledger_bytes(root: Path) -> dict[str, bytes]:
    return {
        name: path.read_bytes()
        for name, path in covered_tool_ledgers(root).items()
        if path.exists()
    }


class RestoredTreeBindTestCase(StateStoreTestCase):
    """A published store, checked out fresh — exactly what a lane restores."""

    def _restored(self) -> Path:
        from aria_kernel.tool_registry import ensure_tools_binding

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            ensure_tools_binding(workspace_root=self.repo)
        self._seed_surface(store, '{"row": 1}\n')
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        return checkout_state_store(self.repo, store_dir=self.repo.parent / "store-fresh")

    def _bind(self, store) -> dict:
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            return bind_tools_root(
                tools_dir=str(tools_root(store)),
                workspace_root=str(self.repo),
                reason="bind the restored aria/state store to this checkout",
            )


class TheTreeCarriesItsOwnContract(RestoredTreeBindTestCase):
    def test_the_contract_travels_but_the_host_identity_does_not(self) -> None:
        """The split, asserted on both halves at once.

        Asserting only that the contract arrives would pass just as well if
        the identity arrived too — which is the thing that must never happen,
        because `bound_repo_root` is an absolute path on another machine.
        """
        root = tools_root(self._restored())
        self.assertTrue((root / TOOLS_CONTRACT_FILENAME).exists())
        self.assertFalse((root / "repo_identity.json").exists())

    def test_a_restored_tree_reports_its_real_version_before_any_bind(self) -> None:
        """The root fix, in one assertion.

        Reading 0 here is what made `migrate_tools_bootstrap` run the whole
        v0-to-v3 chain on a healthy tree, every night.
        """
        root = tools_root(self._restored())
        self.assertEqual(tools_contract_version(root), SCHEMA_VERSION)

    def test_the_published_contract_carries_no_host_path(self) -> None:
        root = tools_root(self._restored())
        contract = json.loads((root / TOOLS_CONTRACT_FILENAME).read_text(encoding="utf-8"))
        self.assertNotIn("bound_repo_root", contract)
        # ...and the positive half: it carries what it is FOR. Absence
        # assertions alone would pass on an empty file.
        self.assertEqual(contract["aria_tools_contract_version"], SCHEMA_VERSION)
        self.assertTrue(contract["bound_canonical_identity"])


class TheBindCostsOneRow(RestoredTreeBindTestCase):
    """What the nightly must NOT do. This is the gate."""

    def test_binding_rewrites_no_ledger_and_takes_no_backup(self) -> None:
        store = self._restored()
        root = tools_root(store)
        before = _ledger_bytes(root)
        self.assertEqual(_backup_names(root), [])

        result = self._bind(store)

        self.assertEqual(result["status"], "bound")
        self.assertIs(result["migrated"], False)
        self.assertEqual(
            _backup_names(root),
            [],
            "a bind copied the whole tools tree; that is a migration",
        )
        after = _ledger_bytes(root)
        for name, blob in before.items():
            if name == "tools_governance":
                continue  # the bind's own row lands here, by design
            self.assertEqual(blob, after.get(name), f"{name} was rewritten by a bind")

    def test_binding_appends_exactly_one_governance_row(self) -> None:
        store = self._restored()
        root = tools_root(store)
        before = _governance_rows(root)

        self._bind(store)

        added = _governance_rows(root)[len(before) :]
        self.assertEqual(
            [row["kind"] for row in added],
            ["tools_root_bound_to_host"],
            "the migration ceremony (9 rows, measured) came back",
        )

    def test_the_bind_makes_the_root_usable(self) -> None:
        """The point of the whole operation, so the cheapness above is not
        cheapness at the cost of doing the job."""
        from aria_kernel.tool_registry import ensure_tools_dir

        fresh = self._restored()
        root = tools_root(fresh)
        self._bind(fresh)
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            self.assertEqual(ensure_tools_dir(), root)

    def test_an_unbound_restored_root_is_still_refused_before_the_bind(self) -> None:
        """The refusal that `ambiguous_tools_root` provides must survive the
        split. The missing half is the HOST half, so it does — but a future
        change that satisfied `_has_valid_tools_identity` from the published
        contract would silently let a lane write into an unbound tree."""
        from aria_kernel.tool_registry import ensure_tools_dir

        fresh = self._restored()
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            with self.assertRaises(GovernanceError) as caught:
                ensure_tools_dir()
        self.assertIn("ambiguous_tools_root", str(caught.exception))

    def test_the_governance_row_goes_through_the_governed_appender(self) -> None:
        """Ordering, pinned where it is load-bearing.

        `append_tools_governance` calls `ensure_tools_dir`, which refuses a
        covered tree with no identity. So a row written BEFORE the identity
        does not merely bypass the gate — it cannot be written at all. That
        makes the ordering testable rather than a matter of comment.
        """
        import inspect

        from aria_kernel import tools_binding

        source = inspect.getsource(tools_binding._mint_host_identity)
        identity_at = source.index('root / "repo_identity.json"')
        row_at = source.index("tools_root_bound_to_host")
        self.assertLess(
            identity_at,
            row_at,
            "the identity must be written before the governance row",
        )


class BindingDelegatesWhenAMigrationIsRequired(RestoredTreeBindTestCase):
    def test_a_tree_published_before_the_split_migrates_once(self) -> None:
        """No flag day. A store whose branch predates `tools_contract.json`
        takes the old path exactly once — and that migration writes the file,
        so the next night is a bind."""
        fresh = self._restored()
        root = tools_root(fresh)
        (root / TOOLS_CONTRACT_FILENAME).unlink()  # what an older branch looks like

        first = self._bind(fresh)
        self.assertIs(first["migrated"], True)
        self.assertEqual(first["migration_trigger"], "contract_absent")
        self.assertTrue((root / TOOLS_CONTRACT_FILENAME).exists())

        kinds = [row["kind"] for row in _governance_rows(root)]
        self.assertIn(
            "tools_root_bind_required_migration",
            kinds,
            "a bind that rewrote ledgers must say so in the ledger",
        )

    def test_the_second_night_is_a_bind(self) -> None:
        fresh = self._restored()
        root = tools_root(fresh)
        (root / TOOLS_CONTRACT_FILENAME).unlink()
        self._bind(fresh)

        # A fresh restore of the same tree, as the next night sees it.
        (root / "repo_identity.json").unlink()
        before = len(_governance_rows(root))

        second = self._bind(fresh)
        self.assertIs(second["migrated"], False)
        added = _governance_rows(root)[before:]
        self.assertEqual([row["kind"] for row in added], ["tools_root_bound_to_host"])

    def test_a_genesis_store_still_binds(self) -> None:
        """An empty store has no contract file for the other reason — nothing
        has ever been written. Both lanes hit this on a first run, so a fix
        that only worked on a populated tree would fail exactly once, on the
        day it first mattered."""
        store = self._bootstrap()
        root = tools_root(store)
        result = self._bind(store)
        self.assertEqual(tools_contract_version(root), SCHEMA_VERSION)
        self.assertTrue((root / TOOLS_CONTRACT_FILENAME).exists())
        self.assertIn(result["status"], {"bound", "bound_via_migration"})

    def test_a_contract_below_target_migrates(self) -> None:
        store = self._restored()
        root = tools_root(store)
        contract_file = root / TOOLS_CONTRACT_FILENAME
        contract = json.loads(contract_file.read_text(encoding="utf-8"))
        contract["aria_tools_contract_version"] = SCHEMA_VERSION - 1
        contract["schema_version"] = SCHEMA_VERSION - 1
        contract_file.write_text(json.dumps(contract), encoding="utf-8")

        result = self._bind(store)
        self.assertIs(result["migrated"], True)
        self.assertEqual(result["migration_trigger"], "contract_below_target")


class AMigrationRefusesToBind(RestoredTreeBindTestCase):
    """The trap the split created, closed and pinned.

    Once the tree publishes its own version, a restored tree already at the
    target reaches `migrate_tools_bootstrap` with nothing to migrate — and
    `already_at_target` would be a SUCCESS handed back for a root that still
    has no host identity and still fails `ensure_tools_dir`. Two existing
    tests walked into it before this refusal existed.

    Pinned here because the refusal had no test of its own: it only ever
    failed the suite through callers in other files, which is a control that
    works by accident.
    """

    def test_a_migration_refuses_a_tree_that_only_needs_binding(self) -> None:
        from aria_kernel.migration import migrate_tools_bootstrap

        store = self._restored()
        root = tools_root(store)
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            with self.assertRaises(GovernanceError) as caught:
                migrate_tools_bootstrap(
                    tools_dir=str(root),
                    workspace_root=str(self.repo),
                    acknowledge=True,
                    reason="a migration asked to do a bind's job",
                )
        message = str(caught.exception)
        self.assertIn("tools_root_needs_binding_not_migration", message)
        self.assertIn(
            "bind-tools-root",
            message,
            "a refusal that does not name the right command is a dead end",
        )

    def test_a_migration_still_runs_when_there_is_something_to_migrate(self) -> None:
        """The positive control. Without it the refusal above would pass just
        as well if `migrate_tools_bootstrap` refused everything."""
        from aria_kernel.migration import migrate_tools_bootstrap

        store = self._restored()
        root = tools_root(store)
        (root / TOOLS_CONTRACT_FILENAME).unlink()  # a pre-split tree
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            result = migrate_tools_bootstrap(
                tools_dir=str(root),
                workspace_root=str(self.repo),
                acknowledge=True,
                reason="a genuine migration",
            )
        self.assertEqual(result["final_version"], SCHEMA_VERSION)


class AForeignStoreIsRefused(RestoredTreeBindTestCase):
    def test_a_store_published_for_another_repository_is_not_adopted(self) -> None:
        """Before the split there was nothing to check against: the migration
        rebound whatever tree it was pointed at to whatever repository it ran
        in. The published identity turns that silent adoption into a refusal.
        """
        store = self._restored()
        root = tools_root(store)
        contract_file = root / TOOLS_CONTRACT_FILENAME
        contract = json.loads(contract_file.read_text(encoding="utf-8"))
        contract["bound_canonical_identity"] = "some-other-repository"
        contract_file.write_text(json.dumps(contract), encoding="utf-8")

        with self.assertRaises(GovernanceError) as caught:
            self._bind(store)
        self.assertIn("tools_root_foreign_store", str(caught.exception))

    def test_the_same_repository_is_not_refused(self) -> None:
        """The positive control. Without it the refusal above would pass just
        as well if `bind_tools_root` refused everything."""
        store = self._restored()
        self.assertEqual(self._bind(store)["status"], "bound")


class TheLockAdmitsItsOwnHolder(RestoredTreeBindTestCase):
    def test_a_new_operation_can_write_while_holding_the_tools_lock(self) -> None:
        """`_guard_tools_lock` used to require the operation NAME to appear in
        a hardcoded set, so re-entrancy was a property of being remembered
        rather than of holding the lock. `tools_binding` was the next
        operation added and could not write its own governance row.

        Driven with an operation name that is deliberately not any of the
        historical three, so re-adding a roster fails here.
        """
        from aria_kernel.migration import tools_lock
        from aria_kernel.tool_registry import append_tools_governance

        fresh = self._restored()
        root = tools_root(fresh)
        self._bind(fresh)
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            with tools_lock(root, "an_operation_invented_after_the_roster", REPO_HASH):
                append_tools_governance(root, "lock_reentrancy_probe", {})


if __name__ == "__main__":
    unittest.main()
