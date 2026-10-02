"""ADR-0023 — one committed registry of signature namespaces, one namespace-parameterised verifier.

The registry (``.github/manifests/aria-signature-namespaces.json``) is the
only list of ``ssh-keygen -Y`` namespaces ARIA signs or verifies; the kernel
reads it at the anchor commit through the hardened reader. These pins cover
its shape (the four operator namespaces admit T0/T1 only, ARIA's own two
admit T2 alone), its completeness against the namespace constants the
kernel exports, the verifier taking namespace, domain tag and principal
classes from the entry, and a request signed before the registry keeping
its exact bytes.
"""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import operator_request_signature as ors
from aria_kernel import state_snapshot
from tests._helpers.operator_requests import (
    REGISTRY_BYTES,
    OperatorRequestFixture,
    allowed_signers_line,
    anchor_from_bytes,
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
