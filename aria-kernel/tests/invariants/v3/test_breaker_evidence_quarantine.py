"""RC-6 — damaged breaker evidence must be exitable WITHOUT becoming permissive.

THE DEFECT. `evaluate_breaker` decides `evidence_incomplete` before the
threshold comparison, and that ordering is correct: unreadable evidence must not
read as permissive (ORPHAN-CRITICAL-418). But `dropped_rows` counts lines that
failed to DECODE, while the sliding window only ages the lines that decoded. A
corrupt line therefore never ages out. One truncated row trips the breaker for
every subsequent nightly `standard` cycle, permanently — and the ledger travels
between runs inside the `aria-tools-state` artifact, so the only lever was
deleting that artifact, which also destroys the agent queue
ORPHAN-CRITICAL-469 exists to carry.

An unexitable safety state is an outage, not a safety property. But exiting it
must not mean discarding evidence, which is why the operation under test is a
QUARANTINE and not a reset. The two are different verbs with different
guarantees, and the test that matters most here is the second one: quarantine
must not clear a breaker that is tripped for a real reason.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

_KERNEL_ROOT = Path(__file__).resolve().parents[3]
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.circuit_breaker import (  # noqa: E402
    BREAKER_REASON_EVIDENCE_INCOMPLETE,
    BreakerEvidence,
    BREAKER_REASON_THRESHOLD_EXCEEDED,
    BREAKER_STATE_OK,
    BREAKER_STATE_TRIPPED,
    _failures_path,
    _quarantine_path,
    evaluate_breaker,
    quarantine_breaker_evidence,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir  # noqa: E402

_TRUNCATED = '{"ts":"2020-01'


def _recent(offset_hours: int = 0) -> str:
    moment = datetime.now(timezone.utc) - timedelta(hours=offset_hours)
    return moment.isoformat().replace("+00:00", "Z")


def _row(**overrides: object) -> str:
    payload: dict[str, object] = {
        "ts": _recent(),
        "kind": "validator_rejection",
        "materialize_event_id": "EV-1",
    }
    payload.update(overrides)
    return json.dumps(payload, sort_keys=True)


class BreakerEvidenceQuarantine(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-rc6-")
        self.root = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        self.ledger = _failures_path(self.root)
        self.ledger.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, *lines: str) -> None:
        self.ledger.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")

    def _quarantine(self) -> dict:
        return quarantine_breaker_evidence(
            base_dir=self.root,
            operator_approval_ref="OPS-4711",
            reason="artifact round-trip truncated the last row",
        )

    def test_damage_blocks_forever_until_quarantined(self) -> None:
        """The state this operation exists to make exitable."""
        self._write(_row(), _TRUNCATED)

        before = evaluate_breaker(self.root)
        self.assertEqual(before.state, BREAKER_STATE_TRIPPED)
        self.assertEqual(before.reason, BREAKER_REASON_EVIDENCE_INCOMPLETE)
        self.assertEqual(before.evidence.dropped_rows, 1)

        # Ageing cannot clear it: the window only filters rows that DECODED, so
        # a corrupt line is outside time entirely. Asserted rather than argued,
        # because "it will age out" is the assumption that made this a
        # permanent outage rather than a transient one.
        self._write(_row(ts=_recent(offset_hours=24 * 365)), _TRUNCATED)
        aged = evaluate_breaker(self.root)
        self.assertEqual(aged.reason, BREAKER_REASON_EVIDENCE_INCOMPLETE)

        result = self._quarantine()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["quarantined"], 1)

        after = evaluate_breaker(self.root)
        self.assertEqual(after.evidence.dropped_rows, 0)
        self.assertEqual(after.state, BREAKER_STATE_OK)

    def test_quarantine_does_not_clear_a_genuinely_tripped_breaker(self) -> None:
        """THE ASSERTION THAT MATTERS. Exitable must not mean permissive.

        Three real failures inside the window plus one corrupt line. Quarantine
        removes the corruption and the breaker must STILL be tripped — now for
        the honest reason, which is what the operator needed to see all along.
        A reset would have cleared both; that is why this is a different verb.
        """
        self._write(_row(), _row(), _row(), _TRUNCATED)

        before = evaluate_breaker(self.root)
        self.assertEqual(before.reason, BREAKER_REASON_EVIDENCE_INCOMPLETE)

        result = self._quarantine()
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(result["surviving"], 3)

        after = evaluate_breaker(self.root)
        self.assertEqual(after.state, BREAKER_STATE_TRIPPED)
        self.assertEqual(after.reason, BREAKER_REASON_THRESHOLD_EXCEEDED)
        self.assertGreaterEqual(after.sliding_count, after.threshold)
        # The caller is told immediately, so nobody reads "quarantine ok" as
        # "breaker cleared".
        self.assertEqual(result["breaker_state_after"], BREAKER_STATE_TRIPPED)

    def test_the_damaged_rows_are_preserved_verbatim(self) -> None:
        """A repaired copy would destroy the only record of what happened."""
        self._write(_row(), _TRUNCATED)
        self._quarantine()

        lines = _quarantine_path(self.root).read_text(encoding="utf-8").splitlines()
        # Compared through the `raw` field rather than by substring: the sidecar
        # is JSONL, so a verbatim payload is stored JSON-ESCAPED. A substring
        # assertion against the file text fails on correctly-preserved evidence,
        # which is what the first version of this test did.
        preserved = [json.loads(line).get("raw") for line in lines[1:]]
        self.assertEqual(preserved, [_TRUNCATED])
        header = json.loads(lines[0])
        self.assertEqual(header["operator_approval_ref"], "OPS-4711")
        self.assertEqual(header["damaged_row_count"], 1)
        self.assertEqual(header["surviving_row_count"], 1)

    def test_surviving_rows_are_kept_byte_for_byte(self) -> None:
        """Quarantine must not rewrite the evidence it keeps.

        Re-serialising a kept row would change bytes the operator may be
        comparing against an artifact copy, and a "repair" that edits good rows
        is indistinguishable from tampering.
        """
        good_one, good_two = _row(materialize_event_id="EV-A"), _row(materialize_event_id="EV-B")
        self._write(good_one, _TRUNCATED, good_two)
        self._quarantine()

        kept = self.ledger.read_text(encoding="utf-8").splitlines()
        self.assertEqual(kept, [good_one, good_two])

    def test_an_operator_contract_is_required(self) -> None:
        """Same fail-closed contract as reset: no silent repair."""
        self._write(_row(), _TRUNCATED)
        for kwargs in (
            {"operator_approval_ref": "", "reason": "x"},
            {"operator_approval_ref": "OPS-1", "reason": "   "},
        ):
            with self.subTest(**kwargs):
                with self.assertRaises(GovernanceError):
                    quarantine_breaker_evidence(base_dir=self.root, **kwargs)
        # And nothing was moved by the refused attempts.
        self.assertFalse(_quarantine_path(self.root).exists())

    def test_it_does_not_pretend_to_repair_an_intact_ledger(self) -> None:
        """A no-op says so, rather than writing an empty quarantine record.

        An operation that always reports success teaches operators that its
        output carries no information.
        """
        self._write(_row(), _row())
        result = self._quarantine()
        self.assertEqual(result["status"], "no_op")
        self.assertEqual(result["quarantined"], 0)
        self.assertFalse(_quarantine_path(self.root).exists())

    def test_a_missing_ledger_is_a_no_op_not_a_crash(self) -> None:
        result = self._quarantine()
        self.assertEqual(result["status"], "no_op")
        self.assertEqual(result["reason"], "no_failure_ledger")

    def test_an_unreadable_ledger_is_refused_rather_than_overwritten(self) -> None:
        """Row damage and a file-access fault are different problems.

        Rewriting a file we could not read would be writing over evidence we
        never saw. The refusal names the read error so the operator fixes the
        actual fault.
        """
        self.ledger.write_text(_row() + "\n", encoding="utf-8")
        original = self.ledger.read_text(encoding="utf-8")

        # Injected at the reader rather than simulated with chmod. The property
        # under test is "when the evidence reads back unreadable, refuse" — and
        # a chmod-based version silently SKIPS under root, which is how this
        # suite runs in CI, so it would have asserted nothing where it matters.
        fault = BreakerEvidence(
            rows=(), rows_present=1, unreadable=True, read_error="simulated io fault",
        )
        with patch("aria_kernel.circuit_breaker._read_failures_evidence", return_value=fault):
            with self.assertRaises(GovernanceError) as caught:
                self._quarantine()

        message = str(caught.exception)
        self.assertIn("ledger_unreadable", message)
        self.assertIn("simulated io fault", message)
        # The refusal must not have touched the file it could not read.
        self.assertEqual(self.ledger.read_text(encoding="utf-8"), original)
        self.assertFalse(_quarantine_path(self.root).exists())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
