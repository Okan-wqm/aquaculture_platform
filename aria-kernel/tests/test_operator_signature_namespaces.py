"""ADR-0023 — one committed registry of signature namespaces, one namespace-parameterised verifier.

The registry (``.github/manifests/aria-signature-namespaces.json``) is the
only list of ``ssh-keygen -Y`` namespaces ARIA signs or verifies; the kernel
reads it at the anchor commit through the hardened reader. These pins cover
its shape (the four operator namespaces admit T0/T1 only, ARIA's own two
admit T2 alone), its completeness against the namespace constants the
kernel exports, the verifier taking namespace, domain tag and principal
classes from the entry, and a request signed before the registry keeping
its exact bytes; and the enrolment chain: the two files change only through
a row signed in ``aria-operator-enrol`` by a key the PARENT version enrols,
walked from the pinned genesis on every anchor read.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib
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
from aria_kernel import operator_request_signature as ors
from aria_kernel import state_snapshot
from aria_kernel.tool_registry import GovernanceError
from tests._helpers import operator_requests as helpers
from tests._helpers.operator_requests import (
    ALL_OPERATOR_NAMESPACES,
    AUDIENCE,
    REGISTRY_BYTES,
    OperatorRequestFixture,
    allowed_signers_line,
    anchor_from_bytes,
    genesis_line,
    git,
    mint_ed25519_key,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_T2_NAMESPACES = {"aria-state-snapshot", "git"}


def _registry(**edits) -> bytes:
    payload = json.loads(REGISTRY_BYTES)
    for name, change in edits.items():
        entry = next(e for e in payload["namespaces"] if e["namespace"] == name.replace("_", "-"))
        if change is None:
            payload["namespaces"].remove(entry)
        else:
            entry.update(change)
    return json.dumps(payload).encode()


class CommittedRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.entries = ors.parse_namespace_registry(REGISTRY_BYTES)
        self.assertIsNotNone(self.entries, "the committed registry must parse")

    def test_operator_namespaces_admit_the_operator_and_never_the_runner(self) -> None:
        self.assertEqual(set(self.entries), set(ors.OPERATOR_NAMESPACES) | _T2_NAMESPACES)
        for name in ors.OPERATOR_NAMESPACES:
            entry = self.entries[name]
            with self.subTest(namespace=name):
                self.assertTrue(entry.operator)
                self.assertTrue(entry.signer_classes <= ors.OPERATOR_ACTOR_CLASSES)
                self.assertEqual(entry.domain_tag, f"{name}/v1")
                self.assertLessEqual(entry.expiry_hours, 168)
                self.assertTrue(ors.OPERATOR_SUBJECT_FIELDS <= set(entry.signed_fields))
        # Label seals and enrolments change ground truth and trust: T0 only.
        self.assertEqual(self.entries[ors.LABEL_NAMESPACE].signer_classes, {"T0"})
        self.assertEqual(self.entries[ors.ENROL_NAMESPACE].signer_classes, {"T0"})
        for name in _T2_NAMESPACES:
            self.assertEqual(self.entries[name].signer_classes, {"T2"}, name)

    def test_every_namespace_the_kernel_speaks_is_registered_with_a_real_verifier(self) -> None:
        for constant in (*ors.OPERATOR_NAMESPACES, ors.SIGNATURE_NAMESPACE, state_snapshot.SIGNATURE_NAMESPACE):
            self.assertIn(constant, self.entries)
        for entry in self.entries.values():
            module, _, function = entry.verifier.rpartition(".")
            self.assertTrue(callable(getattr(importlib.import_module(module), function, None)), entry.verifier)
        # A request's identity digest and its verified bytes use one tag.
        self.assertEqual(self.entries[ors.SIGNATURE_NAMESPACE].domain_tag, ors.REQUEST_DOMAIN_TAG)

    def test_the_allowed_signers_file_enrols_keys_for_operator_namespaces_only(self) -> None:
        text = (_REPO_ROOT / ors.ALLOWED_SIGNERS_PATH).read_text(encoding="utf-8")
        lines = [line for line in text.splitlines() if line.strip() and not line.startswith("#")]
        self.assertTrue(lines)
        for line in lines:
            options = line.split()[1]
            self.assertTrue(options.startswith('namespaces="'), "every key is restricted to named namespaces")
            names = options.split('"')[1].split(",")
            self.assertTrue(set(names) <= set(ors.OPERATOR_NAMESPACES), names)

    def test_a_registry_that_breaks_the_contract_is_no_registry(self) -> None:
        cases = {
            "runner_beside_operator": _registry(aria_operator_label={"signer_classes": ["T0", "T2"]}),
            "operator_namespace_dropped": _registry(aria_operator_journey=None),
            "no_actor_class_field": _registry(aria_operator_request={
                "signed_fields": ["audience", "expires_at", "signer_principal"]}),
            "foreign_domain_tag": _registry(aria_operator_enrol={"domain_tag": "aria-operator-request/v1"}),
            "unknown_class": _registry(aria_operator_label={"signer_classes": ["T9"]}),
            "unhashable_class": _registry(aria_operator_label={"signer_classes": [["T0"]]}),
            "unbounded_expiry": _registry(aria_operator_request={"expiry_hours": None}),
            "not_json": b"{",
            "wrong_schema": REGISTRY_BYTES.replace(b"aria/signature-namespaces/v1", b"aria/other/v1"),
        }
        for name, content in cases.items():
            with self.subTest(case=name):
                self.assertIsNone(ors.parse_namespace_registry(content))


class NamespaceVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ns-")
        self.addCleanup(self.tmp.cleanup)
        self.key = mint_ed25519_key(Path(self.tmp.name) / "keys")
        namespaces = ",".join(ors.OPERATOR_NAMESPACES)
        self.anchor = anchor_from_bytes(allowed_signers_line("op@aria.test", self.key, namespace=namespaces).encode())

    def _sign(self, namespace: str, subject: dict) -> dict:
        entry = self.anchor.namespaces[namespace]
        return ors.sign_operator_subject(subject, namespace=namespace, domain_tag=entry.domain_tag,
                                         signing_key=self.key, signer_principal="op@aria.test")

    def _verify(self, subject: dict, namespace: str):
        return ors.verify_operator_signature(subject, namespace=namespace, allowed_signers=self.anchor.content,
                                             namespaces=self.anchor.namespaces)

    def test_each_namespace_verifies_its_own_subject_and_no_other(self) -> None:
        signed = self._sign(ors.JOURNEY_NAMESPACE, {"actor_class": "T1", "path": "packs/x.json"})
        self.assertTrue(self._verify(signed, ors.JOURNEY_NAMESPACE).valid)
        for other in (ors.SIGNATURE_NAMESPACE, ors.LABEL_NAMESPACE):
            self.assertEqual(self._verify(signed, other).reason,
                             ors.ACTOR_CLASS_REFUSED if other == ors.LABEL_NAMESPACE else ors.SIGNATURE_INVALID)
        for name in ("git", "aria-state-snapshot", "aria-operator-unregistered"):
            self.assertEqual(self._verify(signed, name).reason, ors.NAMESPACE_UNREGISTERED, name)

    def test_a_label_seal_declaring_a_delegated_signer_is_refused(self) -> None:
        signed = self._sign(ors.LABEL_NAMESPACE, {"actor_class": "T1", "round": "2026-W40"})
        self.assertEqual(self._verify(signed, ors.LABEL_NAMESPACE).reason, ors.ACTOR_CLASS_REFUSED)
        sealed = self._sign(ors.LABEL_NAMESPACE, {"actor_class": "T0", "round": "2026-W40"})
        self.assertTrue(self._verify(sealed, ors.LABEL_NAMESPACE).valid)
        self.assertEqual(self._verify(dict(sealed, actor_class=["T0"]), ors.LABEL_NAMESPACE).reason,
                         ors.ACTOR_CLASS_REFUSED)

    def test_a_request_signed_before_the_registry_keeps_its_bytes(self) -> None:
        # The ADR-0020 subject, formed here by hand exactly as the pre-ADR-0023
        # signer formed it: no actor_class, the request domain tag.
        row = {"schema_version": 2, "row_kind": "operator_request", "id": "OP-legacy", "finding_id": "F-007",
               "authored_at": "2026-10-01T00:00:00+00:00", "expires_at": "2026-10-02T00:00:00+00:00",
               "audience": "Okan-wqm/aquaculture_platform", "signer_principal": "op@aria.test"}
        legacy = b"aria-operator-request/v1\n" + json.dumps(
            row, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        self.assertEqual(ors.request_signing_bytes(row), legacy)
        data = Path(self.tmp.name) / "legacy"
        data.write_bytes(legacy)
        subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(self.key), "-n", "aria-operator-request", str(data)],
                       check=True, capture_output=True, stdin=subprocess.DEVNULL)
        signed = dict(row, signature=data.with_name("legacy.sig").read_text(encoding="ascii"))
        self.assertTrue(ors.verify_operator_request(signed, allowed_signers=self.anchor).valid)


class RegistryAnchorTests(unittest.TestCase):
    """The registry is read with the allowed-signers file, at the same proven commit."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ns-anchor-")
        self.addCleanup(self.tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name) / "fixture")

    def test_the_registry_is_the_committed_object_not_the_working_tree(self) -> None:
        anchor, reason = ors.allowed_signers_for_checkout(self.fx.repo)
        self.assertIsNone(reason)
        self.assertEqual(set(anchor.namespaces), set(ors.parse_namespace_registry(REGISTRY_BYTES)))
        (self.fx.repo / ors.NAMESPACE_REGISTRY_PATH).write_bytes(b"{}")
        self.assertIsNotNone(ors.allowed_signers_for_checkout(self.fx.repo)[0])

    def test_a_missing_or_broken_registry_leaves_no_anchor(self) -> None:
        self.fx.commit_files({ors.NAMESPACE_REGISTRY_PATH: "{}"}, message="chore(test): break the registry")
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo), (None, ors.NAMESPACE_REGISTRY_INVALID))
        self.fx.commit_files({ors.NAMESPACE_REGISTRY_PATH: None}, message="chore(test): drop the registry")
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo), (None, ors.ALLOWED_SIGNERS_UNAVAILABLE))


if __name__ == "__main__":
    unittest.main()


def _git_out(*args: str) -> str:
    return subprocess.run(["git", "-C", str(_REPO_ROOT), *args], check=True, capture_output=True, text=True).stdout.strip()


class CommittedChainTests(unittest.TestCase):
    """The repository's own chain: it walks from the production pin, and a change only appends live rows."""

    def test_the_committed_chain_walks_from_the_production_pin(self) -> None:
        head = _git_out("rev-parse", "HEAD")
        blobs = {path: main_anchor.committed_blob(_REPO_ROOT, commit=head, path=path).content
                 for path in (ors.ALLOWED_SIGNERS_PATH, ors.NAMESPACE_REGISTRY_PATH, ors.ENROLMENTS_PATH)}
        genesis = json.loads(blobs[ors.ENROLMENTS_PATH].splitlines()[0])
        with mock.patch.object(ors, "genesis_pinned", helpers._production_genesis_pinned):
            self.assertTrue(ors.genesis_pinned(genesis["child"]))
            self.assertIsNone(ors.verify_enrolment_chain(
                blobs[ors.ENROLMENTS_PATH], allowed_signers=blobs[ors.ALLOWED_SIGNERS_PATH],
                registry=blobs[ors.NAMESPACE_REGISTRY_PATH]))
        for name in ors.OPERATOR_NAMESPACES:
            self.assertIn(name, genesis["child_allowed_signers"], "the genesis enrols the operator for every act")

    def test_an_enrolment_this_change_appends_has_not_expired(self) -> None:
        # Runs in the required aria-merge-authority job: on a pull request
        # the merge base with main is main's tip, so these are the PR's rows.
        base = _git_out("merge-base", "HEAD", main_anchor.MAIN_TRACKING_REF)
        read = {commit: main_anchor.committed_blob(_REPO_ROOT, commit=commit, path=ors.ENROLMENTS_PATH)
                for commit in (base, _git_out("rev-parse", "HEAD"))}
        before, after = (blob.content if blob else None for blob in read.values())
        self.assertIsNone(ors.appended_enrolments_reason(before, after, now=datetime.now(timezone.utc)))

    def test_the_pre_merge_check_refuses_rewrites_and_expired_rows(self) -> None:
        now = datetime.now(timezone.utc)
        genesis = genesis_line(b"x", pin=False).encode()

        def row(hours: int) -> bytes:
            return (json.dumps({"kind": "enrolment", "expires_at": (now + timedelta(hours=hours)).isoformat()})
                    + "\n").encode()

        self.assertIsNone(ors.appended_enrolments_reason(None, genesis, now=now))
        self.assertIsNone(ors.appended_enrolments_reason(genesis, genesis + row(1), now=now))
        self.assertEqual(ors.appended_enrolments_reason(genesis, genesis + row(-1), now=now), ors.SUBJECT_EXPIRED)
        self.assertEqual(ors.appended_enrolments_reason(genesis + row(1), genesis, now=now), ors.ENROL_CHAIN_BROKEN)


class EnrolmentChainTests(unittest.TestCase):
    """ADR-0023 ruling 3 — a key a change adds cannot sign its own enrolment."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-enrol-")
        self.addCleanup(self.tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name) / "fixture")
        self.base = git(self.fx.repo, "rev-parse", "HEAD").strip()
        self.newcomer = mint_ed25519_key(Path(self.tmp.name) / "newcomer", name="k")
        self.signers = (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).read_text(encoding="utf-8")
        self.widened = self.signers + allowed_signers_line("newcomer@aria.test", self.newcomer,
                                                           namespace=ALL_OPERATOR_NAMESPACES)

    def _reason(self) -> str | None:
        return ors.allowed_signers_for_checkout(self.fx.repo)[1]

    def _reset(self) -> None:
        git(self.fx.repo, "reset", "-q", "--hard", self.base)
        git(self.fx.repo, "update-ref", main_anchor.MAIN_TRACKING_REF, self.base)

    def _newcomer_request_verifies(self) -> bool:
        anchor = ors.allowed_signers_for_checkout(self.fx.repo)[0]
        row = ors.sign_operator_request(self.fx.request_row(), signing_key=self.newcomer,
                                        signer_principal="newcomer@aria.test")
        return anchor is not None and ors.verify_operator_request(row, allowed_signers=anchor).valid

    def _append_row(self, row: dict, **files: str) -> None:
        ledger = (self.fx.repo / ors.ENROLMENTS_PATH).read_text(encoding="utf-8")
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: self.widened, **files,
                              ors.ENROLMENTS_PATH: ledger + json.dumps(row, sort_keys=True) + "\n"})

    def _hand_row(self, *, key: Path, principal: str) -> dict:
        parent = {"allowed_signers": "sha256:" + hashlib.sha256(self.signers.encode()).hexdigest(),
                  "registry": "sha256:" + hashlib.sha256(REGISTRY_BYTES).hexdigest()}
        row = dict(ors.enrolment_genesis_row(self.widened.encode(), REGISTRY_BYTES), kind="enrolment",
                   parent=parent, actor_class="T0", audience=AUDIENCE,
                   expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
        return ors.sign_operator_subject(row, namespace=ors.ENROL_NAMESPACE, domain_tag="aria-operator-enrol/v1",
                                         signing_key=key, signer_principal=principal)

    def test_a_properly_enrolled_signer_verifies(self) -> None:
        self.assertFalse(self._newcomer_request_verifies())
        row = self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.widened})
        self.assertEqual((row["actor_class"], row["signer_principal"]), ("T0", self.fx.principal))
        self.assertIn('"kind":"enrolment"', self.fx.subjects.getvalue(), "the operator saw what they signed")
        self.assertIsNone(self._reason())
        self.assertTrue(self._newcomer_request_verifies())

    def test_a_signer_added_without_a_parent_key_enrolment_is_refused(self) -> None:
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: self.widened}, message="chore(test): unsigned enrolment")
        self.assertEqual(self._reason(), ors.ENROL_TIP_MISMATCH)
        self.assertFalse(self._newcomer_request_verifies())
        self._reset()
        # A self-enrolment: the key the change adds signs its own row.
        with self.assertRaisesRegex(GovernanceError, ors.SIGNER_NOT_ENROLLED):
            self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.widened}, key=self.newcomer, principal="newcomer@aria.test")
        self._reset()
        self._append_row(self._hand_row(key=self.newcomer, principal="newcomer@aria.test"))
        self.assertEqual(self._reason(), ors.ENROL_SIGNATURE_INVALID)
        self._reset()
        signed = self._hand_row(key=self.fx.key, principal=self.fx.principal)
        self._append_row({k: v for k, v in signed.items() if k != "signature"})
        self.assertEqual(self._reason(), ors.ENROL_SIGNATURE_INVALID)
        self._reset()
        self._append_row(dict(signed, parent={"allowed_signers": "sha256:" + "0" * 64, "registry": "sha256:" + "0" * 64}))
        self.assertEqual(self._reason(), ors.ENROL_CHAIN_BROKEN)
        self._reset()
        self._append_row(signed)
        self.assertIsNone(self._reason(), "the same row, signed by the parent's key, verifies")

    def test_a_rewritten_local_main_cannot_carry_an_unsigned_enrolment(self) -> None:
        # ARIA-LOW-269 narrowed: the runner can rewrite refs/remotes/origin/main.
        forged = self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: self.widened}, on_main=False)
        git(self.fx.repo, "update-ref", main_anchor.MAIN_TRACKING_REF, forged)
        self.assertIsNone(main_anchor.resolve_main_anchor(self.fx.repo).reason, "the forged commit is 'on main'")
        self.assertEqual(self._reason(), ors.ENROL_TIP_MISMATCH)

    def test_a_genesis_the_kernel_does_not_pin_is_refused(self) -> None:
        self.fx.commit_files({ors.ENROLMENTS_PATH: genesis_line(self.widened.encode(), pin=False),
                              ors.ALLOWED_SIGNERS_PATH: self.widened})
        self.assertEqual(self._reason(), ors.ENROL_GENESIS_MISMATCH)
        self.fx.commit_files({ors.ENROLMENTS_PATH: None})
        self.assertEqual(self._reason(), ors.ENROL_GENESIS_MISMATCH)
        self.fx.commit_files({ors.ENROLMENTS_PATH: "not json\n"})
        self.assertEqual(self._reason(), ors.ENROL_CHAIN_BROKEN)

    def test_enrolment_is_a_t0_act_by_a_key_enrolled_for_enrolment(self) -> None:
        with self.assertRaisesRegex(GovernanceError, ors.ACTOR_CLASS_REFUSED):
            self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.widened}, actor_class="T1")
        self._reset()
        with self.assertRaisesRegex(GovernanceError, ors.SUBJECT_EXPIRY_INVALID):
            self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.widened}, expires_in_hours=169)
        self._reset()
        # The parent narrows the fixture key to requests; it can no longer enrol.
        narrowed = allowed_signers_line(self.fx.principal, self.fx.key, namespace=ors.SIGNATURE_NAMESPACE)
        self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: narrowed})
        self.assertIsNone(self._reason())
        with self.assertRaisesRegex(GovernanceError, ors.SIGNATURE_INVALID):
            self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: narrowed + "# widened again\n"})

    def test_a_broken_chain_is_a_runner_fault_and_spends_no_request(self) -> None:
        from aria_kernel.operator_feedback_ingestion import ingest_operator_feedback

        self.fx.seed_finding("F-007", refs=[f"{helpers.GROUNDED_FILE}:12"])
        self.fx.record(request_id="OP-chain")
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: self.widened}, message="chore(test): unsigned enrolment")
        scan = ingest_operator_feedback(base_dir=self.fx.tools, cycle_id="c1", repo_root=self.fx.repo)
        self.assertEqual(scan.admitted, ())
        self.assertEqual([(d["reason"], d["runner_fault"]) for d in scan.dropped],
                         [(ors.ALLOWED_SIGNERS_UNAVAILABLE, True)])
        self._reset()
        self.assertEqual([a["id"] for a in ingest_operator_feedback(
            base_dir=self.fx.tools, cycle_id="c2", repo_root=self.fx.repo).admitted], ["OP-chain"])

    def test_the_cli_verb_appends_a_row_the_walk_accepts(self) -> None:
        from aria_kernel.cli import main as cli_main

        (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).write_text(self.widened, encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(["feedback", "enrol", "--actor-class", "T0", "--signing-key", str(self.fx.key),
                             "--signer-principal", self.fx.principal, "--repo-root", str(self.fx.repo),
                             "--tools-dir", str(self.fx.tools)])
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn("aria-operator-enrol", err.getvalue())
        self.fx.commit_files({path: (self.fx.repo / path).read_text(encoding="utf-8")
                              for path in (ors.ALLOWED_SIGNERS_PATH, ors.ENROLMENTS_PATH)})
        self.assertIsNone(self._reason())
        self.assertTrue(self._newcomer_request_verifies())
