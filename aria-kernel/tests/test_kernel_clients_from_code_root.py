"""ARIA-HIGH-142 — the in-sandbox kernel clients are served from the kernel
that is running, not from the workspace the implementer is changing.

Trial eleven's task source (``6652139901``) predates ``hook_client.py`` and
``mcp_relay.py``. The executor that spawned into it had both, but every
hook line and the MCP relay named ``<workspace>/aria-kernel/…`` — a path
that did not exist inside the sandbox — so the hooks died by ``execvp`` and
the relay never came up, silently, on the first real implementation
request. ARIA-HIGH-133's class: a live seam with no live input.

One property per test:

* ``kernel_code_root()`` is the running kernel's ``aria-kernel/`` and holds
  both clients.
* The runtime's hook context names that root for ANY workspace, and refuses
  by name when a client is missing there.
* The sandbox binds that root read-only when it lies outside the workspace,
  and adds nothing when the workspace is the kernel's own checkout.
* The executor says out loud when its repo root is its own module's tree.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.claude_settings import hook_client_path, kernel_code_root
from aria_kernel.mcp_client import MCP_RELAY_RELPATH
from tests._helpers.executor_module import load_ci_executor

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import claude_runtime  # noqa: E402


class TheRootIsTheRunningKernels(unittest.TestCase):
    def test_kernel_code_root_holds_both_clients(self) -> None:
        root = kernel_code_root()
        self.assertEqual(root, _REPO_ROOT / "aria-kernel")
        self.assertTrue(hook_client_path(root).is_file(), hook_client_path(root))
        self.assertTrue(root.joinpath(*MCP_RELAY_RELPATH).is_file())


class TheHookContextNamesTheKernelsRoot(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-142-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        # A workspace at a commit WITHOUT the clients — no aria-kernel/ at all.
        self.workspace = self.root / "task-source"
        (self.workspace / "apps").mkdir(parents=True)
        self.recording = claude_runtime.UsageRecording(
            request_id="AIR-142", role="implementation", target_agent="aria-implementer",
            base_dir=self.root / "tools",
        )

    def test_the_context_points_at_the_kernel_not_the_workspace(self) -> None:
        context = claude_runtime._hook_context(usage_recording=self.recording, workspace_root=self.workspace)
        assert context is not None
        self.assertEqual(Path(context["kernel_root"]), kernel_code_root())
        self.assertNotEqual(Path(context["kernel_root"]), self.workspace / "aria-kernel")
        self.assertTrue(hook_client_path(context["kernel_root"]).is_file())
        self.assertEqual(Path(context["workspace_root"]), self.workspace)

    def test_no_ledger_or_no_workspace_means_no_context(self) -> None:
        self.assertIsNone(claude_runtime._hook_context(usage_recording=None, workspace_root=self.workspace))
        self.assertIsNone(claude_runtime._hook_context(usage_recording=self.recording, workspace_root=None))

    def test_a_kernel_tree_without_a_client_is_refused_by_name(self) -> None:
        # The fixture is a kernel root that is missing the relay: the
        # refusal names the file, before any settings document names it.
        bare = self.root / "kernel-without-relay"
        (bare / "aria_kernel").mkdir(parents=True)
        (bare / "aria_kernel" / "hook_client.py").write_text("# fixture\n", encoding="utf-8")
        with mock.patch.object(claude_runtime, "_spawn_interpreter", return_value=sys.executable), \
             mock.patch("aria_kernel.claude_settings.kernel_code_root", return_value=bare):
            with self.assertRaises(claude_runtime.ClaudePolicyViolation) as refused:
                claude_runtime._hook_context(usage_recording=self.recording, workspace_root=self.workspace)
        self.assertIn("kernel_client_missing:", str(refused.exception))
        self.assertIn("mcp_relay.py", str(refused.exception))


class TheSandboxBindsTheKernelsRoot(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-142-bind-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.workspace = self.root / "task-source"
        (self.workspace / "apps").mkdir(parents=True)
        patcher = mock.patch.object(impl, "_bwrap_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _ro_bind_sources(argv: list[str]) -> list[str]:
        return [argv[i + 1] for i, flag in enumerate(argv) if flag == "--ro-bind"]

    def _listening_socket(self) -> str:
        import socket

        path = str(self.root / "hook.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(1)
        self.addCleanup(server.close)
        return path

    def test_a_workspace_that_is_not_the_kernels_checkout_gets_the_root_read_only(self) -> None:
        kernel_root = str(kernel_code_root())
        self.assertEqual(impl.kernel_root_ro_binds(self.workspace), ["--ro-bind", kernel_root, kernel_root])
        # A route that serves an in-sandbox client (a broker socket handed in)
        # gets the code root; the validation sandbox and a plain bash spawn,
        # which pass no broker, do not (HIGH-124 round 3).
        plain = impl.wrap_bash_in_sandbox(["true"], workspace_root=self.workspace)
        self.assertNotIn(kernel_root, self._ro_bind_sources(plain))
        argv = impl.wrap_bash_in_sandbox(
            ["true"], workspace_root=self.workspace, hook_broker_socket=self._listening_socket(),
        )
        self.assertIn(kernel_root, self._ro_bind_sources(argv))
        # The bind is at the root's OWN path: the settings document's hook
        # line names it by absolute path and must resolve to the same file.
        i = argv.index("--ro-bind", argv.index(kernel_root) - 1)
        self.assertEqual(argv[i + 1], argv[i + 2])

    def test_the_kernels_own_checkout_adds_nothing(self) -> None:
        # Inside the checkout READONLY_PATHS already keeps aria-kernel/aria_kernel/
        # read-only; a second bind of the same tree would be the ORPHAN-452
        # class of drift between the probe and the wrapper.
        self.assertEqual(impl.kernel_root_ro_binds(_REPO_ROOT), [])
        nested = _REPO_ROOT / "aria-kernel"
        self.assertEqual(impl.kernel_root_ro_binds(nested), [])

    def test_a_kernel_under_a_system_root_is_already_covered(self) -> None:
        with mock.patch.object(impl, "_SANDBOX_SYSTEM_ROOTS", (str(kernel_code_root().parent),)):
            self.assertEqual(impl.kernel_root_ro_binds(self.workspace), [])


class TheExecutorSaysWhereItsRootCameFrom(unittest.TestCase):
    def test_without_the_env_the_root_is_the_modules_and_the_run_says_so(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ARIA_WORKSPACE_ROOT", None)
            executor = load_ci_executor("ci_executor_142_module_root")
        self.assertEqual(executor._REPO_ROOT_SOURCE, "module_location")
        self.assertEqual(executor._REPO_ROOT, _REPO_ROOT)
        note = executor.repo_root_provenance_note()
        assert note is not None
        self.assertTrue(note.startswith(executor.REPO_ROOT_FROM_MODULE_MARKER))
        self.assertIn(str(_REPO_ROOT), note)
        # The note is written by the entry point, ahead of any request work:
        # a source pin, since running `_main` claims and journals.
        import inspect

        self.assertIn("repo_root_provenance_note()", inspect.getsource(executor._main))

    def test_with_the_env_the_root_is_the_requests_tree_and_nothing_is_said(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-142-root-") as tmp:
            with mock.patch.dict(os.environ, {"ARIA_WORKSPACE_ROOT": tmp}):
                executor = load_ci_executor("ci_executor_142_env_root")
            self.assertEqual(executor._REPO_ROOT_SOURCE, "env")
            self.assertEqual(executor._REPO_ROOT, Path(tmp).resolve())
            self.assertIsNone(executor.repo_root_provenance_note())


if __name__ == "__main__":
    unittest.main()
