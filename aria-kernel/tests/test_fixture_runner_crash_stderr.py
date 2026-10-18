"""ARIA-LOW-542 — a fixture case that crashed says why.

A case whose adapter exited non-zero kept only ``stderr_hash``
(``fixture_runner.run_fixture_case``): with ``digest.py`` untracked in the
work tree, kernel-dead-wire-adapter's ``real-repo-baseline`` case crashed in
the adapter room on ``EACCES`` and the fixture contract
(``test_adapter_fixture_evidence_contract``) reported ``crash`` with no
message, so the cause was invisible until someone reran the adapter by hand.

A case that did not run ``ok`` now carries ``stderr_sample``: the tail of its
stderr through ``adapter_room.adapter_stderr_sample`` — the one sample the
night's run rows keep too, through ``artifact_safety.published_tail``, the
sanitizer for text that leaves the host, as fixture rows do on aria/state —
so secret shapes are redacted and host paths reduced before the bound is
applied.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel import register_tool, run_fixture_suite
from aria_kernel.tool_runner import run_tool
from aria_kernel.adapter_room import ADAPTER_STDERR_SAMPLE_MAX_CHARS
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.git_fixtures import commit_files, make_local_git_repo

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"
# Built at run time: no credential-shaped literal is committed.
FAKE_TOKEN = "gh" + "p_" + "R" * 36
CRASH_STDERR = (
    "x" * 9000 + "\n"
    "Error: EACCES: permission denied, open '/var/tmp/aria-room/repo/aria-kernel/aria_kernel/digest.py'\n"
    f"GH_TOKEN={FAKE_TOKEN}\n"
)
OK_OUTPUT = {
    "observations": [], "findings": [], "read_paths": ["src/app.ts"], "evidence_sources": ["src/app.ts"], "cost_units": 1,
}


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


CRASH_ARGV = ["python3", FAKE_RUNNER.as_posix(), "--stderr-b64", _b64(CRASH_STDERR), "--exit-code", "1"]
OK_ARGV = [
    "python3", FAKE_RUNNER.as_posix(), "--output-b64", _b64(json.dumps(OK_OUTPUT)),
    "--stderr-b64", _b64("a warning nobody needs in the row\n"),
]


class CrashedCaseStderrTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in ("ARIA_TOOLS_DIR", "ARIA_REPO_ROOT")}
        os.environ.pop("ARIA_REPO_ROOT", None)
        os.environ.pop("ARIA_TOOLS_DIR", None)
        self.workspace = make_local_git_repo(
            Path(tempfile.mkdtemp(prefix="aria-542-")), name="workspace", initial_commit=False,
        )
        self.addCleanup(shutil.rmtree, self.workspace.parent, True)
        self.tools = self.workspace / ".aria-state-store" / "tools"
        ensure_tools_dir(self.tools)
        cases = self.workspace / "tools" / "aria-adapters" / "fixtures" / "x-adapter" / "cases"
        cases.mkdir(parents=True)
        (cases / "baseline.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok"}}), encoding="utf-8",
        )
        commit_files(self.workspace, {"src/app.ts": "export const app = true;\n"})

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _register(self, argv: list[str]) -> None:
        register_tool(
            {
                "tool_id": "x-adapter",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": ["src/**/*.ts"],
                "output_schema": {
                    "type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"],
                },
                "fixture_set": "tools/aria-adapters/fixtures/x-adapter",
                "health_thresholds": {"max_cost_units": 10},
                "allowed_read_globs": ["src/**/*.ts"],
                "forbidden_read_globs": [],
                "claim_types": ["drift"],
                "owner": "platform",
                "runner": {
                    "type": "subprocess", "argv": argv, "cwd": ".",
                    "timeout_ms": 30_000, "stdin_json": True,
                },
                "schema_version": 1,
            },
            base_dir=self.tools,
        )

    def _case(self, argv: list[str]) -> dict:
        self._register(argv)
        run_fixture_suite("x-adapter", workspace_root=self.workspace, cycle_id="cycle-542", base_dir=self.tools)
        row = json.loads((self.tools / "fixture-runs.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        [case] = row["cases"]
        return case

    def test_a_crashed_case_keeps_the_sanitized_tail_of_its_stderr(self) -> None:
        case = self._case(CRASH_ARGV)
        self.assertEqual(case["status"], "crash")
        sample = case["stderr_sample"]
        # The cause is in the row, not only its hash.
        self.assertIn("Error: EACCES: permission denied, open 'digest.py'", sample)
        # Redacted before it is bounded or published; host paths reduced.
        self.assertNotIn(FAKE_TOKEN, sample)
        self.assertNotIn("/var/tmp/aria-room", sample)
        # Bounded from the end: the 9000-character prefix does not crowd out the error.
        self.assertLessEqual(len(sample), ADAPTER_STDERR_SAMPLE_MAX_CHARS)
        self.assertTrue(case["stderr_hash"].startswith("sha256:"))

    def test_the_nights_run_row_keeps_the_same_sample(self) -> None:
        # One sample for both rows (adapter_room.adapter_stderr_sample): the
        # night's row used to keep the first 4,096 characters, scrubbed after
        # the cut, with host paths whole — here the error would be cut off by
        # the prefix and the room path published.
        self._register(CRASH_ARGV)
        envelope = run_tool(
            "x-adapter", {}, "cycle-542", workspace_root=self.workspace, base_dir=self.tools,
        )["envelope"]
        self.assertEqual(envelope["status"], "crash")
        sample = envelope["runner"]["stderr_sample"]
        self.assertIn("Error: EACCES: permission denied, open 'digest.py'", sample)
        self.assertNotIn(FAKE_TOKEN, sample)
        self.assertNotIn("/var/tmp/aria-room", sample)
        self.assertLessEqual(len(sample), ADAPTER_STDERR_SAMPLE_MAX_CHARS)

    def test_an_ok_case_carries_no_stderr_text(self) -> None:
        case = self._case(OK_ARGV)
        self.assertEqual(case["status"], "ok", case["errors"])
        self.assertIsNone(case["stderr_sample"])


if __name__ == "__main__":
    unittest.main()
