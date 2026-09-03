"""Plan ARIA-V2 §3.7 + I-41 + INFRA-LOW-001 — no external network in tests.

Test modules under ``aria-kernel/tests/`` MUST NOT reach external
network. The CI runner has restricted egress, and silent network
calls in tests turn into flakey failures the moment a corporate
mirror or air-gapped checkout runs the suite.

Banned tokens (substring grep over source bytes, before import):

  * ``socket.socket(``       — direct socket construction
  * ``urllib.request.urlopen``
  * ``urllib.urlopen``       — Py2 form, defensive
  * ``requests.get(`` / ``requests.post(`` / ``requests.put(`` /
    ``requests.delete(`` / ``requests.request(``
  * ``http.client.HTTP`` constructors
  * ``aiohttp.ClientSession``

Allowed exceptions:

  * Per-line ``# allowlist-external-network:<reason>`` comment
    (deliberate, reviewed escape hatch).
  * Files in ``_EXEMPT_FILES`` (this file describes the banned
    tokens by name).
"""

from __future__ import annotations

import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
_TESTS_DIR = _REPO_ROOT / "aria-kernel" / "tests"

_EXEMPT_FILES: frozenset[str] = frozenset({
    "test_no_external_network_in_aria_kernel_tests.py",
})

_BANNED_TOKENS: tuple[str, ...] = (
    "socket.socket(",
    "urllib.request.urlopen",
    "urllib.urlopen",
    "requests.get(",
    "requests.post(",
    "requests.put(",
    "requests.delete(",
    "requests.request(",
    "http.client.HTTPConnection",
    "http.client.HTTPSConnection",
    "aiohttp.ClientSession",
)

_ALLOWLIST_TOKEN = "allowlist-external-network:"


class NoExternalNetworkInTests(unittest.TestCase):
    def test_no_banned_network_token_in_kernel_tests(self) -> None:
        if not _TESTS_DIR.exists():
            self.skipTest(f"{_TESTS_DIR} not present")

        violations: list[str] = []
        for path in sorted(_TESTS_DIR.rglob("*.py")):
            if path.name in _EXEMPT_FILES:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for line_no, line in enumerate(text.splitlines(), start=1):
                if _ALLOWLIST_TOKEN in line:
                    continue
                # Strip Python comment tails so a doc-comment mentioning
                # the banned token doesn't false-positive.
                code_line = line
                hash_idx = code_line.find("  #")
                if hash_idx == -1:
                    hash_idx = code_line.find("\t#")
                if hash_idx != -1:
                    code_line = code_line[:hash_idx]
                stripped = code_line.lstrip()
                if stripped.startswith("#"):
                    continue
                for token in _BANNED_TOKENS:
                    if token in code_line:
                        violations.append(
                            f"{path.relative_to(_REPO_ROOT)}:{line_no}: "
                            f"banned token {token!r} → {line.strip()}"
                        )
                        break

        if violations:
            self.fail(
                "Plan ARIA-V2 §3.7 + I-41: external-network token found "
                "in aria-kernel test source. Mock the call OR add a "
                f"`# {_ALLOWLIST_TOKEN}<reason>` opt-out comment.\n\n  "
                + "\n  ".join(violations)
            )


if __name__ == "__main__":
    unittest.main()
