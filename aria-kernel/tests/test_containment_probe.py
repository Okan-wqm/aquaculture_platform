"""ARIA-HIGH-123 — "containment is usable" means "a SIGNED commit lands from inside it".

The pre-change probe ran `/bin/true` under the system binds and reported
bwrap usable on every host where the implementer's `git commit` then died
inside the sandbox. The first cut committed UNSIGNED with `GIT_AUTHOR_*`
set and passed on the production runner where the signed route did not:
`ssh-keygen -Y sign` resolves its own uid before it signs and died `No user
exists for uid 1000?` in a sandbox without `/etc/passwd`, while git needed
no lookup with the ident in the environment — a runner was admitted, the
request claimed, the key minted, the turn spent, the result refused. The
probe now mints a throwaway key into a throwaway linked worktree, holds the
agent, derives the containment WITH the signing exposure, commits inside
the argv the wrapper builds with the managed route's network setting, then
publishes the quarantine and verifies the commit from outside.

One property per test:

* on a host whose bwrap can host a signed commit the probe answers None;
* a builder that withholds the account database (`/etc/passwd`,
  `/etc/group`) with the network off is refused by name, naming the uid
  failure — the production runner's shape, reproducible as root;
* a builder that lets git write the branch into a phantom (a tmpfs over the
  quarantine's `refs/heads` mount) is refused: the commit must reach the
  real repository through the kernel's publication;
* a builder that leaves the common config writable, one that lets the
  private key be read, and one that binds the shared `refs/heads` writable
  (a planted lock reaches the host) are each refused by name;
* a publication that publishes nothing is refused: the probe proves the
  executor's own publication step, not only that git ran;
* `_bwrap_available()` is False and the wrapper's refusal carries the
  reason when the git probe refuses; the real probe builds through the
  wrapper's own builder with the managed route's network setting.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import containment_probe as probe_module
from aria_kernel import implementation_safety as impl
from aria_kernel.containment_probe import (
    EXIT_CONFIG_WRITABLE,
    EXIT_PRIVATE_KEY_READABLE,
    PROBE_BRANCH,
    probe_git_containment,
)
from aria_kernel.git_containment import GitContainment, QuarantinePublication


def _builder(*, allow_network: bool, drop_ro_binds: tuple[str, ...] = ()):
    def build(command: list[str], workspace: Path, containment: GitContainment) -> list[str]:
        argv = impl._sandbox_argv(command, workspace_root=workspace, allow_network=allow_network, git=containment)
        for source in drop_ro_binds:
            for index in range(len(argv) - 2):
                if argv[index] == "--ro-bind" and argv[index + 1] == source:
                    argv = argv[:index] + argv[index + 3:]
                    break
            else:
                raise AssertionError(f"--ro-bind {source} not in argv")
        return argv
    return build


_real_builder = _builder(allow_network=impl.MANAGED_SPAWN_ALLOW_NETWORK)


def _with_flags_before_separator(build, flags_for):
    def wrapped(command, workspace, containment):
        argv = build(command, workspace, containment)
        separator = argv.index("--")
        return argv[:separator] + flags_for(containment) + argv[separator:]
    return wrapped


class _NeedsBwrap(unittest.TestCase):
    def setUp(self) -> None:
        impl._bwrap_available.cache_clear()
        if not impl._sandbox_probe_succeeds(impl._bwrap_probe_argv()):
            self.skipTest("bwrap cannot build its namespaces on this host")

    def tearDown(self) -> None:
        impl._bwrap_available.cache_clear()


class ProbeTests(_NeedsBwrap):
    def test_a_host_that_can_sign_a_commit_inside_the_sandbox_passes(self) -> None:
        self.assertIsNone(probe_git_containment(_real_builder))

    def test_without_the_account_database_the_signed_route_is_refused_by_name(self) -> None:
        # The production runner's shape: no `/etc/passwd` inside and no
        # nss-systemd to synthesize the account (network off binds no
        # nsswitch). ssh-keygen dies on getpwuid before it signs.
        reason = probe_git_containment(_builder(allow_network=False, drop_ro_binds=("/etc/passwd", "/etc/group")))
        self.assertIsNotNone(reason)
        self.assertTrue(reason.startswith("git_in_sandbox_failed:rc=128"), reason)
        self.assertIn("No user exists for uid", reason)
        self.assertIn("failed to write commit object", reason)
        # With the two binds present the same argv signs.
        self.assertIsNone(probe_git_containment(_builder(allow_network=False)))

    def test_the_account_database_is_a_system_bind_of_the_wrapper(self) -> None:
        self.assertIn("/etc/passwd", impl._SANDBOX_SYSTEM_ROOTS)
        self.assertIn("/etc/group", impl._SANDBOX_SYSTEM_ROOTS)
        for path in ("/etc/passwd", "/etc/group"):
            if Path(path).exists():
                self.assertIn(("--ro-bind", path, path), [tuple(impl._system_ro_binds()[i:i + 3])
                                                          for i in range(0, len(impl._system_ro_binds()), 3)])

    def test_a_phantom_commit_is_refused(self) -> None:
        phantom = _with_flags_before_separator(
            _real_builder, lambda c: ["--tmpfs", str(c.common_git_dir / "refs" / "heads")],
        )
        self.assertEqual(probe_git_containment(phantom), "sandbox_commit_did_not_reach_repository")

    def test_a_writable_control_surface_is_refused(self) -> None:
        def writable_config(command, workspace, containment):
            # The common dir writable right after its read-only bind, with
            # the quarantine and replica mounts still on top: `config` (and
            # its lock) are then writable inside.
            argv = _real_builder(command, workspace, containment)
            common = str(containment.common_git_dir)
            index = argv.index(common)
            assert argv[index - 1] == "--ro-bind" and argv[index + 1] == common
            return argv[:index + 2] + ["--bind", common, common] + argv[index + 2:]

        reason = probe_git_containment(writable_config)
        self.assertIsNotNone(reason)
        self.assertTrue(reason.startswith(f"git_in_sandbox_failed:rc={EXIT_CONFIG_WRITABLE}"), reason)

    def test_a_readable_private_key_is_refused(self) -> None:
        def key_visible(command, workspace, containment):
            argv = _real_builder(command, workspace, containment)
            keys_dir = str(containment.signing.keys_dir)
            index = argv.index("--tmpfs", argv.index(keys_dir) - 1)
            assert argv[index + 1] == keys_dir
            # Drop the keys-dir mask: the ro-bind of `aria-debts/` is then the
            # last word, and read-only is readable.
            return argv[:index] + argv[index + 2:]

        reason = probe_git_containment(key_visible)
        self.assertIsNotNone(reason)
        self.assertTrue(reason.startswith(f"git_in_sandbox_failed:rc={EXIT_PRIVATE_KEY_READABLE}"), reason)

    def test_a_lock_that_reaches_the_repository_is_refused(self) -> None:
        shared_heads = _with_flags_before_separator(
            _real_builder,
            lambda c: ["--bind", str(c.common_git_dir / "refs" / "heads"), str(c.common_git_dir / "refs" / "heads")],
        )
        self.assertEqual(probe_git_containment(shared_heads), "sandbox_lock_reached_repository")

    def test_a_publication_that_publishes_nothing_is_refused(self) -> None:
        nothing = QuarantinePublication(0, 0, (), (), ())
        with mock.patch.object(probe_module, "publish_quarantine", return_value=nothing):
            self.assertEqual(probe_git_containment(_real_builder), "sandbox_commit_did_not_reach_repository")
        refused = QuarantinePublication(0, 0, (), (), (), refusal="git_unavailable:OSError")
        with mock.patch.object(probe_module, "publish_quarantine", return_value=refused):
            self.assertEqual(probe_git_containment(_real_builder), "sandbox_publication_refused:git_unavailable:OSError")

    def test_the_probe_branch_never_touches_a_real_repository(self) -> None:
        self.assertIsNone(probe_git_containment(_real_builder))
        here = Path(__file__).resolve().parents[2]
        import subprocess

        done = subprocess.run(["git", "-C", str(here), "rev-parse", "--verify", "-q", f"refs/heads/{PROBE_BRANCH}"],
                              capture_output=True, text=True, check=False)
        self.assertNotEqual(done.returncode, 0)


class AvailabilityFoldsTheProbeTests(_NeedsBwrap):
    def test_a_refused_git_probe_means_no_backend(self) -> None:
        with mock.patch.object(impl, "_git_containment_probe_reason", return_value="git_in_sandbox_failed:rc=128:x"):
            self.assertFalse(impl._bwrap_available())
            self.assertIsNone(impl.sandbox_backend())
            with self.assertRaises(impl.SandboxUnavailable) as refused:
                impl.wrap_bash_in_sandbox(["true"], workspace_root=Path(__file__).resolve().parent)
        self.assertIn("git containment probe refused: git_in_sandbox_failed:rc=128:x", str(refused.exception))

    def test_a_passing_git_probe_means_bwrap(self) -> None:
        with mock.patch.object(impl, "_git_containment_probe_reason", return_value=None):
            self.assertTrue(impl._bwrap_available())
            self.assertEqual(impl.sandbox_backend(), "bwrap")

    def test_the_real_probe_builds_through_the_wrappers_own_builder_with_the_managed_network(self) -> None:
        seen: list[list[str]] = []
        original = impl._sandbox_argv

        def spy(*args, **kwargs):
            argv = original(*args, **kwargs)
            seen.append(argv)
            return argv

        with mock.patch.object(impl, "_sandbox_argv", spy):
            self.assertIsNone(impl._git_containment_probe_reason())
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0], "bwrap")
        # The managed route's network setting, not a smaller argv: the probe
        # proves what the implementer gets.
        self.assertTrue(impl.MANAGED_SPAWN_ALLOW_NETWORK)
        self.assertNotIn("--unshare-net", seen[0])
        for path in ("/etc/passwd", "/etc/group"):
            if Path(path).exists():
                self.assertIn(path, seen[0])
        self.assertIn("SSH_AUTH_SOCK", seen[0])
        self.assertIn("GIT_OBJECT_DIRECTORY", seen[0])


if __name__ == "__main__":
    unittest.main()
