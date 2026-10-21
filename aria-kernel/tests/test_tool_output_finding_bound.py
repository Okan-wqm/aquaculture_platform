"""ARIA-HIGH-617 — a finding the parser accepts fits every row that stores it.

``record_run`` appends the runs row, then one raw-findings row per finding
(``feedback_store.record_raw_findings_for_run``), then, for an ACTIVE tool, one
findings row and one seeding row per finding, and only then decides the run's
health. Those rows hold an adapter-written finding with no bound of their own:
a v2-shadow raw-findings row holds its id twice (``finding_id`` and
``finding_summary.id``), a v1 row also holds the finding inline. One finding
over the 1 MiB row cap made the append refuse the batch with
LedgerRowTooLargeError, so ``record_run`` left before ``evaluate_health``: the
runs row said ``scope_violation`` and the tool stayed SHADOW, and an in-scope
run failed the tools phase, and so the cycle, every night.

The parser now refuses a finding past ``TOOL_OUTPUT_FINDING_MAX_BYTES``
(``output_finding_too_large``), so the run is ``schema_error``, recorded and
quarantined like every other refusal there. These tests pin both sides: the
refused run, end to end in both ledger formats, and the largest finding the
parser accepts, stored by every ledger that holds it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _helpers.git_fixtures import make_local_git_repo  # noqa: E402
from test_enterprise_cycle import FAKE_RUNNER, register_active_for_test, shadow_tool  # noqa: E402

from aria_kernel.ledger import LEDGER_ROW_MAX_BYTES, canonical_json  # noqa: E402
from aria_kernel.tool_registry import get_tool  # noqa: E402
from aria_kernel.tool_runner import run_tool  # noqa: E402

# The verifier's probe: a 600,000-byte id. Words, not one alphanumeric run:
# the scrub is slow on a long run (registered separately), and this test is
# about the row, not the scrub.
OVERSIZED_ID = "probe " * 100_000
# The report sits inside the fixture tool's read scope (src/**/*.ts), so only
# what a test adds to it can make the run a scope violation.
REPORT = "src/report.ts"


def _small(index: int) -> dict[str, Any]:
    return {"id": f"finding-{index}", "rule": "probe", "evidence": [{"path": "src/app.ts", "line": 1}]}


def _lines(path: Path) -> list[bytes]:
    return path.read_bytes().splitlines() if path.exists() else []


class _OneRunEndToEnd:
    """One adapter run through ``run_tool``; the adapter reports the findings a test commits."""

    LEDGER_FORMAT: str

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        (self.workspace / "src").mkdir()
        (self.workspace / "src" / "app.ts").write_text("x\n", encoding="utf-8")
        self.tools = root / "tools"
        self.tools.mkdir()
        env = patch.dict(os.environ, {"ARIA_RUN_LEDGER_FORMAT": self.LEDGER_FORMAT})
        env.start()
        self.addCleanup(env.stop)

    def _run(self, findings: list[dict[str, Any]], *, status: str = "SHADOW") -> dict[str, Any]:
        (self.workspace / REPORT).write_text(json.dumps(findings), encoding="utf-8")
        subprocess.run(["git", "add", "--", "src"], cwd=self.workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "fixture"], cwd=self.workspace, check=True)
        tool = {**shadow_tool(), "status": status}
        tool["runner"]["argv"] = ["python3", FAKE_RUNNER.as_posix(), "--findings-file", REPORT]
        tool["runner"]["timeout_ms"] = 60_000
        register_active_for_test(tool, base_dir=self.tools)
        result = run_tool(
            "fixture-shadow-tool", {}, "cyc-finding", run_id="run-finding",
            workspace_root=self.workspace, base_dir=self.tools,
        )
        [line] = _lines(self.tools / "runs.jsonl")
        self.assertLessEqual(len(line) + 1, LEDGER_ROW_MAX_BYTES)
        return {"result": result, "row": json.loads(line)}

    def _assert_refused_recorded_and_quarantined(self, run: dict[str, Any]) -> None:
        row = run["row"]
        self.assertEqual(row["status"], "schema_error")
        self.assertEqual(row["runner"]["parse_error"], "output_finding_too_large")
        self.assertEqual(run["result"]["health_decision"]["action"], "quarantine")
        self.assertEqual(len(_lines(self.tools / "health.jsonl")), 1)
        self.assertEqual(get_tool("fixture-shadow-tool", self.tools)["status"], "QUARANTINED")

    def test_an_oversized_finding_beside_a_dotenv_read_is_recorded_and_quarantined(self) -> None:
        # The probe: 50 small findings, then one citing .env whose id is 600 KB.
        oversized = {"id": OVERSIZED_ID, "rule": "probe", "evidence": [{"path": ".env", "line": 1}]}
        self._assert_refused_recorded_and_quarantined(self._run([*map(_small, range(50)), oversized]))

    def test_an_oversized_finding_first_is_recorded_and_quarantined(self) -> None:
        # First, the finding is also in the runs row's raw_findings_sample.
        oversized = {"id": OVERSIZED_ID, "rule": "probe", "evidence": [{"path": ".env", "line": 1}]}
        self._assert_refused_recorded_and_quarantined(self._run([oversized, *map(_small, range(50))]))

    def test_an_oversized_finding_in_an_in_scope_run_no_longer_fails_the_run(self) -> None:
        # No forbidden read: before the bound the refused append left run_tool
        # on every run, so the tools phase failed the cycle every night.
        oversized = {"id": OVERSIZED_ID, "rule": "probe", "evidence": [{"path": "src/app.ts", "line": 1}]}
        self._assert_refused_recorded_and_quarantined(self._run([*map(_small, range(50)), oversized]))

    def test_the_largest_finding_the_parser_accepts_is_stored_by_every_ledger_that_holds_it(self) -> None:
        # An ACTIVE tool's finding goes to raw-findings, findings and seeding.
        # The id is a mapping of backslashes, the shape a row stores largest:
        # finding_id keeps it, and finding_summary keeps str() of it, which
        # escapes each backslash twice (repr, then JSON).
        from aria_kernel.calibration_bootstrap import seeding_path
        from aria_kernel.feedback_store import findings_path, raw_findings_path

        finding = largest_accepted_finding()
        run = self._run([finding], status="ACTIVE")
        self.assertIsNone(run["row"]["runner"]["parse_error"])
        for ledger in (
            raw_findings_path(self.tools), findings_path(self.tools), seeding_path(self.tools, "fixture-shadow-tool"),
        ):
            [line] = _lines(ledger)
            self.assertLessEqual(len(line) + 1, LEDGER_ROW_MAX_BYTES, ledger.name)
        self.assertEqual(len(_lines(self.tools / "health.jsonl")), 1)


def largest_accepted_finding() -> dict[str, Any]:
    """A finding exactly ``TOOL_OUTPUT_FINDING_MAX_BYTES`` long, its bytes in a backslash-filled id."""
    from aria_kernel.tool_runner import TOOL_OUTPUT_FINDING_MAX_BYTES

    finding: dict[str, Any] = {"id": {"k": ""}, "rule": "probe", "evidence": [{"path": "src/app.ts", "line": 1}]}
    # canonical_json writes one backslash as two bytes.
    spare = TOOL_OUTPUT_FINDING_MAX_BYTES - len(canonical_json(finding))
    finding["id"]["k"] = "\\" * (spare // 2) + "x" * (spare % 2)
    assert len(canonical_json(finding)) == TOOL_OUTPUT_FINDING_MAX_BYTES
    return finding


class OneRunInTheDefaultFormat(_OneRunEndToEnd, unittest.TestCase):
    LEDGER_FORMAT = "v2-shadow"


class OneRunInTheV1Format(_OneRunEndToEnd, unittest.TestCase):
    LEDGER_FORMAT = "v1"


class TheParserBoundsEachFinding(unittest.TestCase):
    """The bound is measured where the rows measure it: canonical JSON bytes."""

    def _parse(self, finding: Any) -> str | None:
        from aria_kernel.tool_runner import _parse_tool_output

        stdout = json.dumps({"observations": [], "findings": [finding], "read_paths": [], "evidence_sources": []})
        return _parse_tool_output(stdout, shadow_tool())[1]

    def test_a_finding_at_the_bound_is_accepted_and_one_byte_more_is_refused(self) -> None:
        finding = largest_accepted_finding()
        self.assertIsNone(self._parse(finding))
        finding["rule"] += "x"
        self.assertEqual(self._parse(finding), "output_finding_too_large")

    def test_a_non_mapping_entry_is_bounded_too(self) -> None:
        from aria_kernel.tool_runner import TOOL_OUTPUT_FINDING_MAX_BYTES

        self.assertEqual(self._parse("x" * TOOL_OUTPUT_FINDING_MAX_BYTES), "output_finding_too_large")

    def test_the_code_is_in_the_closed_vocabulary(self) -> None:
        from aria_kernel.tool_runner import PARSE_ERROR_CODES

        self.assertIn("output_finding_too_large", PARSE_ERROR_CODES)


if __name__ == "__main__":
    unittest.main()
