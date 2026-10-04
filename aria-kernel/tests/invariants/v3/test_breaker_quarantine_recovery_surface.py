"""ORPHAN-CRITICAL-506 — the breaker-evidence repair is reachable where the ledger lives.

WHAT THE SIBLING FILE PINS. ``test_breaker_evidence_quarantine.py`` proves the
repair FUNCTION: undecodable rows move to a sidecar, decodable rows stay byte
for byte, and a breaker tripped for a real reason stays tripped.

WHAT IT DOES NOT PIN, and what the finding was half about. The ledger is not on
an operator's disk. It travels between runs inside ARIA's durable state, and at
the time of the finding the only lever an operator could reach was deleting that
state, which also destroyed the agent-invocation queue ORPHAN-CRITICAL-469
exists to carry. ``quarantine_breaker_evidence`` closed that only because two
callers reach it: the ``aria-kernel breaker quarantine`` command, and the
``aria-agent-executor`` recovery dispatch that runs the command against the
restored store, inside the same transaction that republishes it.

Nothing asserted either caller. The workflow contract pins the recovery step's
NAME and its position between the restore and the publish, so a step that kept
its name and ran ``breaker reset`` (the destructive verb) or nothing at all would
still satisfy it. A correct function behind a command surface nobody can reach
is ORPHAN-HIGH-465, the defect this class keeps producing. This file pins both
callers: the command does the repair and reports a still-tripped breaker as
unfinished, and the dispatch runs that command on the restored tree.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import yaml

_KERNEL_ROOT = Path(__file__).resolve().parents[3]
_REPO_ROOT = _KERNEL_ROOT.parent
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel import cli  # noqa: E402
from aria_kernel.circuit_breaker import (  # noqa: E402
    BREAKER_REASON_THRESHOLD_EXCEEDED,
    BREAKER_STATE_OK,
    BREAKER_STATE_TRIPPED,
    _failures_path,
    _quarantine_path,
    evaluate_breaker,
)
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402
from aria_kernel.workflow_contract_registry import (  # noqa: E402
    WORKFLOW_CONTRACTS,
    _EXECUTOR_BREAKER_QUARANTINE_STEP,
)

_TRUNCATED = '{"ts":"2020-01'
_REASON = "artifact round-trip truncated the last row"


def _row(event_id: str) -> str:
    stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return json.dumps(
        {"ts": stamp, "kind": "validator_rejection", "materialize_event_id": event_id},
        sort_keys=True,
    )


def _executable(script: str) -> str:
    """The shell lines that run, comments dropped, continuations joined.

    A comment that mentions ``breaker reset`` (the recovery step's own comment
    explains why it is not a reset) must neither satisfy nor fail an assertion
    about what the step executes.
    """
    lines = [line for line in script.splitlines() if not line.strip().startswith("#")]
    return " ".join(" ".join(lines).replace("\\", " ").split())


class TheCommandIsTheRepair(unittest.TestCase):
    """``aria-kernel breaker quarantine`` is the operator surface of the repair."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-506-")
        self.root = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        self.ledger = _failures_path(self.root)
        self.ledger.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, *lines: str) -> None:
        self.ledger.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")

    def _run(self, *extra: str) -> tuple[int, str]:
        argv = [
            "breaker", "quarantine",
            "--tools-dir", str(self.root),
            "--reason", _REASON,
            "--operator-approval-ref", "OPS-4711",
            *extra,
        ]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(argv)
        return code, out.getvalue()

    def test_the_command_quarantines_the_damage_and_keeps_the_evidence(self) -> None:
        good = _row("EV-1")
        self._write(good, _TRUNCATED)

        code, output = self._run("--acknowledge")

        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output)["quarantined"], 1)
        self.assertEqual(self.ledger.read_text(encoding="utf-8").splitlines(), [good])
        sidecar = _quarantine_path(self.root).read_text(encoding="utf-8").splitlines()
        self.assertEqual([json.loads(line).get("raw") for line in sidecar[1:]], [_TRUNCATED])
        after = evaluate_breaker(self.root)
        self.assertEqual(after.evidence.dropped_rows, 0)
        self.assertEqual(after.state, BREAKER_STATE_OK)

    def test_without_acknowledge_it_refuses_and_moves_nothing(self) -> None:
        self._write(_row("EV-1"), _TRUNCATED)
        before = self.ledger.read_bytes()

        code, _output = self._run()

        self.assertEqual(code, 2)
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(_quarantine_path(self.root).exists())

    def test_a_breaker_still_tripped_after_the_repair_does_not_exit_zero(self) -> None:
        """The recovery dispatch reads the exit code; ok must mean recovered."""
        self._write(_row("EV-1"), _row("EV-2"), _row("EV-3"), _TRUNCATED)

        code, output = self._run("--acknowledge")

        self.assertEqual(code, 1, output)
        self.assertEqual(json.loads(output)["breaker_state_after"], BREAKER_STATE_TRIPPED)
        self.assertEqual(evaluate_breaker(self.root).reason, BREAKER_REASON_THRESHOLD_EXCEEDED)


class TheDispatchRunsTheCommandOnTheRestoredStore(unittest.TestCase):
    """The executor's recovery step is the only route to the deployed ledger."""

    @classmethod
    def setUpClass(cls) -> None:
        contract = WORKFLOW_CONTRACTS["aria-agent-executor"]
        workflow = yaml.safe_load(
            (_REPO_ROOT / contract.workflow_file).read_text(encoding="utf-8")
        )
        cls.workflow = workflow
        job = workflow["jobs"][contract.job_contracts[0].job_id]
        matches = [
            step for step in job["steps"]
            if isinstance(step, dict) and step.get("name") == _EXECUTOR_BREAKER_QUARANTINE_STEP
        ]
        cls.matches = matches

    def test_the_dispatch_declares_the_operator_inputs(self) -> None:
        # PyYAML reads the bare key `on` as the boolean True.
        triggers = self.workflow.get("on", self.workflow.get(True))
        inputs = triggers["workflow_dispatch"]["inputs"]
        self.assertIn("breaker_quarantine_reason", inputs)
        self.assertIn("operator_approval_ref", inputs)

    def test_the_recovery_step_runs_only_on_a_recovery_dispatch(self) -> None:
        self.assertEqual(len(self.matches), 1)
        condition = " ".join(str(self.matches[0].get("if", "")).split())
        self.assertIn("inputs.breaker_quarantine_reason != ''", condition)

    def test_the_recovery_step_runs_the_quarantine_on_the_restored_store(self) -> None:
        self.assertEqual(len(self.matches), 1)
        script = _executable(str(self.matches[0].get("run", "")))
        # The restore exports the store binding as ARIA_TOOLS_DIR; a literal
        # tools dir would repair a tree the publish never reads.
        self.assertIn(
            '-m aria_kernel breaker quarantine --tools-dir "$ARIA_TOOLS_DIR" --acknowledge',
            script,
        )
        self.assertIn('--operator-approval-ref "$QUARANTINE_APPROVAL_REF"', script)
        # The verb that discards the evidence must not be the one this step runs.
        self.assertNotIn("breaker reset", script)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
