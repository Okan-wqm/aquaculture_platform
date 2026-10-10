"""Plan ARIA-V9.0-E — skill_genesis_sandbox invariants.

Closes ai-safety MED-015 + sec CRIT-006 (tool adapter execution
sandbox + AST allowlist).

ARIA-HIGH-414 — this module is the allowlist and its static pre-check. The
runtime enforcement, the room run and the byte custody are pinned in
tests/test_genesis_adapter_custody.py; the path-based ``execute_in_sandbox``
and the self-written-sha ``verify_adapter_signature`` were removed with
their tests.
"""
from __future__ import annotations

import unittest

from . import _helpers  # noqa: F401

from aria_kernel import skill_genesis_sandbox as _sb


class TestV9SkillSandbox(unittest.TestCase):

    def test_i_v9_skill_03_allowed_imports_closed_set(self):
        """ALLOWED_ADAPTER_IMPORTS is a closed frozenset."""
        self.assertIsInstance(_sb.ALLOWED_ADAPTER_IMPORTS, frozenset)
        # Core safe stdlib
        for required in ("re", "json", "hashlib", "pathlib", "typing"):
            self.assertIn(required, _sb.ALLOWED_ADAPTER_IMPORTS)

    def test_i_v9_skill_03_forbidden_imports_closed_set(self):
        """FORBIDDEN_ADAPTER_IMPORTS captures network + subprocess + dynamic-import vectors."""
        self.assertIsInstance(_sb.FORBIDDEN_ADAPTER_IMPORTS, frozenset)
        for must_deny in (
            "urllib", "socket", "subprocess", "requests",
            "ssl", "ftplib", "smtplib", "pickle",
            "importlib", "ctypes",
        ):
            self.assertIn(
                must_deny, _sb.FORBIDDEN_ADAPTER_IMPORTS,
                f"{must_deny} MUST be in FORBIDDEN_ADAPTER_IMPORTS",
            )

    def test_i_v9_skill_03_ast_rejects_urllib(self):
        source = """
import urllib.request
def detect(): pass
"""
        with self.assertRaises(_sb.UnsafeAdapterImport):
            _sb.verify_adapter_imports(source)

    def test_i_v9_skill_03_ast_rejects_subprocess(self):
        source = "import subprocess\n"
        with self.assertRaises(_sb.UnsafeAdapterImport):
            _sb.verify_adapter_imports(source)

    def test_i_v9_skill_03_ast_rejects_requests(self):
        source = "from requests import get\n"
        with self.assertRaises(_sb.UnsafeAdapterImport):
            _sb.verify_adapter_imports(source)

    def test_i_v9_skill_03_ast_rejects_pickle(self):
        source = "import pickle\n"
        with self.assertRaises(_sb.UnsafeAdapterImport):
            _sb.verify_adapter_imports(source)

    def test_i_v9_skill_03_ast_accepts_safe(self):
        # `import os.path` binds the name `os` (ARIA-HIGH-414, refused now);
        # the aliased form binds only the submodule.
        source = """
from __future__ import annotations
import re
import json
import hashlib
from pathlib import Path
from typing import Any
import os.path as osp

def detect(payload: str) -> dict:
    return {"hits": re.findall(r"foo", payload)}
"""
        _sb.verify_adapter_imports(source)  # MUST NOT raise

    def test_i_v9_skill_03_ast_rejects_syntax_error(self):
        source = "this is not python at all >>> )"
        with self.assertRaises(_sb.UnsafeAdapterImport):
            _sb.verify_adapter_imports(source)

    def test_i_v9_skill_03_error_redacts_body(self):
        """Error message lists offending NAMES but not full source
        body (potential injection vector)."""
        source = "import urllib.request  # secret_in_comment = 'AKIAFOO'\n"
        try:
            _sb.verify_adapter_imports(source)
            self.fail("expected UnsafeAdapterImport")
        except _sb.UnsafeAdapterImport as exc:
            msg = str(exc)
            self.assertIn("urllib", msg)
            self.assertNotIn("AKIAFOO", msg)
            self.assertNotIn("secret_in_comment", msg)

    def test_i_v9_skill_03_public_api_complete(self):
        canonical = {
            "ALLOWED_ADAPTER_IMPORTS", "DYNAMIC_IMPORT_PRIMITIVES", "FORBIDDEN_ADAPTER_IMPORTS",
            "UnsafeAdapterImport", "verify_adapter_imports",
        }
        self.assertEqual(set(_sb.__all__), canonical)


if __name__ == "__main__":
    unittest.main()
