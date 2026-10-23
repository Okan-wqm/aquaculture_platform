"""ARIA-HIGH-519 — one table of credential shapes, and a publication boundary that redacts what the kernel refuses.

The executor's one publication boundary (``artifact_safety.scrub_text`` /
``write_sanitized_json``) redacted with ``secret_scrub``'s patterns, while the
kernel refused with ``implementation_safety.SECRET_SCAN_PATTERNS``, a separate
set. Five families the refusal fires on passed the boundary untouched:
private-key headers AND bodies, the value assigned to ``aws_secret_access_key``,
``gho_``/``ghr_`` tokens and ``DATABASE_PASSWORD=``-style values. An executor
exit that released without submitting left those bytes on the published
surface, and no kernel check ever read them. Six modules each kept their own
copy of "what a credential looks like".

These tests drive the real seams: the boundary's scrubbers, the writer, the
kernel's own refusal check (``verify_no_secret_in_envelope``), and the
consumers' module attributes. Every credential-shaped string here is built
from parts, so this file's source matches no detection shape (the DLP proof
and the kernel's diff scan read diffs that carry it).
"""
from __future__ import annotations

import ast
import json
import re
import tempfile
import unittest
from dataclasses import MISSING, fields
from pathlib import Path
from unittest import mock

from aria_kernel import artifact_safety
from aria_kernel import secret_scrub
from aria_kernel.artifact_safety import ArtifactSafetyError, scrub_text, write_sanitized_json
from aria_kernel.implementation_safety import (
    SECRET_SCAN_PATTERNS,
    SecretLeakDetected,
    verify_no_secret_in_diff,
    verify_no_secret_in_envelope,
)

KERNEL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = KERNEL_ROOT.parent

# Synthetic key material; the header words are split so no line of this file
# is a key header.
_KEY_BODY = "MIIE" + "Qk9EWQ" * 6
_BEGIN = "-----BEGIN "
_END = "-----END "


def _probe_families() -> dict[str, tuple[str, str]]:
    """(text, secret) per family the boundary left (remediate/r6/probe_scrub_gap.out)."""
    rsa_header = _BEGIN + "RSA PRIVATE KEY-----"
    rsa_footer = _END + "RSA PRIVATE KEY-----"
    pgp_header = _BEGIN + "PGP PRIVATE KEY BLOCK-----"
    pgp_footer = _END + "PGP PRIVATE KEY BLOCK-----"
    return {
        "rsa_block_real_newlines": (f"key:\n{rsa_header}\n{_KEY_BODY}\n{rsa_footer}\ntail", _KEY_BODY),
        # The escaped form an envelope's free text carries once JSON-dumped.
        "pgp_block_json_escaped": (f"{pgp_header}\\n{_KEY_BODY}\\n{pgp_footer} tail", _KEY_BODY),
        "openssh_block_truncated": (f"{_BEGIN}OPENSSH PRIVATE KEY-----\n{_KEY_BODY}", _KEY_BODY),
        # ARIA-MEDIUM-620 — the setup-token shape ARIA now holds: base64url,
        # so an underscore sits inside the first 32 body characters.
        "anthropic_setup_token": ("token " + "sk-ant-oat01-" + "Ab3_" + "Q" * 60 + " end", "Ab3_" + "Q" * 60),
        # The refusal view's own widenings: an ENCRYPTED (pkcs8 v2) block and
        # a standard-base64 bearer-style authorization token.
        "encrypted_pkcs8_block": (
            f"{_BEGIN}ENCRYPTED PRIVATE KEY-----\n{_KEY_BODY}\n{_END}ENCRYPTED PRIVATE KEY-----\nend", _KEY_BODY),
        "bearer_standard_base64": ("authorization: bearer" + " " + "m3+" * 12 + "/Q" + " end", "m3+" * 12 + "/Q"),
        "aws_secret_access_key": ("conf aws_secret_access_key" + " = " + "W" * 40 + " end", "W" * 40),
        "gho_token": ("token gh" + "o_" + "a" * 36 + " end", "a" * 36),
        "ghr_token": ("token gh" + "r_" + "b" * 36 + " end", "b" * 36),
        "database_password": ("DATABASE_" + "PASSWORD=" + "Zq7" * 6 + " end", "Zq7" * 6),
        "jwt_secret_quoted": ("JWT_" + "SECRET: '" + "Kx9" * 7 + "'", "Kx9" * 7),
    }


def _refusal_hits(text: str) -> list[str]:
    return [pattern.pattern[:40] for pattern in SECRET_SCAN_PATTERNS if pattern.search(text)]


def _surviving_runs(text: str, secret: str) -> list[str]:
    """Every four-character run of ``secret`` still in ``text``.

    "The secret is gone" means no piece of it is left, not that the whole
    string is: a redaction that stops one character into the value leaves
    all the rest, and a whole-string check passes it.
    """
    width = min(4, len(secret))
    return sorted({secret[i:i + width] for i in range(len(secret) - width + 1) if secret[i:i + width] in text})


def _spanned_by_one_match(pattern: re.Pattern[str], text: str, secret: str) -> bool:
    start = text.index(secret)
    end = start + len(secret)
    return any(match.start() <= start and end <= match.end() for match in pattern.finditer(text))


class BoundaryRedactsWhatTheKernelRefusesTest(unittest.TestCase):
    """Reproduction through the boundary's real scrubbers (red before the fix)."""

    def test_artifact_scrub_leaves_no_refusal_shape_and_no_secret(self) -> None:
        for family, (text, secret) in _probe_families().items():
            with self.subTest(family=family):
                out = scrub_text(text)
                self.assertEqual(_refusal_hits(out), [])
                self.assertEqual(_surviving_runs(out, secret), [])

    def test_typed_scrub_removes_the_secret_too(self) -> None:
        # The cross-review scrubber, hooks' argv journal and progress previews
        # read the same redact view through secret_scrub.scrub_text.
        for family, (text, secret) in _probe_families().items():
            with self.subTest(family=family):
                out, kinds = secret_scrub.scrub_text(text)
                self.assertEqual(_surviving_runs(out, secret), [])
                self.assertTrue(kinds)

    def test_written_envelope_passes_the_kernels_own_refusal(self) -> None:
        for family, (text, secret) in _probe_families().items():
            with self.subTest(family=family), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "envelope.json"
                write_sanitized_json(path, {
                    "summary": text,
                    "notes": [f"quoted: {text}"],
                    "evidence_refs": ["apps/x.ts:12"],
                })
                raw = path.read_text(encoding="utf-8")
                self.assertEqual(_surviving_runs(raw, secret), [])
                written = json.loads(raw)
                verify_no_secret_in_envelope(written)  # the kernel's submit check
                self.assertEqual(written["evidence_refs"], ["apps/x.ts:12"])

    def test_a_refusal_shape_the_redaction_misses_is_never_written(self) -> None:
        # Inject a table without a redact view: the writer must refuse, not
        # publish what the kernel would refuse.
        text, _secret = _probe_families()["rsa_block_real_newlines"]
        no_redact_view = tuple(row for row in secret_scrub.CREDENTIAL_SHAPES if "redact" not in row.views)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(secret_scrub, "CREDENTIAL_SHAPES", no_redact_view):
            self.assertEqual(scrub_text(text), text)
            path = Path(tmp) / "envelope.json"
            with self.assertRaises(ArtifactSafetyError) as caught:
                write_sanitized_json(path, {"summary": text})
            self.assertFalse(path.exists())
            self.assertNotIn(_KEY_BODY, str(caught.exception))

    def test_a_credential_in_a_dict_key_is_never_written(self) -> None:
        # Keys are not rewritten (two keys could collapse into one); a key
        # carrying a credential the redact view knows is refused instead of
        # published, whether or not the refusal set knows the shape too.
        keys = {
            "refusal_shape": "gh" + "p_" + "c" * 36,
            "short_github_token": "gh" + "p_" + "e" * 24,
            "project_key": "sk" + "-proj_" + "d" * 24,
            "named_env_assignment": "OPENAI_API_KEY" + "=" + "f" * 12,
            "password_assignment": "password" + "='" + "g" * 8 + "'",
        }
        for label, key in keys.items():
            for payload in ({key: 1}, {"outer": [{key: 1}]}, {"outer": ({key: 1},)}):
                with self.subTest(key=label, payload=type(payload["outer"]).__name__ if "outer" in payload else "top"):
                    with tempfile.TemporaryDirectory() as tmp:
                        path = Path(tmp) / "envelope.json"
                        with self.assertRaises(ArtifactSafetyError) as caught:
                            write_sanitized_json(path, payload)
                        self.assertFalse(path.exists())
                        self.assertNotIn(key, str(caught.exception))

    def test_a_map_keyed_by_personal_data_stays_writable(self) -> None:
        # PII rows are redacted in values but are no credential: a map keyed
        # by an address or an e-mail is written with its keys.
        address = ".".join(("198", "51", "100", "23"))
        mail = "ops" + "@" + "example.org"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "envelope.json"
            write_sanitized_json(path, {address: 1, mail: 2})
            self.assertEqual(sorted(json.loads(path.read_text(encoding="utf-8"))), sorted([address, mail]))

    def test_strings_inside_a_tuple_are_redacted(self) -> None:
        # json.dumps writes a tuple as an array; its strings are published too.
        secret = "h" * 24
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "envelope.json"
            write_sanitized_json(path, {"notes": ("key " + "sk" + "-proj_" + secret,)})
            self.assertEqual(_surviving_runs(path.read_text(encoding="utf-8"), secret), [])

    def test_a_refusal_hit_formed_by_json_escaping_is_refused(self) -> None:
        # No raw substring is a refusal hit, so redaction has nothing to
        # rewrite; json.dumps escapes the e-circumflex as a sequence ending
        # in "a", and the bytes it would write are refused (fail closed).
        value = "x" + chr(0xEA) + "ws_secret_access_key" + "=" + chr(0x1A)
        self.assertEqual(_refusal_hits(value), [])
        self.assertEqual(scrub_text(value), value)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "envelope.json"
            with self.assertRaises(ArtifactSafetyError):
                write_sanitized_json(path, {"summary": value})
            self.assertFalse(path.exists())

    def test_reference_shapes_survive_the_boundary_unchanged(self) -> None:
        for text in (
            "apps/x.ts:12",
            "aria-kernel/aria_kernel/secret_scrub.py:36",
            "0123456789abcdef" * 4,
            "sha256:" + "0123456789abcdef" * 4,
            "SHA256:" + "U3ludGhldGljRmluZ2VycHJpbnRGb3JBVGVzdE9ubHkx"[:43],
            "commit 99689e46b8f1d3c1e4a5b6c7d8e9f0a1b2c3d4e5",
        ):
            with self.subTest(text=text):
                self.assertEqual(scrub_text(text), text)
                self.assertEqual(secret_scrub.scrub_text(text), (text, []))


class CredentialTableTest(unittest.TestCase):
    """The one table: every row complete, every consumer reading its view."""

    def test_every_field_is_required(self) -> None:
        from aria_kernel.secret_scrub import CredentialShape

        for field in fields(CredentialShape):
            with self.subTest(field=field.name):
                self.assertIs(field.default, MISSING)
                self.assertIs(field.default_factory, MISSING)

    def test_every_row_detects_its_fixture_and_redacts_its_secret(self) -> None:
        from aria_kernel.secret_scrub import CREDENTIAL_SHAPES, CREDENTIAL_VIEWS

        self.assertTrue(CREDENTIAL_SHAPES)
        for row in CREDENTIAL_SHAPES:
            with self.subTest(row=row.name, views=sorted(row.views)):
                self.assertTrue(row.views)
                self.assertLessEqual(row.views, CREDENTIAL_VIEWS)
                self.assertIn(row.fixture_secret, row.fixture)
                self.assertIsNotNone(row.detect.search(row.fixture))
                self.assertTrue(_spanned_by_one_match(row.redact, row.fixture, row.fixture_secret))
                self.assertEqual(_surviving_runs(row.redact.sub("<x>", row.fixture), row.fixture_secret), [])

    def test_names_are_unique_within_each_view(self) -> None:
        from aria_kernel.secret_scrub import CREDENTIAL_VIEWS, shapes_in

        for view in CREDENTIAL_VIEWS:
            names = [row.name for row in shapes_in(view)]
            with self.subTest(view=view):
                self.assertTrue(names)
                self.assertEqual(len(names), len(set(names)))

    def test_every_refusal_row_is_redacted_by_the_boundary(self) -> None:
        from aria_kernel.secret_scrub import shapes_in

        for row in shapes_in("refuse"):
            with self.subTest(row=row.name):
                out = scrub_text(row.fixture)
                self.assertEqual(_refusal_hits(out), [])
                self.assertEqual(_surviving_runs(out, row.fixture_secret), [])

    def test_an_unknown_view_is_refused(self) -> None:
        from aria_kernel.secret_scrub import CredentialTableError, shapes_in

        with self.assertRaises(CredentialTableError):
            shapes_in("published")

    def test_a_row_whose_redaction_misses_its_secret_cannot_be_built(self) -> None:
        from aria_kernel.secret_scrub import CredentialShape, CredentialTableError

        with self.assertRaises(CredentialTableError):
            CredentialShape(
                name="header_only", kind="credential",
                detect=re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
                redact=re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
                views=frozenset({"refuse"}),
                fixture=_BEGIN + "EC PRIVATE KEY-----\n" + _KEY_BODY,
                fixture_secret=_KEY_BODY,
            )

    def test_a_row_whose_redaction_keeps_one_character_of_its_secret_cannot_be_built(self) -> None:
        # Near-total redaction is a leak: one value character redacted, the
        # other thirty-nine published.
        from aria_kernel.secret_scrub import CredentialShape, CredentialTableError

        with self.assertRaises(CredentialTableError) as caught:
            CredentialShape(
                name="one_value_character", kind="credential",
                detect=re.compile(r"aws_secret_access_key\s*[:=]"),
                redact=re.compile(r"aws_secret_access_key\s*[:=]\s*\S"),
                views=frozenset({"refuse"}),
                fixture="aws_secret_access_key" + " = " + "W" * 40,
                fixture_secret="W" * 40,
            )
        self.assertIn("redact_leaves_part_of_fixture_secret", str(caught.exception))

    def test_the_named_secret_redaction_runs_to_the_end_of_the_value(self) -> None:
        # The refusal regex stops at the first character outside its class;
        # as a redactor it leaves the value's tail. The table row's fixture
        # carries such a tail, so a row redacting with the refusal regex
        # cannot be built, and the boundary removes the tail.
        from aria_kernel.secret_scrub import CredentialShape, CredentialTableError, shapes_in

        row = next(row for row in shapes_in("redact") if row.name == "named_secret_assignment")
        tail_start = re.search(r"[^A-Za-z0-9+/=_-]", row.fixture_secret)
        self.assertIsNotNone(tail_start)
        with self.assertRaises(CredentialTableError):
            CredentialShape(
                name="refusal_regex_as_redactor", kind="credential", detect=row.detect, redact=row.detect,
                views=frozenset({"refuse"}), fixture=row.fixture, fixture_secret=row.fixture_secret,
            )
        self.assertEqual(_surviving_runs(scrub_text(row.fixture + "#tail9"), row.fixture_secret + "#tail9"), [])

    def test_a_table_where_an_earlier_row_cuts_into_a_later_value_cannot_be_built(self) -> None:
        # Each row alone spans its secret; in order, the first one eats the
        # key name and two value characters of the AWS row, which then no
        # longer matches, so 38 of its 40 value characters would be published.
        from aria_kernel.secret_scrub import CREDENTIAL_SHAPES, CredentialShape, CredentialTableError, validate_credential_table

        aws = next(row for row in CREDENTIAL_SHAPES if row.name == "aws_secret_access_key" and "redact" in row.views)
        head = aws.fixture_secret[:2]
        eats_head = CredentialShape(
            name="eats_head", kind="credential",
            detect=re.compile(re.escape("key = " + head)), redact=re.compile(re.escape("key = " + head)),
            views=frozenset({"redact"}), fixture="key = " + head, fixture_secret=head,
        )
        with self.assertRaises(CredentialTableError) as caught:
            validate_credential_table((eats_head, *CREDENTIAL_SHAPES))
        self.assertIn("redact_view_leaves_secret:aws_secret_access_key", str(caught.exception))

    def test_a_table_whose_redact_view_misses_a_refusal_row_cannot_be_built(self) -> None:
        from aria_kernel.secret_scrub import CREDENTIAL_SHAPES, CredentialTableError, validate_credential_table

        key_rows = {row for row in CREDENTIAL_SHAPES if "redact" in row.views and "PRIVATE KEY" in row.redact.pattern}
        self.assertTrue(key_rows)
        validate_credential_table(CREDENTIAL_SHAPES)
        with self.assertRaises(CredentialTableError):
            validate_credential_table(tuple(row for row in CREDENTIAL_SHAPES if row not in key_rows))

    def test_the_refusal_set_is_the_refuse_view(self) -> None:
        from aria_kernel.secret_scrub import refusal_patterns

        self.assertEqual(SECRET_SCAN_PATTERNS, frozenset(refusal_patterns()))
        self.assertEqual(len(refusal_patterns()), len(SECRET_SCAN_PATTERNS))

    def test_the_boundary_runs_the_tables_one_redaction_loop(self) -> None:
        from aria_kernel.secret_scrub import secret_pattern_types, shapes_in

        rows = shapes_in("redact")
        self.assertEqual(secret_pattern_types(), tuple(row.name for row in rows))
        text = "probe " + _probe_families()["gho_token"][0]
        with mock.patch.object(secret_scrub, "_redact_counted", wraps=secret_scrub._redact_counted) as loop:
            artifact_safety.scrub_text(text)
            secret_scrub.scrub_text(text)
            secret_scrub.scrub_text_with_count(text)
        self.assertEqual(
            [(call.args, call.kwargs) for call in loop.call_args_list],
            [((rows, text), {"typed": False}), ((rows, text), {"typed": True}), ((rows, text), {"typed": True})],
        )
        # Specific before generic: the key block runs first so no shorter
        # row splits it, and its PEM body is never seen by the others.
        self.assertIn("PRIVATE KEY", rows[0].redact.pattern)

    def test_dlp_system_one_harness_and_habitat_read_their_views(self) -> None:
        import sys

        from aria_kernel import habitat, readiness_proofs, system_one
        from aria_kernel.secret_scrub import shapes_in, view_alternation
        from aria_kernel.security import vault

        self.assertEqual(readiness_proofs.DLP_PATTERNS, tuple((row.name, row.detect) for row in shapes_in("dlp")))
        self.assertEqual(system_one._EXTRA_SECRET, view_alternation("system_one"))
        self.assertEqual(habitat._PERSONAL_TOKEN_RE, view_alternation("habitat"))
        self.assertEqual(vault._REDACT_VALUES, view_alternation("vault"))
        sys.path.insert(0, str(REPO_ROOT / "tools" / "aria-poc"))
        try:
            import agent_harness_security_adapter as harness  # type: ignore[import-not-found]
        finally:
            sys.path.remove(str(REPO_ROOT / "tools" / "aria-poc"))
        self.assertEqual(
            [(name, pattern.pattern) for name, pattern in harness._SECRET_RES],
            [(row.name, row.detect.pattern) for row in shapes_in("harness")],
        )

    def test_the_broker_reads_the_armour_shape_from_the_table(self) -> None:
        # token_broker restated the BEGIN/END regexes (run 39744490984, shard
        # 2); it now asks the table, which keeps its input check exact.
        body = "MIIE" + "U3ludGhldGljS2V5Qm9keQ" * 3
        rsa = "RSA PRIVATE" + " KEY"

        def armour(begin: str, end: str) -> str:
            return "\n".join((f"-----BEGIN {begin}-----", body, f"-----END {end}-----"))

        self.assertTrue(secret_scrub.is_armoured_private_key(armour(rsa, rsa) + "\n"))
        self.assertFalse(secret_scrub.is_armoured_private_key(armour(rsa, "EC PRIVATE" + " KEY")))
        self.assertFalse(secret_scrub.is_armoured_private_key(armour("PGP PRIVATE" + " KEY BLOCK",
                                                                     "PGP PRIVATE" + " KEY BLOCK")))
        self.assertFalse(secret_scrub.is_armoured_private_key(armour(rsa, rsa).replace(body + "\n", "")))
        self.assertFalse(secret_scrub.is_armoured_private_key("x\n" + armour(rsa, rsa)))

    def test_system_one_excludes_exactly_the_pii_rows(self) -> None:
        from aria_kernel.secret_scrub import pii_shape_names, shapes_in

        self.assertEqual(pii_shape_names(), frozenset({"email", "ipv4_octet"}))
        self.assertEqual(
            pii_shape_names(), frozenset(row.name for row in shapes_in("redact") if row.kind == "pii"),
        )


class OneOwnerTest(unittest.TestCase):
    """No second copy of a credential shape with a distinctive literal grows outside the table.

    The scan knows every family whose shape carries a distinctive literal
    (a token prefix, a key header, a named variable, the JWT header, the
    authorization scheme word). It cannot see families built only from
    common words (``password``/``token``/``secret`` assignments, ``sk-``):
    those words fill unrelated regexes across the kernel, so a marker for
    them would flag every one. A copy of those shapes is a review matter.
    """

    # Distinctive fragments of the table's families. A string constant that
    # carries one AND a regex metacharacter is a detection or redaction shape.
    MARKERS = (
        "AKIA", "ghp_", "gho_", "ghs_", "ghu_", "ghr_", "gh[p", "ghp|", "github_pat", "sk-ant-", "PRIVATE KEY",
        "sk_live", "[sr]k_", "whsec", "dop_v1", "glpat", "AIza", "xox", "hooks\\.slack", "_authToken",
        "aws_secret_access_key", "JWT_SECRET", "DATABASE_PASSWORD", "Bearer", "bearer", "eyJ", "SG\\.",
        "npm_", "apikey_",
    )
    REGEX_METACHARACTERS = frozenset("[](){}|\\*+?")
    OWNER = KERNEL_ROOT / "aria_kernel" / "secret_scrub.py"

    def _scanned_modules(self) -> list[Path]:
        kernel = sorted((KERNEL_ROOT / "aria_kernel").rglob("*.py"))
        poc = sorted(
            path for path in (REPO_ROOT / "tools" / "aria-poc").rglob("*.py")
            if "invariants" not in path.parts and "tests" not in path.parts
        )
        return [path for path in kernel + poc if path != self.OWNER]

    @staticmethod
    def _docstring_nodes(tree: ast.AST) -> set[int]:
        ids: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                body = node.body
                if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                    ids.add(id(body[0].value))
        return ids

    def test_no_credential_shape_lives_outside_the_table(self) -> None:
        copies: list[str] = []
        for path in self._scanned_modules():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            docstrings = self._docstring_nodes(tree)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Constant) or not isinstance(node.value, str) or id(node) in docstrings:
                    continue
                if any(marker in node.value for marker in self.MARKERS) and self.REGEX_METACHARACTERS & set(node.value):
                    copies.append(f"{path.relative_to(REPO_ROOT)}:{node.lineno}")
        self.assertEqual(copies, [])

    def test_the_table_is_a_standard_library_leaf(self) -> None:
        # The harness adapter loads this one file by path, without the
        # aria_kernel package (whose __init__ imports some sixty modules), so
        # the table may import nothing but the standard library.
        import sys

        tree = ast.parse(self.OWNER.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, "a relative import ties the table to the package")
                imported.add(str(node.module).split(".")[0])
            elif isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
        self.assertLessEqual(imported - {"__future__"}, set(sys.stdlib_module_names))

    def test_the_table_and_this_test_match_no_detection_shape(self) -> None:
        # The harness adapter scans aria_kernel/**; the DLP proof and the
        # kernel's diff scan read diffs. The table's own text and this file
        # must trip none of them.
        from aria_kernel.secret_scrub import CREDENTIAL_SHAPES

        for source in (self.OWNER, Path(__file__)):
            text = source.read_text(encoding="utf-8")
            hits = sorted({row.name for row in CREDENTIAL_SHAPES if row.detect.search(text)})
            with self.subTest(source=source.name):
                self.assertEqual(hits, [])
            with self.subTest(source=source.name, check="kernel diff scan"):
                try:
                    verify_no_secret_in_diff(text)
                except SecretLeakDetected as exc:  # pragma: no cover - the failure message is the evidence
                    self.fail(str(exc))


if __name__ == "__main__":
    unittest.main()
