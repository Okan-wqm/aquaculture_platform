"""ADR-0020 — operator plan requests carry an operator ed25519 signature.

Pre-fix a request row was signed by an HMAC key the KERNEL minted on the
runner (``aria-tools/secrets/operator-feedback-hmac.key``): any runner-uid
process could sign with it, the self-hosted lanes' ``git clean -ffdx`` swept
it every job, and the GitHub-hosted merge lane never held it. These pins
cover the replacement: a throwaway ed25519 key signs, a committed
allowed-signers file read at a commit proven on main verifies, every forgery
class has a named reason, the anchor cannot be steered (review round 2,
GSEC-MEDIUM-003), the recorder signs the replay-bounding terms and refuses
what ingestion would refuse, and the kernel's own HMAC rows keep verifying.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import main_anchor
from aria_kernel import operator_feedback_signature as ofs
from aria_kernel import operator_request_signature as ors
from aria_kernel.finding_grounding import admit_finding, load_grounding_context
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.operator_request_terms import request_audience
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_requests import (
    GROUNDED_FILE,
    OperatorRequestFixture,
    allowed_signers_line,
    anchor_from_bytes,
    git,
    mint_ed25519_key,
)


def _request_row(**overrides) -> dict:
    row = {
        "schema_version": ofs.OPERATOR_REQUEST_SCHEMA_VERSION, "row_kind": ofs.OPERATOR_REQUEST_ROW_KIND,
        "id": "OP-sig", "finding_id": "F-007", "authored_at": "2026-10-02T00:00:00+00:00",
        "authored_by": "okan", "request": "Fix it", "priority": "high", "status": "unaddressed",
    }
    row.update(overrides)
    return row


def _clean_env() -> mock._patch:
    env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
    return mock.patch.dict(os.environ, env, clear=True)


class OperatorSignatureVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ors-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.key = mint_ed25519_key(root / "keys")
        self.allowed = anchor_from_bytes(allowed_signers_line("op@aria.test", self.key).encode())

    def _sign(self, row: dict, principal: str = "op@aria.test", key: Path | None = None) -> dict:
        return ors.sign_operator_request(row, signing_key=key or self.key, signer_principal=principal)

    def test_a_signed_request_verifies_against_the_allowed_signers_bytes(self) -> None:
        signed = self._sign(_request_row())
        verdict = ors.verify_operator_request(signed, allowed_signers=self.allowed)
        self.assertTrue(verdict.valid, verdict.reason)
        self.assertEqual(verdict.signer, "op@aria.test")
        self.assertTrue(signed["signature"].startswith("-----BEGIN SSH SIGNATURE-----"))
        # Chain fields the ledger stamps after signing are outside the subject.
        stored = dict(signed, ledger_hash="sha256:" + "0" * 64, previous_ledger_hash=None)
        self.assertTrue(ors.verify_operator_request(stored, allowed_signers=self.allowed).valid)
        self.assertEqual(ors.request_subject_digest(stored), ors.request_subject_digest(signed))

    def test_every_forgery_class_is_named(self) -> None:
        signed = self._sign(_request_row())
        other_key = mint_ed25519_key(Path(self.tmp.name) / "other", name="intruder")
        wrong_namespace = anchor_from_bytes(self.allowed.content.replace(b'"aria-operator-request"', b'"git"'))
        cases = {
            "tampered_request": (dict(signed, request="Delete the audit log"), self.allowed, ors.SIGNATURE_INVALID),
            "tampered_finding": (dict(signed, finding_id="F-999"), self.allowed, ors.SIGNATURE_INVALID),
            "tampered_priority": (dict(signed, priority="low"), self.allowed, ors.SIGNATURE_INVALID),
            "tampered_expiry": (dict(signed, expires_at="2099-01-01T00:00:00+00:00"), self.allowed,
                                ors.SIGNATURE_INVALID),
            "wrong_namespace": (signed, wrong_namespace, ors.SIGNATURE_INVALID),
            "unenrolled_principal": (self._sign(_request_row(), principal="intruder@aria.test", key=other_key),
                                     self.allowed, ors.SIGNER_NOT_ENROLLED),
            "enrolled_principal_foreign_key": (self._sign(_request_row(), key=other_key),
                                               self.allowed, ors.SIGNATURE_INVALID),
            "no_signature": ({k: v for k, v in signed.items() if k != "signature"}, self.allowed,
                             ors.SIGNATURE_MISSING),
            "hmac_shaped": (dict(signed, signature="a" * 64), self.allowed, ors.SIGNATURE_MALFORMED),
            "no_principal": ({k: v for k, v in signed.items() if k != "signer_principal"}, self.allowed,
                             ors.SIGNER_PRINCIPAL_MISSING),
            "option_smuggling_principal": (dict(signed, signer_principal="-Ihack"), self.allowed,
                                           ors.SIGNER_PRINCIPAL_INVALID),
            "no_anchor": (signed, None, ors.ALLOWED_SIGNERS_UNAVAILABLE),
        }
        for name, (row, allowed, expected) in cases.items():
            with self.subTest(case=name):
                verdict = ors.verify_operator_request(row, allowed_signers=allowed)
                self.assertFalse(verdict.valid)
                self.assertEqual(verdict.reason, expected)

    def test_a_signature_made_for_another_namespace_is_refused(self) -> None:
        # A key the operator also uses for git commit signing must not turn a
        # commit-namespace signature over the same bytes into a request.
        signed = self._sign(_request_row())
        data = Path(self.tmp.name) / "subject"
        data.write_bytes(ors.request_signing_bytes(signed))
        subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(self.key), "-n", "git", str(data)],
                       check=True, capture_output=True, stdin=subprocess.DEVNULL)
        foreign = dict(signed, signature=data.with_name("subject.sig").read_text(encoding="ascii"))
        verdict = ors.verify_operator_request(foreign, allowed_signers=self.allowed)
        self.assertEqual((verdict.valid, verdict.reason), (False, ors.SIGNATURE_INVALID))

    def test_a_missing_verifier_is_a_refusal_not_a_pass(self) -> None:
        signed = self._sign(_request_row())
        with mock.patch("aria_kernel.operator_request_signature.shutil.which", return_value=None):
            verdict = ors.verify_operator_request(signed, allowed_signers=self.allowed)
        self.assertEqual((verdict.valid, verdict.reason), (False, ors.VERIFIER_UNAVAILABLE))
        with mock.patch("aria_kernel.operator_request_signature.subprocess.run",
                        side_effect=subprocess.TimeoutExpired("ssh-keygen", 15)):
            verdict = ors.verify_operator_request(signed, allowed_signers=self.allowed)
        self.assertEqual((verdict.valid, verdict.reason), (False, ors.VERIFICATION_TIMEOUT))
        self.assertTrue({ors.VERIFIER_UNAVAILABLE, ors.VERIFICATION_TIMEOUT} <= ors.VERIFICATION_RUNNER_FAULTS)

    def test_the_verifier_runs_the_binary_it_resolved(self) -> None:
        # GSEC-LOW-006 — the absolute path that was checked is the one executed.
        signed = self._sign(_request_row())
        real = subprocess.run
        seen: list[str] = []

        def spy(argv, *args, **kwargs):
            seen.append(argv[0])
            return real(argv, *args, **kwargs)

        with mock.patch("aria_kernel.operator_request_signature.subprocess.run", side_effect=spy):
            self.assertTrue(ors.verify_operator_request(signed, allowed_signers=self.allowed).valid)
        self.assertEqual(len(seen), 1)
        self.assertTrue(Path(seen[0]).is_absolute(), seen)


class TrustAnchorTests(unittest.TestCase):
    """GSEC-MEDIUM-003 / arbiter ruling ii — the anchor is a commit proven on main, read hardened."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ors-anchor-")
        self.addCleanup(self.tmp.cleanup)
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name) / "fixture")
        self.intruder = mint_ed25519_key(Path(self.tmp.name) / "intruder", name="k")

    def test_the_anchor_is_the_committed_file_on_main_not_the_working_tree(self) -> None:
        signers, reason = ors.allowed_signers_for_checkout(self.fx.repo)
        self.assertIsNone(reason)
        self.assertIn(self.fx.principal.encode(), signers.content)
        self.assertEqual(signers.commit, git(self.fx.repo, "rev-parse", "HEAD").strip())
        self.assertRegex(signers.blob_oid, r"^[0-9a-f]{40,64}$")
        (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).write_text(
            allowed_signers_line("intruder@aria.test", self.intruder), encoding="utf-8",
        )
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo)[0].content, signers.content)
        self.assertIsNone(ors.allowed_signers_at(self.fx.repo, commit="--output=/tmp/x"))

    def test_a_checkout_moved_off_main_is_no_anchor(self) -> None:
        # A branch commit that enrols another key is not trust until it is on main.
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: allowed_signers_line("intruder@aria.test", self.intruder)},
                             message="chore(test): self-enrolment", on_main=False)
        signers, reason = ors.allowed_signers_for_checkout(self.fx.repo)
        self.assertIsNone(signers)
        self.assertEqual(reason, main_anchor.ANCHOR_NOT_ON_MAIN)
        git(self.fx.repo, "update-ref", "-d", main_anchor.MAIN_TRACKING_REF)
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo)[1], main_anchor.ANCHOR_MAIN_UNRESOLVED)

    def test_a_replace_ref_cannot_substitute_the_anchor(self) -> None:
        original = ors.allowed_signers_for_checkout(self.fx.repo)[0]
        evil = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=self.fx.repo, check=True,
                              capture_output=True, input=allowed_signers_line("intruder@aria.test", self.intruder).encode(),
                              ).stdout.decode().strip()
        git(self.fx.repo, "replace", original.blob_oid, evil)
        # Git honours the replacement by default: an unhardened read is steered.
        self.assertIn("intruder", git(self.fx.repo, "show", f"HEAD:{ors.ALLOWED_SIGNERS_PATH}"))
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo)[0].content, original.content)

    def test_the_git_environment_cannot_steer_the_read(self) -> None:
        other = OperatorRequestFixture(Path(self.tmp.name) / "other", principal="intruder@aria.test")
        original = ors.allowed_signers_for_checkout(self.fx.repo)[0]
        with mock.patch.dict(os.environ, {"GIT_DIR": str(other.repo / ".git"),
                                          "GIT_REPLACE_REF_BASE": "refs/evil/",
                                          "GIT_OBJECT_DIRECTORY": str(other.repo / ".git" / "objects")}):
            self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo)[0].content, original.content)
        self.assertNotIn("GIT_DIR", main_anchor.scrubbed_git_env())
        self.assertEqual(main_anchor.scrubbed_git_env()["GIT_NO_REPLACE_OBJECTS"], "1")

    def test_a_repository_with_object_alternates_is_no_anchor(self) -> None:
        alternates = self.fx.repo / ".git" / "objects" / "info" / "alternates"
        alternates.parent.mkdir(parents=True, exist_ok=True)
        alternates.write_text("/nonexistent/objects\n", encoding="utf-8")
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo)[1], main_anchor.ANCHOR_ALTERNATES_PRESENT)


class OperatorRequestRecorderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ors-rec-")
        self.addCleanup(self.tmp.cleanup)
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fixture = OperatorRequestFixture(Path(self.tmp.name))
        self.fixture.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])

    def _rows(self) -> list[dict]:
        return load_declared_jsonl(self.fixture.tools / "operator-feedback.jsonl", expected_surface="operator_feedback")

    def test_the_recorder_signs_the_request_and_its_replay_bounding_terms(self) -> None:
        before = datetime.now(timezone.utc).replace(microsecond=0)
        stored = self.fixture.record(finding_id="F-007", request_id="OP-1")
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["ledger_hash"], stored["ledger_hash"])
        self.assertEqual((row["finding_id"], row["signer_principal"]), ("F-007", self.fixture.principal))
        self.assertEqual(row["schema_version"], ofs.OPERATOR_REQUEST_SCHEMA_VERSION)
        self.assertEqual(row["audience"], request_audience())
        self.assertEqual(request_audience(), "Okan-wqm/aquaculture_platform")
        expires = datetime.fromisoformat(row["expires_at"])
        self.assertLessEqual(expires - before, timedelta(hours=168, seconds=2))
        self.assertGreaterEqual(expires - before, timedelta(hours=167, minutes=59))
        grounding = admit_finding(load_grounding_context(self.fixture.repo), "F-007")
        self.assertEqual(row["grounding_digest"], grounding.grounding_digest)
        self.assertNotIn("signer_kid", row, "no runner-held key signs a request")
        signers, _reason = ors.allowed_signers_for_checkout(self.fixture.repo)
        self.assertTrue(ors.verify_operator_request(row, allowed_signers=signers).valid)
        self.assertIsNone(ofs.operator_request_schema_reason(row, now=datetime.now(timezone.utc)))
        self.assertFalse(ofs.signing_key_path(self.fixture.tools).exists(),
                         "recording a request mints no runner-side key material")
        # GSEC-MEDIUM-005 — the exact subject was shown before ssh-keygen ran.
        self.assertIn(ors.request_signing_bytes(row).decode("ascii"), self.fixture.subjects.getvalue())

    def test_the_recorder_refuses_what_ingestion_would_refuse(self) -> None:
        self.fixture.record(request_id="OP-1")
        self.fixture.seed_finding("F-010", refs=[f"{GROUNDED_FILE}:1"], status="RESOLVED")
        cases = {
            "operator_request_id_reused": dict(request_id="OP-1"),
            "operator_request_finding_id_invalid": dict(finding_id="ORPHAN-HIGH-104"),
            "operator_request_priority_unknown": dict(priority="max"),
            "operator_request_finding_not_a_plan_ground: finding_not_open": dict(finding_id="F-010"),
            "operator_request_expiry_out_of_range": dict(expires_in_hours=169),
        }
        for expected, kwargs in cases.items():
            with self.subTest(reason=expected), self.assertRaisesRegex(GovernanceError, expected):
                self.fixture.record(**kwargs)
        with self.assertRaisesRegex(GovernanceError, "operator_request_signature_unverified: signer_not_enrolled"):
            ofs.record_operator_request(
                request="x", priority="high", authored_by="okan", finding_id="F-007",
                signing_key=self.fixture.key, signer_principal="someone@else", actor_class="T0",
                base_dir=self.fixture.tools, repo_root=self.fixture.repo, subject_stream=io.StringIO(),
            )
        self.assertEqual([row["id"] for row in self._rows()], ["OP-1"])

    def test_an_id_the_ingestion_history_holds_is_refused_at_record_time(self) -> None:
        # The feedback ledger can lose a row (rollback); the kernel's own
        # history still holds the id (AISAFETY-HIGH-001).
        from aria_kernel.operator_feedback_ingestion import ingest_operator_feedback

        self.fixture.record(request_id="OP-1")
        ingest_operator_feedback(base_dir=self.fixture.tools, cycle_id="c1", repo_root=self.fixture.repo)
        (self.fixture.tools / "operator-feedback.jsonl").unlink()
        with self.assertRaisesRegex(GovernanceError, "operator_request_id_reused"):
            self.fixture.record(request_id="OP-1")

    def test_the_kernel_hmac_path_cannot_mint_a_request_row(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "operator_request_rows_are_operator_signed"):
            ofs.append_signed_operator_feedback_row(_request_row(), base_dir=self.fixture.tools)
        with self.assertRaisesRegex(GovernanceError, "operator_request_rows_are_operator_signed"):
            ofs.append_signed_operator_feedback_row(
                {"id": "OP-x", "row_kind": ofs.OPERATOR_REQUEST_ROW_KIND}, base_dir=self.fixture.tools,
            )

    def test_the_cli_verb_records_a_signed_request_and_requires_its_finding(self) -> None:
        from aria_kernel.cli import main as cli_main

        argv = ["feedback", "request", "--tools-dir", str(self.fixture.tools), "--request", "Fix it",
                "--priority", "high", "--authored-by", "okan", "--signing-key", str(self.fixture.key),
                "--signer-principal", self.fixture.principal, "--actor-class", "T1",
                "--repo-root", str(self.fixture.repo),
                "--request-id", "OP-cli", "--expires-in-hours", "24"]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(cli_main([*argv, "--finding-id", "F-007"]), 0)
        printed = json.loads(out.getvalue())
        self.assertEqual((printed["id"], printed["finding_id"]), ("OP-cli", "F-007"))
        self.assertIn('"id":"OP-cli"', err.getvalue(), "the signed subject is shown on stderr")
        self.assertEqual([row["id"] for row in self._rows()], ["OP-cli"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exit_ctx:
            cli_main(argv)
        self.assertEqual(exit_ctx.exception.code, 2, "--finding-id is required")

    def test_kernel_written_verdict_rows_keep_their_hmac(self) -> None:
        from aria_kernel.feedback_store import record_operator_feedback

        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="f-1", verdict="true_positive",
            severity="medium", note="verified by hand", base_dir=self.fixture.tools,
        )
        row = self._rows()[-1]
        self.assertFalse(ofs.is_operator_request_row(row))
        self.assertTrue(ofs.verify_operator_feedback_row(row, base_dir=self.fixture.tools).valid)


if __name__ == "__main__":
    unittest.main()
