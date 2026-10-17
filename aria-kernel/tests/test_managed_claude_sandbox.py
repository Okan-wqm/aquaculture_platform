"""ARIA-HIGH-077 — what the attempt names is what runs inside the sandbox.

The managed Anthropic route's first live attempt ran `claude` by NAME inside
the write-containment sandbox: the sandbox does not bind `~/.local`, so PATH
resolved a different, older installation under `/usr/local`; the settings
document the spawn had written under `/tmp` was hidden by the sandbox's
fresh tmpfs ("Settings file not found"); and the operator's whole login
directory was bound read-only, which the CLI stalls on while it tries to
write its own state there. `wrap_managed_claude_in_sandbox` is the mirror of
the Codex lane's runtime-state wrapper. ARIA-MEDIUM-563: no login file
enters the room at all — the kernel's provider gateway holds the credential.

What this pins, one property per test:

* The executable is bound read-only and run by its resolved absolute path.
* The spawn documents' directories are bound read-only, after the /tmp tmpfs.
* No login enters the sandbox: the private home's `.claude` is the CLI's
  config dir, empty but for the session store, and the room's credential is
  the gateway route's placeholder.
* A spawn document inside the workspace (or a workspace inside a document
  directory) is refused by name: the two mounts would shadow each other.
* The wrapper keeps the base sandbox's own properties (READONLY_PATHS,
  network files, private /tmp) — nothing is re-implemented.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.implementation_safety import (
    SANDBOX_HOME,
    SandboxUnavailable,
    wrap_managed_claude_in_sandbox,
)


def _pairs(command: list[str], flag: str) -> list[tuple[str, str]]:
    return [(command[i + 1], command[i + 2]) for i, token in enumerate(command) if token == flag]


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-claude-sandbox-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.workspace = self.root / "workspace"
        (self.workspace / "aria-kernel" / "aria_kernel").mkdir(parents=True)
        self.install = self.root / "install" / "versions"
        self.install.mkdir(parents=True)
        (self.install / "2.1.269").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        (self.install / "2.1.269").chmod(0o755)
        (self.root / "claude").symlink_to(self.install / "2.1.269")
        self.documents = self.root / "spawn-settings"
        self.documents.mkdir()
        self.settings = self.documents / "aria-settings-AIR-1.json"
        self.settings.write_text("{}", encoding="utf-8")
        self.mcp_dir = self.root / "spawn-mcp"
        self.mcp_dir.mkdir()
        self.mcp = self.mcp_dir / "aria-mcp-judge.json"
        self.mcp.write_text("{}", encoding="utf-8")
        patcher = mock.patch.object(impl, "_bwrap_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _wrap(self, **overrides) -> list[str]:
        arguments = dict(
            workspace_root=self.workspace, write_scope=(), executable=self.root / "claude",
            spawn_files=(self.settings, self.mcp),
        )
        arguments.update(overrides)
        return wrap_managed_claude_in_sandbox(["claude", "-p", "--model", "opus"], **arguments)


class TheExecutableIsTheOneResolved(_Fixture):
    def test_it_is_bound_read_only_and_run_by_absolute_path(self) -> None:
        command = self._wrap()
        real = str((self.install / "2.1.269").resolve())
        # ARIA-MEDIUM-563 — the CLI is the room's first process, by absolute
        # path: the gateway room has no relay in front of it.
        self.assertEqual(command[command.index("--") + 1:], [real, "-p", "--model", "opus"])
        self.assertIn((real, real), _pairs(command, "--ro-bind"))
        # ARIA-HIGH-143 — the spawn is isolated from the host's PID, IPC,
        # UTS and NETWORK namespaces and its controlling session, not just
        # reaped with its parent: the CLI reaches its provider through the
        # kernel's provider gateway, whose socket is the room's one road out.
        from aria_kernel.provider_routes import ROOM_CREDENTIAL_PLACEHOLDER, route

        prefix = command[:command.index("--")]
        for flag in ("--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session",
                     "--die-with-parent"):
            self.assertIn(flag, prefix, flag)
        gateway = route("anthropic")
        self.assertEqual([target for _, target in _pairs(prefix, "--bind")
                          if target == gateway.room_socket], [gateway.room_socket])
        self.assertNotIn(impl.SANDBOX_EGRESS_PROXY_SOCKET, prefix)
        self.assertNotIn(impl.SANDBOX_EGRESS_RELAY, prefix)
        self.assertIn(("ANTHROPIC_UNIX_SOCKET", gateway.room_socket), _pairs(prefix, "--setenv"))
        self.assertIn(("CLAUDE_CODE_OAUTH_TOKEN", ROOM_CREDENTIAL_PLACEHOLDER), _pairs(prefix, "--setenv"))
        unset = [prefix[i + 1] for i, token in enumerate(prefix) if token == "--unsetenv"]
        for name in (*gateway.room_unset, "HTTPS_PROXY", "https_proxy"):
            self.assertIn(name, unset)
        self.assertNotIn("/etc/resolv.conf", [source for source, _ in _pairs(prefix, "--ro-bind")])


class TheSpawnDocumentsAreVisible(_Fixture):
    def test_their_directories_are_bound_after_the_tmpfs(self) -> None:
        command = self._wrap()
        binds = _pairs(command, "--ro-bind")
        self.assertIn((str(self.documents), str(self.documents)), binds)
        self.assertIn((str(self.mcp_dir), str(self.mcp_dir)), binds)
        tmpfs_at = command.index("/tmp") - 1
        self.assertEqual(command[tmpfs_at], "--tmpfs")
        self.assertLess(tmpfs_at, command.index(str(self.documents)))

    def test_a_document_inside_the_workspace_is_refused(self) -> None:
        inside = self.workspace / "settings.json"
        inside.write_text("{}", encoding="utf-8")
        with self.assertRaises(SandboxUnavailable) as caught:
            self._wrap(spawn_files=(inside,))
        self.assertIn("spawn_document_directory_overlaps_workspace", str(caught.exception))


class NoLoginEntersThePrivateHome(_Fixture):
    def test_the_login_file_is_never_bound(self) -> None:
        # ARIA-MEDIUM-563 — the room used to receive the managed login's
        # `.credentials.json` (writable, ARIA-HIGH-157), so any process in it
        # could read the operator's token. The wrapper takes no login at all;
        # the private config dir is the CLI's, empty.
        import inspect

        self.assertNotIn("managed_login_dir", inspect.signature(wrap_managed_claude_in_sandbox).parameters)
        command = self._wrap()
        private = f"{SANDBOX_HOME}/.claude"
        self.assertIn(("CLAUDE_CONFIG_DIR", private), _pairs(command, "--setenv"))
        targets = [target for _, target in _pairs(command, "--bind") + _pairs(command, "--ro-bind")]
        self.assertFalse([target for target in targets if target.startswith(private)])
        self.assertFalse([arg for arg in command if arg.endswith((".credentials.json", "auth.json"))])
        self.assertFalse([arg for arg in command if str(Path.home() / ".claude") in arg])

    def test_the_session_store_projects_dir_is_the_private_config_dirs_projects_writable(self) -> None:
        # ARIA-HIGH-179 — the tmpfs HOME loses every conversation with the
        # process; the durable store's `projects` is bound writable where the
        # CLI writes and reads them, so `--resume` finds its transcript.
        store = self.root / "sessions"
        command = self._wrap(session_store_dir=store)
        private = f"{SANDBOX_HOME}/.claude"
        projects = (str((store / "projects").resolve()), f"{private}/projects")
        self.assertIn(projects, _pairs(command, "--bind"))
        self.assertNotIn(projects, _pairs(command, "--ro-bind"))
        self.assertTrue((store / "projects").is_dir(), "the store is created for the first spawn")
        self.assertLess(command.index("--tmpfs"), command.index(projects[0]), "bound after the tmpfs it lives under")
        # Without a store nothing under the private home is bound.
        bare = self._wrap()
        self.assertNotIn(f"{private}/projects", bare)
        # A store inside the workspace is refused by name.
        with self.assertRaises(impl.SandboxUnavailable) as refused:
            self._wrap(session_store_dir=self.workspace / "sessions")
        self.assertEqual(str(refused.exception), "session_store_overlaps_workspace")


class TheBaseSandboxIsKept(_Fixture):
    def test_readonly_paths_and_private_tmp_remain(self) -> None:
        command = self._wrap()
        kernel = str(self.workspace / "aria-kernel" / "aria_kernel")
        self.assertIn((kernel, kernel), _pairs(command, "--ro-bind"))
        self.assertIn(("--tmpfs", "/tmp"), list(zip(command, command[1:])))
        self.assertIn(("--tmpfs", SANDBOX_HOME), list(zip(command, command[1:])))
        self.assertIn("--unshare-net", command[:command.index("--")])
        self.assertEqual((os.path.isabs(command[0]), os.path.basename(command[0])), (True, "bwrap"))

    def test_the_git_binds_and_the_broker_socket_reach_the_base_wrapper_unchanged(self) -> None:
        """ARIA-HIGH-123 — both routes derive ONE set of git binds: the
        managed route hands `git` and `hook_broker_socket` to
        `wrap_bash_in_sandbox` and adds nothing of its own about either;
        no store is bound by either route."""
        from aria_kernel.git_containment import derive_git_containment
        from aria_kernel.hook_broker import SANDBOX_HOOK_BROKER_SOCKET
        from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit
        from tests._helpers.unix_sockets import bound_unix_socket

        repo = make_repo_with_initial_commit(self.root, {"f.txt": "x\n"}, name="checkout")
        worktree = repo / "aria-worktrees" / "req-1"
        worktree.parent.mkdir()
        _git(["worktree", "add", "--detach", "-q", str(worktree), "HEAD"], cwd=repo)
        (worktree / "aria-kernel" / "aria_kernel").mkdir(parents=True)
        containment = derive_git_containment(worktree, commit_capable=True)
        with bound_unix_socket(self.root / "hb" / "sock") as broker_socket:
            managed = self._wrap(workspace_root=worktree, git=containment, hook_broker_socket=broker_socket)
            base = impl.wrap_bash_in_sandbox(
                [str(self.root / "claude"), "-p", "--model", "opus"], workspace_root=worktree,
                provider=impl.MANAGED_SPAWN_PROVIDER, write_scope=(),
                extra_ro_binds=(self.root / "claude", self.documents, self.mcp_dir),
                git=containment, hook_broker_socket=broker_socket,
            )
        # ARIA-MEDIUM-563 — the managed route adds no writable mount of its
        # own (no login file any more): every --bind is the base's.
        self.assertEqual(_pairs(managed, "--bind"), _pairs(base, "--bind"))
        self.assertIn((str(broker_socket), SANDBOX_HOOK_BROKER_SOCKET), _pairs(managed, "--bind"))
        common = (repo / ".git").resolve()
        replica = containment.sandbox_git_dir
        self.assertIn((str(replica / "refs" / "heads"), str(common / "refs" / "heads")), _pairs(managed, "--bind"))
        self.assertNotIn((str(common / "objects"), str(common / "objects")), _pairs(managed, "--bind"))
        # ARIA-HIGH-141: the common dir is a tmpfs with its shared entries
        # bound back read-only one by one, never bound as a whole.
        self.assertNotIn((str(common), str(common)), _pairs(managed, "--ro-bind"))
        self.assertIn(str(common), [managed[i + 1] for i, tok in enumerate(managed) if tok == "--tmpfs"])
        self.assertIn((str(common / "objects"), str(common / "objects")), _pairs(managed, "--ro-bind"))
        self.assertIn((str(common / "config"), str(common / "config")), _pairs(managed, "--ro-bind"))
        self.assertNotIn("tools_dir", wrap_managed_claude_in_sandbox.__code__.co_varnames)


if __name__ == "__main__":
    unittest.main()
