"""Plan ARIA-V9.0-E — skill_genesis_sandbox invariants.

Closes ai-safety MED-015 + sec CRIT-006 (tool adapter execution
sandbox + AST allowlist).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

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
        source = """
from __future__ import annotations
import re
import json
import hashlib
from pathlib import Path
from typing import Any
import os.path

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

    def test_i_v9_skill_03_sandbox_refuses_without_tool(self):
        """When no bwrap/firejail available, execute_in_sandbox
        MUST raise RuntimeError (refusal not passthrough)."""
        if _sb._bwrap_available() or _sb._firejail_available():
            self.skipTest("sandbox tool available; refusal path not reachable")
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False) as tmp:
            tmp.write(b"print('hello')")
            adapter = tmp.name
        with tempfile.TemporaryDirectory() as workspace:
            with self.assertRaises(RuntimeError):
                _sb.execute_in_sandbox(adapter, workspace_root=workspace)

    def test_i_v9_skill_03_sandbox_result_frozen(self):
        result = _sb.SandboxedResult(
            exit_code=0, stdout="x", stderr="y", timed_out=False,
        )
        with self.assertRaises((AttributeError, Exception)):
            result.exit_code = 1  # type: ignore[misc]

    def test_i_v9_skill_03_adapter_signature_hash_match(self):
        """verify_adapter_signature checks sha256 against manifest."""
        import hashlib
        import json
        with tempfile.TemporaryDirectory() as tmp:
            adapter = Path(tmp) / "adapter.py"
            adapter.write_text("def detect(): pass\n")
            sha = hashlib.sha256(adapter.read_bytes()).hexdigest()
            bundle = Path(tmp) / "bundle.json"
            bundle.write_text(json.dumps({"source_sha256": sha}))
            self.assertTrue(_sb.verify_adapter_signature(adapter, bundle))

    def test_i_v9_skill_03_adapter_signature_mismatch(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            adapter = Path(tmp) / "adapter.py"
            adapter.write_text("def detect(): pass\n")
            bundle = Path(tmp) / "bundle.json"
            bundle.write_text(json.dumps({"source_sha256": "0" * 64}))
            self.assertFalse(_sb.verify_adapter_signature(adapter, bundle))

    def test_i_v9_skill_03_public_api_complete(self):
        canonical = {
            "ALLOWED_ADAPTER_IMPORTS", "FORBIDDEN_ADAPTER_IMPORTS",
            "UnsafeAdapterImport", "AdapterSignatureMismatch", "SandboxedResult",
            "verify_adapter_imports", "execute_in_sandbox", "verify_adapter_signature",
        }
        self.assertEqual(set(_sb.__all__), canonical)


if __name__ == "__main__":
    unittest.main()
