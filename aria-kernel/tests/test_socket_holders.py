"""ARIA-LOW-565 — the killed-holder socket-directory sweep has one owner.

THE DEFECT. The sweep the orchestrator's startup pass runs over the socket
directories a killed holder left behind was copied verbatim into four
modules (``hook_broker``, ``mcp_broker``, ``signing_agent``,
``egress_proxy``), differing only in the directory prefix and the socket's
name, and the orchestrator called each copy by name. A new holder was swept
only if its author wrote a fifth copy and a fifth call.

WHAT IS PINNED: every holder is a ``socket_holders.SocketHolder``
declaration, the one sweep covers every declaration, the orchestrator runs
that sweep, and no other module carries a sweep or a holder prefix of its
own. A holder's sockets are a fixed set in its declaration: the egress
proxy serves one per room route (ARIA-MEDIUM-563, the provider gateway's
``anthropic`` socket beside the CONNECT tunnel's ``openai``), and the sweep
removes such a directory only when none of them answers.
"""
from __future__ import annotations

import ast
import shutil
import socket
import tempfile
import unittest
from pathlib import Path

from aria_kernel import socket_holders
from aria_kernel.provider_routes import ROOM_ROUTE_KEYS
from aria_kernel.socket_holders import EGRESS_PROXY, SOCKET_HOLDERS, prune_stale_holder_sockets, prune_stale_socket_dirs

_KERNEL = Path(socket_holders.__file__).resolve().parent


class TheSweepCoversEveryDeclaredHolder(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp(prefix="aria-socket-holders-"))
        self.addCleanup(shutil.rmtree, self.temp_root, True)

    def _dead_directory(self, holder: socket_holders.SocketHolder, suffix: str) -> Path:
        directory = self.temp_root / f"{holder.prefix}{suffix}"
        directory.mkdir()
        for name in holder.socket_names:
            dead = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: binds a unix socket file and closes it; nothing is sent
            dead.bind(str(directory / name))
            dead.close()
        return directory

    def _listening(self, directory: Path, name: str) -> None:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: a unix socket listener in a temp dir; nothing is sent
        self.addCleanup(listener.close)
        listener.bind(str(directory / name))
        listener.listen(1)

    def test_the_five_holders_are_declared(self) -> None:
        # ARIA-MEDIUM-583 added the fifth: the GitHub App token broker a
        # lane starts as a sibling of its kernel-run process — swept like
        # every holder even though its holder process is a workflow step's,
        # because a broker the runner fails to reap leaves the same dead
        # socket directory behind.
        self.assertEqual(
            sorted((holder.name, holder.prefix, holder.socket_names) for holder in SOCKET_HOLDERS),
            [("egress_proxies", "aria-ep-", ("anthropic", "openai")), ("hook_brokers", "aria-hb-", ("sock",)),
             ("mcp_brokers", "aria-mb-", ("sock",)), ("signing_agents", "aria-sa-", ("agent",)),
             ("token_brokers", "aria-tb-", ("sock",))],
        )

    def test_the_egress_proxys_sockets_are_the_room_routes(self) -> None:
        # ARIA-MEDIUM-563 — the kernel serves one listener per room route,
        # named by the route's key; the sweep's set is that table's, not a copy.
        self.assertEqual(EGRESS_PROXY.socket_names, ROOM_ROUTE_KEYS)
        with self.assertRaisesRegex(ValueError, "socket_holder_has_several_sockets:egress_proxies"):
            EGRESS_PROXY.socket_name

    def test_a_declaration_needs_distinct_socket_names(self) -> None:
        for names in ((), ("sock", "sock")):
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, "socket_holder_names_invalid"):
                socket_holders.SocketHolder(name="x", prefix="aria-xx-", socket_names=names)

    def test_a_multi_socket_directory_is_live_while_any_socket_answers(self) -> None:
        # The gateway's socket answering keeps the directory, even when the
        # tunnel's is dead; a directory with every socket dead is swept, and
        # one holding a socket name the declaration does not list is left.
        live = self._dead_directory(EGRESS_PROXY, "live0000")
        (live / "anthropic").unlink()
        self._listening(live, "anthropic")
        dead = self._dead_directory(EGRESS_PROXY, "dead0000")
        foreign = self._dead_directory(EGRESS_PROXY, "frgn0000")
        dead_extra = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: binds a unix socket file and closes it; nothing is sent
        dead_extra.bind(str(foreign / "sock"))
        dead_extra.close()

        swept = prune_stale_socket_dirs(EGRESS_PROXY, temp_root=self.temp_root)

        self.assertEqual(swept["live"], [live.name])
        self.assertEqual(swept["swept"], [dead.name])
        self.assertTrue(live.exists())
        self.assertFalse(dead.exists())
        self.assertTrue(foreign.exists())

    def test_one_sweep_removes_every_holders_dead_directory_and_keeps_a_live_one(self) -> None:
        dead = {holder.name: self._dead_directory(holder, "dead0000") for holder in SOCKET_HOLDERS}
        live_holder = SOCKET_HOLDERS[0]
        live_dir = self.temp_root / f"{live_holder.prefix}live0000"
        live_dir.mkdir()
        self._listening(live_dir, live_holder.socket_names[0])

        swept = prune_stale_holder_sockets(temp_root=self.temp_root)

        self.assertEqual(sorted(swept), sorted(holder.name for holder in SOCKET_HOLDERS))
        for name, directory in dead.items():
            self.assertEqual(swept[name]["swept"], [directory.name], name)
            self.assertFalse(directory.exists(), name)
        self.assertEqual(swept[live_holder.name]["live"], [live_dir.name])
        self.assertTrue(live_dir.exists())

    def test_a_directory_with_files_of_its_own_or_a_foreign_name_is_left(self) -> None:
        holder = SOCKET_HOLDERS[0]
        crowded = self._dead_directory(holder, "files000")
        (crowded / "note").write_text("not the holder's", encoding="utf-8")
        foreign = self.temp_root / f"{holder.prefix}test-fixture-root"
        foreign.mkdir()
        self.assertEqual(prune_stale_holder_sockets(temp_root=self.temp_root)[holder.name]["swept"], [])
        self.assertTrue(crowded.exists())
        self.assertTrue(foreign.exists())


class TheSweepHasOneOwner(unittest.TestCase):
    def test_no_other_kernel_module_declares_a_holder_or_carries_a_sweep(self) -> None:
        # A sweep copy needs its holder's prefix and the shape of mkdtemp's
        # suffix as literals; a holder needs a SocketHolder declaration. Any
        # of the three outside socket_holders is a second owner.
        prefixes = {holder.prefix for holder in SOCKET_HOLDERS}
        offenders: list[str] = []
        for path in sorted(_KERNEL.glob("*.py")):
            if path.name == "socket_holders.py":
                continue
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and (
                    node.value in prefixes or "[A-Za-z0-9_]{8}" in node.value
                ):
                    offenders.append(f"{path.name}:{node.lineno} {node.value!r}")
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "SocketHolder":
                    offenders.append(f"{path.name}:{node.lineno} SocketHolder(...)")
        self.assertEqual(offenders, [], "a holder is declared in socket_holders and swept by it alone")

    def test_each_holder_makes_its_directory_through_its_declaration(self) -> None:
        for module, holder in (("hook_broker", "HOOK_BROKER"), ("mcp_broker", "MCP_BROKER"),
                               ("signing_agent", "SIGNING_AGENT"), ("egress_proxy", "EGRESS_PROXY")):
            with self.subTest(module=module):
                source = (_KERNEL / f"{module}.py").read_text(encoding="utf-8")
                self.assertIn(f"from .socket_holders import {holder} as _SOCKET_HOLDER", source)
                self.assertIn("_SOCKET_HOLDER.make_directory()", source)
                self.assertNotIn("mkdtemp", source)

    def test_the_orchestrators_startup_pass_runs_the_one_sweep(self) -> None:
        source = (_KERNEL / "autonomy_orchestrator.py").read_text(encoding="utf-8")
        self.assertIn("**prune_stale_holder_sockets(),", source,
                      "the startup pass must run the one sweep over every declared holder")


if __name__ == "__main__":
    unittest.main()
