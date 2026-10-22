"""ARIA-HIGH-123 — the sandbox binds git where the implementer commits, and nothing more.

The pre-change containment bound the workspace and ro-bound `.git/`: in a
linked worktree (the production shape) every git command died `not a git
repository`, in a main checkout `git add` died on `index.lock` (EROFS), and
the private signing key was readable inside. The first cut bound the shared
common dir's `objects/`, `refs/heads/`, `logs/refs/heads/`, the private git
dir and the whole state store WRITABLE — and the reverify showed the agent
deleting the shared packs, rewriting them with `git repack`, re-pointing
`objects/info/alternates`, planting `refs/heads/main.lock` and
`objects/maintenance.lock` (never cleaned by git), locking the worktree
against the reaper, and forging rows on every kernel ledger. These pins run
the REAL wrapper under the REAL bwrap on throwaway repositories (skipped
where bwrap is unusable) and re-run the measurement the design rests on,
one property per test:

* derivation: a linked worktree yields the replica (the sandbox's private
  git dir, a copy of the host's) with its quarantine (`objects/` with an
  alternates pointer at the shared store, `refs/heads/`, `logs/refs/heads/`)
  and the binds in mount order — a tmpfs AT the shared common dir with
  every shared entry bound back read-only one by one (ARIA-HIGH-141: a
  lock sibling git creates beside `packed-refs` lands in the tmpfs; the
  main checkout's in-progress state and `*.lock` files are not bound),
  the quarantine's ref dirs bound AT the common paths, existing
  loose refs read-only on top (bounded), the replica bound AT the private
  dir with its control files overlaid, `GIT_OBJECT_DIRECTORY` at the
  quarantine; a main checkout asked for commit capability is refused by
  name and never bound writable; a workspace that is not a checkout is
  refused (commit) or yields nothing (read); signing needs commit
  capability, a keys dir inside the workspace and a live agent socket;
* under bwrap, commit-capable: `git status`, `git switch -c`, `git add`,
  `git commit` (signed through the kernel-held agent, private key absent),
  `git verify-commit` and `git push` succeed inside — and NOTHING reaches
  the shared repository until the kernel publishes the quarantine from
  outside (objects re-hashed, the `aria-impl-*` ref published, the rest
  discarded by name); read-only: git reads answer and a write is EROFS,
  never "not a git repository";
* under bwrap, refused: the private key (masked), the effective hooks dir,
  `config`, `config.worktree` (`user.signingkey`), the signers file, the
  snapshots, `packed-refs`, every existing loose ref, the shared packs
  (`rm`, `git repack` writes only into the quarantine),
  `objects/info/alternates`, `objects/maintenance.lock`; a planted
  `refs/heads/main.lock`, a `packed-refs.lock` and a `locked` file land in
  the quarantine, the tmpfs and the replica, never on the host; the
  sibling worktree's tree and git dir and the main checkout's working
  tree are absent; a commit on a branch beside a PACKED `main` writes no
  `Read-only file system` line under the host's git;
* under bwrap, the state store is NOT in the sandbox: absent inside, a
  write there never reaches the host — while a hook journal row written
  inside through the hook client reaches the store outside, via the
  kernel-side broker;
* publication: verified loose objects move, a crafted object is refused by
  name and its ref discarded, a pack is unpacked (never copied), only
  `aria-impl-*` names are published, the rest are named; idempotent;
* mutation: the round-1 shapes — the store root bound writable, the shared
  `refs/heads` bound writable, the `config.worktree` overlay dropped — each
  let the agent through, which the pins above would catch.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from aria_kernel import git_containment as gc
from aria_kernel import implementation_safety as impl
from aria_kernel.containment_probe import probe_git_environment
from aria_kernel.git_containment import (
    GIT_OBJECT_DIRECTORY_ENV,
    LOOSE_REF_OVERLAY_BOUND,
    SANDBOX_GIT_DIR_NAME,
    SANDBOX_SIGNING_AGENT_SOCKET,
    GitContainmentRefusal,
    SandboxSigning,
    derive_git_containment,
    publish_quarantine,
)
from aria_kernel.dependency_tree import TOOL_CACHE_DIRNAMES
from aria_kernel.hook_broker import HOOK_BROKER_SOCKET_ENV, SANDBOX_HOOK_BROKER_SOCKET, serve_hook_broker
from aria_kernel.signing_agent import hold_signing_agent
from tests._helpers.ambient_git_config import AMBIENT_GIT_CONFIG, injected_git_config
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit
from tests._helpers.sandbox_pins import require_sandbox_backend

# ARIA-HIGH-138 — the seam(s) this file proves by a real process, per
# the closed registry in tests/invariants/seam_registry.py.
REAL_PROCESS_SEAMS = (
    "aria-kernel/aria_kernel/git_containment.py",
)

CYCLE = "cyc-aria-high-123"
BRANCH = "aria-impl-0123abcd"
_KERNEL_ROOT = Path(__file__).resolve().parents[1]


def _pairs(argv: list[str]) -> list[tuple[str, str, str]]:
    return [(argv[i], argv[i + 1], argv[i + 2]) for i, tok in enumerate(argv) if tok in ("--bind", "--ro-bind")]


def _mounts(argv: list[str]) -> list[tuple[str, str]]:
    return [(argv[i], argv[i + 1]) for i, tok in enumerate(argv) if tok in ("--bind", "--ro-bind", "--tmpfs")]


class _Checkout(unittest.TestCase):
    """A main checkout with two linked worktrees (`req-1` is the spawn's,
    `req-sibling` the neighbour), a local bare remote, packs in the shared
    store and `core.hooksPath = .husky` — the shape the persistent runner
    checkout carries."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-123-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo_with_initial_commit(self.root, {
            ".gitignore": "aria-debts/keys/\naria-worktrees/\n",
            "apps/sample.ts": "export const one = 1;\n",
            ".husky/pre-commit": "#!/bin/sh\nexit 0\n",
        }, name="checkout")
        _git(["config", "--local", "core.hooksPath", ".husky"], cwd=self.repo)
        (self.repo / "node_modules").mkdir()
        self.remote = self.root / "remote.git"
        _git(["init", "-q", "--bare", str(self.remote)], cwd=self.root)
        _git(["remote", "add", "origin", str(self.remote)], cwd=self.repo)
        # The shared store carries a pack (the runner checkout's shape).
        _git(["repack", "-a", "-d", "-q"], cwd=self.repo)
        # `packed-refs` exists (a packed tag; `main` stays loose), as on
        # every real checkout — the entry ARIA-HIGH-141 is about.
        _git(["tag", "v0-fixture"], cwd=self.repo)
        _git(["pack-refs"], cwd=self.repo)
        self.base = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        # ARIA-LOW-269 (b): the tracking ref the main anchor trusts, published
        # on the host as a cycle's checkout carries it, so `refs/remotes` is a
        # real shared entry the control-surface probes can aim at.
        _git(["update-ref", "refs/remotes/origin/main", self.base], cwd=self.repo)
        self.worktree = self.repo / "aria-worktrees" / "req-1"
        self.sibling = self.repo / "aria-worktrees" / "req-sibling"
        self.worktree.parent.mkdir()
        for path in (self.worktree, self.sibling):
            _git(["worktree", "add", "--detach", "-q", str(path), self.base], cwd=self.repo)
        self.common = (self.repo / ".git").resolve()
        self.private = self.common / "worktrees" / "req-1"
        self.replica = self.private / SANDBOX_GIT_DIR_NAME
        self.packs_before = sorted(path.name for path in (self.common / "objects" / "pack").iterdir())
        self.assertTrue((self.common / "packed-refs").is_file())
        self.assertTrue((self.common / "refs" / "heads" / "main").is_file(), "main stays loose")
        # The main checkout's in-progress state: not a shared entry, not
        # bound (ARIA-HIGH-141).
        (self.common / "ORIG_HEAD").write_text(self.base + "\n", encoding="utf-8")

    def _argv(self, script: str, containment, *, hook_broker_socket: Path | None = None,
              wrap=None, extra_flags: list[str] = ()) -> list[str]:
        wrapper = wrap or impl.wrap_bash_in_sandbox
        argv = wrapper(["sh", "-c", script], workspace_root=self.worktree, provider=impl.MANAGED_SPAWN_PROVIDER,
                       git=containment, hook_broker_socket=hook_broker_socket)
        if extra_flags:
            separator = argv.index("--")
            argv = argv[:separator] + list(extra_flags) + argv[separator:]
        return argv

    def _run(self, script: str, containment, *, hook_broker_socket: Path | None = None, wrap=None,
             extra_flags: list[str] = (), env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        argv = self._argv(script, containment, hook_broker_socket=hook_broker_socket, wrap=wrap,
                          extra_flags=extra_flags)
        return subprocess.run(argv, capture_output=True, text=True, timeout=90, env=env or probe_git_environment())

    def _shared_objects(self) -> set[str]:
        store = self.common / "objects"
        return {f"{d.name}{f.name}" for d in store.iterdir() if d.is_dir() and len(d.name) == 2 for f in d.iterdir()}


class DerivationTests(_Checkout):
    def test_a_linked_worktree_yields_the_replica_and_the_binds_in_mount_order(self) -> None:
        # A stale lock on the host (an interrupted operation of the main
        # checkout) is not a shared entry either: not bound, so it cannot
        # wedge the agent's git inside.
        (self.common / "index.lock").write_bytes(b"")
        self.addCleanup(lambda: (self.common / "index.lock").unlink(missing_ok=True))
        containment = derive_git_containment(self.worktree, commit_capable=True)
        assert containment is not None
        self.assertEqual((containment.private_git_dir, containment.common_git_dir), (self.private, self.common))
        self.assertEqual(containment.hooks_dir, (self.worktree / ".husky").resolve())
        self.assertEqual(containment.sandbox_git_dir, self.replica)
        # The replica: the private dir's files copied, the quarantine made,
        # the alternates pointer at the shared store.
        for name in ("HEAD", "index", "commondir", "gitdir"):
            self.assertEqual((self.replica / name).read_bytes(), (self.private / name).read_bytes(), name)
        self.assertEqual((self.replica / "objects" / "info" / "alternates").read_text(encoding="utf-8").strip(),
                         str(self.common / "objects"))
        self.assertTrue((self.replica / "refs" / "heads").is_dir())
        self.assertTrue((self.replica / "logs" / "refs" / "heads").is_dir())
        self.assertFalse((self.replica / SANDBOX_GIT_DIR_NAME).exists(), "the replica does not nest itself")
        flags = containment.bwrap_flags()
        mounts = _mounts(flags)
        binds = _pairs(flags)
        # A tmpfs at the common dir first, every shared entry bound back
        # read-only one by one (ARIA-HIGH-141); the quarantine's ref dirs
        # bound at the common paths; the loose `main` overlaid; siblings
        # masked; the replica AT the private dir; its control files
        # overlaid last.
        self.assertEqual(mounts[0], ("--tmpfs", str(self.common)))
        self.assertNotIn(("--ro-bind", str(self.common)), mounts, "the common dir is no longer bound as a whole")
        shared = [source for flag, source, target in binds if flag == "--ro-bind" and source == target
                  and Path(source).parent in (self.common, self.common / "refs", self.common / "logs", self.common / "logs" / "refs")]
        for name in ("config", "hooks", "info", "objects", "packed-refs", "HEAD", "refs/tags", "logs/HEAD"):
            self.assertIn(str(self.common / name), shared, name)
        self.assertEqual(tuple(Path(source) for source in shared), containment.common_entries)
        for absent in ("refs/heads", "logs/refs/heads", "worktrees", "ORIG_HEAD", "index.lock", "refs", "logs"):
            self.assertNotIn(str(self.common / absent), shared, f"{absent} is not a shared entry bound as such")
        self.assertLess(max(mounts.index(("--ro-bind", source)) for source in shared),
                        mounts.index(("--bind", str(self.replica / "refs" / "heads"))),
                        "the quarantine binds come after the shared entries")
        self.assertIn(("--bind", str(self.replica / "refs" / "heads"), str(self.common / "refs" / "heads")), binds)
        self.assertIn(("--bind", str(self.replica / "logs" / "refs" / "heads"), str(self.common / "logs" / "refs" / "heads")), binds)
        self.assertIn(("--ro-bind", str(self.common / "refs" / "heads" / "main")), mounts)
        self.assertEqual(containment.loose_refs, (self.common / "refs" / "heads" / "main",))
        self.assertIn(("--tmpfs", str(self.common / "worktrees")), mounts)
        self.assertIn(("--bind", str(self.replica), str(self.private)), binds)
        self.assertIn(("--ro-bind", str(self.replica / "commondir"), str(self.private / "commondir")), binds)
        # ARIA-HIGH-148: the effective hooks dir is an empty read-only mount
        # inside, never the repository's hooks — the agent's git runs none.
        hooks = str((self.worktree / ".husky").resolve())
        self.assertIn(("--tmpfs", hooks), mounts)
        self.assertNotIn(("--ro-bind", hooks), mounts)
        self.assertEqual(flags[flags.index("--remount-ro") + 1], hooks)
        self.assertLess(mounts.index(("--tmpfs", str(self.common / "worktrees"))), mounts.index(("--bind", str(self.replica))))
        self.assertLess(mounts.index(("--bind", str(self.replica))), mounts.index(("--ro-bind", str(self.replica / "commondir"))))
        env_index = flags.index("--setenv")
        self.assertEqual(flags[env_index:env_index + 3],
                         ["--setenv", GIT_OBJECT_DIRECTORY_ENV, str(self.private / "objects")])
        # Nothing of the shared repository is writable: not the common dir,
        # not its objects, not the host's private dir.
        writable = [source for flag, source, _target in binds if flag == "--bind"]
        self.assertNotIn(str(self.common), writable)
        self.assertNotIn(str(self.common / "objects"), writable)
        self.assertNotIn(str(self.common / "refs" / "heads"), writable)
        self.assertNotIn(str(self.private), writable)
        self.assertTrue(all(source.startswith(str(self.replica)) for source in writable), writable)

    def test_a_stale_replica_is_replaced(self) -> None:
        derive_git_containment(self.worktree, commit_capable=True)
        (self.replica / "objects" / "ab").mkdir()
        (self.replica / "objects" / "ab" / "cdef").write_bytes(b"stale")
        (self.replica / "refs" / "heads" / "aria-impl-stale").write_text(self.base + "\n", encoding="utf-8")
        derive_git_containment(self.worktree, commit_capable=True)
        self.assertFalse((self.replica / "objects" / "ab").exists())
        self.assertEqual(list((self.replica / "refs" / "heads").iterdir()), [])

    def test_read_only_derivation_binds_nothing_writable_and_makes_no_replica(self) -> None:
        containment = derive_git_containment(self.worktree, commit_capable=False)
        assert containment is not None
        flags = containment.bwrap_flags()
        self.assertNotIn("--bind", flags)
        self.assertNotIn("--setenv", flags)
        self.assertEqual(_mounts(flags)[0], ("--tmpfs", str(self.common)))
        self.assertIn(self.common / "refs" / "heads", containment.common_entries,
                      "without a quarantine the shared heads are a read-only entry like any other")
        self.assertIsNone(containment.hooks_dir)
        self.assertIsNone(containment.sandbox_git_dir)
        self.assertIn(str(self.private), flags)
        self.assertFalse(self.replica.exists())

    def test_a_main_checkout_is_refused_for_commits_and_never_bound_writable(self) -> None:
        with self.assertRaises(GitContainmentRefusal) as refused:
            derive_git_containment(self.repo, commit_capable=True)
        self.assertEqual(refused.exception.reason, "shared_checkout_scope:--local")
        self.assertIsNone(derive_git_containment(self.repo, commit_capable=False))
        argv = impl._sandbox_argv(["true"], workspace_root=self.repo, 
                                  git=derive_git_containment(self.repo, commit_capable=False))
        writable = [argv[i + 1] for i, tok in enumerate(argv) if tok == "--bind"]
        self.assertEqual(writable, [str(self.repo)])
        self.assertIn(str(self.repo / ".git"), argv[argv.index("--ro-bind"):], "the main checkout's .git stays read-only")

    def test_a_non_checkout_is_refused_for_commits_and_nothing_for_reads(self) -> None:
        bare = self.root / "not-a-checkout"
        bare.mkdir()
        with self.assertRaises(GitContainmentRefusal) as refused:
            derive_git_containment(bare, commit_capable=True)
        self.assertEqual(refused.exception.reason, "not_a_checkout")
        self.assertIsNone(derive_git_containment(bare, commit_capable=False))

    def test_too_many_loose_refs_are_refused_by_name(self) -> None:
        heads = self.common / "refs" / "heads"
        for index in range(LOOSE_REF_OVERLAY_BOUND):
            (heads / f"loose-{index}").write_text(self.base + "\n", encoding="utf-8")
        with self.assertRaises(GitContainmentRefusal) as refused:
            derive_git_containment(self.worktree, commit_capable=True)
        self.assertEqual(refused.exception.reason, f"loose_refs_exceed_overlay_bound:{LOOSE_REF_OVERLAY_BOUND + 1}")
        self.assertFalse(self.replica.exists(), "refused before any replica was made")
        # Packed, the same refs cost no mount: the remedy the reason names.
        _git(["pack-refs", "--all"], cwd=self.repo)
        containment = derive_git_containment(self.worktree, commit_capable=True)
        assert containment is not None
        self.assertEqual(containment.loose_refs, ())

    def test_signing_is_validated_against_the_workspace(self) -> None:
        from tests._helpers.unix_sockets import bound_unix_socket

        keys = self.worktree / "aria-debts" / "keys"
        keys.mkdir(parents=True)
        (keys / f"{CYCLE}.pub").write_text("ssh-ed25519 AAAA fixture\n", encoding="utf-8")
        outside = self.root / "elsewhere"
        outside.mkdir()
        (outside / "x.pub").write_text("ssh-ed25519 AAAA fixture\n", encoding="utf-8")
        cases = {
            "signing_without_commit_capability": (False, SandboxSigning(keys, keys / f"{CYCLE}.pub", self.root / "sock")),
            "signing_keys_dir_outside_workspace": (True, SandboxSigning(outside, outside / "x.pub", self.root / "sock")),
            "signing_public_key_outside_keys_dir": (True, SandboxSigning(keys, outside / "x.pub", self.root / "sock")),
            "signing_agent_socket_missing": (True, SandboxSigning(keys, keys / f"{CYCLE}.pub", self.root / "sock")),
        }
        for reason, (commit_capable, signing) in cases.items():
            with self.subTest(reason=reason), self.assertRaises(GitContainmentRefusal) as refused:
                derive_git_containment(self.worktree, commit_capable=commit_capable, signing=signing)
            self.assertEqual(refused.exception.reason, reason)
        with bound_unix_socket(self.root / "sa" / "agent") as socket_path:
            containment = derive_git_containment(self.worktree, commit_capable=True, signing=SandboxSigning(
                keys, keys / f"{CYCLE}.pub", socket_path,
            ))
        assert containment is not None and containment.signing is not None
        self.assertEqual(containment.signing.agent_socket, socket_path)

    def test_the_wrapper_refuses_a_containment_derived_for_another_workspace(self) -> None:
        containment = derive_git_containment(self.sibling, commit_capable=False)
        with self.assertRaises(impl.SandboxUnavailable) as refused:
            impl._sandbox_argv(["true"], workspace_root=self.worktree, git=containment)
        self.assertIn("git_containment_workspace_mismatch", str(refused.exception))

    def test_the_wrapper_appends_the_git_binds_after_readonly_paths_and_never_binds_a_store(self) -> None:
        containment = derive_git_containment(self.worktree, commit_capable=True)
        argv = impl._sandbox_argv(["true"], workspace_root=self.worktree, git=containment)
        marker = argv.index(str(self.worktree / ".git"))
        self.assertLess(marker, argv.index(str(self.common)), "READONLY_PATHS first, the derived git binds after")
        self.assertIn("--unshare-net", argv)
        self.assertNotIn("tools_dir", impl.wrap_bash_in_sandbox.__code__.co_varnames)
        self.assertNotIn("tools_dir", impl._sandbox_argv.__code__.co_varnames)

    def test_a_missing_hook_broker_socket_is_refused_by_name(self) -> None:
        containment = derive_git_containment(self.worktree, commit_capable=True)
        with self.assertRaises(impl.SandboxUnavailable) as refused:
            impl._sandbox_argv(["true"], workspace_root=self.worktree, git=containment,
                               hook_broker_socket=self.root / "nowhere.sock")
        self.assertIn("hook_broker_socket_missing", str(refused.exception))


class _HeldIdentity(_Checkout):
    """The signing shape the executor hands the spawn: a minted key, the
    agent holding it, the containment derived with the signing exposure."""

    def setUp(self) -> None:
        super().setUp()
        require_sandbox_backend(fresh_probe=True)
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key

        key = mint_signing_key(cycle_id=CYCLE, workspace_root=self.worktree)
        self.addCleanup(lambda: revoke_signing_key(cycle_id=CYCLE, workspace_root=self.worktree))
        assert key.git_signing is not None and key.git_signing.configured, key.git_signing
        self.key = key
        agent_cm = hold_signing_agent(key.private_key_path, expected_fingerprint=key.fingerprint)
        self.agent = agent_cm.__enter__()
        self.addCleanup(agent_cm.__exit__, None, None, None)
        self.signing = SandboxSigning(
            keys_dir=key.private_key_path.parent, public_key_path=key.public_key_path,
            agent_socket=self.agent.socket_path,
        )
        self.containment = derive_git_containment(self.worktree, commit_capable=True, signing=self.signing)
        self.host_head_before = (self.private / "HEAD").read_text(encoding="utf-8")
        self.objects_before = self._shared_objects()

    def _verify_outside(self, sha: str) -> subprocess.CompletedProcess[str]:
        signers = self.private / "aria-allowed-signers"
        return _git(["-c", f"gpg.ssh.allowedSignersFile={signers}", "verify-commit", "--raw", sha],
                    cwd=self.repo, check=False)


class UnderRealBwrapTests(_HeldIdentity):
    def test_the_implementers_git_operations_succeed_inside_and_land_only_when_the_kernel_publishes(self) -> None:
        # (round 3) the branch is the KERNEL's seed; only the seeded name
        # is ever published, so the sandbox is stood on it first.
        self.containment = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        done = self._run(
            f"set -e; git status --short >/dev/null; test \"$(git branch --show-current)\" = {BRANCH}; "
            "echo two > apps/sample.ts; git add apps/sample.ts; git commit -q -m 'feat: two'; "
            f"git verify-commit HEAD 2>&1; git push -q origin {BRANCH} 2>/dev/null || true; git rev-parse HEAD",
            self.containment, extra_flags=["--bind", str(self.remote), str(self.remote)],
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        head = done.stdout.strip().splitlines()[-1]
        self.assertIn("Good \"git\" signature", done.stdout + done.stderr)
        # The push reached the remote from inside (the quarantine's objects
        # and ref are what pack-objects read).
        self.assertEqual(_git(["rev-parse", BRANCH], cwd=self.remote).stdout.strip(), head)
        # NOTHING reached the shared repository yet: no branch, no new
        # object, the host's worktree HEAD untouched — all of it is in the
        # quarantine.
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", BRANCH], cwd=self.repo, check=False).returncode, 0)
        self.assertEqual(self._shared_objects(), self.objects_before)
        self.assertEqual((self.private / "HEAD").read_text(encoding="utf-8"), self.host_head_before)
        self.assertEqual((self.replica / "refs" / "heads" / BRANCH).read_text(encoding="utf-8").strip(), head)
        self.assertGreater(len(list((self.replica / "objects").rglob("*"))), 3)
        # The kernel publishes from outside: verified objects move, the
        # branch is published, the commit verifies through the real common
        # dir against the cycle's key, the quarantine is empty.
        publication = publish_quarantine(self.containment)
        self.assertIsNone(publication.refusal)
        self.assertEqual(publication.refs_published, (BRANCH,))
        self.assertEqual(publication.objects_refused, ())
        self.assertGreaterEqual(publication.loose_objects_migrated, 3)
        self.assertEqual(_git(["rev-parse", BRANCH], cwd=self.repo).stdout.strip(), head)
        verify = self._verify_outside(head)
        self.assertEqual(verify.returncode, 0, verify.stderr)
        self.assertIn(self.key.fingerprint, verify.stderr + verify.stdout)
        self.assertEqual(list((self.replica / "refs" / "heads").iterdir()), [])
        # The host worktree now stands where the agent left the replica: on
        # the published branch, index at its commit, working tree clean —
        # what the executor's evidence check reads.
        self.assertEqual(publication.head_adopted, BRANCH)
        self.assertEqual(_git(["symbolic-ref", "HEAD"], cwd=self.worktree).stdout.strip(), f"refs/heads/{BRANCH}")
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=self.worktree).stdout.strip(), head)
        self.assertEqual(_git(["status", "--porcelain"], cwd=self.worktree).stdout.strip(), "")
        # And a second publication moves nothing.
        again = publish_quarantine(self.containment)
        self.assertEqual((again.loose_objects_migrated, again.refs_published), (0, ()))

    def test_links_planted_inside_the_sandbox_are_refused_by_name_and_follow_nothing(self) -> None:
        """ARIA-HIGH-527 — measured from inside the real sandbox, not assumed:
        the agent replaces the quarantine's pack dir and the replica's
        `refs/heads` with links to a directory outside the replica (both
        succeed inside). The host's publication refuses by the first planted
        entry's name, publishes nothing, and the directory the links name is
        untouched — the link-following walk deleted every file in it."""
        self.containment = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        sentinel = self.root / "outside"
        sentinel.mkdir()
        (sentinel / "sentinel.pack").write_bytes(b"PACK but not one\n")
        (sentinel / "sentinel.idx").write_bytes(b"index\n")
        (sentinel / "aria-impl-0000f00d").write_text(self.base + "\n", encoding="utf-8")
        before = _snapshot(sentinel)
        quarantine = f'"${GIT_OBJECT_DIRECTORY_ENV}"'
        heads = self.private / "refs" / "heads"
        done = self._run(
            "set -e; git commit -q --allow-empty -m planted; "
            f"rm -rf {quarantine}/pack; ln -s {sentinel} {quarantine}/pack; "
            f"mv {heads} {heads}.agent; ln -s {sentinel} {heads}; echo PLANTED",
            self.containment,
        )
        self.assertEqual(done.stdout.split(), ["PLANTED"], done.stderr)
        self.assertTrue((self.replica / "objects" / "pack").is_symlink())
        self.assertTrue((self.replica / "refs" / "heads").is_symlink())
        publication = publish_quarantine(self.containment)
        self.assertEqual(_snapshot(sentinel), before, "the directory the planted links name changed")
        self.assertEqual(publication.refusal, "replica_entry_refused:symlink:objects/pack")
        self.assertEqual((publication.loose_objects_migrated, publication.refs_published, publication.head_adopted),
                         (0, (), None))
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", BRANCH], cwd=self.repo, check=False).returncode, 0)
        self.assertEqual(sorted(path.name for path in (self.common / "objects" / "pack").iterdir()), self.packs_before)
        self.assertEqual(self._shared_objects(), self.objects_before)

    def test_read_only_containment_answers_reads_and_refuses_writes_by_erofs(self) -> None:
        read_only = derive_git_containment(self.worktree, commit_capable=False)
        done = self._run("git status --short && git log --oneline -1 && git rev-parse HEAD", read_only)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("not a git repository", done.stderr)
        write = self._run("echo two > apps/sample.ts; git add apps/sample.ts", read_only)
        self.assertNotEqual(write.returncode, 0)
        self.assertIn("Read-only file system", write.stderr)
        self.assertNotIn("not a git repository", write.stderr)

    def test_the_private_key_is_not_in_the_sandbox_and_the_public_key_is(self) -> None:
        done = self._run(
            f"ls -A {self.key.private_key_path.parent}; cat {self.key.private_key_path} 2>&1 || echo PRIVATE_UNREADABLE",
            self.containment,
        )
        self.assertIn("PRIVATE_UNREADABLE", done.stdout)
        self.assertEqual(sorted(done.stdout.splitlines()[:1]), [self.key.public_key_path.name])
        self.assertNotIn("PRIVATE KEY", done.stdout)

    def test_a_commit_without_the_agent_fails_rather_than_going_unsigned(self) -> None:
        without_agent = self._run(
            "git switch -q -c aria-impl-00000a9e HEAD; echo x > apps/sample.ts; git add apps/sample.ts; "
            "SSH_AUTH_SOCK=/tmp/nowhere git commit -q -m 'feat: x'",
            self.containment,
        )
        self.assertNotEqual(without_agent.returncode, 0)
        # The refusal's wording is OpenSSH's, and it moved between releases
        # (9.x: `No private key found`; 8.9 on Ubuntu 22.04: `Load key
        # "...": No such file or directory`). The property is the same: with
        # no agent, the commit is refused rather than going unsigned.
        self.assertRegex(without_agent.stderr, r"No private key found|No such file or directory")
        # `git switch -c` made the ref at its base; the refused commit never
        # existed, so nothing is published: a branch the kernel never seeded
        # is discarded by name (round 3), and had it been the seed it would
        # be discarded as unadvanced.
        publication = publish_quarantine(self.containment)
        self.assertEqual(publication.refs_published, ())
        self.assertIn(("aria-impl-00000a9e", "not_the_seeded_branch"), publication.refs_discarded)
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", "aria-impl-00000a9e"], cwd=self.repo, check=False).returncode, 0)

    def test_control_surfaces_are_unwritable_and_siblings_invisible(self) -> None:
        pack = self.common / "objects" / "pack" / self.packs_before[0]
        # ARIA-LOW-269 (b): a real loose object on the host, so an EXISTING
        # objects fan-out directory is among the surfaces probed.
        minted = subprocess.run(
            ["git", "hash-object", "-w", "--stdin"], cwd=self.repo, input="aria-269 probe\n",
            capture_output=True, text=True, env=probe_git_environment(), check=True).stdout.strip()
        fan_out = self.common / "objects" / minted[:2]
        # The host state the probes must leave byte-identical (ARIA-LOW-269
        # (b): the invariant is host state, never ALLOWED inside a tmpfs).
        head_bytes = (self.common / "HEAD").read_bytes()
        objects_before = _snapshot(self.common / "objects")
        probes = {
            "hooks": f"echo x > {self.worktree}/.husky/pre-commit",
            "hooks_new_file": f"echo x > {self.worktree}/.husky/post-checkout",
            "common_config": f"echo x >> {self.common}/config",
            "git_config_local": "git config --local aria.probe 1",
            "config_worktree": f"echo x >> {self.private}/config.worktree",
            "git_config_worktree_signingkey": "git config --worktree user.signingkey /tmp/other",
            "allowed_signers": f"echo x >> {self.private}/aria-allowed-signers",
            "snapshot": f"echo x > {self.private}/aria-signing-config-snapshots/{CYCLE}.json",
            "main_ref": f"echo {self.base} > {self.common}/refs/heads/main",
            "main_ref_unlink": f"rm -f {self.common}/refs/heads/main && test ! -e {self.common}/refs/heads/main",
            "git_update_ref_main": ("git switch -q -c aria-impl-0000b0be HEAD && git commit -q --allow-empty -m probe "
                                    "&& git update-ref refs/heads/main HEAD"),
            "git_delete_ref_main": "git update-ref -d refs/heads/main",
            "git_branch_force_main": "git branch -f main HEAD",
            # ARIA-LOW-269 (b): the anchor's OTHER ref — refs/remotes/origin/
            # main, published on the host as a cycle's checkout carries it —
            # the common HEAD, and a file in an existing objects fan-out.
            "origin_main_ref": f"echo {self.base} > {self.common}/refs/remotes/origin/main",
            "git_update_ref_origin_main": "git update-ref refs/remotes/origin/main HEAD",
            "common_head": f"echo x > {self.common}/HEAD",
            "object_in_existing_fan_out": f"echo x > {fan_out}/probe",
            "packed_refs": f"echo x >> {self.common}/packed-refs",
            "pack_unlink": f"rm -f {pack} && test ! -e {pack}",
            "pack_truncate": f"( : > {pack} )",
            "alternates": f"echo /tmp/evil > {self.common}/objects/info/alternates",
            "maintenance_lock": f"touch {self.common}/objects/maintenance.lock",
            "loose_object_dir": f"mkdir {self.common}/objects/zz",
            "sibling_tree": f"ls {self.sibling}",
            "sibling_git_dir": f"ls {self.common}/worktrees/req-sibling",
            "main_working_tree": f"ls {self.repo}/apps",
            "main_index": f"echo x >> {self.common}/index",
            "orig_head_absent": f"test -e {self.common}/ORIG_HEAD",
            # ARIA-HIGH-141: the lock a current git takes beside
            # `packed-refs` on a ref update CAN be created — in the tmpfs.
            "packed_refs_lock_sibling": f"touch {self.common}/packed-refs.lock",
        }
        outcomes = {}
        for name, command in probes.items():
            done = self._run(f"{command} 2>/dev/null && echo ALLOWED || echo REFUSED", self.containment)
            outcomes[name] = done.stdout.strip()
        expected = {name: "REFUSED" for name in probes}
        expected["packed_refs_lock_sibling"] = "ALLOWED"
        self.assertEqual(outcomes, expected)
        self.assertFalse((self.common / "packed-refs.lock").exists(), "the lock sibling died with the sandbox")
        # And nothing changed outside — the anchor's tracking ref and the
        # common HEAD included.
        self.assertEqual(_git(["config", "--worktree", "user.signingkey"], cwd=self.worktree).stdout.strip(),
                         str(self.key.private_key_path))
        self.assertEqual(_git(["rev-parse", "main"], cwd=self.repo).stdout.strip(), self.base)
        self.assertEqual(_git(["rev-parse", "refs/remotes/origin/main"], cwd=self.repo).stdout.strip(), self.base)
        self.assertEqual((self.common / "HEAD").read_bytes(), head_bytes)
        self.assertEqual(_snapshot(self.common / "objects"), objects_before)
        self.assertEqual(sorted(path.name for path in (self.common / "objects" / "pack").iterdir()), self.packs_before)
        self.assertFalse((self.common / "objects" / "info" / "alternates").exists())
        self.assertFalse((self.common / "objects" / "maintenance.lock").exists())
        self.assertEqual(_git(["fsck", "--no-dangling"], cwd=self.repo, check=False).returncode, 0)

    def test_planted_locks_a_repack_and_a_worktree_lock_stay_in_the_quarantine(self) -> None:
        self.containment = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        done = self._run(
            f"git commit -q --allow-empty -m probe && git repack -dq 2>/dev/null && echo REPACK_OK; "
            f"git repack -adq 2>/dev/null; echo REPACK_ALL_RC=$?; "
            f"touch {self.common}/refs/heads/main.lock && echo LOCK_PLANTED; "
            f"touch {self.common}/refs/heads/{BRANCH}.lock && echo BRANCH_LOCK_PLANTED; "
            f"echo agent > {self.private}/locked && echo LOCKED_WRITTEN; "
            f"ls {self.common}/objects/pack",
            self.containment,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.split()[:5],
                         ["REPACK_OK", "REPACK_ALL_RC=0", "LOCK_PLANTED", "BRANCH_LOCK_PLANTED", "LOCKED_WRITTEN"])
        # Both repacks "succeed" inside — into the quarantine's pack dir; the
        # full one could not remove the shared packs it made redundant (a
        # warning inside), and the shared pack set is what it was.
        self.assertEqual(sorted(path.name for path in (self.common / "objects" / "pack").iterdir()), self.packs_before)
        self.assertTrue(any(path.suffix == ".pack" for path in (self.replica / "objects" / "pack").iterdir()))
        # On the host: no lock under the shared refs, no `locked` on the
        # worktree — the reaper's `git worktree remove --force` is not
        # refused — and git is not wedged.
        self.assertFalse((self.common / "refs" / "heads" / "main.lock").exists())
        self.assertFalse((self.common / "refs" / "heads" / f"{BRANCH}.lock").exists())
        self.assertFalse((self.private / "locked").exists())
        self.assertTrue((self.replica / "refs" / "heads" / "main.lock").exists(), "the lock landed in the quarantine")
        self.assertTrue((self.replica / "locked").exists(), "the lock file landed in the replica")
        self.assertEqual(_git(["commit", "-q", "--allow-empty", "-m", "host-commit-on-main"], cwd=self.repo, check=False).returncode, 0,
                         "the host's `main` is not wedged by a planted lock")
        self.assertEqual(_git(["worktree", "list", "--porcelain"], cwd=self.repo).stdout.count("locked"), 0)
        # Publication: the pack is UNPACKED into the store (never copied),
        # the branch published, the locks discarded by name.
        publication = publish_quarantine(self.containment)
        self.assertIsNone(publication.refusal)
        self.assertEqual(publication.packs_unpacked, 1)
        self.assertEqual(publication.refs_published, (BRANCH,))
        self.assertEqual(sorted(publication.refs_discarded),
                         [(f"{BRANCH}.lock", "not_an_aria_implementation_branch"), ("main.lock", "not_an_aria_implementation_branch")])
        self.assertEqual(sorted(path.name for path in (self.common / "objects" / "pack").iterdir()), self.packs_before)
        self.assertEqual(_git(["fsck", "--no-dangling"], cwd=self.repo, check=False).returncode, 0)
        self.assertEqual(_git(["worktree", "remove", "--force", str(self.worktree)], cwd=self.repo, check=False).returncode, 0)

    def test_a_commit_beside_a_packed_main_leaves_no_lock_and_no_erofs_line(self) -> None:
        """ARIA-HIGH-141 — the production shape: every ref packed. A current
        git takes `packed-refs.lock` on the loose-ref update the commit makes;
        under the whole-dir read-only bind that was an `error: ... Read-only
        file system` line on every branch creation (hosted 22.04, git 2.55).
        The property is pinned under the host's git, whatever it is: the
        commit lands in the quarantine, stderr carries no EROFS line, no lock
        reaches the repository, and the publication publishes the branch."""
        _git(["pack-refs", "--all"], cwd=self.repo)
        self.assertFalse((self.common / "refs" / "heads" / "main").exists())
        containment = derive_git_containment(self.worktree, commit_capable=True, signing=self.signing)
        assert containment is not None
        self.assertEqual(containment.loose_refs, ())
        containment = gc.stand_on_implementation_branch(containment, branch=BRANCH, base_sha=self.base)
        done = self._run(
            "git commit -q --allow-empty -m packed-probe && git rev-parse HEAD "
            f"&& git rev-parse --verify -q refs/heads/main && ( : > {self.common}/packed-refs ) 2>/dev/null; echo RC=$?",
            containment,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("Read-only file system", done.stderr, done.stderr)
        self.assertNotIn("packed-refs.lock", done.stderr, done.stderr)
        head_inside, main_inside, rc = done.stdout.split()
        self.assertNotEqual(head_inside, self.base)
        self.assertEqual(main_inside, self.base, "the packed main reads through packed-refs")
        self.assertNotEqual(rc, "RC=0", "packed-refs itself stays EROFS")
        self.assertFalse((self.common / "packed-refs.lock").exists())
        self.assertEqual(_git(["rev-parse", "--verify", "-q", f"refs/heads/{BRANCH}"], cwd=self.repo, check=False).returncode, 1,
                         "nothing reached the repository before publication")
        publication = publish_quarantine(containment)
        self.assertIsNone(publication.refusal)
        self.assertEqual(publication.refs_published, (BRANCH,))
        self.assertEqual(_git(["rev-parse", f"refs/heads/{BRANCH}"], cwd=self.repo).stdout.strip(), head_inside)
        self.assertEqual(_git(["rev-parse", "main"], cwd=self.repo).stdout.strip(), self.base)
        self.assertEqual(_git(["fsck", "--no-dangling"], cwd=self.repo, check=False).returncode, 0)

    def test_the_repositorys_hooks_do_not_run_inside_and_a_failing_hook_cannot_block_the_commit(self) -> None:
        """ARIA-HIGH-148 — the repository's `.husky/pre-commit` (the
        developer's gate suite, which writes fixtures under READONLY paths)
        exited 1 inside the sandbox on a clean index, so no implementation
        could be committed. The agent's git runs no hooks: the effective
        hooks dir is an empty read-only mount; a hook that would fail (or
        record that it ran) is neither run nor writable."""
        marker = self.worktree / ".husky" / "ran"
        (self.worktree / ".husky" / "pre-commit").write_text(f"#!/bin/sh\necho ran > {marker}\nexit 1\n", encoding="utf-8")
        (self.worktree / ".husky" / "pre-commit").chmod(0o755)
        self.assertNotEqual(_git(["commit", "-q", "--allow-empty", "-m", "host-probe"], cwd=self.worktree, check=False).returncode, 0,
                            "on the host the hook runs and blocks the commit")
        marker.unlink(missing_ok=True)
        containment = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        done = self._run(
            "ls .husky | wc -l; git commit -q --allow-empty -m probe && echo COMMIT_OK; "
            "sh -c 'echo x > .husky/pre-commit' 2>/dev/null && echo HOOK_WRITABLE || echo HOOK_REFUSED",
            containment,
        )
        self.assertEqual(done.stdout.split(), ["0", "COMMIT_OK", "HOOK_REFUSED"], done.stderr)
        self.assertFalse(marker.exists(), "the repository's hook did not run inside")
        publication = publish_quarantine(containment)
        self.assertEqual(publication.refs_published, (BRANCH,))

    def test_a_missing_hooks_dir_cannot_be_created_by_the_agent(self) -> None:
        shutil.rmtree(self.worktree / ".husky")
        containment = derive_git_containment(self.worktree, commit_capable=True, signing=self.containment.signing)
        assert containment is not None and containment.hooks_dir is not None
        self.assertFalse(containment.hooks_dir.exists())
        flags = containment.bwrap_flags()
        self.assertIn("--remount-ro", flags)
        done = self._run(
            "mkdir -p .husky && echo x > .husky/pre-commit && echo ALLOWED || echo REFUSED; "
            "git commit -q --allow-empty -m probe && echo COMMIT_OK",
            containment,
        )
        self.assertEqual(done.stdout.split(), ["REFUSED", "COMMIT_OK"], done.stderr)
        self.assertEqual(list((self.worktree / ".husky").iterdir()), [], "nothing landed on the host")


class StoreOutsideTheSandboxTests(_HeldIdentity):
    """The kernel's durable state store is never mounted in the sandbox; the
    hooks reach the kernel through the broker's socket alone."""

    def setUp(self) -> None:
        super().setUp()
        from aria_kernel.tool_registry import ensure_tools_binding

        self.store = ensure_tools_binding(self.root / "state" / "tools", workspace_root=self.repo)
        (self.store / "agent-invocations").mkdir(exist_ok=True)
        self.requests = self.store / "agent-invocations" / "requests.jsonl"
        self.requests.write_text('{"request_id":"req-other","prompt":"another request"}\n', encoding="utf-8")
        # The in-sandbox hook client rides the workspace's own kernel tree.
        client = self.worktree / "aria-kernel" / "aria_kernel" / "hook_client.py"
        client.parent.mkdir(parents=True)
        shutil.copy(_KERNEL_ROOT / "aria_kernel" / "hook_client.py", client)
        self.client = client
        self.surfaces = [
            "agent-invocations/requests.jsonl", "agent-invocations/claims.jsonl", "governance.jsonl",
            "knowledge-graph/signers.jsonl", "control/commands.jsonl", "human-required/adjudications.jsonl",
            "cost-attribution/rows.jsonl", "hooks/decisions.jsonl",
        ]

    def _inside(self, broker_socket: Path | None) -> dict:
        checks = " ".join(
            f"printf '%s=' {surface}; ( test -e {self.store}/{surface} && echo present ) || echo absent;"
            for surface in self.surfaces
        )
        forge = " ".join(
            f"( echo forged >> {self.store}/{surface} ) 2>/dev/null && echo forged_{surface}=written;"
            for surface in self.surfaces
        )
        payload = json.dumps({"session_id": "sess-1", "tool_use_id": "toolu_1", "hook_event_name": "PostToolUse",
                              "tool_name": "Bash", "tool_input": {"command": "git status"},
                              "tool_response": {"exit_code": 0}})
        pre = json.dumps({"session_id": "sess-1", "tool_use_id": "toolu_1", "hook_event_name": "PreToolUse",
                          "tool_name": "Bash", "tool_input": {"command": "git status"}})
        script = (
            f"printf 'store_dir='; ( test -d {self.store} && echo present ) || echo absent; {checks} {forge} "
            f"printf 'broker_env='; echo ${{{HOOK_BROKER_SOCKET_ENV}:-unset}}; "
            # ARIA-MEDIUM-609 — the production shape: the CLI consults
            # PreToolUse for a budgeted tool before its PostToolUse, and the
            # broker journals the post-tool of a turn IT allowed.
            f"printf %s {pre!r} | python3 {self.client} pre-tool >/dev/null; "
            f"printf 'hook_rc='; ( printf %s {payload!r} | python3 {self.client} post-tool >/dev/null; echo $? )"
        )
        done = self._run(script, self.containment, hook_broker_socket=broker_socket)
        self.assertEqual(done.returncode, 0, done.stderr)
        return dict(line.split("=", 1) for line in done.stdout.splitlines() if "=" in line)

    def test_the_store_is_absent_inside_while_a_hook_row_reaches_it_through_the_broker(self) -> None:
        from aria_kernel.hooks import journal_rows_for

        with serve_hook_broker(base_dir=self.store, workspace_root=self.worktree, request_id="req-1",
                               turn_budget=None) as broker:
            observed = self._inside(broker.socket_path)
        self.assertEqual(observed["store_dir"], "absent")
        for surface in self.surfaces:
            self.assertEqual(observed[surface], "absent", surface)
            self.assertNotIn(f"forged_{surface}", observed)
        self.assertEqual(observed["broker_env"], SANDBOX_HOOK_BROKER_SOCKET)
        self.assertEqual(observed["hook_rc"], "0")
        # Nothing the sandbox wrote reached the host …
        self.assertEqual(self.requests.read_text(encoding="utf-8"),
                         '{"request_id":"req-other","prompt":"another request"}\n')
        self.assertFalse((self.store / "governance.jsonl").read_text(encoding="utf-8").count("forged"))
        # … while the hook's journal row did, written by the kernel outside
        # under the broker's request id.
        rows = journal_rows_for("req-1", base_dir=self.store)
        self.assertEqual([row["command_family"] for row in rows], ["git_read"])
        self.assertEqual(rows[0]["tool_use_id"], "toolu_1")

    def test_mutation_the_round_1_store_bind_lets_the_agent_forge_every_ledger(self) -> None:
        """Bind the store root writable — the first cut's shape — and the
        forgeries land on the host: the pin above would fail."""
        with serve_hook_broker(base_dir=self.store, workspace_root=self.worktree, request_id="req-1",
                               turn_budget=None) as broker:
            original = impl._sandbox_argv

            def weakened(*args, **kwargs):
                argv = original(*args, **kwargs)
                separator = argv.index("--")
                return argv[:separator] + ["--bind", str(self.store), str(self.store)] + argv[separator:]

            with mock.patch.object(impl, "_sandbox_argv", weakened):
                observed = self._inside(broker.socket_path)
        self.assertEqual(observed["store_dir"], "present")
        self.assertEqual(observed["agent-invocations/requests.jsonl"], "present")
        self.assertEqual(observed.get("forged_agent-invocations/requests.jsonl"), "written")
        self.assertIn("forged", self.requests.read_text(encoding="utf-8"))


class _Quarantine(_Checkout):
    """A commit-capable containment whose quarantine the test fills on the
    host, with git pointed at it the way the sandbox's git is."""

    def setUp(self) -> None:
        super().setUp()
        self.containment = derive_git_containment(self.worktree, commit_capable=True)
        assert self.containment is not None
        self.quarantine = self.replica / "objects"
        self.env = {**probe_git_environment(), GIT_OBJECT_DIRECTORY_ENV: str(self.quarantine)}

    def _quarantined_commit(self, branch: str, *, message: str = "feat: q") -> str:
        """A commit whose objects live in the quarantine and whose ref lives
        in the quarantine's refs/heads — what the sandbox leaves behind."""
        (self.worktree / "apps" / "sample.ts").write_text(f"export const q = '{branch}';\n", encoding="utf-8")
        subprocess.run(["git", "add", "apps/sample.ts"], cwd=self.worktree, env=self.env, check=True)
        subprocess.run(["git", "commit", "-q", "-m", message], cwd=self.worktree, env=self.env, check=True)
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.worktree, env=self.env, capture_output=True,
                             text=True, check=True).stdout.strip()
        (self.replica / "refs" / "heads" / branch).write_text(sha + "\n", encoding="utf-8")
        return sha


class PublicationTests(_Quarantine):
    """The kernel-side publication, exercised on the host with git pointed at
    the quarantine the way the sandbox's git is."""

    def test_verified_objects_move_and_only_the_seeded_branch_is_published(self) -> None:
        objects_before = self._shared_objects()
        self.containment = gc.replace(self.containment, seeded_refs=((BRANCH, self.base),))
        sha = self._quarantined_commit(BRANCH)
        (self.replica / "refs" / "heads" / "feature-of-my-own").write_text(sha + "\n", encoding="utf-8")
        (self.replica / "refs" / "heads" / "aria-impl-0000dead").write_text("not a sha\n", encoding="utf-8")
        # (round 3) a well-formed `aria-impl-*` ref the kernel never seeded —
        # ANOTHER request's name — is discarded, never published: it would
        # make that request collide before its first turn.
        (self.replica / "refs" / "heads" / "aria-impl-0000beef").write_text(sha + "\n", encoding="utf-8")
        (self.replica / "refs" / "heads" / "main").write_text("", encoding="utf-8")
        (self.replica / "refs" / "heads" / "main.lock").write_text("", encoding="utf-8")
        self.assertNotIn(sha, objects_before)
        publication = publish_quarantine(self.containment)
        self.assertIsNone(publication.refusal)
        self.assertEqual(publication.refs_published, (BRANCH,))
        self.assertEqual(sorted(publication.refs_discarded), [
            ("aria-impl-0000beef", "not_the_seeded_branch"),
            ("aria-impl-0000dead", "not_an_object_id"),
            ("feature-of-my-own", "not_an_aria_implementation_branch"),
            ("main.lock", "not_an_aria_implementation_branch"),
        ])
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", "aria-impl-0000beef"], cwd=self.repo, check=False).returncode, 0)
        self.assertEqual(publication.objects_refused, ())
        self.assertGreaterEqual(publication.loose_objects_migrated, 3)
        self.assertIn(sha, self._shared_objects())
        self.assertEqual(_git(["rev-parse", BRANCH], cwd=self.repo).stdout.strip(), sha)
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", "feature-of-my-own"], cwd=self.repo, check=False).returncode, 0)
        self.assertEqual(_git(["rev-parse", "main"], cwd=self.repo).stdout.strip(), self.base)
        self.assertEqual(list((self.replica / "refs" / "heads").iterdir()), [])
        self.assertEqual([p for p in self.quarantine.rglob("*") if p.is_file() and len(p.parent.name) == 2], [])
        reflog = _git(["reflog", "show", BRANCH], cwd=self.repo).stdout
        self.assertIn("aria: published from the request sandbox", reflog)

    def test_a_crafted_loose_object_is_refused_by_name_and_never_enters_the_store(self) -> None:
        # A packed object's name (the base commit is in the pack) with bytes
        # that do not hash to it: git would read this loose file FIRST.
        target = self.quarantine / self.base[:2] / self.base[2:]
        target.parent.mkdir(parents=True)
        target.write_bytes(zlib.compress(b"commit 5\0evil\n"))
        # And a well-formed object under the wrong name.
        payload = b"blob 6\0hello\n"
        wrong_name = hashlib.sha1(b"blob 6\0other\n").hexdigest()
        # The base commit's own fan-out directory may be this one (one run in
        # 256: the base hash is minted per run), so the directory is shared.
        (self.quarantine / wrong_name[:2]).mkdir(exist_ok=True)
        (self.quarantine / wrong_name[:2] / wrong_name[2:]).write_bytes(zlib.compress(payload))
        (self.replica / "refs" / "heads" / "aria-impl-0000ea11").write_text(wrong_name + "\n", encoding="utf-8")
        publication = publish_quarantine(gc.replace(self.containment, seeded_refs=(("aria-impl-0000ea11", self.base),)))
        self.assertIsNone(publication.refusal)
        self.assertEqual(sorted(publication.objects_refused),
                         sorted([(self.base, "object_hash_mismatch"), (wrong_name, "object_hash_mismatch")]))
        self.assertEqual(publication.loose_objects_migrated, 0)
        self.assertEqual(publication.refs_published, ())
        self.assertEqual(len(publication.refs_discarded), 1)
        self.assertTrue(publication.refs_discarded[0][1].startswith("update_ref_failed:"), publication.refs_discarded)
        self.assertFalse((self.common / "objects" / self.base[:2] / self.base[2:]).exists())
        self.assertFalse((self.common / "objects" / wrong_name[:2] / wrong_name[2:]).exists())
        self.assertEqual(_git(["cat-file", "-t", self.base], cwd=self.repo).stdout.strip(), "commit",
                         "the packed object still reads")
        self.assertEqual(_git(["fsck", "--no-dangling"], cwd=self.repo, check=False).returncode, 0)

    def test_a_pack_in_the_quarantine_is_unpacked_never_copied(self) -> None:
        self.containment = gc.replace(self.containment, seeded_refs=((BRANCH, self.base),))
        sha = self._quarantined_commit(BRANCH)
        subprocess.run(["git", "repack", "-d", "-q"], cwd=self.worktree, env=self.env, check=True)
        self.assertTrue(any(p.suffix == ".pack" for p in (self.quarantine / "pack").iterdir()))
        publication = publish_quarantine(self.containment)
        self.assertIsNone(publication.refusal)
        self.assertEqual(publication.packs_unpacked, 1)
        self.assertEqual(publication.refs_published, (BRANCH,))
        self.assertEqual(sorted(p.name for p in (self.common / "objects" / "pack").iterdir()), self.packs_before)
        self.assertIn(sha, self._shared_objects())
        self.assertEqual(_git(["rev-parse", BRANCH], cwd=self.repo).stdout.strip(), sha)
        self.assertEqual(list((self.quarantine / "pack").iterdir()), [])

    def test_nothing_to_publish_publishes_nothing(self) -> None:
        publication = publish_quarantine(self.containment)
        self.assertEqual((publication.loose_objects_migrated, publication.packs_unpacked, publication.refs_published),
                         (0, 0, ()))
        read_only = derive_git_containment(self.worktree, commit_capable=False)
        self.assertEqual(publish_quarantine(read_only).refs_published, ())

    def _bounded_reads(self) -> tuple[list[tuple[str, int]], object]:
        """Record every (path, limit) the publication reads from the replica."""
        from aria_kernel.untrusted_tree import UntrustedTree

        reads: list[tuple[str, int]] = []
        real_read = UntrustedTree.read

        def recording(tree: UntrustedTree, relative: str, limit: int = -1) -> bytes:
            reads.append((relative, limit))
            return real_read(tree, relative, limit)

        return reads, mock.patch.object(UntrustedTree, "read", recording)

    def test_an_oversized_ref_file_is_discarded_by_name_and_never_read_whole(self) -> None:
        # ARIA-LOW-569 — a ref holds an object id and a newline. A ref file
        # the agent padded inside its own replica (here: the commit's real
        # id, then whitespace) was read whole into the executor's memory,
        # and `strip()` made the padding vanish: the branch was published.
        # It is discarded by name instead, never truncated into an id.
        self.containment = gc.replace(self.containment, seeded_refs=((BRANCH, self.base),))
        sha = self._quarantined_commit(BRANCH)
        (self.replica / "refs" / "heads" / BRANCH).write_text(sha + "\n" + " " * (64 * 1024), encoding="utf-8")
        reads, recording = self._bounded_reads()
        with recording:
            publication = publish_quarantine(self.containment)
        self.assertIsNone(publication.refusal)
        self.assertEqual(publication.refs_published, ())
        self.assertEqual(publication.refs_discarded, ((BRANCH, "ref_file_too_large"),))
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", BRANCH], cwd=self.repo, check=False).returncode, 0)
        self.assertEqual(list((self.replica / "refs" / "heads").iterdir()), [])
        ref_reads = [limit for relative, limit in reads if relative.startswith("refs/heads/") or relative == "HEAD"]
        self.assertTrue(ref_reads, reads)
        self.assertTrue(all(0 < limit <= gc._MAX_REPLICA_REF_BYTES + 1 for limit in ref_reads), reads)

    def test_an_oversized_replica_head_names_no_branch(self) -> None:
        # The replica's HEAD is the agent's file too: padded past any
        # `ref: refs/heads/aria-impl-<hex>`, it adopts nothing (the branch
        # itself, a well-formed ref, is still published).
        self.containment = gc.replace(self.containment, seeded_refs=((BRANCH, self.base),))
        self._quarantined_commit(BRANCH)
        (self.replica / "HEAD").write_text(f"ref: refs/heads/{BRANCH}\n" + " " * (64 * 1024), encoding="utf-8")
        publication = publish_quarantine(self.containment)
        self.assertEqual((publication.refusal, publication.refs_published, publication.head_adopted),
                         (None, (BRANCH,), None))


def _snapshot(root: Path) -> dict[str, tuple[str, bytes]]:
    """Every entry under ``root`` by its own kind, never through a link (a
    link is its target string, a file its bytes, a FIFO is never opened)."""
    state: dict[str, tuple[str, bytes]] = {}
    for path in sorted(root.rglob("*")):  # rglob does not descend a linked directory
        mode = path.lstat().st_mode
        key = path.relative_to(root).as_posix()
        if stat.S_ISLNK(mode):
            state[key] = ("symlink", os.readlink(path).encode())
        elif stat.S_ISREG(mode):
            state[key] = ("file", path.read_bytes())
        else:
            state[key] = (oct(stat.S_IFMT(mode)), b"")
    return state


class PlantedLinkPublicationTests(_Quarantine):
    """ARIA-HIGH-527 — the replica is the AGENT's tree, and the host walks it.

    The sandbox binds the replica writable, so anything in it — a fan-out
    directory, ``objects/pack``, ``refs/heads``, ``objects`` or ``refs``
    themselves, one object or ref file, ``HEAD`` — can be a symlink when the
    kernel publishes it. Walked with link-following calls, a fan-out linked
    at a directory had its object-named files read, refused and UNLINKED, a
    pack dir linked at the shared ``objects/pack`` had every shared pack
    unpacked and DELETED, a ``refs/heads`` linked anywhere had every file
    under its target deleted, and a link to a valid object file was renamed
    INTO the shared store. Each test plants one real link (or FIFO) at one
    place, aimed at a sentinel directory and file outside the replica shaped
    so the old walk acts on them: the publication is refused by the
    entry's name before it touches anything — the sentinels, the shared
    store and the agent's own quarantine are byte-for-byte what they were,
    and nothing is published."""

    SENTINEL_REF = "aria-impl-0000f00d"

    def setUp(self) -> None:
        super().setUp()
        self.containment = gc.replace(self.containment, seeded_refs=((BRANCH, self.base),))
        # The agent's real work: a refused publication must not have moved,
        # published or deleted any of it.
        self.head = self._quarantined_commit(BRANCH)
        self.outside = self.root / "outside"
        self.sentinel_dir = self.outside / "sentinel-dir"
        (self.sentinel_dir / "heads").mkdir(parents=True)
        # A loose-object name (the old walk verified it, refused it, unlinked it) …
        (self.sentinel_dir / ("0" * 38)).write_bytes(b"not an object\n")
        # … a pack and its sibling (unpack refused, every `sentinel.*` unlinked) …
        (self.sentinel_dir / "sentinel.pack").write_bytes(b"PACK but not one\n")
        (self.sentinel_dir / "sentinel.idx").write_bytes(b"index\n")
        # … and ref files at both depths a linked `refs/heads` or `refs` reaches (read, then unlinked).
        (self.sentinel_dir / self.SENTINEL_REF).write_text(self.base + "\n", encoding="utf-8")
        (self.sentinel_dir / "heads" / self.SENTINEL_REF).write_text(self.base + "\n", encoding="utf-8")
        # A VALID loose object outside the replica: linked under its own
        # name, the old walk verified its bytes and renamed the LINK into
        # the shared store.
        payload = b"blob 9\0sentinel\n"
        self.sentinel_object = hashlib.sha1(payload).hexdigest()
        self.sentinel_file = self.outside / "sentinel-file"
        self.sentinel_file.write_bytes(zlib.compress(payload))
        self.outside_before = _snapshot(self.outside)
        self.store_before = _snapshot(self.common / "objects")

    def _free_fan_out(self) -> str:
        return next(name for name in (f"{index:02x}" for index in range(256)) if not (self.quarantine / name).exists())

    def _assert_refused_before_touching_anything(self, relative: str, kind: str = "symlink") -> None:
        replica_before = _snapshot(self.replica)
        publication = publish_quarantine(self.containment)
        self.assertEqual(_snapshot(self.outside), self.outside_before, "a sentinel outside the replica changed")
        self.assertEqual(_snapshot(self.common / "objects"), self.store_before, "the shared store changed")
        self.assertEqual(publication.refusal, f"replica_entry_refused:{kind}:{relative}")
        self.assertEqual((publication.loose_objects_migrated, publication.packs_unpacked, publication.objects_refused,
                          publication.refs_published, publication.refs_discarded, publication.head_adopted),
                         (0, 0, (), (), (), None))
        self.assertEqual(_snapshot(self.replica), replica_before, "the replica was touched before the refusal")
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", BRANCH], cwd=self.repo, check=False).returncode, 0,
                            "the agent's branch was published past a planted entry")
        # (Not `git fsck`: the host worktree's HEAD and index already name the
        # quarantine's objects, which an unpublished quarantine never moved.)
        self.assertEqual(_git(["cat-file", "-t", "main"], cwd=self.repo).stdout.strip(), "commit")

    def test_a_fan_out_directory_linked_outside_is_refused_and_its_target_survives(self) -> None:
        fan_out = self._free_fan_out()
        (self.quarantine / fan_out).symlink_to(self.sentinel_dir, target_is_directory=True)
        self._assert_refused_before_touching_anything(f"objects/{fan_out}")

    def test_a_loose_object_linked_outside_is_refused_and_never_enters_the_store(self) -> None:
        fan_out = self.quarantine / self.sentinel_object[:2]
        fan_out.mkdir(exist_ok=True)
        (fan_out / self.sentinel_object[2:]).symlink_to(self.sentinel_file)
        self._assert_refused_before_touching_anything(f"objects/{self.sentinel_object[:2]}/{self.sentinel_object[2:]}")

    def test_the_pack_directory_linked_outside_is_refused_and_its_target_survives(self) -> None:
        shutil.rmtree(self.quarantine / "pack")
        (self.quarantine / "pack").symlink_to(self.sentinel_dir, target_is_directory=True)
        self._assert_refused_before_touching_anything("objects/pack")

    def test_a_pack_file_linked_outside_is_refused(self) -> None:
        (self.quarantine / "pack" / "planted.pack").symlink_to(self.sentinel_dir / "sentinel.pack")
        self._assert_refused_before_touching_anything("objects/pack/planted.pack")

    def test_the_pack_directory_linked_at_the_shared_packs_deletes_none_of_them(self) -> None:
        shutil.rmtree(self.quarantine / "pack")
        (self.quarantine / "pack").symlink_to(self.common / "objects" / "pack", target_is_directory=True)
        self._assert_refused_before_touching_anything("objects/pack")
        self.assertEqual(sorted(path.name for path in (self.common / "objects" / "pack").iterdir()), self.packs_before)

    def test_the_quarantine_linked_at_the_shared_store_deletes_none_of_it(self) -> None:
        # A loose object in the shared store: the old walk found it valid, found
        # it already in the store (the same file) and unlinked the "source".
        (self.root / "loose.txt").write_text("a loose object of the shared store\n", encoding="utf-8")
        loose = _git(["hash-object", "-w", str(self.root / "loose.txt")], cwd=self.repo).stdout.strip()
        self.store_before = _snapshot(self.common / "objects")
        self.assertIn(loose[2:], {key.split("/")[-1] for key in self.store_before})
        self.quarantine.rename(self.replica / "objects.agent")
        self.quarantine.symlink_to(self.common / "objects", target_is_directory=True)
        self._assert_refused_before_touching_anything("objects")
        self.assertEqual(_git(["cat-file", "-t", loose], cwd=self.repo).stdout.strip(), "blob")

    def test_the_refs_heads_directory_linked_outside_is_refused_and_its_target_survives(self) -> None:
        heads = self.replica / "refs" / "heads"
        shutil.rmtree(heads)
        heads.symlink_to(self.sentinel_dir, target_is_directory=True)
        self._assert_refused_before_touching_anything("refs/heads")

    def test_the_refs_directory_linked_outside_is_refused_and_its_target_survives(self) -> None:
        refs = self.replica / "refs"
        refs.rename(self.replica / "refs.agent")
        refs.symlink_to(self.sentinel_dir, target_is_directory=True)
        self._assert_refused_before_touching_anything("refs")

    def test_a_ref_file_linked_outside_is_refused(self) -> None:
        (self.replica / "refs" / "heads" / self.SENTINEL_REF).symlink_to(self.sentinel_dir / self.SENTINEL_REF)
        self._assert_refused_before_touching_anything(f"refs/heads/{self.SENTINEL_REF}")

    def test_head_linked_outside_is_refused(self) -> None:
        (self.replica / "HEAD").unlink()
        (self.replica / "HEAD").symlink_to(self.sentinel_file)
        self._assert_refused_before_touching_anything("HEAD")

    def test_a_fifo_ref_is_refused_by_name_and_never_opened(self) -> None:
        os.mkfifo(self.replica / "refs" / "heads" / "aria-impl-0000f1f0")
        self._assert_refused_before_touching_anything("refs/heads/aria-impl-0000f1f0", kind="fifo")

    def test_a_fifo_head_is_refused_by_name_and_never_opened(self) -> None:
        # The old reader opened HEAD for reading: a FIFO with no writer
        # blocked the executor's publication forever.
        (self.replica / "HEAD").unlink()
        os.mkfifo(self.replica / "HEAD")
        self._assert_refused_before_touching_anything("HEAD", kind="fifo")

    def test_a_stale_replica_full_of_links_is_removed_without_following_one(self) -> None:
        """The other host-side walk of the agent's tree: the next derivation
        removes the replica a previous spawn left (`_prepare_sandbox_git_dir`),
        through the standard library's fd-based, no-follow removal."""
        self.assertTrue(shutil.rmtree.avoids_symlink_attacks)
        (self.quarantine / self._free_fan_out()).symlink_to(self.sentinel_dir, target_is_directory=True)
        shutil.rmtree(self.replica / "refs" / "heads")
        (self.replica / "refs" / "heads").symlink_to(self.sentinel_dir, target_is_directory=True)
        (self.replica / "aria-planted").symlink_to(self.sentinel_file)
        derive_git_containment(self.worktree, commit_capable=True)
        self.assertEqual(_snapshot(self.outside), self.outside_before)
        self.assertFalse((self.replica / "aria-planted").exists())
        self.assertFalse((self.replica / "refs" / "heads").is_symlink())
        self.assertEqual(list((self.replica / "refs" / "heads").iterdir()), [])


class MutationTests(_HeldIdentity):
    def test_mutation_a_writable_config_worktree_is_caught_by_the_pin(self) -> None:
        """Drop the `config.worktree` overlay and the agent re-points the
        replica's `user.signingkey`: the control-surface pin would fail."""
        original = gc.GitContainment.bwrap_flags

        def weakened(containment):
            flags = original(containment)
            path = str(containment.private_git_dir / "config.worktree")
            index = flags.index(path)
            assert flags[index - 2] == "--ro-bind"
            return flags[: index - 2] + flags[index + 1:]

        with mock.patch.object(gc.GitContainment, "bwrap_flags", weakened):
            done = self._run("git config --worktree user.signingkey /tmp/other && echo ALLOWED || echo REFUSED",
                             self.containment)
        self.assertEqual(done.stdout.strip(), "ALLOWED")
        # The host's config is untouched even so: the agent edited the replica.
        self.assertEqual(_git(["config", "--worktree", "user.signingkey"], cwd=self.worktree).stdout.strip(),
                         str(self.key.private_key_path))

    def test_mutation_the_round_1_shared_refs_bind_lets_a_planted_lock_reach_the_host(self) -> None:
        """Bind the shared `refs/heads` writable on top of the quarantine —
        the first cut's shape — and `main.lock` lands on the host."""
        heads = str(self.common / "refs" / "heads")
        done = self._run(f"touch {heads}/main.lock && echo PLANTED", self.containment,
                         extra_flags=["--bind", heads, heads])
        self.assertEqual(done.stdout.strip(), "PLANTED")
        self.assertTrue((self.common / "refs" / "heads" / "main.lock").exists())
        (self.common / "refs" / "heads" / "main.lock").unlink()


class KernelMadeBranchTests(_HeldIdentity):
    """ARIA-HIGH-124 — the implementation branch is the kernel's to make.

    The contract's ``git switch -c <branch> <base_sha>`` was never admitted
    by the command policy; the executor stands the sandbox on the branch in
    the replica before the spawn, and the agent's plain commit advances a
    ref that exists only in the quarantine until the kernel publishes it.
    """

    def test_the_sandbox_starts_on_the_branch_and_a_plain_commit_publishes_to_it(self) -> None:
        seeded = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        # (round 2) the seed is the containment's fact: the binds are the
        # same, the publication reads the seed off it.
        self.assertEqual(seeded.seeded_refs, ((BRANCH, self.base),))
        self.assertEqual(seeded.bwrap_flags(), self.containment.bwrap_flags())
        self.containment = seeded
        # Written in the replica only: the host worktree's HEAD and the
        # shared repository carry nothing of it.
        self.assertEqual((self.replica / "HEAD").read_text(encoding="utf-8"), f"ref: refs/heads/{BRANCH}\n")
        self.assertEqual((self.replica / "refs" / "heads" / BRANCH).read_text(encoding="utf-8").strip(), self.base)
        self.assertEqual((self.private / "HEAD").read_text(encoding="utf-8"), self.host_head_before)
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", BRANCH], cwd=self.repo, check=False).returncode, 0)
        done = self._run(
            "set -e; git branch --show-current; git rev-parse HEAD; git status --porcelain; "
            "echo two > apps/sample.ts; git add apps/sample.ts; git commit -q -m 'feat: two'; git rev-parse HEAD",
            self.containment,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = done.stdout.strip().splitlines()
        self.assertEqual(lines[:2], [BRANCH, self.base], done.stdout)
        head = lines[-1]
        self.assertNotEqual(head, self.base)
        self.assertEqual((self.replica / "refs" / "heads" / BRANCH).read_text(encoding="utf-8").strip(), head)
        publication = publish_quarantine(self.containment)
        self.assertEqual((publication.refusal, publication.refs_published, publication.head_adopted), (None, (BRANCH,), BRANCH))
        self.assertEqual(_git(["rev-parse", BRANCH], cwd=self.repo).stdout.strip(), head)
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=self.worktree).stdout.strip(), head)

    def test_a_seed_the_agent_never_advanced_is_discarded_not_published(self) -> None:
        # ARIA-HIGH-124 (round 2) — a spawn that ends before any commit (a
        # timeout, a provider outage, a cancel, an agent that commits
        # nothing) leaves the quarantine ref at its seed. Publishing it made
        # the kernel's own two file writes a real branch of the shared
        # repository, and the retry the harness-class release promises was
        # then refused pre-turn as `implementation_branch_exists`.
        seeded = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        publication = publish_quarantine(seeded)
        self.assertEqual((publication.refusal, publication.refs_published, publication.head_adopted), (None, (), None))
        self.assertEqual(publication.refs_discarded, ((BRANCH, "branch_unadvanced"),))
        self.assertNotEqual(_git(["rev-parse", "--verify", "-q", BRANCH], cwd=self.repo, check=False).returncode, 0,
                            "the seed reached the shared repository")
        self.assertEqual((self.private / "HEAD").read_text(encoding="utf-8"), self.host_head_before)
        # A containment WITHOUT the seed recorded publishes nothing at all
        # (round 3: only the seeded name is ever published) — the
        # publication reads the seed, not the branch's content.
        unseeded = gc.stand_on_implementation_branch(self.containment, branch=f"{BRANCH}ff", base_sha=self.base)
        self.assertEqual(unseeded.seeded_refs, ((f"{BRANCH}ff", self.base),))
        without_seed = publish_quarantine(gc.replace(unseeded, seeded_refs=()))
        self.assertEqual((without_seed.refs_published, without_seed.refs_discarded),
                         ((), ((f"{BRANCH}ff", "not_the_seeded_branch"),)))
        # The same tree can be stood on the branch again: no collision, and
        # a commit inside then advances and publishes it.
        seeded = gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        done = self._run("echo two > apps/sample.ts; git add apps/sample.ts; git commit -q -m 'feat: two'; git rev-parse HEAD", seeded)
        self.assertEqual(done.returncode, 0, done.stderr)
        head = done.stdout.strip().splitlines()[-1]
        publication = publish_quarantine(seeded)
        self.assertEqual((publication.refs_published, publication.head_adopted, publication.refs_discarded), ((BRANCH,), BRANCH, ()))
        self.assertEqual(_git(["rev-parse", BRANCH], cwd=self.repo).stdout.strip(), head)

    def test_refusals_are_by_name_and_write_nothing(self) -> None:
        replica_head = (self.replica / "HEAD").read_text(encoding="utf-8")
        for branch, base, reason in (
            ("feature/mine", self.base, "implementation_branch_name_invalid"),
            (BRANCH, "not-a-sha", "base_sha_not_an_object_id"),
            (BRANCH, "0" * 40, f"worktree_not_at_base_sha:{self.base}"),
        ):
            with self.subTest(reason=reason):
                with self.assertRaises(GitContainmentRefusal) as refused:
                    gc.stand_on_implementation_branch(self.containment, branch=branch, base_sha=base)
                self.assertEqual(refused.exception.reason, reason)
        self.assertEqual((self.replica / "HEAD").read_text(encoding="utf-8"), replica_head)
        self.assertFalse((self.replica / "refs" / "heads" / BRANCH).exists())
        # A branch the shared repository already holds (an earlier attempt
        # published it): refused, never re-pointed, nothing written.
        _git(["branch", BRANCH, self.base], cwd=self.repo)
        with self.assertRaises(GitContainmentRefusal) as refused:
            gc.stand_on_implementation_branch(self.containment, branch=BRANCH, base_sha=self.base)
        self.assertEqual(refused.exception.reason, "implementation_branch_exists")
        self.assertFalse((self.replica / "refs" / "heads" / BRANCH).exists())
        # And a read-only containment cannot host a branch at all.
        read_only = derive_git_containment(self.worktree, commit_capable=False)
        assert read_only is not None
        with self.assertRaises(GitContainmentRefusal) as refused:
            gc.stand_on_implementation_branch(read_only, branch=BRANCH, base_sha=self.base)
        self.assertEqual(refused.exception.reason, "branch_without_commit_capability")

    def test_mutation_a_branch_made_in_the_shared_repository_is_caught_by_the_pin(self) -> None:
        # The tempting shape — `git switch -c` on the host worktree — creates
        # the ref in the SHARED repository; the loose-ref overlay then makes
        # it read-only inside and the agent's commit dies on it. The pin
        # above (a commit inside advances the ref) catches that shape.
        _git(["switch", "-q", "-c", BRANCH, self.base], cwd=self.worktree)
        self.addCleanup(lambda: _git(["switch", "-q", "--detach", self.base], cwd=self.worktree, check=False))
        containment = derive_git_containment(self.worktree, commit_capable=True, signing=SandboxSigning(
            keys_dir=self.key.private_key_path.parent, public_key_path=self.key.public_key_path,
            agent_socket=self.agent.socket_path,
        ))
        assert containment is not None
        done = self._run(
            "echo two > apps/sample.ts; git add apps/sample.ts; git commit -q -m 'feat: two'",
            containment,
        )
        self.assertNotEqual(done.returncode, 0)
        # git's own words for a ref it cannot rename over (the overlay's
        # mountpoint: EBUSY): the branch would never advance.
        self.assertIn(f"couldn't set 'refs/heads/{BRANCH}'", done.stderr + done.stdout)
        _git(["branch", "-D", BRANCH], cwd=self.repo, check=False)


class DependencyTreeTests(_Checkout):
    def test_the_checkouts_node_modules_resolve_from_the_worktree_read_only(self) -> None:
        """Node walks up from the cwd for `node_modules`; the per-request
        worktree resolves the checkout's, which the sandbox hid — the
        canonical validation suite could not start inside. Bound read-only."""
        require_sandbox_backend(fresh_probe=True)
        binary = self.repo / "node_modules" / ".bin"
        binary.mkdir()
        (binary / "nx").write_text("#!/bin/sh\necho NX_FROM_CHECKOUT \"$@\"\n", encoding="utf-8")
        (binary / "nx").chmod(0o755)
        walk = ('d=$PWD; while [ "$d" != / ]; do if [ -x "$d/node_modules/.bin/nx" ]; then '
                '"$d/node_modules/.bin/nx" affected; touch "$d/node_modules/probe" 2>/dev/null && echo WRITABLE '
                '|| echo READ_ONLY; exit 0; fi; d=$(dirname "$d"); done; echo NX_NOT_FOUND; exit 1')
        done = self._run(walk, derive_git_containment(self.worktree, commit_capable=False))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.split("\n")[:2], ["NX_FROM_CHECKOUT affected", "READ_ONLY"])
        self.assertFalse((self.repo / "node_modules" / "probe").exists())
        hidden = self._run(f"ls {self.repo}/apps 2>/dev/null && echo VISIBLE || echo HIDDEN",
                           derive_git_containment(self.worktree, commit_capable=False))
        self.assertEqual(hidden.stdout.strip(), "HIDDEN")

    def test_the_nearest_ancestor_tree_is_bound_and_nothing_further_up(self) -> None:
        """At its own path (ARIA-HIGH-123) and in place inside the workspace
        (ARIA-HIGH-361); a tree further up is never consulted."""
        (self.root / "node_modules").mkdir()

        def caches(mountpoint: Path) -> list[str]:
            return [flag for name in TOOL_CACHE_DIRNAMES for flag in ("--tmpfs", str(mountpoint / name))]

        self.assertEqual(impl._dependency_tree_binds(self.worktree),
                         ["--ro-bind", str(self.repo / "node_modules"), str(self.repo / "node_modules"),
                          "--ro-bind", str(self.repo / "node_modules"), str(self.worktree / "node_modules"),
                          *caches(self.worktree / "node_modules")])
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.assertEqual(impl._dependency_tree_binds(elsewhere),
                         ["--ro-bind", str(self.root / "node_modules"), str(self.root / "node_modules"),
                          "--ro-bind", str(self.root / "node_modules"), str(elsewhere / "node_modules"),
                          *caches(elsewhere / "node_modules")])


class TemporaryDirectoryTests(unittest.TestCase):
    def test_the_sandbox_owns_the_temp_dir(self) -> None:
        """`TMPDIR` is in the spawn's baseline environment; a host value the
        sandbox does not mount made `git commit` die writing the buffer it
        signs. The sandbox exports its own /tmp as TMPDIR, by name."""
        require_sandbox_backend(fresh_probe=True)
        with tempfile.TemporaryDirectory() as workspace:
            argv = impl.wrap_bash_in_sandbox(["sh", "-c", "echo $TMPDIR; test -d \"$TMPDIR\""], workspace_root=workspace)
            done = subprocess.run(argv, capture_output=True, text=True, timeout=30,
                                  env={**os.environ, "TMPDIR": "/nonexistent-host-temp"})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), impl.SANDBOX_TMPDIR)


class PublishEnvironmentTests(unittest.TestCase):
    """The kernel's own git calls (the publication's ref writes, the
    delivery's push) never inherit git config injected through the ambient
    environment. A CI step can carry ``AUTHORIZATION: basic`` in
    ``GIT_CONFIG_VALUE_0`` (validation_env.py says so), and a push without a
    minted credential would otherwise go out under that job's identity."""

    AMBIENT = {**AMBIENT_GIT_CONFIG, "GIT_CONFIG_PARAMETERS": "'core.hookspath'='.husky'"}

    def test_ambient_git_config_injection_is_not_inherited(self) -> None:
        with mock.patch.dict(os.environ, self.AMBIENT):
            env = gc._publish_environment()
        self.assertEqual(injected_git_config(env), {})
        self.assertEqual(env["GIT_CONFIG_GLOBAL"], os.devnull)
        self.assertEqual(env["GIT_CONFIG_SYSTEM"], os.devnull)

    def test_git_under_the_publish_environment_sees_no_injected_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, self.AMBIENT):
            subprocess.run(["git", "init", "-q", tmp], check=True, env=gc._publish_environment())
            read = subprocess.run(
                ["git", "config", "--get", "http.https://github.com/.extraheader"],
                cwd=tmp, env=gc._publish_environment(), capture_output=True, text=True, check=False,
            )
        self.assertEqual(read.returncode, 1, read.stdout)
        self.assertEqual(read.stdout, "")


if __name__ == "__main__":
    unittest.main()
