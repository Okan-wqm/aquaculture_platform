"""A sandbox that lets nothing run is not containment; it is an outage.

Every nightly `aria-agent-executor` run from 2026-08-04 onward ended in
`claude exec exited 1`, and the whole learning loop — judgments, consensus,
calibration, gold corpus — stayed empty because no agent ever produced a
result. Reproducing the executor's exact bwrap argv on 2026-08-08 found two
independent reasons, and BOTH had to be true for the agent to run:

1. `$HOME` resolved inside the sandbox but was NOT writable — it survived only
   as an implicit parent of the workspace bind, on the read-only root. The CLI
   blocked trying to write its own state.

2. the network-granting room (then `allow_network=True`) shared the host's
   network namespace and bound no resolver configuration, so `getent hosts api.anthropic.com` failed inside
   the sandbox and the CLI hung until its timeout.

The second is the more instructive: a permission that is granted and unusable
reads to every reviewer as granted. These tests pin both, so a future edit
cannot quietly restore either.

ARIA-HIGH-143 changed what the granted network IS, not the lesson: the room
no longer shares the host's namespace or binds its resolver (that was the
road a prompt-injected test file took to any host). It has its own namespace,
and its one road out is the kernel's listener for its provider route, which
resolves the provider OUTSIDE — so "granted and usable" is now "the room's
gateway answers from inside", pinned below by the gate's own in-room probe
(ARIA-MEDIUM-563: the managed room's road is the provider gateway, which
forwards under the kernel's credential).
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel.implementation_safety import (
    SANDBOX_HOME,
    wrap_bash_in_sandbox,
)
from tests._helpers.sandbox_pins import require_sandbox_backend


def _argv(provider: str | None) -> list[str]:
    """The argv the executor would run.

    `wrap_bash_in_sandbox` RAISES when bwrap is missing rather than degrading —
    that refusal is the containment guarantee and must not be softened for a
    test. So every caller here skips on a host without bwrap; the
    GitHub-hosted runner is one, and three of these tests originally forgot to,
    which is how they went red on their first CI run.
    """
    with TemporaryDirectory() as tmp:
        return list(wrap_bash_in_sandbox(["true"], workspace_root=tmp, provider=provider))


class SandboxHomeTest(unittest.TestCase):
    def test_the_agent_gets_a_home_it_can_write(self) -> None:
        require_sandbox_backend()
        argv = _argv(provider="anthropic")

        self.assertIn("--setenv", argv)
        self.assertEqual(argv[argv.index("--setenv") + 1 : argv.index("--setenv") + 3], ["HOME", SANDBOX_HOME])
        # `--tmpfs` as well as `--setenv`: pointing HOME at a path that does not
        # exist reproduces the same hang by a different route.
        self.assertIn(SANDBOX_HOME, argv[: argv.index("--")])
        self.assertIn("--tmpfs", argv)

    def test_the_home_is_ephemeral_not_the_operators_own(self) -> None:
        require_sandbox_backend()
        # Stronger containment than binding the real home, not weaker: the
        # agent cannot read the operator's ~/.claude.json nor leave anything in
        # it. No credential arrives at all: the gateway holds it.
        argv = _argv(provider="anthropic")

        self.assertTrue(SANDBOX_HOME.startswith("/tmp/"))
        self.assertNotIn(str(Path.home()), argv)

    def test_home_is_actually_writable_inside_the_sandbox(self) -> None:
        require_sandbox_backend()
        with TemporaryDirectory() as tmp:
            argv = wrap_bash_in_sandbox(
                ["sh", "-c", 'touch "$HOME/probe" && echo WRITABLE'],
                workspace_root=tmp,
            )
            result = subprocess.run(list(argv), capture_output=True, text=True, timeout=60)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WRITABLE", result.stdout)


class SandboxNetworkTest(unittest.TestCase):
    def test_a_provider_route_grants_its_listener_not_the_hosts_network(self) -> None:
        require_sandbox_backend()
        from aria_kernel.implementation_safety import SANDBOX_EGRESS_PROXY_SOCKET
        from aria_kernel.provider_routes import route

        gateway = _argv(provider="anthropic")
        self.assertIn("--unshare-net", gateway)
        self.assertNotIn("/etc/resolv.conf", gateway)
        self.assertIn(route("anthropic").room_socket, gateway[: gateway.index("--")])
        self.assertNotIn(SANDBOX_EGRESS_PROXY_SOCKET, gateway)
        tunnel = _argv(provider="openai")
        self.assertIn(SANDBOX_EGRESS_PROXY_SOCKET, tunnel[: tunnel.index("--")])

    def test_denying_the_network_binds_no_resolver(self) -> None:
        require_sandbox_backend()
        # The resolver files are a network capability, so they must not travel
        # with a sandbox that was denied the network.
        argv = _argv(provider=None)

        self.assertIn("--unshare-net", argv)
        self.assertNotIn("/etc/resolv.conf", argv)

    def test_the_granted_network_actually_works_inside(self) -> None:
        # The assertion that would have caught 2026-08-08 in the first place:
        # not "was the flag passed" but "does the granted road carry traffic,
        # asked from inside the room" — the room's gateway answers, and
        # answers as the gateway (the gate's own probe, ARIA-HIGH-143,
        # ARIA-MEDIUM-563).
        require_sandbox_backend()
        from aria_kernel.implementation_safety import egress_boundary_probe

        self.assertIsNone(egress_boundary_probe())


if __name__ == "__main__":
    unittest.main()
