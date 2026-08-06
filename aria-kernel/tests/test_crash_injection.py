"""Wave 2 completion evidence — a mission resumes across a crash.

PLAN Wave 2 completes on this sentence: *"crash-injection testlerinin
tamamında mission kaldığı yerden devam eder."* The obvious way to build the
suite is to race a `SIGKILL` against a transition. The better way is to ask
what residue a crash actually LEAVES and produce it deterministically — a
raced kill tests the scheduler, a produced residue tests the contract.

A crash mid-append leaves an incomplete trailing record. The appender writes
``json + "\\n"`` in ONE ``os.write``, so a record that reached disk is always
newline terminated and a torn one never is: that is the discriminator, and it
comes from the writer's physics rather than from a guess about where damage
looks like it is.

The suite therefore pins both directions. A torn tail must heal — the mission
is readable and advanceable, and the row that was never acknowledged is gone.
Tampering must not: a damaged line mid-file, a forged hash on a complete row,
and a complete-but-unparseable final line all stay exactly as fatal as they
were before ORPHAN-CRITICAL-561 was fixed.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from aria_kernel.ledger import LedgerIntegrityError, heal_torn_tail, torn_tail_length, verify_jsonl
from aria_kernel.mission import (
    events_path,
    fold_mission,
    list_open_missions,
    open_mission,
    transition_mission,
)
from aria_kernel.tool_registry import ensure_tools_dir

REPO_HASH = "repohash0001"
# A record cut off mid-key: exactly what an interrupted `os.write` leaves.
TORN_RECORD = '{"event":"transition","mission_id":"m-abc","to_st'


class CrashResidueTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.tools = Path(self._tmpdir.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.mission_id = open_mission(
            source_kind="finding",
            source_id="F-1",
            repo_hash=REPO_HASH,
            title="crash residue",
            base_dir=self.tools,
        )["mission_id"]
        self._advance("CONTRACTING", "s1")
        self.events = events_path(self.tools)

    def _advance(self, to_state: str, step_id: str) -> None:
        transition_mission(
            mission_id=self.mission_id,
            to_state=to_state,
            reason_code="test",
            step_id=step_id,
            next_action="continue",
            base_dir=self.tools,
        )

    # --- the torn tail heals ------------------------------------------

    def test_a_mission_resumes_across_a_torn_write(self) -> None:
        # THE WAVE 2 CRITERION. Before the fix this raised on both the read
        # and the write, so no mission continued — the criterion inverted.
        before = fold_mission(mission_id=self.mission_id, base_dir=self.tools)
        self.events.write_text(self.events.read_text() + TORN_RECORD, encoding="utf-8")

        after = fold_mission(mission_id=self.mission_id, base_dir=self.tools)
        self.assertEqual(after["state"], before["state"])

        self._advance("PLANNING", "s2")
        self.assertEqual(
            fold_mission(mission_id=self.mission_id, base_dir=self.tools)["state"], "PLANNING"
        )

    def test_the_torn_row_is_gone_rather_than_carried(self) -> None:
        self.events.write_text(self.events.read_text() + TORN_RECORD, encoding="utf-8")
        self._advance("PLANNING", "s2")
        text = self.events.read_text(encoding="utf-8")
        # The incomplete record was never acknowledged to any caller, so it
        # leaves no trace; the file ends cleanly and the chain is intact.
        self.assertNotIn(TORN_RECORD, text)
        self.assertTrue(text.endswith("\n"))
        self.assertTrue(verify_jsonl(self.events)["valid"])

    def test_the_healed_crash_is_reported_not_silent(self) -> None:
        self.events.write_text(self.events.read_text() + TORN_RECORD, encoding="utf-8")
        verdict = verify_jsonl(self.events)
        self.assertTrue(verdict["valid"])
        self.assertEqual(verdict["torn_tail_bytes"], len(TORN_RECORD))

    def test_other_missions_in_the_same_ledger_survive(self) -> None:
        # The blast radius was the SURFACE, not the mission: one torn write
        # took every mission recorded in the file with it.
        second = open_mission(
            source_kind="pressure",
            source_id="p-2",
            repo_hash=REPO_HASH,
            title="bystander",
            base_dir=self.tools,
        )["mission_id"]
        self.events.write_text(self.events.read_text() + TORN_RECORD, encoding="utf-8")
        ids = {row["mission_id"] for row in list_open_missions(base_dir=self.tools)}
        self.assertEqual(ids, {self.mission_id, second})

    def test_a_ledger_that_is_only_a_torn_record_reads_as_empty(self) -> None:
        scratch = Path(self._tmpdir.name) / "aria-tools-2"
        ensure_tools_dir(scratch)
        path = events_path(scratch)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(TORN_RECORD, encoding="utf-8")
        verdict = verify_jsonl(path)
        self.assertTrue(verdict["valid"])
        self.assertEqual(verdict["row_count"], 0)

    # --- tampering stays fatal ----------------------------------------

    def test_a_damaged_line_mid_file_stays_fatal(self) -> None:
        lines = self.events.read_text(encoding="utf-8").splitlines()
        lines[0] = lines[0][:40] + "GARBAGE" + lines[0][47:]
        self.events.write_text("\n".join(lines) + "\n", encoding="utf-8")

        self.assertFalse(verify_jsonl(self.events)["valid"])
        with self.assertRaises(LedgerIntegrityError):
            fold_mission(mission_id=self.mission_id, base_dir=self.tools)
        with self.assertRaises(LedgerIntegrityError):
            self._advance("PLANNING", "s2")

    def test_a_forged_hash_on_a_complete_row_stays_fatal(self) -> None:
        rows = [json.loads(line) for line in self.events.read_text().splitlines()]
        rows[-1]["ledger_hash"] = "sha256:" + "0" * 64
        self.events.write_text(
            "\n".join(json.dumps(r, sort_keys=True, separators=(",", ":")) for r in rows) + "\n",
            encoding="utf-8",
        )
        self.assertFalse(verify_jsonl(self.events)["valid"])
        with self.assertRaises(LedgerIntegrityError):
            self._advance("PLANNING", "s2")

    def test_a_complete_but_unparseable_final_line_stays_fatal(self) -> None:
        # THE DISCRIMINATOR. This line is unparseable AND last — the shape a
        # looser "ignore the last line" rule would have swallowed. It ends
        # with a newline, so the writer finished it, so it was NOT a torn
        # write and something else put it there.
        text = self.events.read_text() + "not-json\n"
        self.events.write_text(text, encoding="utf-8")
        # Pinned at the DISCRIMINATOR, not only at the downstream symptom.
        # `valid == False` alone was too weak: a mutation that dropped the
        # newline requirement still failed verification, by mangling the file
        # a different way, so the test passed for a reason it did not mean.
        self.assertEqual(torn_tail_length(text), 0)
        self.assertFalse(verify_jsonl(self.events)["valid"])
        with self.assertRaises(LedgerIntegrityError):
            self._advance("PLANNING", "s2")

    def test_a_complete_json_object_missing_only_its_newline_is_not_torn(self) -> None:
        # The writer emits the newline in the same call as the record, so a
        # complete object without one was not written by it. Trimming it would
        # be discarding a record someone may have been told about.
        rows = self.events.read_text(encoding="utf-8")
        self.assertEqual(torn_tail_length(rows.rstrip("\n")), 0)

    def test_healing_is_a_no_op_on_a_clean_ledger(self) -> None:
        before = self.events.read_bytes()
        self.assertEqual(heal_torn_tail(self.events), 0)
        self.assertEqual(self.events.read_bytes(), before)


class CrashSubprocessTests(unittest.TestCase):
    """A real kill, not a simulated residue — the same claim end to end."""

    def test_a_mission_survives_a_killed_process_mid_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            mission_id = open_mission(
                source_kind="finding",
                source_id="F-kill",
                repo_hash=REPO_HASH,
                title="killed",
                base_dir=tools,
            )["mission_id"]

            # The child transitions the mission and then kills ITSELF with
            # SIGKILL — no unwinding, no flush, exactly what a runner timeout
            # or an OOM does to the nightly.
            script = textwrap.dedent(
                f"""
                import os, signal, sys
                sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})
                from aria_kernel.mission import transition_mission
                transition_mission(
                    mission_id={mission_id!r},
                    to_state="CONTRACTING",
                    reason_code="test",
                    step_id="s1",
                    next_action="continue",
                    base_dir={str(tools)!r},
                )
                os.kill(os.getpid(), signal.SIGKILL)
                """
            )
            result = subprocess.run([sys.executable, "-c", script], capture_output=True)
            self.assertEqual(result.returncode, -9, result.stderr.decode()[:500])

            # The transition that COMPLETED before the kill is durable, and
            # the ledger is usable by the next process.
            self.assertEqual(
                fold_mission(mission_id=mission_id, base_dir=tools)["state"], "CONTRACTING"
            )
            transition_mission(
                mission_id=mission_id,
                to_state="PLANNING",
                reason_code="test",
                step_id="s2",
                next_action="continue",
                base_dir=tools,
            )
            self.assertEqual(
                fold_mission(mission_id=mission_id, base_dir=tools)["state"], "PLANNING"
            )


if __name__ == "__main__":
    unittest.main()
