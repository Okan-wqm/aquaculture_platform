"""ARIA-HIGH-077 — what the attempt names is what runs inside the sandbox.

The managed Anthropic route's first live attempt ran `claude` by NAME inside
the write-containment sandbox: the sandbox does not bind `~/.local`, so PATH
resolved a different, older installation under `/usr/local`; the settings
document the spawn had written under `/tmp` was hidden by the sandbox's
fresh tmpfs ("Settings file not found"); and the operator's whole login
directory was bound read-only, which the CLI stalls on while it tries to
write its own state there. `wrap_managed_claude_in_sandbox` is the mirror of
the Codex lane's runtime-state wrapper.

What this pins, one property per test:

* The executable is bound read-only and run by its resolved absolute path.
* The spawn documents' directories are bound read-only, after the /tmp tmpfs.
* Only the credential file of the login directory enters the sandbox, into
  the private home's `.claude`, which becomes the CLI's config dir.
* A login without a credential file binds nothing and still names the
  private config dir.
* A spawn document inside the workspace (or a workspace inside a document
  directory) is refused by name: the two mounts would shadow each other.
* The wrapper keeps the base sandbox's own properties (READONLY_PATHS,
  network files, private /tmp) — nothing is re-implemented.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.implementation_safety import (
    CLAUDE_LOGIN_CREDENTIALS_FILENAME,
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
        self.login = self.root / "login"
        self.login.mkdir()
        (self.login / CLAUDE_LOGIN_CREDENTIALS_FILENAME).write_text('{"fixture": "managed"}\n', encoding="utf-8")
        (self.login / ".claude.json").write_text("{}", encoding="utf-8")
        patcher = mock.patch.object(impl, "_bwrap_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _wrap(self, **overrides) -> list[str]:
        arguments = dict(
            workspace_root=self.workspace, write_scope=(), executable=self.root / "claude",
            spawn_files=(self.settings, self.mcp), managed_login_dir=self.login,
        )
        arguments.update(overrides)
        return wrap_managed_claude_in_sandbox(["claude", "-p", "--model", "opus"], **arguments)


class TheExecutableIsTheOneResolved(_Fixture):
    def test_it_is_bound_read_only_and_run_by_absolute_path(self) -> None:
        command = self._wrap()
        real = str((self.install / "2.1.269").resolve())
        self.assertEqual(command[command.index("--") + 1:], [real, "-p", "--model", "opus"])
        self.assertIn((real, real), _pairs(command, "--ro-bind"))
        self.assertIn("--die-with-parent", command[:command.index("--")])


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


class OnlyTheCredentialFileEntersThePrivateHome(_Fixture):
    def test_the_credential_file_lands_in_the_private_config_dir(self) -> None:
        command = self._wrap()
        private = f"{SANDBOX_HOME}/.claude"
        self.assertIn((str(self.login / CLAUDE_LOGIN_CREDENTIALS_FILENAME), f"{private}/{CLAUDE_LOGIN_CREDENTIALS_FILENAME}"),
                      _pairs(command, "--ro-bind"))
        self.assertIn(("CLAUDE_CONFIG_DIR", private), _pairs(command, "--setenv"))
        self.assertNotIn(str(self.login), [target for _, target in _pairs(command, "--ro-bind")],
                         "the login directory itself never enters the sandbox")
        self.assertNotIn(str(self.login / ".claude.json"), command)

    def test_a_login_without_a_credential_file_binds_nothing(self) -> None:
        (self.login / CLAUDE_LOGIN_CREDENTIALS_FILENAME).unlink()
        command = self._wrap()
        self.assertFalse([pair for pair in _pairs(command, "--ro-bind") if str(self.login) in pair[0]])
        self.assertIn(("CLAUDE_CONFIG_DIR", f"{SANDBOX_HOME}/.claude"), _pairs(command, "--setenv"))
        self.assertIn(("CLAUDE_CONFIG_DIR", f"{SANDBOX_HOME}/.claude"), _pairs(self._wrap(managed_login_dir=None), "--setenv"))


class TheBaseSandboxIsKept(_Fixture):
    def test_readonly_paths_and_private_tmp_remain(self) -> None:
        command = self._wrap()
        kernel = str(self.workspace / "aria-kernel" / "aria_kernel")
        self.assertIn((kernel, kernel), _pairs(command, "--ro-bind"))
        self.assertIn(("--tmpfs", "/tmp"), list(zip(command, command[1:])))
        self.assertIn(("--tmpfs", SANDBOX_HOME), list(zip(command, command[1:])))
        self.assertNotIn("--unshare-net", command)
        self.assertEqual(command[0], "bwrap")


if __name__ == "__main__":
    unittest.main()
