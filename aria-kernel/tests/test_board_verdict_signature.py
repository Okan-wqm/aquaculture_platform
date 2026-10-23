"""PLAN-v2 B0 — the Examination Board signs its verdicts through the ONE operator verifier.

§2 'İmza': no new signature mechanism. The Board gets its own namespace,
``aria-board-verdict``, and its own principal class in the committed
registry (``.github/manifests/aria-signature-namespaces.json``); its key is
enrolled in ``.github/manifests/aria-operator-signers`` for that namespace
only, and every verdict is verified by
``operator_request_signature.verify_operator_signature``. §1.9: the Board is
outside ARIA's trust domain, so the Board class is never T2 and never an
operator class, the Board namespace admits the Board class alone, and no
operator namespace admits it (a Board key cannot sign an operator request or
an enrolment, and the operator's key cannot mint a Board verdict).

The Board's public key is the one ``board/SETUP.md`` (2026-10-21) records for
the ``aria-board`` environment's ``ARIA_BOARD_SIGNING_KEY``: fingerprint
SHA256:anPvUrqkiKPRFoO8gKfALLquIy+o7VS/f0TjWaTRi5A.

New API pinned here (red at the base because it does not exist yet):
``operator_request_signature.BOARD_VERDICT_NAMESPACE`` and
``operator_request_signature.BOARD_ACTOR_CLASS``. Every other assertion is
red at the base by the defect itself: the registry has no Board entry, the
parser refuses any class outside T0/T1/T2, and no key is enrolled for the
Board.

Operator step (not code, not signed by any session): changing the two
manifests needs one enrolment row in ``aria-operator-enrolments.jsonl``
signed in ``aria-operator-enrol`` with the operator's key; until that row is
appended ``CommittedChainTests`` stays red by design.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel import operator_request_signature as ors
from tests._helpers.operator_requests import (
    ALL_OPERATOR_NAMESPACES,
    AUDIENCE,
    REGISTRY_BYTES,
    allowed_signers_line,
    mint_ed25519_key,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
BOARD_NAMESPACE = "aria-board-verdict"
BOARD_DOMAIN_TAG = "aria-board-verdict/v1"
# board/SETUP.md — the aria-board environment's signing key, public half.
BOARD_KEY_FINGERPRINT = "SHA256:anPvUrqkiKPRFoO8gKfALLquIy+o7VS/f0TjWaTRi5A"
# PLAN-v2 B2: a signed verdict binds head_sha, surface, scope, board_version
# and an expiry; B4 reads it as ``board:<verdict_id>``. The fields are fixed
# in B0 because a later registry change is another operator-signed enrolment.
BOARD_VERDICT_FIELDS = frozenset({"verdict_id", "head_sha", "surface", "scope", "board_version"})
THE_ONE_VERIFIER = "aria_kernel.operator_request_signature.verify_operator_signature"


def _board_class(case: unittest.TestCase) -> str:
    value = getattr(ors, "BOARD_ACTOR_CLASS", None)
    case.assertIsInstance(value, str, "operator_request_signature.BOARD_ACTOR_CLASS names the Board principal class")
    return str(value)


def _registry_with_board(board_class: str, **entry_edits: object) -> bytes:
    """The committed registry plus the Board entry B0 adds (whatever the working tree holds today)."""
    payload = json.loads(REGISTRY_BYTES)
    payload["namespaces"] = [e for e in payload["namespaces"] if e["namespace"] != BOARD_NAMESPACE]
    entry = {
        "namespace": BOARD_NAMESPACE,
        "domain_tag": BOARD_DOMAIN_TAG,
        "signed_fields": sorted(ors.OPERATOR_SUBJECT_FIELDS | BOARD_VERDICT_FIELDS),
        "signer_classes": [board_class],
        "expiry_hours": 168,
        "verifier": THE_ONE_VERIFIER,
        "status": "active",
    }
    entry.update(entry_edits)
    payload["namespaces"].append(entry)
    return json.dumps(payload).encode()


def _edit(registry: bytes, namespace: str, **change: object) -> bytes:
    payload = json.loads(registry)
    entry = next(e for e in payload["namespaces"] if e["namespace"] == namespace)
    entry.update(change)
    return json.dumps(payload).encode()


class BoardApiTests(unittest.TestCase):
    def test_the_board_namespace_and_class_are_named_by_the_verifier_module(self) -> None:
        self.assertEqual(getattr(ors, "BOARD_VERDICT_NAMESPACE", None), BOARD_NAMESPACE)
        board = _board_class(self)
        self.assertNotIn(board, ors.OPERATOR_ACTOR_CLASSES, "the Board is not the operator")
        self.assertNotEqual(board, ors.RUNNER_ACTOR_CLASS, "the Board is not ARIA's runner")
        self.assertNotIn(BOARD_NAMESPACE, ors.OPERATOR_NAMESPACES, "a Board verdict is not an operator act")


class CommittedBoardEnrolmentTests(unittest.TestCase):
    """What B0 commits under .github/manifests (the operator signs the enrolment row)."""

    def setUp(self) -> None:
        self.board = _board_class(self)
        self.entries = ors.parse_namespace_registry(REGISTRY_BYTES)
        self.assertIsNotNone(self.entries, "the committed registry must parse")

    def test_the_committed_registry_registers_the_board_namespace_for_the_board_class_alone(self) -> None:
        self.assertIn(BOARD_NAMESPACE, self.entries, "no aria-board-verdict entry in the committed registry")
        entry = self.entries[BOARD_NAMESPACE]
        self.assertEqual(entry.domain_tag, BOARD_DOMAIN_TAG)
        self.assertEqual(entry.signer_classes, frozenset({self.board}))
        self.assertEqual(entry.verifier, THE_ONE_VERIFIER, "no new signature mechanism (§2 'İmza')")
        self.assertEqual(entry.status, ors.NAMESPACE_ACTIVE)
        self.assertIsInstance(entry.expiry_hours, int)
        self.assertGreater(entry.expiry_hours, 0)
        self.assertTrue(ors.OPERATOR_SUBJECT_FIELDS | BOARD_VERDICT_FIELDS <= set(entry.signed_fields))

    def test_no_other_namespace_admits_the_board_class(self) -> None:
        for name, entry in self.entries.items():
            if name != BOARD_NAMESPACE:
                with self.subTest(namespace=name):
                    self.assertNotIn(self.board, entry.signer_classes)

    def test_the_allowed_signers_file_enrols_the_board_key_for_the_board_namespace_only(self) -> None:
        text = (_REPO_ROOT / ors.ALLOWED_SIGNERS_PATH).read_text(encoding="utf-8")
        lines = [line for line in text.splitlines() if line.strip() and not line.startswith("#")]
        board_lines = [line for line in lines if BOARD_NAMESPACE in line.split()[1]]
        self.assertEqual(len(board_lines), 1, "exactly one key is enrolled for aria-board-verdict")
        line = board_lines[0]
        self.assertEqual(line.split()[1], f'namespaces="{BOARD_NAMESPACE}"',
                         "the Board key signs Board verdicts and nothing else")
        keytype, blob = line.split()[2:4]
        with tempfile.TemporaryDirectory(prefix="aria-board-pub-") as scratch:
            public = Path(scratch) / "board.pub"
            public.write_text(f"{keytype} {blob}\n", encoding="utf-8")
            listed = subprocess.run(["ssh-keygen", "-l", "-E", "sha256", "-f", str(public)],
                                    check=True, capture_output=True, text=True).stdout.split()
        self.assertEqual(listed[1], BOARD_KEY_FINGERPRINT, "the enrolled key is the aria-board environment's")
        for other in lines:
            if other is not line:
                with self.subTest(line=other.split()[0]):
                    self.assertNotIn(blob, other, "the Board key is enrolled for no operator namespace")


class BoardRegistryContractTests(unittest.TestCase):
    """The parser keeps the Board class in its own namespace, the way it keeps T2 in ARIA's."""

    def setUp(self) -> None:
        self.board = _board_class(self)
        self.registry = _registry_with_board(self.board)

    def test_a_registry_with_the_board_entry_parses(self) -> None:
        entries = ors.parse_namespace_registry(self.registry)
        self.assertIsNotNone(entries, "a registry carrying the Board class must parse")
        self.assertEqual(entries[BOARD_NAMESPACE].signer_classes, frozenset({self.board}))

    def test_a_registry_that_mixes_the_board_with_another_class_is_no_registry(self) -> None:
        cases = {
            "board_beside_operator": _registry_with_board(self.board, signer_classes=[self.board, "T0"]),
            "board_beside_root_session": _registry_with_board(self.board, signer_classes=[self.board, "T1"]),
            "board_beside_runner": _registry_with_board(self.board, signer_classes=[self.board, "T2"]),
            "operator_namespace_admits_board": _edit(self.registry, ors.ENROL_NAMESPACE,
                                                     signer_classes=["T0", self.board]),
            "request_namespace_admits_board": _edit(self.registry, ors.SIGNATURE_NAMESPACE,
                                                    signer_classes=["T0", "T1", self.board]),
            "board_entry_without_actor_class": _registry_with_board(
                self.board, signed_fields=sorted(BOARD_VERDICT_FIELDS | {"audience", "expires_at", "signer_principal"})),
            "board_entry_unbounded_expiry": _registry_with_board(self.board, expiry_hours=None),
        }
        for name, content in cases.items():
            with self.subTest(case=name):
                self.assertIsNone(ors.parse_namespace_registry(content))

    def test_a_tip_that_drops_the_board_namespace_is_no_registry(self) -> None:
        payload = json.loads(self.registry)
        payload["namespaces"] = [e for e in payload["namespaces"] if e["namespace"] != BOARD_NAMESPACE]
        self.assertIsNone(ors.parse_namespace_registry(json.dumps(payload).encode()),
                          "every namespace the kernel speaks is registered at the tip, the Board's included")


class BoardVerdictVerificationTests(unittest.TestCase):
    """B0 exit 'imza doğrulaması': a Board verdict verifies through verify_operator_signature, and only as one."""

    def setUp(self) -> None:
        self.board = _board_class(self)
        tmp = tempfile.TemporaryDirectory(prefix="aria-board-verdict-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.board_key = mint_ed25519_key(root / "board", name="board-key")
        self.operator_key = mint_ed25519_key(root / "operator", name="operator-key")
        self.allowed = (allowed_signers_line("operator@aria.test", self.operator_key, namespace=ALL_OPERATOR_NAMESPACES)
                        + allowed_signers_line("board@aria.test", self.board_key, namespace=BOARD_NAMESPACE)).encode()
        self.namespaces = ors.parse_namespace_registry(_registry_with_board(self.board))
        self.assertIsNotNone(self.namespaces, "a registry carrying the Board class must parse")
        self.now = datetime.now(timezone.utc).replace(microsecond=0)

    def _verdict(self, **overrides: object) -> dict:
        verdict = {
            "actor_class": self.board, "audience": AUDIENCE,
            "expires_at": (self.now + timedelta(hours=24)).isoformat(),
            "verdict_id": "BV-0001", "head_sha": "a" * 40, "surface": "kernel_change_request",
            "scope": {"digest": "b" * 64}, "board_version": "c" * 40,
        }
        verdict.update(overrides)
        return verdict

    def _sign(self, subject: dict, *, key: Path, principal: str, namespace: str = BOARD_NAMESPACE) -> dict:
        tag = f"{namespace}/v1"
        return ors.sign_operator_subject(subject, namespace=namespace, domain_tag=tag, signing_key=key,
                                         signer_principal=principal)

    def _verify(self, subject: dict, namespace: str = BOARD_NAMESPACE) -> ors.OperatorRequestVerdict:
        return ors.verify_operator_signature(subject, namespace=namespace, allowed_signers=self.allowed,
                                             namespaces=self.namespaces)

    def test_a_board_signed_verdict_verifies_in_the_board_namespace(self) -> None:
        signed = self._sign(self._verdict(), key=self.board_key, principal="board@aria.test")
        verdict = self._verify(signed)
        self.assertEqual((verdict.valid, verdict.signer, verdict.reason), (True, "board@aria.test", None))

    def test_a_verdict_is_fresh_by_the_board_entry_terms(self) -> None:
        signed = self._sign(self._verdict(), key=self.board_key, principal="board@aria.test")
        entry = self.namespaces[BOARD_NAMESPACE]
        self.assertIsNone(ors.operator_act_terms_reason(signed, entry=entry, audience=AUDIENCE, now=self.now))
        self.assertEqual(ors.operator_act_terms_reason(dict(signed, actor_class="T1"), entry=entry, audience=AUDIENCE,
                                                       now=self.now), ors.ACTOR_CLASS_REFUSED)
        without_head = {k: v for k, v in signed.items() if k != "head_sha"}
        self.assertEqual(ors.operator_act_terms_reason(without_head, entry=entry, audience=AUDIENCE, now=self.now),
                         ors.SUBJECT_FIELD_MISSING)

    def test_a_tampered_verdict_does_not_verify(self) -> None:
        signed = self._sign(self._verdict(), key=self.board_key, principal="board@aria.test")
        self.assertEqual(self._verify(dict(signed, head_sha="d" * 40)).reason, ors.SIGNATURE_INVALID)

    def test_a_verdict_declaring_an_operator_class_is_refused(self) -> None:
        signed = self._sign(self._verdict(actor_class="T1"), key=self.board_key, principal="board@aria.test")
        self.assertEqual(self._verify(signed).reason, ors.ACTOR_CLASS_REFUSED)

    def test_the_operator_key_cannot_mint_a_board_verdict(self) -> None:
        signed = self._sign(self._verdict(), key=self.operator_key, principal="operator@aria.test")
        self.assertFalse(self._verify(signed).valid)

    def test_a_board_verdict_is_no_operator_act(self) -> None:
        signed = self._sign(self._verdict(), key=self.board_key, principal="board@aria.test")
        for namespace in ors.OPERATOR_NAMESPACES:
            with self.subTest(namespace=namespace):
                self.assertFalse(self._verify(signed, namespace).valid)
        # The Board key, asked to sign in an operator namespace, yields
        # nothing the verifier admits: its enrolment names the Board's alone.
        request = self._sign({"actor_class": "T1", "audience": AUDIENCE, "row_kind": "operator_request",
                              "schema_version": 2, "expires_at": self._verdict()["expires_at"]},
                             key=self.board_key, principal="board@aria.test", namespace=ors.SIGNATURE_NAMESPACE)
        self.assertEqual(self._verify(request, ors.SIGNATURE_NAMESPACE).reason, ors.SIGNATURE_INVALID)


if __name__ == "__main__":
    unittest.main()
