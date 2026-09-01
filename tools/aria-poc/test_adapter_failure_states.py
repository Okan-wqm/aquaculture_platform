#!/usr/bin/env python3
"""Adapter failure states — a dead scanner is never a clean scan.

The 2026-09-01 audit reproduced both shapes: the banned-phrase adapter
turned child exit 127 (CLI missing) into zero observations with exit 0,
and the outbox adapter silently skipped unreadable in-scope sources while
reporting the remaining read as clean. Tool-execution failure and scan
result are now different typed states: `unavailable` / `incomplete`.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_POC = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


banned = _load("banned_phrase_adapter_under_test", _POC / "banned_phrase_adapter.py")
outbox = _load("outbox_adapter_under_test", _POC / "outbox_adapter.py")


class BannedPhraseUnavailableTests(unittest.TestCase):
    def _run_main(self) -> tuple[int, dict]:
        import contextlib
        import io

        stdin = io.StringIO("{}")
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(stdout):
            code = banned.main()
        return code, json.loads(stdout.getvalue())

    def test_exit_127_is_unavailable_not_clean(self) -> None:
        with mock.patch.object(
            banned, "_invoke_banned_phrase_cli",
            return_value=(127, "banned-phrase CLI unavailable at /x /y"),
        ), mock.patch.object(banned, "_resolve_repo_root", return_value=Path("/x")):
            code, body = self._run_main()
        self.assertNotEqual(code, 0)
        self.assertEqual(body["status"], "unavailable")
        self.assertEqual(body["observations"], [])
        self.assertEqual(body["metadata"]["exit_code"], 127)

    def test_gate_error_exit_2_is_unavailable(self) -> None:
        with mock.patch.object(
            banned, "_invoke_banned_phrase_cli",
            return_value=(2, "ts-node crashed"),
        ), mock.patch.object(banned, "_resolve_repo_root", return_value=Path("/x")):
            code, body = self._run_main()
        self.assertNotEqual(code, 0)
        self.assertEqual(body["status"], "unavailable")


class OutboxIncompleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-outbox-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))

    def test_unreadable_source_marks_envelope_incomplete(self) -> None:
        good = self.root / "src" / "svc.ts"
        good.parent.mkdir(parents=True)
        good.write_text("export const x = 1;\n", encoding="utf-8")
        bad = self.root / "src" / "broken.ts"
        # Valid path, invalid UTF-8 payload: read_text raises
        # UnicodeDecodeError, the exact production shape of an
        # unreadable in-scope source.
        bad.write_bytes(b"\xff\xfe\x00bad\xff")

        envelope = outbox.scan(self.root, allowed_paths=["src/svc.ts", "src/broken.ts"])

        self.assertEqual(envelope["metadata"]["unreadable_file_count"], 1)
        self.assertIn("src/broken.ts", envelope["metadata"]["unreadable_paths"])
        self.assertEqual(envelope["status"], "incomplete")

    def test_fully_readable_scan_has_no_status_override(self) -> None:
        good = self.root / "src" / "svc.ts"
        good.parent.mkdir(parents=True)
        good.write_text("export const x = 1;\n", encoding="utf-8")

        envelope = outbox.scan(self.root, allowed_paths=["src/svc.ts"])

        self.assertNotIn("status", envelope)
        self.assertEqual(envelope["metadata"]["scanned_file_count"], 1)


if __name__ == "__main__":
    unittest.main()
