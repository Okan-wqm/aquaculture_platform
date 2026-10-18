"""ARIA-MEDIUM-563 — a provider host is named in one place: ``provider_routes``.

The CONNECT proxy kept its own tuple of provider endpoints and admitted all
of them to every room; the Z.ai transport kept its own base URLs. A host
named twice is a road that can open in one copy while the review reads the
other. Every executable module of the kernel and the executor is scanned:
the literals live in ``aria_kernel/provider_routes.py`` alone, and the OAuth
refresh host, which nothing in a room needs any more, lives nowhere.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = (_REPO_ROOT / "aria-kernel" / "aria_kernel", _REPO_ROOT / "tools" / "aria-poc")
_OWNER = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "provider_routes.py"
_HOSTS = ("api.anthropic.com", "api.z.ai", "chatgpt.com", "auth.openai.com", "api.openai.com")
_RETIRED = ("platform.claude.com",)


def _string_literals(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return [(node.lineno, node.value) for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)]


def _sources() -> list[Path]:
    return sorted(path for root in _SCANNED for path in root.rglob("*.py") if "tests" not in path.parts)


class ProviderHostsHaveOneOwner(unittest.TestCase):
    def test_the_host_literals_live_in_provider_routes_alone(self) -> None:
        stray = [f"{path.relative_to(_REPO_ROOT)}:{line}:{host}"
                 for path in _sources() if path != _OWNER
                 for line, text in _string_literals(path)
                 for host in _HOSTS if host in text]
        self.assertEqual(stray, [], "a provider host is named outside provider_routes.py")
        owner_text = _OWNER.read_text(encoding="utf-8")
        for host in _HOSTS:
            self.assertIn(host, owner_text)

    def test_the_oauth_refresh_host_is_named_nowhere(self) -> None:
        # No room refreshes a token any more: the gateway injects the
        # kernel's long-lived one.
        named = [f"{path.relative_to(_REPO_ROOT)}" for path in _sources()
                 if any(host in path.read_text(encoding="utf-8") for host in _RETIRED)]
        self.assertEqual(named, [])

    def test_the_connect_allowlist_is_derived_from_the_route_table(self) -> None:
        from aria_kernel import egress_proxy, provider_routes

        self.assertFalse(hasattr(egress_proxy, "PROVIDER_ENDPOINTS"), "a second copy of the provider hosts")
        self.assertEqual(provider_routes.tunnel_allowlist("openai"),
                         ("chatgpt.com:443", "auth.openai.com:443", "api.openai.com:443"))
        # A gateway route and a kernel transport carry no CONNECT road.
        for key in ("anthropic", "zai"):
            with self.assertRaises(KeyError):
                provider_routes.tunnel_allowlist(key)
        self.assertNotIn("zai", provider_routes.ROOM_ROUTE_KEYS)

    def test_the_scan_sees_the_owner(self) -> None:
        # Guard against a scan that silently reads nothing.
        self.assertIn(_OWNER, _sources())
        self.assertGreater(len(_sources()), 50)


if __name__ == "__main__":
    unittest.main()
