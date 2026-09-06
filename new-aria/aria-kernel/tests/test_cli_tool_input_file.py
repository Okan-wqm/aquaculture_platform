from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cli import main


class ToolInputFileCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tools_dir = self.root / "tools"
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def argv(self, *input_args: str) -> list[str]:
        return [
            "--tools-dir",
            str(self.tools_dir),
            "tool",
            "run",
            "--tool-id",
            "legal-document-snapshot",
            *input_args,
            "--cycle-id",
            "cycle-input-file",
            "--workspace-root",
            str(self.workspace),
        ]

    def test_input_file_supplies_the_same_json_object_as_inline_input(self) -> None:
        payload = {"case": {"id": "sak-24-001"}, "receipts": [{"sha256": "a" * 64}]}
        input_file = self.root / "input.json"
        input_file.write_text(json.dumps(payload), encoding="utf-8")
        result = {"envelope": {"status": "ok"}}

        with patch("aria_kernel.cli.run_tool", return_value=result) as run_tool_mock:
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main(self.argv("--input-file", str(input_file))), 0)

        run_tool_mock.assert_called_once_with(
            "legal-document-snapshot",
            payload,
            "cycle-input-file",
            workspace_root=str(self.workspace),
            base_dir=str(self.tools_dir),
        )

    def test_input_file_and_inline_input_are_mutually_exclusive(self) -> None:
        input_file = self.root / "input.json"
        input_file.write_text("{}", encoding="utf-8")

        with redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(SystemExit) as raised:
                main(self.argv("--input", "{}", "--input-file", str(input_file)))

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("not allowed with argument", stderr.getvalue())

    def test_input_file_rejects_symlinks_and_non_regular_files(self) -> None:
        target = self.root / "target.json"
        target.write_text("{}", encoding="utf-8")
        symlink = self.root / "input-link.json"
        symlink.symlink_to(target)
        directory = self.root / "input-directory"
        directory.mkdir()

        for path in (symlink, directory):
            with self.subTest(path=path.name):
                with redirect_stderr(io.StringIO()) as stderr:
                    with self.assertRaises(SystemExit) as raised:
                        main(self.argv("--input-file", str(path)))
                self.assertEqual(raised.exception.code, 2)
                self.assertIn("regular file", stderr.getvalue())

    def test_input_file_refuses_more_than_eight_mibibytes(self) -> None:
        input_file = self.root / "oversized.json"
        input_file.write_bytes(b"{" + b" " * (8 * 1024 * 1024))

        with redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(SystemExit) as raised:
                main(self.argv("--input-file", str(input_file)))

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("8388608 bytes", stderr.getvalue())

    def test_input_file_requires_a_json_object(self) -> None:
        input_file = self.root / "array.json"
        input_file.write_text("[]", encoding="utf-8")

        with patch(
            "aria_kernel.cli.run_tool",
            return_value={"envelope": {"status": "ok"}},
        ) as run_tool_mock:
            with redirect_stderr(io.StringIO()) as stderr:
                with self.assertRaises(SystemExit) as raised:
                    main(self.argv("--input-file", str(input_file)))

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("JSON must be an object", stderr.getvalue())
        run_tool_mock.assert_not_called()

    def test_inline_input_remains_supported(self) -> None:
        payload = {"target": "farm"}
        result = {"envelope": {"status": "ok"}}

        with patch("aria_kernel.cli.run_tool", return_value=result) as run_tool_mock:
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main(self.argv("--input", json.dumps(payload))), 0)

        self.assertEqual(run_tool_mock.call_args.args[1], payload)


if __name__ == "__main__":
    unittest.main()
