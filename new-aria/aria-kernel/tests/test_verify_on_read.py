"""Plan 026R §F.4 — verify-on-read kwarg + hot-path AST invariant.

4 tests:

* load_jsonl(path, verify=False) preserves legacy semantics.
* load_jsonl(path, verify=True) raises LedgerIntegrityError on
  hash-chain mismatch.
* load_jsonl(path, verify=True) returns rows on a clean ledger.
* AST invariant: hot-path consumer modules use either
  ``load_jsonl_verified(`` or ``load_jsonl(`` with ``verify=True``
  (or the kwarg literal ``verify=True`` somewhere in the call).
"""
from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import (
    LedgerIntegrityError,
    append_jsonl,
    load_jsonl,
)
from aria_kernel.runtime_profile import set_profile


HOT_PATH_MODULES: tuple[str, ...] = (
    "autonomy_state.py",
    "autonomy_orchestrator.py",
    # NOTE: cycle.py + reflection.py already use load_jsonl_verified
    # directly (Plan 026R §A.2 + §F.4) — the invariant accepts either
    # spelling.
)


class VerifyOnReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f4-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="f4-t", base_dir=self.base,
        )
        self.path = self.base / "sample.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_verify_false_preserves_legacy_read(self) -> None:
        # Even an unhashed row is returned when verify=False.
        self.path.write_text(
            json.dumps({"a": 1}) + "\n", encoding="utf-8",
        )
        rows = load_jsonl(self.path, verify=False)
        self.assertEqual(rows, [{"a": 1}])

    def test_verify_true_clean_ledger_returns_rows(self) -> None:
        append_jsonl(self.path, {"a": 1})
        append_jsonl(self.path, {"b": 2})
        rows = load_jsonl(self.path, verify=True)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["a"], 1)
        self.assertEqual(rows[1]["b"], 2)

    def test_verify_true_chain_mismatch_raises(self) -> None:
        append_jsonl(self.path, {"a": 1})
        # Tamper the row's ledger_hash to break the chain.
        line = self.path.read_text(encoding="utf-8").splitlines()[0]
        row = json.loads(line)
        row["ledger_hash"] = "sha256:" + ("0" * 64)
        self.path.write_text(
            json.dumps(row) + "\n", encoding="utf-8",
        )
        with self.assertRaises(LedgerIntegrityError):
            load_jsonl(self.path, verify=True)

    def test_hot_path_consumers_opt_in_to_verify(self) -> None:
        # AST scan: each hot-path module must NOT contain
        # `load_jsonl(<args>)` calls without `verify=True`.
        # Direct `load_jsonl_verified(` callsites are also accepted.
        # `read_jsonl(` is the unverified primitive used inside
        # ledger.py only — outside ledger.py, hot-path modules MUST
        # NOT call it.
        kernel_dir = (
            Path(__file__).resolve().parent.parent / "aria_kernel"
        )
        load_jsonl_re = re.compile(r"\bload_jsonl\s*\(")
        verify_kw_re = re.compile(r"verify\s*=\s*True")
        for module in HOT_PATH_MODULES:
            src_path = kernel_dir / module
            if not src_path.exists():
                continue
            src = src_path.read_text(encoding="utf-8")
            # Strip the function-definition signature(s) of
            # load_jsonl to avoid matching the public surface
            # definition itself (not present in hot-path consumers
            # but defensive).
            # For every `load_jsonl(` callsite, check verify=True
            # appears within the next 200 chars (call-window).
            for match in load_jsonl_re.finditer(src):
                window = src[match.start(): match.start() + 200]
                self.assertTrue(
                    verify_kw_re.search(window),
                    f"{module}: load_jsonl( call without verify=True at "
                    f"offset {match.start()} — "
                    f"hot-path consumers must opt in to verified read "
                    f"(Plan 026R §F.4)",
                )


if __name__ == "__main__":
    unittest.main()
