"""ARIA-MEDIUM-471 — a module's JSONL wrapper refuses a path its surface table does not name.

Eleven kernel modules wrap ``append_jsonl`` / ``load_jsonl`` with a table
mapping their ledgers to declared state surfaces. Four of them (worker_dispatch,
memory, validation, pressure) already failed closed on a path outside the
table; seven fell through to the raw, undeclared ledger writer and reader,
so a mistyped or new path was written with no manifest assertion, no
profile gate and no lock, and read back as ``[]``. Every internal caller
passes a path its own table declares, so the fallback served no one.
"""
from __future__ import annotations

import importlib
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import GovernanceError

# (module, has load_jsonl). feedback wraps only the writer.
_WRAPPERS: tuple[tuple[str, bool], ...] = (
    ("verification_gate", True),
    ("agent_genesis", True),
    ("skill_genesis", True),
    ("pr_tracking", True),
    ("triage", True),
    ("ci", True),
    ("feedback", False),
    ("worker_dispatch", True),
    ("memory", True),
    ("validation", True),
    ("pressure", True),
)


class UnknownSurfaceIsRefused(unittest.TestCase):
    def test_every_wrapper_fails_closed_on_an_undeclared_path(self) -> None:
        for name, has_load in _WRAPPERS:
            with self.subTest(module=name), tempfile.TemporaryDirectory() as tmp:
                module = importlib.import_module(f"aria_kernel.{name}")
                path = Path(tmp) / "aria-tools" / "undeclared" / "not-a-declared-surface.jsonl"
                path.parent.mkdir(parents=True)
                with self.assertRaisesRegex(GovernanceError, rf"^{name}_append_unknown_surface:"):
                    module.append_jsonl(path, {"k": 1})
                self.assertFalse(path.exists())
                if has_load:
                    with self.assertRaisesRegex(GovernanceError, rf"^{name}_load_unknown_surface:"):
                        module.load_jsonl(path)


if __name__ == "__main__":
    unittest.main()
