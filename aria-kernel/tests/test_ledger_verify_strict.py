"""Plan 026R §A.2 — strict verify_jsonl + load_jsonl_verified.

3 invariants:

* hashless row → ``valid=False`` + ``reason="ledger_hash_missing"``
* canonical-hash drift (row mutated post-write) → mismatch
* previous-hash chain mismatch → ``previous_hash_mismatch``
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import (
    LedgerIntegrityError,
    append_declared_jsonl,
    append_jsonl,
    load_jsonl_verified,
    verify_jsonl,
)
from aria_kernel.state_manifest import surface_for_path
from aria_kernel.tool_registry import ensure_tools_dir


class VerifyJsonlStrictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-strict-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_ledger_hash_marks_invalid(self) -> None:
        # Hand-write a hashless row that pre-§A.2 strict mode would
        # have silently accepted via the `if expected:` guard.
        path = self.tmp / "claims.jsonl"
        path.write_text(
            json.dumps({"event": "x"}) + "\n",
            encoding="utf-8",
        )
        result = verify_jsonl(path)
        self.assertFalse(result["valid"])
        self.assertEqual(result["reason"], "ledger_hash_missing")
        self.assertEqual(result["line"], 1)
        # load_jsonl_verified converts invalid into a raise.
        with self.assertRaises(LedgerIntegrityError):
            load_jsonl_verified(path)

    def test_canonical_drift_marks_invalid(self) -> None:
        path = self.tmp / "claims.jsonl"
        append_jsonl(path, {"event": "first"})
        # Re-write the first row with the same hash but mutated payload —
        # canonical hash recomputation now diverges from the stored value.
        rows = path.read_text(encoding="utf-8").splitlines()
        row = json.loads(rows[0])
        original_hash = row["ledger_hash"]
        row["event"] = "TAMPERED"
        row["ledger_hash"] = original_hash  # preserve the stale hash
        path.write_text(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n",
                        encoding="utf-8")
        result = verify_jsonl(path)
        self.assertFalse(result["valid"])
        self.assertEqual(result["reason"], "ledger_hash_mismatch")

    def test_previous_hash_chain_mismatch_marks_invalid(self) -> None:
        path = self.tmp / "claims.jsonl"
        append_jsonl(path, {"event": "first"})
        append_jsonl(path, {"event": "second"})
        lines = path.read_text(encoding="utf-8").splitlines()
        row0_hash = json.loads(lines[0])["ledger_hash"]
        row2 = json.loads(lines[1])
        # Architecture: `_record_hash` computes from the canonical
        # ``record`` body + the previous_hash arg PASSED IN, NOT from
        # the row's ``previous_ledger_hash`` field (that field is popped
        # before hashing). So we tamper ONLY the ``previous_ledger_hash``
        # field, recompute ``ledger_hash`` with the CORRECT prior hash
        # so the canonical-hash check passes, and verify_jsonl trips the
        # later previous_hash chain assertion.
        row2["previous_ledger_hash"] = "sha256:deadbeef"
        from aria_kernel.ledger import _record_hash  # type: ignore[attr-defined]
        row2["ledger_hash"] = _record_hash(row2, row0_hash)
        path.write_text(
            lines[0]
            + "\n"
            + json.dumps(row2, sort_keys=True, separators=(",", ":"))
            + "\n",
            encoding="utf-8",
        )
        result = verify_jsonl(path)
        self.assertFalse(result["valid"])
        self.assertEqual(result["reason"], "previous_hash_mismatch")

    def test_rogue_registry_path_is_not_manifest_declared(self) -> None:
        rogue = self.tmp / "rogue" / "registry.json"
        rogue.parent.mkdir(parents=True)
        rogue.write_text('{"schema_version":1,"tools":[]}\n', encoding="utf-8")
        self.assertIsNone(surface_for_path(rogue))

    def test_declared_strict_ledger_refuses_append_after_tamper(self) -> None:
        tools = self.tmp / "aria-tools"
        ensure_tools_dir(tools)
        path = tools / "governance.jsonl"
        append_declared_jsonl(path, {"event": "first"}, expected_surface="tools_governance")
        row = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
        row["event"] = "tampered"
        path.write_text(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(LedgerIntegrityError, "refuses_append_to_corrupt_chain"):
            append_declared_jsonl(path, {"event": "second"}, expected_surface="tools_governance")


class AppendStripsStaleChainFieldsTests(unittest.TestCase):
    """Plan 026R §A.2 — `_append_jsonl_unlocked` strips caller-provided
    stale chain hash fields.

    Pattern: hot-path code (memory.py:322 et al) re-appends a row by
    starting from ``dict(loaded_belief_row)``. That dict already carries
    the chain hashes from when the original row was written; the §A.1
    primitive must overwrite both ``previous_ledger_hash`` and
    ``ledger_hash`` so the new row's chain link is the actual on-disk
    tail, NOT the stale snapshot from when the row was first written.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-stale-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_re_append_loaded_row_dict_yields_strict_clean_chain(self) -> None:
        # Simulate the memory.py:322 pattern: row = dict(belief_from_disk).
        target = self.tmp / "beliefs.jsonl"
        append_jsonl(target, {"belief_id": "b0"})
        append_jsonl(target, {"belief_id": "b1"})
        rows = json.loads("[" + ",".join(
            target.read_text(encoding="utf-8").splitlines()
        ) + "]")
        # The caller carries the loaded belief AS-IS (stale chain hashes
        # embedded) into a new append.
        re_appended = dict(rows[0])  # contains old previous_ledger_hash + ledger_hash
        re_appended["updated_at"] = "2026-05-04T00:00:00+00:00"
        append_jsonl(target, re_appended)
        # Strict verify MUST pass — the primitive stripped the stale chain
        # fields and resealed against the actual tail.
        result = verify_jsonl(target)
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["row_count"], 3)


class LoadJsonlVerifiedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-load-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_load_jsonl_verified_returns_rows_when_strict_clean(self) -> None:
        path = self.tmp / "claims.jsonl"
        append_jsonl(path, {"event": "a"})
        append_jsonl(path, {"event": "b"})
        rows = load_jsonl_verified(path)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["event"], "a")
        self.assertEqual(rows[1]["event"], "b")
        # Missing file → empty list (matches load_jsonl semantics).
        self.assertEqual(load_jsonl_verified(self.tmp / "nope.jsonl"), [])


if __name__ == "__main__":
    unittest.main()
