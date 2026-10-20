"""ARIA-LOW-578 — a host with no tracking ref cannot adopt a replaced lineage.

The ARIA-HIGH-572 purge investigation measured it: a checkout on a host that
had never tracked ``aria/state`` (every GitHub-hosted runner, the
``aria-state-maintenance`` lane, a fresh clone) adopted a replacement tip with
a brand-new root and exited 0, because the only lineage check compared the
fetched tip with the host's OWN tracking ref. These tests drive the real
``checkout_state_store`` and the real CLI against a real bare remote, with the
host shaped the way ``actions/checkout`` leaves it: ``main`` fetched, no
``refs/remotes/origin/aria/state``.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import state_lineage, state_store
from aria_kernel.state_lineage import (
    LINEAGE_HISTORY_TRUNCATED,
    LINEAGE_PINNED_BRANCH_ABSENT,
    LINEAGE_POLICY_MALFORMED,
    LINEAGE_POLICY_MISSING,
    LINEAGE_ROOT_MISMATCH,
    LINEAGE_UNPINNED,
    STATE_LINEAGE_POLICY_PATH,
    read_lineage_pins,
)
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    STATE_BRANCH,
    StateStoreRefusal,
    _repository_identity,
    checkout_state_store,
)
from aria_kernel.state_snapshot import build_snapshot
from aria_kernel.tools_binding import bind_tools_root
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.hermetic_git import apply_hermetic_git_env
from tests._helpers.state_lineage_pin import (
    lineage_root,
    pin_bootstrapped_lineage,
    sync_fixture_lineage_pin,
    write_state_lineage_policy,
)
from tests._helpers.writer_lease import leased_publish

REPO_ROOT = Path(__file__).resolve().parents[2]
STATE_REF = f"refs/heads/{STATE_BRANCH}"
TRACKING_REF = f"refs/remotes/origin/{STATE_BRANCH}"
# The aria/state genesis on the production remote: `chore(aria-state): genesis
# for aria/state`, 2026-08-05, no parents (git show -s --format=%P is empty).
PRODUCTION_GENESIS_ROOT = "22edebf1885eb2d632201abe38cccc18c3621016"
REPO_HASH = "repohash0578"


def _env() -> dict[str, str]:
    """Every inherited GIT_* dropped, then the suite's hermetic config bound."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    apply_hermetic_git_env(env)
    return env


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True, env=_env(),
    ).stdout


def _commit_tree(cwd: Path, message: str, *parents: str, tree_of: str | None = None) -> str:
    """A commit on ``parents`` (none: a new root) carrying ``tree_of``'s tree."""
    tree = (
        _git(cwd, "rev-parse", f"{tree_of}^{{tree}}").strip()
        if tree_of
        else _git(cwd, "hash-object", "-t", "tree", "/dev/null").strip()
    )
    parent_args = [arg for parent in parents for arg in ("-p", parent)]
    return _git(cwd, "commit-tree", tree, *parent_args, "-m", message).strip()


class _LineageFixture(unittest.TestCase):
    """An operator host that bootstrapped aria/state, and a fresh lane host."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-lineage-pin-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.remote = self.tmp / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")
        self.operator = self._host("operator")
        (self.operator / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.operator, "add", "README.md")
        _git(self.operator, "commit", "-m", "seed")
        _git(self.operator, "push", "origin", "main")
        # The operator's acknowledged bootstrap mints the real genesis commit;
        # the lineage reaches the remote the way a first publish puts it there.
        saved_ack = os.environ.get(BOOTSTRAP_ACK_ENV)
        os.environ[BOOTSTRAP_ACK_ENV] = _repository_identity(self.operator)
        try:
            store = checkout_state_store(self.operator, store_dir=self.tmp / "operator-store")
        finally:
            if saved_ack is None:
                os.environ.pop(BOOTSTRAP_ACK_ENV, None)
            else:
                os.environ[BOOTSTRAP_ACK_ENV] = saved_ack
        self.assertTrue(store.bootstrapped)
        self.genesis = lineage_root(store.root)
        _git(store.root, "push", "origin", f"HEAD:{STATE_REF}")
        self.tip = _commit_tree(self.remote, "a published snapshot", self.genesis, tree_of=self.genesis)
        _git(self.remote, "update-ref", STATE_REF, self.tip, self.genesis)
        self.lane = self._lane_host("lane")

    def _host(self, name: str) -> Path:
        host = self.tmp / name
        host.mkdir()
        _git(host, "init", "--initial-branch=main", ".")
        _git(host, "remote", "add", "origin", str(self.remote))
        return host

    def _lane_host(self, name: str) -> Path:
        """What actions/checkout leaves: main fetched, aria/state never tracked."""
        host = self._host(name)
        _git(host, "fetch", "origin", "main:refs/remotes/origin/main")
        _git(host, "checkout", "--quiet", "-B", "main", "refs/remotes/origin/main")
        return host

    def _pin(self, host: Path, root: str, branch: str = STATE_BRANCH) -> None:
        write_state_lineage_policy(host, {branch: root})

    def _replace_remote_lineage(self) -> str:
        """The purge-rewrite shape: the same tree, re-rooted (no parent)."""
        replacement = _commit_tree(self.remote, "replacement root", tree_of=self.tip)
        _git(self.remote, "update-ref", STATE_REF, replacement)
        return replacement

    def _refused(self, host: Path) -> StateStoreRefusal:
        store_dir = host.parent / f"{host.name}-store"
        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(host, store_dir=store_dir)
        # Nothing was adopted: no anchor, no store, no scratch fetch ref left.
        self.assertEqual(_git(host, "for-each-ref", "--format=%(refname)", TRACKING_REF), "")
        self.assertEqual(_git(host, "for-each-ref", "--format=%(refname)", "refs/aria/tmp"), "")
        self.assertFalse(store_dir.exists())
        return ctx.exception


class AFreshHostIsHeldToThePinnedRoot(_LineageFixture):
    def test_a_new_root_replacement_tip_is_refused_on_a_host_with_no_tracking_ref(self) -> None:
        # The ARIA-HIGH-572 lab shape exactly: adopted with exit 0 before.
        self._pin(self.lane, self.genesis)
        replacement = self._replace_remote_lineage()

        refusal = self._refused(self.lane)

        self.assertIn(LINEAGE_ROOT_MISMATCH, str(refusal))
        self.assertIn(replacement, str(refusal))
        self.assertIn(self.genesis, str(refusal))

    def test_a_tip_that_descends_from_the_pinned_root_is_adopted(self) -> None:
        self._pin(self.lane, self.genesis)

        store = checkout_state_store(self.lane, store_dir=self.tmp / "lane-store")

        self.assertFalse(store.bootstrapped)
        self.assertEqual(_git(self.lane, "rev-parse", TRACKING_REF).strip(), self.tip)
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), self.tip)

    def test_a_tip_that_merged_in_a_second_root_is_refused(self) -> None:
        self._pin(self.lane, self.genesis)
        stranger = _commit_tree(self.remote, "another lineage")
        merged = _commit_tree(self.remote, "merge another lineage in", self.tip, stranger)
        _git(self.remote, "update-ref", STATE_REF, merged)

        refusal = self._refused(self.lane)

        self.assertIn(LINEAGE_ROOT_MISMATCH, str(refusal))

    def test_a_replacement_grafted_onto_the_pin_by_a_replace_ref_is_still_refused(self) -> None:
        # A host-local `git replace --graft` makes the new root LOOK like a
        # descendant of the pin to every history walk that honours it.
        self._pin(self.lane, self.genesis)
        _git(self.lane, "fetch", "origin", f"{STATE_REF}:refs/aria/old")
        replacement = self._replace_remote_lineage()
        _git(self.lane, "fetch", "origin", f"{STATE_REF}:refs/aria/new")
        _git(self.lane, "replace", "--graft", replacement, self.genesis)
        for probe in ("refs/aria/old", "refs/aria/new"):
            _git(self.lane, "update-ref", "-d", probe)
        # Honouring the replace ref, the walk now "proves" the pinned root.
        self.assertEqual(
            _git(self.lane, "rev-list", "--max-parents=0", replacement).split(), [self.genesis],
        )

        store_dir = self.tmp / "lane-store"
        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(self.lane, store_dir=store_dir)

        self.assertIn(LINEAGE_ROOT_MISMATCH, str(ctx.exception))
        self.assertFalse(store_dir.exists())

    def test_a_history_cut_short_cannot_prove_the_pin_and_is_refused(self) -> None:
        # A shallow fetch leaves the tip looking like a root to the walk; the
        # commit object still names its parent, so the pin is unprovable.
        self._pin(self.lane, self.genesis)
        _git(self.lane, "fetch", "--depth=1", "--refmap=", "origin", f"{STATE_REF}:refs/aria/shallow")
        _git(self.lane, "update-ref", "-d", "refs/aria/shallow")

        refusal = self._refused(self.lane)

        self.assertIn(LINEAGE_HISTORY_TRUNCATED, str(refusal))


class AnUnpinnedRepositoryTrustsNoLineage(_LineageFixture):
    def test_no_policy_refuses_and_names_the_root_to_pin(self) -> None:
        refusal = self._refused(self.lane)

        self.assertIn(LINEAGE_POLICY_MISSING, str(refusal))
        self.assertIn(self.genesis, str(refusal))

    def test_a_policy_that_pins_another_branch_only_refuses_this_one(self) -> None:
        self._pin(self.lane, self.genesis, branch="aria/state-trial")

        refusal = self._refused(self.lane)

        self.assertIn(LINEAGE_UNPINNED, str(refusal))
        self.assertIn(self.genesis, str(refusal))

    def test_a_host_that_tracked_the_old_lineage_is_held_to_the_pin_too(self) -> None:
        # The pin is checked whether or not a tracking ref exists: the
        # tracking ref is what the host saw, the pin is what main says.
        _git(self.lane, "fetch", "origin", f"{STATE_REF}:{TRACKING_REF}")
        tracked = _git(self.lane, "rev-parse", TRACKING_REF).strip()

        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(self.lane, store_dir=self.tmp / "lane-store")

        self.assertIn(LINEAGE_POLICY_MISSING, str(ctx.exception))
        self.assertEqual(_git(self.lane, "rev-parse", TRACKING_REF).strip(), tracked)


class APinnedBranchIsNeverReBootstrapped(_LineageFixture):
    def test_an_absent_pinned_branch_refuses_the_bootstrap_even_with_an_ack(self) -> None:
        self._pin(self.lane, self.genesis)
        _git(self.remote, "update-ref", "-d", STATE_REF)
        saved_ack = os.environ.get(BOOTSTRAP_ACK_ENV)
        os.environ[BOOTSTRAP_ACK_ENV] = _repository_identity(self.lane)
        self.addCleanup(
            lambda: os.environ.pop(BOOTSTRAP_ACK_ENV, None)
            if saved_ack is None else os.environ.__setitem__(BOOTSTRAP_ACK_ENV, saved_ack)
        )

        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(self.lane, store_dir=self.tmp / "lane-store")

        self.assertIn(LINEAGE_PINNED_BRANCH_ABSENT, str(ctx.exception))
        self.assertFalse((self.tmp / "lane-store").exists())


class TheCliReportsALineageRefusalAsARefusal(_LineageFixture):
    def test_state_checkout_exits_3_with_the_named_refusal(self) -> None:
        from aria_kernel.cli import main

        self._pin(self.lane, self.genesis)
        self._replace_remote_lineage()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main([
                "state", "checkout", "--repo-root", str(self.lane),
                "--store-dir", str(self.tmp / "lane-store"),
            ])

        self.assertEqual(code, 3)
        verdict = json.loads(out.getvalue())
        self.assertEqual(verdict["published"], False)
        self.assertTrue(verdict["refusal"].startswith(LINEAGE_ROOT_MISMATCH), verdict)


class ThePublishPathIsHeldToThePinToo(unittest.TestCase):
    """Every publish-side adoption of a remote tip proves the pin as well.

    Ambiguous-push reconciliation, contention replay and accepted-loser
    recovery adopt a FRESHLY fetched tip that only has to descend from the
    one the checkout proved. Descent is not lineage: an intermediate merge
    brings a second root into a history that still descends from the proven
    tip, and the snapshot verifier reads only the tip's own parent. Two real
    clones, a real bare remote, a real leased publish.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-lineage-publish-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.remote = self.tmp / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")
        self.repo_a = self._clone("work-a", seed=True)
        saved_ack = os.environ.get(BOOTSTRAP_ACK_ENV)
        os.environ[BOOTSTRAP_ACK_ENV] = _repository_identity(self.repo_a)
        self.addCleanup(
            lambda: os.environ.pop(BOOTSTRAP_ACK_ENV, None)
            if saved_ack is None else os.environ.__setitem__(BOOTSTRAP_ACK_ENV, saved_ack)
        )
        self.repo_b = self._clone("work-b", seed=False)

    def _clone(self, name: str, *, seed: bool) -> Path:
        repo = self.tmp / name
        repo.mkdir()
        _git(repo, "init", "--initial-branch=main", ".")
        _git(repo, "remote", "add", "origin", str(self.remote))
        if seed:
            (repo / "README.md").write_text("seed\n", encoding="utf-8")
            _git(repo, "add", "README.md")
            _git(repo, "commit", "-m", "seed")
            _git(repo, "push", "origin", "main")
        else:
            _git(repo, "fetch", "origin", "main")
            _git(repo, "checkout", "--quiet", "-B", "main", "origin/main")
        return repo

    def _store(self, repo: Path, name: str):
        sync_fixture_lineage_pin(repo, self.remote)
        store = checkout_state_store(repo, store_dir=self.tmp / name)
        if store.bootstrapped:
            pin_bootstrapped_lineage(store)
        return store

    def _append(self, store, cycle_id: str) -> None:
        root = state_store.tools_root(store)
        root.mkdir(parents=True, exist_ok=True)
        if not (root / "repo_identity.json").exists():
            bind_tools_root(
                tools_dir=root, workspace_root=store.repo_root,
                reason="bind the store checkout as this lane's tools root",
            )
        append_declared_fixture(
            root / "cycles.jsonl",
            {"schema_version": 2, "cycle_id": cycle_id, "event": "started"},
            expected_surface="cycles",
        )

    def _publish(self, store, snapshot_id: str, cycle_id: str):
        return leased_publish(
            store, snapshot_id=snapshot_id, cycle_id=cycle_id, lane="test", repo_hash=REPO_HASH,
        )

    def _two_root_descendant_of(self, commit: str) -> tuple[str, str]:
        """``T`` -> ``M`` -> {``commit``, a stranger root}: T has ONE parent
        and ``commit``'s tree, so the snapshot verifier reads it as valid."""
        stranger = _commit_tree(self.remote, "a stranger lineage")
        merge = _git(
            self.remote, "commit-tree", f"{commit}^{{tree}}", "-p", commit, "-p", stranger,
            "-m", "merge a stranger lineage in",
        ).strip()
        tip = _git(
            self.remote, "commit-tree", f"{commit}^{{tree}}", "-p", merge,
            "-m", "a state commit on top of it",
        ).strip()
        return tip, stranger

    def test_an_ambiguous_push_never_adopts_a_descendant_that_merged_in_a_second_root(self) -> None:
        store = self._store(self.repo_a, "store-a")
        self._append(store, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []
        replaced: list[str] = []

        def accept_then_extend_with_a_second_root(cwd, args):
            result = real_run_git(cwd, args)
            if cwd != store.root or args[0] != "push":
                return result
            self.assertEqual(result.returncode, 0, result.stderr)
            committed.append(next(
                arg for arg in args if isinstance(arg, str) and arg.endswith(f":{STATE_REF}")
            ).split(":", 1)[0])
            tip, _stranger = self._two_root_descendant_of(committed[0])
            _git(self.remote, "update-ref", STATE_REF, tip, committed[0])
            replaced.append(tip)
            return subprocess.CompletedProcess(result.args, 1, result.stdout, "injected ambiguous push")

        with mock.patch.object(
            state_store, "_run_git", side_effect=accept_then_extend_with_a_second_root,
        ), self.assertRaises(StateStoreRefusal) as ctx:
            self._publish(store, "snap-1", "cycle-1")

        self.assertIn(LINEAGE_ROOT_MISMATCH, str(ctx.exception))
        # Nothing adopted: the store keeps its own verified commit, the
        # publication anchor never names the two-root tip.
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), committed[0])
        self.assertNotEqual(_git(store.root, "rev-parse", TRACKING_REF).strip(), replaced[0])
        self.assertEqual(_git(self.remote, "rev-parse", STATE_REF).strip(), replaced[0])

    def test_a_stale_lane_never_replays_onto_a_tip_that_merged_in_a_second_root(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        base_head = _git(store_b.root, "rev-parse", "HEAD").strip()
        self._append(store_b, "lane-b-only")
        tip, _stranger = self._two_root_descendant_of(base_head)
        _git(self.remote, "update-ref", STATE_REF, tip, base_head)

        base = state_store.read_snapshot_at_worktree_head(store_b, expected_head=base_head)
        local = build_snapshot(
            snapshot_id="recovery-local", cycle_id="recovery-local", lane="test",
            roots=state_store.store_roots(store_b, REPO_HASH),
        )
        with self.assertRaises(StateStoreRefusal) as ctx:
            state_store.rebase_store_onto_remote(
                store_b, base=base, local=local, repo_hash=REPO_HASH, expected_base=base_head,
            )

        self.assertIn(LINEAGE_ROOT_MISMATCH, str(ctx.exception))
        self.assertEqual(_git(store_b.root, "rev-parse", "HEAD").strip(), base_head)


class ThePolicyIsReadStrictly(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-lineage-policy-"))
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.path = self.repo / STATE_LINEAGE_POLICY_PATH
        self.path.parent.mkdir(parents=True)

    def _refusal(self, text: str) -> str:
        self.path.write_text(text, encoding="utf-8")
        with self.assertRaises(StateStoreRefusal) as ctx:
            read_lineage_pins(self.repo)
        self.assertIn(LINEAGE_POLICY_MALFORMED, str(ctx.exception))
        return str(ctx.exception)

    def _policy(self, **overrides: object) -> str:
        policy: dict[str, object] = {
            "$schema": "aria/state-lineage/v1",
            "schema_version": 1,
            "policy_id": "aria-state-lineage",
            "lineages": [{"branch": STATE_BRANCH, "root": "a" * 40}],
        }
        policy.update(overrides)
        return json.dumps(policy)

    def test_absent_is_none_and_valid_is_the_pins(self) -> None:
        self.assertIsNone(read_lineage_pins(self.repo))
        self.path.write_text(self._policy(), encoding="utf-8")
        self.assertEqual(read_lineage_pins(self.repo), {STATE_BRANCH: "a" * 40})

    def test_every_loosening_is_refused(self) -> None:
        self._refusal("{")
        self._refusal(self._policy(extra=True))
        self._refusal(self._policy(schema_version=2))
        self._refusal(self._policy(schema_version=True))
        self._refusal(self._policy(policy_id="another-policy"))
        self._refusal(self._policy(lineages={"aria/state": "a" * 40}))
        self._refusal(self._policy(lineages=[{"branch": STATE_BRANCH, "root": "a" * 12}]))
        self._refusal(self._policy(lineages=[{"branch": STATE_BRANCH, "root": "0" * 40}]))
        self._refusal(self._policy(lineages=[
            {"branch": STATE_BRANCH, "root": "a" * 40},
            {"branch": STATE_BRANCH, "root": "b" * 40},
        ]))
        self._refusal(self._policy(lineages=[{"branch": STATE_BRANCH, "root": "a" * 40, "note": 1}]))
        self._refusal('{"$schema": "aria/state-lineage/v1", "$schema": "x", "schema_version": 1,'
                      ' "policy_id": "aria-state-lineage", "lineages": []}')

    def test_a_symlinked_policy_is_refused(self) -> None:
        target = self.repo / "elsewhere.json"
        target.write_text(self._policy(), encoding="utf-8")
        self.path.symlink_to(target)
        with self.assertRaises(StateStoreRefusal) as ctx:
            read_lineage_pins(self.repo)
        self.assertIn(LINEAGE_POLICY_MALFORMED, str(ctx.exception))


class TheRepositoryPinsItsOwnLineage(unittest.TestCase):
    """The pin every lane reads is committed policy in this repository."""

    def test_this_repository_pins_aria_state_to_its_genesis_root(self) -> None:
        self.assertEqual(read_lineage_pins(REPO_ROOT), {STATE_BRANCH: PRODUCTION_GENESIS_ROOT})

    def test_the_policy_path_is_one_codeowners_protects(self) -> None:
        codeowners = (REPO_ROOT / ".github" / "CODEOWNERS").read_text(encoding="utf-8")
        owned = [line.split()[0] for line in codeowners.splitlines() if line and not line.startswith("#")]
        self.assertTrue(
            any(STATE_LINEAGE_POLICY_PATH.startswith(entry.rstrip("*")) for entry in owned if entry.endswith("/")),
            "docs/aria/policy/ must stay CODEOWNERS-protected: the pin is reviewed policy",
        )
        self.assertEqual(state_lineage.STATE_LINEAGE_POLICY_PATH, "docs/aria/policy/state-lineage.json")


if __name__ == "__main__":
    unittest.main()
