"""ARIA-MEDIUM-563 — the kernel holds a provider credential behind one boundary.

``provider_credentials.read_provider_credential`` is the one reader the
Anthropic gateway, the Claude preflight and admission, the workflows' check
and the Z.ai transport go through. Each refusal is by name and never
carries the value.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel import provider_credentials as pc

SECRET = "fixture-kernel-token-" + "q" * 24
KERNEL_ROOT = Path(__file__).resolve().parents[1]


class TheCredentialBoundary(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-provider-cred-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def token(self, content: str = SECRET + "\n", mode: int = 0o600, where: Path | None = None) -> Path:
        path = (where or self.tmp) / "token"
        path.write_text(content, encoding="utf-8")
        os.chmod(path, mode)
        return path

    def refused(self, provider: str, environ: dict[str, str], **kwargs) -> pc.ProviderCredentialUnavailable:
        with self.assertRaises(pc.ProviderCredentialUnavailable) as caught:
            pc.read_provider_credential(provider, environ, **kwargs)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertEqual(caught.exception.provider, provider)
        return caught.exception

    def test_a_0600_file_named_by_the_fleet_row_is_the_credential(self) -> None:
        path = self.token()
        credential = pc.read_provider_credential("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(path)})
        self.assertEqual((credential.provider, credential.source, credential.location), ("anthropic", "file", str(path)))
        self.assertEqual(credential.header_value(), "Bearer " + SECRET)
        self.assertNotIn(SECRET, repr(credential))
        self.assertNotIn(SECRET, str(credential))

    def test_each_refusal_is_by_name(self) -> None:
        name = "ARIA_CLAUDE_OAUTH_TOKEN_FILE"
        self.assertEqual(self.refused("anthropic", {}).reason, "credential_not_configured")
        self.assertEqual(self.refused("anthropic", {name: str(self.tmp / "absent")}).reason,
                         "credential_file_unreadable")
        self.assertEqual(self.refused("anthropic", {name: str(self.tmp)}).reason, "credential_file_unreadable")
        self.assertEqual(self.refused("anthropic", {name: str(self.token(mode=0o644))}).reason,
                         "credential_file_permissions")
        self.assertEqual(self.refused("anthropic", {name: str(self.token(mode=0o640))}).reason,
                         "credential_file_permissions")
        for content in ("", "\n"):
            with self.subTest(content=repr(content)):
                self.assertEqual(self.refused("anthropic", {name: str(self.token(content))}).reason,
                                 "credential_file_empty")
        # One line of printable ASCII, nothing else: a second line, a space or
        # a CR would be header text the gateway writes upstream.
        for content in ("one\ntwo\n", SECRET + " x\n", SECRET + "\r\nx-a: 1\n", SECRET + "\u00e7\n"):
            with self.subTest(content=repr(content)):
                self.assertEqual(self.refused("anthropic", {name: str(self.token(content))}).reason,
                                 "credential_file_malformed")
        self.assertEqual(self.refused("anthropic", {name: str(self.token("a" * (pc.MAX_CREDENTIAL_FILE_BYTES + 1)))})
                         .reason, "credential_file_too_large")

    def test_the_file_is_opened_as_itself(self) -> None:
        # Opened without following a symlink and judged on the descriptor
        # it read (no window between the check and the read).
        target = self.token()
        link = self.tmp / "link"
        link.symlink_to(target)
        self.assertEqual(self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(link)}).reason,
                         "credential_file_unreadable")
        fifo = self.tmp / "fifo"
        os.mkfifo(fifo, 0o600)
        self.assertEqual(self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(fifo)}).reason,
                         "credential_file_unreadable")

    @unittest.skipUnless(os.geteuid() == 0, "changing a file's owner needs root")
    def test_a_file_another_account_owns_is_refused(self) -> None:
        path = self.token()
        os.chown(path, 65534, -1)
        self.assertEqual(self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(path)}).reason,
                         "credential_file_owner")

    def test_a_file_under_a_root_every_room_binds_is_refused(self) -> None:
        # Rooms run as the kernel's uid and ro-bind the system roots and the
        # kernel's interpreter: a 0600 token under /usr/local/etc or
        # /etc/ssl/private would be readable inside every room. The refused
        # trees are the room builder's own bind list, not a copy of it.
        from aria_kernel import implementation_safety

        roots = implementation_safety.room_host_roots()
        for root in implementation_safety._SANDBOX_SYSTEM_ROOTS:
            self.assertIn(Path(root), roots)
        for root in roots:
            with self.subTest(root=str(root)):
                refusal = self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(root / "aria-token")})
                self.assertEqual(refusal.reason, "credential_file_in_room_tree")

    def test_the_anthropic_credential_is_never_a_value_in_the_environment(self) -> None:
        # The fleet row names a file only: a token in a variable is not read,
        # because every child of the process would inherit it.
        self.assertEqual(self.refused("anthropic", {"CLAUDE_CODE_OAUTH_TOKEN": SECRET}).reason,
                         "credential_not_configured")

    def test_two_sources_at_once_are_ambiguous(self) -> None:
        refusal = self.refused("zai", {"ARIA_ZAI_API_KEY_FILE": str(self.token()), "ARIA_ZAI_API_KEY": "other"})
        self.assertEqual(refusal.reason, "credential_sources_ambiguous")

    def test_a_file_inside_a_room_bound_tree_is_refused(self) -> None:
        workspace = self.tmp / "workspace"
        workspace.mkdir()
        inside = self.token(where=workspace)
        refusal = self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(inside)}, room_trees=(workspace,))
        self.assertEqual(refusal.reason, "credential_file_in_room_tree")
        # The kernel's own checkout is always such a tree: rooms bind its
        # code, and its worktrees are their workspaces.
        in_checkout = Path(tempfile.mkdtemp(prefix="aria-cred-", dir=KERNEL_ROOT / "tests"))
        self.addCleanup(shutil.rmtree, in_checkout, True)
        refusal = self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(self.token(where=in_checkout))})
        self.assertEqual(refusal.reason, "credential_file_in_room_tree")
        # A symlink outside pointing inside is judged by where it leads.
        link = self.tmp / "link"
        link.symlink_to(inside)
        refusal = self.refused("anthropic", {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(link)}, room_trees=(workspace,))
        self.assertEqual(refusal.reason, "credential_file_in_room_tree")

    def test_an_unknown_provider_has_no_boundary(self) -> None:
        with self.assertRaises(KeyError):
            pc.read_provider_credential("nobody", {})

    def test_the_command_line_check_names_the_boundary_and_never_the_value(self) -> None:
        path = self.token()
        def run(env: dict[str, str]) -> subprocess.CompletedProcess:
            # As the workflows run it: PYTHONPATH=aria-kernel.
            return subprocess.run(
                [sys.executable, "-m", "aria_kernel.provider_credentials", "check", "anthropic"],
                capture_output=True, text=True, timeout=60,
                env={"PATH": os.defpath, "PYTHONPATH": str(KERNEL_ROOT), "PYTHONDONTWRITEBYTECODE": "1", **env},
            )

        ok = run({"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(path)})
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(ok.stdout.strip(), f"ok:file:{path}")
        os.chmod(path, 0o644)
        refused = run({"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(path)})
        self.assertEqual(refused.returncode, 1)
        self.assertTrue(refused.stdout.startswith("refused:credential_file_permissions"), refused.stdout)
        self.assertNotIn(SECRET, ok.stdout + ok.stderr + refused.stdout + refused.stderr)


class TheJevTransportReadsTheSameFileRules(unittest.TestCase):
    def test_jev_runtime_reads_its_key_through_the_one_file_reader(self) -> None:
        from aria_kernel import jev_runtime

        source = Path(jev_runtime.__file__).read_text(encoding="utf-8")
        self.assertIn("read_secret_file(", source)
        for copy in ("S_ISREG", "0o077", "O_NOFOLLOW", "st_uid"):
            self.assertNotIn(copy, source, f"a second copy of the file boundary: {copy}")
        # The rules the one reader adds reach Jev too: a key under a root
        # every room binds is refused by name.
        result = jev_runtime.post_systemone({}, environ={"ARIA_JEV_API_KEY_FILE": "/etc/ssl/aria-jev-key"},
                                            opener=lambda *_: (500, b""), breaker=jev_runtime.CircuitBreaker())
        self.assertEqual(result, jev_runtime.JevUnavailable("credential_file_in_room_tree"))


class TheZaiTransportReadsTheSameBoundary(unittest.TestCase):
    def test_read_zai_credential_delegates_to_the_one_reader(self) -> None:
        sys.path.insert(0, str(KERNEL_ROOT.parent / "tools" / "aria-poc"))
        import zai_runtime

        source = Path(zai_runtime.__file__).read_text(encoding="utf-8")
        self.assertIn("read_provider_credential(ZAI_PROVIDER_KEY", source)
        self.assertNotIn("S_ISREG", source, "a second copy of the file boundary")
        self.assertNotIn("0o077", source, "a second copy of the file boundary")
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
            zai_runtime.read_zai_credential({"ARIA_ZAI_API_KEY_FILE": "/nonexistent/zai.key"})
        self.assertEqual(caught.exception.reason, "credential_file_unreadable")
        self.assertIsInstance(caught.exception.__cause__, pc.ProviderCredentialUnavailable)


if __name__ == "__main__":
    unittest.main()
