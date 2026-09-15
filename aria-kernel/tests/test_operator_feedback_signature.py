"""V9.5 hard-fail check 12 — operator-feedback rows are signed by the kernel.

Pre-fix, ``plan_synthesizer._verify_operator_feedback_signature`` accepted
any row whose ``signature`` / ``signature_kid`` were non-empty strings, so
``"signature": "x"`` spoke with operator authority. These pins cover the
signing round trip, the key custody (0600, rolling list, rotation keeps
history verifiable), the kernel-owned recorders, and the static rule that
no kernel module appends to the surface any way but through the signer.
"""
from __future__ import annotations

import ast
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from aria_kernel import operator_feedback_signature as ofs
from aria_kernel.hmac_keyring import MAX_ROLLING_KEYS
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_KERNEL_DIR = Path(__file__).resolve().parents[1] / "aria_kernel"


class SigningRoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ofs-")
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def test_signed_row_verifies_and_names_its_key(self) -> None:
        row = {"id": "OP-1", "status": "unaddressed", "request": "r", "priority": "high",
               "authored_at": "2026-09-12T00:00:00+00:00"}
        signed = ofs.sign_operator_feedback_row(row, base_dir=self.tools)
        verdict = ofs.verify_operator_feedback_row(signed, base_dir=self.tools)
        self.assertTrue(verdict.valid, verdict.reason)
        self.assertEqual(verdict.signer_kid, signed["signer_kid"])
        self.assertEqual(signed["schema_version"], 1)
        self.assertRegex(signed["signature"], r"^[0-9a-f]{64}$")
        # Chain fields stamped by the ledger AFTER signing do not enter the subject.
        stored = dict(signed, ledger_hash="sha256:" + "0" * 64, previous_ledger_hash=None)
        self.assertTrue(ofs.verify_operator_feedback_row(stored, base_dir=self.tools).valid)

    def test_key_file_is_0600_under_secrets(self) -> None:
        ofs.sign_operator_feedback_row({"id": "OP-1"}, base_dir=self.tools)
        key_path = ofs.signing_key_path(self.tools)
        self.assertEqual(key_path.parent.name, "secrets")
        self.assertEqual(stat.S_IMODE(os.stat(key_path).st_mode), 0o600)
        payload = json.loads(key_path.read_text(encoding="utf-8"))
        self.assertEqual(len(payload["keys"]), 1)

    def test_every_tamper_class_is_named(self) -> None:
        signed = ofs.sign_operator_feedback_row(
            {"id": "OP-1", "request": "keep"}, base_dir=self.tools,
        )
        cases = {
            ofs.SIGNATURE_MISSING: {k: v for k, v in signed.items() if k != "signature"},
            ofs.SIGNER_KID_MISSING: {k: v for k, v in signed.items() if k != "signer_kid"},
            ofs.SIGNATURE_MALFORMED: dict(signed, signature="sig-stub-for-test"),
            ofs.SIGNER_KID_UNKNOWN: dict(signed, signer_kid="operator-key-01"),
            ofs.SIGNATURE_INVALID: dict(signed, request="changed after signing"),
        }
        for expected_reason, row in cases.items():
            with self.subTest(reason=expected_reason):
                verdict = ofs.verify_operator_feedback_row(row, base_dir=self.tools)
                self.assertFalse(verdict.valid)
                self.assertEqual(verdict.reason, expected_reason)
        # A signature minted under another store's key never verifies here.
        other = ensure_tools_dir(Path(self.tmp.name) / "other-tools")
        foreign = ofs.sign_operator_feedback_row({"id": "OP-1", "request": "keep"}, base_dir=other)
        self.assertEqual(
            ofs.verify_operator_feedback_row(foreign, base_dir=self.tools).reason,
            ofs.SIGNER_KID_UNKNOWN,
        )

    def test_rotation_keeps_history_verifiable_and_moves_new_rows(self) -> None:
        before = ofs.sign_operator_feedback_row({"id": "OP-old"}, base_dir=self.tools)
        rotated = ofs.rotate_signing_key(base_dir=self.tools, reason="scheduled rotation test")
        after = ofs.sign_operator_feedback_row({"id": "OP-new"}, base_dir=self.tools)
        self.assertEqual(rotated["old_key_id"], before["signer_kid"])
        self.assertEqual(rotated["new_key_id"], after["signer_kid"])
        self.assertTrue(ofs.verify_operator_feedback_row(before, base_dir=self.tools).valid)
        self.assertTrue(ofs.verify_operator_feedback_row(after, base_dir=self.tools).valid)
        for _ in range(MAX_ROLLING_KEYS):
            ofs.rotate_signing_key(base_dir=self.tools, reason="window rolls the first key off")
        self.assertEqual(
            ofs.verify_operator_feedback_row(before, base_dir=self.tools).reason,
            ofs.SIGNER_KID_UNKNOWN,
        )
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        kinds = [row["kind"] for row in governance]
        self.assertEqual(kinds.count("operator_feedback_signing_key_rotated"), MAX_ROLLING_KEYS + 1)


class KernelRecordersTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ofs-rec-")
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def _ledger_rows(self) -> list[dict]:
        return load_declared_jsonl(
            self.tools / "operator-feedback.jsonl", expected_surface="operator_feedback",
        )

    def test_record_operator_request_writes_a_signed_unaddressed_row(self) -> None:
        stored = ofs.record_operator_request(
            request="Tighten the harvest weight validator", priority="high",
            authored_by="okan", base_dir=self.tools,
        )
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ledger_hash"], stored["ledger_hash"])
        self.assertEqual(rows[0]["status"], ofs.OPERATOR_REQUEST_STATUS_UNADDRESSED)
        self.assertEqual(rows[0]["row_kind"], ofs.OPERATOR_REQUEST_ROW_KIND)
        self.assertTrue(rows[0]["id"].startswith("OP-"))
        self.assertTrue(ofs.verify_operator_feedback_row(rows[0], base_dir=self.tools).valid)
        self.assertTrue(ofs.operator_request_schema_valid(rows[0]))
        for bad in (
            dict(request="", priority="high"),
            dict(request="x", priority="max"),
            dict(request="x" * (ofs.MAX_OPERATOR_REQUEST_CHARS + 1), priority="low"),
        ):
            with self.subTest(bad=bad), self.assertRaises(GovernanceError):
                ofs.record_operator_request(authored_by="okan", base_dir=self.tools, **bad)
        with self.assertRaises(GovernanceError):
            ofs.record_operator_request(request="x", priority="low", authored_by=" ", base_dir=self.tools)

    def test_feedback_store_verdict_rows_are_signed_too(self) -> None:
        from aria_kernel.feedback_store import record_operator_feedback

        returned = record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="medium", note="verified by hand", base_dir=self.tools,
        )
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(returned["signature"], rows[0]["signature"])
        self.assertEqual(returned["signer_kid"], rows[0]["signer_kid"])
        self.assertEqual(rows[0]["schema_version"], 2)
        self.assertTrue(ofs.verify_operator_feedback_row(rows[0], base_dir=self.tools).valid)
        # A verdict row is not a plan request: it carries no `status`, so the
        # synthesizer never treats it as one.
        self.assertNotIn("status", rows[0])

    def test_calibration_corpus_fixtures_are_signed(self) -> None:
        from aria_kernel.calibration_bootstrap import finalize_corpus, label_finding

        for index in range(2):
            label_finding(
                tool_id="tool-a", finding_fingerprint=f"fp-{index}", label="tp",
                severity="high", evidence=f"apps/x.ts:{index}", base_dir=self.tools,
            )
        summary = finalize_corpus(tool_id="tool-a", base_dir=self.tools, min_labels=2)
        self.assertEqual(summary["fixtures_appended"], 2)
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertTrue(ofs.verify_operator_feedback_row(row, base_dir=self.tools).valid)


class OnlyTheSignerAppendsTheSurfaceTests(unittest.TestCase):
    """Static pin: no kernel module names the operator_feedback surface in an append.

    ``append_declared_jsonl(..., expected_surface="operator_feedback")`` from
    anywhere but the signer would write an unsigned row the synthesizer
    then drops — an ingestion-time defect the compiler cannot see, so the
    sweep sees it instead.
    """

    def test_no_kernel_module_appends_operator_feedback_directly(self) -> None:
        offenders: list[str] = []
        for module in sorted(_KERNEL_DIR.rglob("*.py")):
            if module.name == "operator_feedback_signature.py":
                continue
            tree = ast.parse(module.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                callee = node.func
                name = callee.attr if isinstance(callee, ast.Attribute) else getattr(callee, "id", "")
                if name != "append_declared_jsonl":
                    continue
                for keyword in node.keywords:
                    if (
                        keyword.arg == "expected_surface"
                        and isinstance(keyword.value, ast.Constant)
                        and keyword.value.value == "operator_feedback"
                    ):
                        offenders.append(f"{module.relative_to(_KERNEL_DIR)}:{node.lineno}")
        self.assertEqual(offenders, [], "unsigned kernel writers of operator-feedback.jsonl")

    def test_pre_fix_presence_verifier_is_gone(self) -> None:
        source = (_KERNEL_DIR / "plan_synthesizer.py").read_text(encoding="utf-8")
        self.assertNotIn("def _verify_operator_feedback_signature", source)
        self.assertNotIn("signature_kid", source.replace("``signature_kid``", ""))


if __name__ == "__main__":
    unittest.main()
