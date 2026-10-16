"""``aria_kernel.digest`` owns the ``sha256:<64 lowercase hex>`` format (ARIA-LOW-517, E11-4 part C1).

WHY THIS EXISTS. No module owned the format: about 150 sites re-spelled the
``sha256:`` label, the validators diverged (``re.match`` that accepts a
trailing newline, prefix-only gates, ``len == 71``), and seven producers mint
a *truncated* hex under the same label, so a value that looks like a digest is
not one. ``digest.py`` is the one owner of the label, the producers, the
parsers, the validator, the legacy-bare policy, the truncated *fingerprint*
form and the named sentinels; ``ledger.sha256_digest_of_canonical_json`` is the
one composed form over the kernel's canonical encoder.

WHAT THESE TESTS PIN. The owner's contract, value by value (the FIPS 180-2
vector, file == bytes at the chunk boundaries, the validator's accepted set,
the strict parsers, the fingerprint/digest disjointness), that the owner stays
a stdlib leaf, and that ``ledger`` holds no second validator. The persisted
bytes the later migration must not move are pinned separately, in
``test_digest_byte_pins.py``.
"""
from __future__ import annotations

import ast
import hashlib
import re
import tempfile
import unittest
from pathlib import Path

from aria_kernel import digest, ledger
from aria_kernel.ledger import LedgerIntegrityError

# FIPS 180-2, appendix B.1: SHA-256("abc").
_FIPS_ABC_HEX = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
_EMPTY_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
_LABEL = "sha256:"
_FULL = _LABEL + "a" * 64
_MIB = 1 << 20

# Values a field validated as a digest must refuse. The first six are the
# wave-1 A3-5 cases (ARIA-LOW-491); the rest are what a widened ``object``
# parameter and the owner's non-digest members add.
_NOT_DIGESTS: tuple[object, ...] = (
    _LABEL + "A" * 64,
    _LABEL + "a" * 63,
    _LABEL + "a" * 65,
    _FULL + "\n",
    "a" * 64,
    "",
    " " + _FULL,
    _LABEL + "g" * 64,
    "SHA256:" + "a" * 64,
    None,
    5,
    _FULL.encode("ascii"),
    digest.ENVELOPE_UNREADABLE_SENTINEL,
    digest.sha256_fingerprint(b"x", hex_chars=24),
)


class DigestProducerTests(unittest.TestCase):
    def test_fips_vector(self) -> None:
        self.assertEqual(digest.sha256_hex(b"abc"), _FIPS_ABC_HEX)
        self.assertEqual(digest.sha256_digest(b"abc"), _LABEL + _FIPS_ABC_HEX)
        self.assertEqual(digest.sha256_digest_text("abc"), _LABEL + _FIPS_ABC_HEX)
        self.assertEqual(digest.sha256_digest(b""), _LABEL + _EMPTY_HEX)

    def test_text_is_strict_utf8(self) -> None:
        self.assertEqual(digest.sha256_digest_text("é"), digest.sha256_digest("é".encode("utf-8")))
        with self.assertRaises(UnicodeEncodeError):
            digest.sha256_digest_text("\ud800")

    def test_file_digest_equals_bytes_digest_across_chunk_boundaries(self) -> None:
        pattern = bytes(range(256))
        with tempfile.TemporaryDirectory() as tmp:
            for size in (0, _MIB - 1, _MIB, 3 * _MIB + 17):
                with self.subTest(size=size):
                    data = (pattern * (size // len(pattern) + 1))[:size]
                    path = Path(tmp) / f"blob-{size}"
                    path.write_bytes(data)
                    self.assertEqual(digest.sha256_digest_file(path), digest.sha256_digest(data))
                    self.assertEqual(digest.sha256_digest_file(str(path)), digest.sha256_digest(data))

    def test_file_digest_states_no_missing_file_policy(self) -> None:
        # The caller owns its missing-file policy; the owner never mints the
        # empty-bytes digest for a file that does not exist.
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(FileNotFoundError):
            digest.sha256_digest_file(Path(tmp) / "absent")

    def test_from_hex_labels_only_a_full_lowercase_hex(self) -> None:
        self.assertEqual(digest.sha256_digest_from_hex(_FIPS_ABC_HEX), _LABEL + _FIPS_ABC_HEX)
        for rejected in ("a" * 63, "a" * 65, "A" * 64, "a" * 64 + "\n", "", _FULL, "g" * 64, None, 64):
            with self.subTest(value=rejected), self.assertRaises(ValueError):
                digest.sha256_digest_from_hex(rejected)

    def test_sentinels(self) -> None:
        self.assertEqual(digest.ZERO_SHA256_DIGEST, _LABEL + "0" * 64)
        self.assertTrue(digest.is_sha256_digest(digest.ZERO_SHA256_DIGEST))
        self.assertEqual(digest.ENVELOPE_UNREADABLE_SENTINEL, _LABEL + "envelope_unreadable")
        self.assertFalse(digest.is_sha256_digest(digest.ENVELOPE_UNREADABLE_SENTINEL))


class DigestValidatorAndParserTests(unittest.TestCase):
    def test_validator_accepts_only_the_full_lowercase_shape(self) -> None:
        self.assertTrue(digest.is_sha256_digest(_FULL))
        self.assertTrue(digest.is_sha256_digest(digest.sha256_digest(b"abc")))
        for rejected in _NOT_DIGESTS:
            with self.subTest(value=rejected):
                self.assertFalse(digest.is_sha256_digest(rejected))

    def test_pattern_fragment_speaks_the_validator_language(self) -> None:
        # The fragment exists for composite grammars only; whole-value checks
        # go through is_sha256_digest. Both must agree on every string.
        pattern = re.compile(digest.SHA256_DIGEST_PATTERN)
        for value in (_FULL, digest.ZERO_SHA256_DIGEST, *_NOT_DIGESTS):
            if isinstance(value, str):
                with self.subTest(value=value):
                    self.assertEqual(pattern.fullmatch(value) is not None, digest.is_sha256_digest(value))

    def test_digest_hex_returns_the_body_of_a_full_digest_only(self) -> None:
        self.assertEqual(digest.sha256_digest_hex(_LABEL + _FIPS_ABC_HEX), _FIPS_ABC_HEX)
        for rejected in _NOT_DIGESTS:
            with self.subTest(value=rejected):
                self.assertIsNone(digest.sha256_digest_hex(rejected))

    def test_normalize_owns_the_legacy_bare_policy(self) -> None:
        self.assertEqual(digest.normalize_sha256_digest(_FIPS_ABC_HEX), _LABEL + _FIPS_ABC_HEX)
        self.assertEqual(digest.normalize_sha256_digest(_FULL), _FULL)
        for rejected in ("A" * 64, _LABEL + "A" * 64, "a" * 63, " " + "a" * 64, "a" * 64 + "\n", None, 5,
                         digest.ENVELOPE_UNREADABLE_SENTINEL, digest.sha256_fingerprint(b"x", hex_chars=32)):
            with self.subTest(value=rejected):
                self.assertIsNone(digest.normalize_sha256_digest(rejected))

    def test_secret_match(self) -> None:
        stored = digest.sha256_digest_text("lease-token")
        self.assertTrue(digest.secret_matches_sha256_digest("lease-token", stored))
        self.assertFalse(digest.secret_matches_sha256_digest("other-token", stored))
        for stored_value in (None, 5, stored.upper(), stored[len(_LABEL):], stored + "\n"):
            with self.subTest(stored=stored_value):
                self.assertFalse(digest.secret_matches_sha256_digest("lease-token", stored_value))


class DigestFingerprintTests(unittest.TestCase):
    def test_length_bounds(self) -> None:
        for hex_chars in (0, -1, 64, 65, True, False, 24.0):
            with self.subTest(hex_chars=hex_chars), self.assertRaises(ValueError):
                digest.sha256_fingerprint(b"x", hex_chars=hex_chars)

    def test_byte_equal_to_the_truncations_it_replaces(self) -> None:
        data = b"ci_failure|run-42"
        for hex_chars in (16, 20, 24, 32):
            with self.subTest(hex_chars=hex_chars):
                self.assertEqual(
                    digest.sha256_fingerprint(data, hex_chars=hex_chars),
                    "sha256:" + hashlib.sha256(data).hexdigest()[:hex_chars],
                )

    def test_a_fingerprint_is_never_a_digest(self) -> None:
        for hex_chars in range(1, 64):
            fingerprint = digest.sha256_fingerprint(b"abc", hex_chars=hex_chars)
            with self.subTest(hex_chars=hex_chars):
                self.assertFalse(digest.is_sha256_digest(fingerprint))
                self.assertIsNone(digest.normalize_sha256_digest(fingerprint))
                self.assertEqual(digest.sha256_fingerprint_hex(fingerprint), _FIPS_ABC_HEX[:hex_chars])

    def test_fingerprint_hex_refuses_non_fingerprints(self) -> None:
        for rejected in (_FULL, _LABEL, _LABEL + "A" * 8, "a" * 8, _LABEL + "a" * 8 + "\n", None, 5):
            with self.subTest(value=rejected):
                self.assertIsNone(digest.sha256_fingerprint_hex(rejected))


class DigestOwnerShapeTests(unittest.TestCase):
    _SOURCE = Path(digest.__file__)

    def test_owner_is_a_stdlib_leaf(self) -> None:
        # tools/aria-poc imports the owner lazily on kernel-dependent paths; a
        # kernel import here would drag the kernel into every such closure and
        # a ledger import would be a cycle (ledger composes over the owner).
        allowed = {"__future__", "hashlib", "hmac", "re", "pathlib", "typing"}
        tree = ast.parse(self._SOURCE.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, "a relative import makes the owner a non-leaf")
                imported.add(str(node.module).split(".")[0])
        self.assertLessEqual(imported, allowed)

    def test_all_names_exactly_the_public_definitions_and_the_label_stays_private(self) -> None:
        tree = ast.parse(self._SOURCE.read_text(encoding="utf-8"))
        defined: set[str] = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                defined.add(node.name)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                defined.add(node.target.id)
            elif isinstance(node, ast.Assign):
                defined.update(t.id for t in node.targets if isinstance(t, ast.Name))
        public = {name for name in defined if not name.startswith("_")}
        self.assertEqual(sorted(digest.__all__), sorted(public))
        self.assertNotIn("_PREFIX", digest.__all__)
        # No exported value is the bare label: a prefix-only check cannot be
        # written against a public constant.
        self.assertNotIn(_LABEL, [getattr(digest, name) for name in digest.__all__])


class LedgerComposesOverTheOwnerTests(unittest.TestCase):
    def test_ledger_holds_no_second_validator(self) -> None:
        self.assertIs(ledger.is_sha256_digest, digest.is_sha256_digest)
        self.assertNotIn("_LEDGER_EVENT_ID", vars(ledger))

    def test_ledger_validator_refuses_a_non_string(self) -> None:
        # Before the move ``re.fullmatch(None)`` raised TypeError.
        self.assertFalse(ledger.is_sha256_digest(None))
        self.assertFalse(ledger.is_sha256_digest(5))

    def test_sha256_digest_of_canonical_json(self) -> None:
        self.assertEqual(
            ledger.sha256_digest_of_canonical_json({"b": 1, "a": 2}),
            digest.sha256_digest(b'{"a":2,"b":1}'),
        )
        for value in ({"b": 1, "a": [2, "é"]}, [{"z": None}, True], "text", 0):
            with self.subTest(value=value):
                self.assertEqual(
                    ledger.sha256_digest_of_canonical_json(value),
                    digest.sha256_digest_from_hex(ledger.sha256_of_canonical_json(value)),
                )

    def test_replay_transport_refuses_a_non_string_producer_identity(self) -> None:
        # Before: ``_LEDGER_EVENT_ID.fullmatch(None)`` raised TypeError out of
        # the builder instead of the ledger's own integrity error.
        payload = {"schema_version": 1, "event": "cost_observed"}
        valid_id = ledger._record_hash(payload, None)
        cases = (
            ({"producer_event_id": None, "producer_previous_ledger_hash": None},
             "replay_transport_producer_identity_invalid"),
            ({"producer_event_id": valid_id, "producer_previous_ledger_hash": 5},
             "replay_transport_producer_previous_identity_invalid"),
        )
        for identities, reason in cases:
            with self.subTest(reason=reason), self.assertRaisesRegex(LedgerIntegrityError, reason):
                ledger._make_replay_transport_row(
                    payload,
                    expected_surface="cost_attribution",
                    surface_instance="cost-attribution/2026-08.jsonl",
                    replay_transaction_id="g006-digest-owner",
                    **identities,
                )


if __name__ == "__main__":
    unittest.main()
