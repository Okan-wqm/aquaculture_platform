"""A sandbox that lets nothing run is not containment; it is an outage.

Every nightly `aria-agent-executor` run from 2026-08-04 onward ended in
`claude exec exited 1`, and the whole learning loop — judgments, consensus,
calibration, gold corpus — stayed empty because no agent ever produced a
result. Reproducing the executor's exact bwrap argv on 2026-08-08 found two
independent reasons, and BOTH had to be true for the agent to run:

1. `$HOME` resolved inside the sandbox but was NOT writable — it survived only
   as an implicit parent of the workspace bind, on the read-only root. The CLI
   blocked trying to write its own state.

2. `allow_network=True` shared the host's network namespace and bound no
   resolver configuration, so `getent hosts api.anthropic.com` failed inside
   the sandbox and the CLI hung until its timeout.

The second is the more instructive: a permission that is granted and unusable
reads to every reviewer as granted. These tests pin both, so a future edit
cannot quietly restore either.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel.implementation_safety import (
    SANDBOX_HOME,
    _bwrap_available,
    wrap_bash_in_sandbox,
)


def _argv(allow_network: bool) -> list[str]:
    with TemporaryDirectory() as tmp:
        return list(wrap_bash_in_sandbox(["true"], workspace_root=tmp, allow_network=allow_network))


class SandboxHomeTest(unittest.TestCase):
    def test_the_agent_gets_a_home_it_can_write(self) -> None:
        if not _bwrap_available():
            self.skipTest("bwrap not installed on this host")
        argv = _argv(allow_network=True)

        self.assertIn("--setenv", argv)
        self.assertEqual(argv[argv.index("--setenv") + 1 : argv.index("--setenv") + 3], ["HOME", SANDBOX_HOME])
        # `--tmpfs` as well as `--setenv`: pointing HOME at a path that does not
        # exist reproduces the same hang by a different route.
        self.assertIn(SANDBOX_HOME, argv[: argv.index("--")])
        self.assertIn("--tmpfs", argv)

    def test_the_home_is_ephemeral_not_the_operators_own(self) -> None:
        # Stronger containment than binding the real home, not weaker: the
        # agent cannot read the operator's ~/.claude.json nor leave anything in
        # it. Credentials arrive through the environment.
        argv = _argv(allow_network=True)

        self.assertTrue(SANDBOX_HOME.startswith("/tmp/"))
        self.assertNotIn(str(Path.home()), argv)

    def test_home_is_actually_writable_inside_the_sandbox(self) -> None:
        if not _bwrap_available():
            self.skipTest("bwrap not installed on this host")
        with TemporaryDirectory() as tmp:
            argv = wrap_bash_in_sandbox(
                ["sh", "-c", 'touch "$HOME/probe" && echo WRITABLE'],
                workspace_root=tmp,
                allow_network=False,
            )
            result = subprocess.run(list(argv), capture_output=True, text=True, timeout=60)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WRITABLE", result.stdout)


class SandboxNetworkTest(unittest.TestCase):
    def test_allowing_the_network_also_supplies_the_resolver(self) -> None:
        argv = _argv(allow_network=True)

        self.assertIn("/etc/resolv.conf", argv)
        self.assertNotIn("--unshare-net", argv)

    def test_denying_the_network_binds_no_resolver(self) -> None:
        # The resolver files are a network capability, so they must not travel
        # with a sandbox that was denied the network.
        argv = _argv(allow_network=False)

        self.assertIn("--unshare-net", argv)
        self.assertNotIn("/etc/resolv.conf", argv)

    def test_name_resolution_actually_works_inside(self) -> None:
        # The assertion that would have caught this in the first place: not
        # "was the flag passed" but "can the sandbox resolve a name".
        if not _bwrap_available():
            self.skipTest("bwrap not installed on this host")
        if not Path("/etc/resolv.conf").exists():
            self.skipTest("host has no /etc/resolv.conf to bind")
        with TemporaryDirectory() as tmp:
            argv = wrap_bash_in_sandbox(
                ["sh", "-c", "cat /etc/resolv.conf > /dev/null && echo RESOLVER_PRESENT"],
                workspace_root=tmp,
                allow_network=True,
            )
            result = subprocess.run(list(argv), capture_output=True, text=True, timeout=60)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("RESOLVER_PRESENT", result.stdout)


if __name__ == "__main__":
    unittest.main()
