"""ARIA-MEDIUM-546 — the publication boundary redacts every credential the kernel detects.

``secret_scrub.CREDENTIAL_SHAPES`` is the one credential table, but its proof
held the redact view only against the redact and refuse rows. 24 credential rows
that the dlp, harness, ``system_one`` and vault views detect left
``artifact_safety.scrub_text`` unredacted: Stripe live keys, SendGrid,
DigitalOcean and Google API keys, Slack tokens and webhooks, JWTs, npm and GitLab
tokens, password lines. Those are the families the runner's host holds, and
nothing else refuses them before aria/state is pushed. The GitHub token family
also had a second prefix list (``github_writes._TOKEN_CLASSES``), and the
habitat view missed ``ghr_`` (a refresh token acts as the user).

These tests drive the real boundary (``artifact_safety.scrub_text``,
``published_text``, ``scrub_transcript``, ``write_sanitized_json``), the table's
import-time proof, ``github_writes.credential_class`` and the habitat probe's
pattern. Every credential-shaped string is assembled from parts, so this file's
text matches no detection shape.
"""
from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from aria_kernel import github_writes, habitat, secret_scrub
from aria_kernel.artifact_safety import published_text, scrub_text, scrub_transcript, write_sanitized_json
from aria_kernel.implementation_safety import SECRET_SCAN_PATTERNS, SecretLeakDetected, verify_no_secret_in_diff


def _surviving_runs(text: str, secret: str) -> list[str]:
    width = min(4, len(secret))
    return sorted({secret[i:i + width] for i in range(len(secret) - width + 1) if secret[i:i + width] in text})


def _refusal_hits(text: str) -> list[str]:
    return [pattern.pattern[:40] for pattern in SECRET_SCAN_PATTERNS if pattern.search(text)]


def _reported_families() -> dict[str, tuple[str, str]]:
    """(text, secret) per family the triage found unredacted, as an agent or a tool would print it."""
    stripe = "a1B2c3D4e5F6g7H8i9J0k1L2"
    webhook = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3"
    sendgrid = "Qq1Rr2Ss3Tt4Uu5Vv6Ww7Xx8Yy9Zz0Aa1Bb2Cc3Dd4Ee5"
    ocean = "0123456789abcdef" * 4
    google = "Sy" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J"
    slack = "1234567890-0987654321-AbCdEfGhIjKlMnOp"
    hook = "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"
    jwt_sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    npm = "Nn1Mm2Ll3Kk4Jj5Hh6Gg7Ff8Dd9Ss0Aa1Qq2Ww3"
    gitlab = "Gg1Ll2Aa3Bb4Pp5Aa6Tt7Xx"
    return {
        "stripe_live": ("STRIPE key " + "sk" + "_live_" + stripe, stripe),
        "stripe_restricted": ("key " + "rk" + "_live_" + stripe, stripe),
        "stripe_webhook": ("secret " + "wh" + "sec_" + webhook, webhook),
        "sendgrid": ("mail key " + "S" + "G." + "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H" + "." + sendgrid, sendgrid),
        "digitalocean": ("doctl auth " + "do" + "p_v1_" + ocean, ocean),
        "google_api": ("maps " + "AI" + "za" + google, google),
        "slack_bot": ("slack " + "xo" + "xb-" + slack, slack),
        "slack_webhook": ("post https://hooks.slack.com/" + "services/" + hook, hook),
        "jwt": ("session " + "ey" + "JhbGciOiJIUzI1NiJ9" + ".ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0." + jwt_sig, jwt_sig),
        "npm_token": ("//registry.npmjs.org/:" + "_auth" + "Token=" + "np" + "m_" + npm, npm),
        "gitlab": ("remote " + "gl" + "pat-" + gitlab, gitlab),
        "url_password": ("db " + "postgres://app:" + "Pw9xQ2mZ7vL4" + "@db:5432/x", "Pw9xQ2mZ7vL4"),
        "quoted_password": ("PASSWORD" + ' = "' + "Hk7Pq2Zt" + '"', "Hk7Pq2Zt"),
        "env_line": ("$ cat .env\nexport STRIPE_API_KEY" + "=" + "Vb3Nm8Qw1Er6", "Vb3Nm8Qw1Er6"),
    }


class EveryDetectedCredentialIsRedacted(unittest.TestCase):
    def test_every_credential_row_of_every_view_leaves_the_boundary_redacted(self) -> None:
        rows = [row for row in secret_scrub.CREDENTIAL_SHAPES if row.kind == "credential"]
        self.assertGreater(len(rows), 40)
        for row in rows:
            with self.subTest(row=row.name, views=sorted(row.views)):
                for out in (scrub_text(row.fixture), secret_scrub.scrub_text(row.fixture)[0]):
                    self.assertEqual(_surviving_runs(out, row.fixture_secret), [])
                    self.assertEqual(_refusal_hits(out), [])

    def test_the_reported_families_leave_no_secret_on_any_published_surface(self) -> None:
        for family, (text, secret) in _reported_families().items():
            with self.subTest(family=family):
                self.assertEqual(_surviving_runs(scrub_text(f"before {text} after"), secret), [])
                self.assertEqual(_surviving_runs(published_text(text, store_root=None, limit=4000), secret), [])
                event = json.dumps({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": f"$ cat .env\n{text}\n"}]}})
                transcript = scrub_transcript(event + "\n")
                self.assertEqual(_surviving_runs(transcript, secret), [])
                json.loads(transcript)
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "envelope.json"
                    write_sanitized_json(path, {"summary": text, "notes": [text]})
                    self.assertEqual(_surviving_runs(path.read_text(encoding="utf-8"), secret), [])

    def test_a_table_whose_redact_view_misses_a_detected_row_cannot_be_built(self) -> None:
        # Drop every redact row that covers Stripe keys: the dlp and system_one
        # rows still detect them, so the table must refuse to load.
        without_stripe_redaction = tuple(
            row for row in secret_scrub.CREDENTIAL_SHAPES
            if not ("redact" in row.views and row.redact.search("sk" + "_live_" + "a1B2c3D4e5F6g7H8i9"))
        )
        with self.assertRaises(secret_scrub.CredentialTableError) as caught:
            secret_scrub.validate_credential_table(without_stripe_redaction)
        self.assertIn("redact_view_leaves_secret:stripe_live_key", str(caught.exception))


class ReferenceShapesSurvive(unittest.TestCase):
    """The negative half of the proof: what a finding or a record cites is never rewritten."""

    def test_the_table_carries_reference_shapes_the_redact_view_leaves_unchanged(self) -> None:
        references = secret_scrub.REFERENCE_SHAPES
        self.assertTrue(references)
        for text in references:
            with self.subTest(text=text):
                self.assertEqual(scrub_text(text), text)
                self.assertEqual(secret_scrub.scrub_text(text), (text, []))

    def test_the_references_cover_what_published_records_cite(self) -> None:
        cited = (
            "apps/x.ts:12",
            "sha256:" + "0123456789abcdef" * 4,
            "commit 99689e46b8f1d3c1e4a5b6c7d8e9f0a1b2c3d4e5",
            "github_write_requires_installation_token:absent",
            "the gateway accepts a " + "bear" + "er token without a scope check",
        )
        for text in cited:
            with self.subTest(text=text):
                self.assertIn(text, secret_scrub.REFERENCE_SHAPES)

    def test_a_redact_row_that_rewrites_a_reference_cannot_be_built(self) -> None:
        commit_as_credential = secret_scrub.CredentialShape(
            name="any_forty_hex", kind="credential",
            detect=re.compile(r"\b[0-9a-f]{40}\b"), redact=re.compile(r"\b[0-9a-f]{40}\b"),
            views=frozenset({"redact"}), fixture="value " + "ab" * 20, fixture_secret="ab" * 20,
        )
        with self.assertRaises(secret_scrub.CredentialTableError) as caught:
            secret_scrub.validate_credential_table((*secret_scrub.CREDENTIAL_SHAPES, commit_as_credential))
        self.assertIn("redact_view_rewrites_reference", str(caught.exception))


class OneGitHubTokenFamily(unittest.TestCase):
    """One prefix table: the write door classifies by it, habitat flags its user prefixes, the boundary redacts all."""

    def test_the_write_door_has_no_prefix_list_of_its_own(self) -> None:
        self.assertFalse(hasattr(github_writes, "_TOKEN_CLASSES"))
        for prefix, token_class in secret_scrub.GITHUB_TOKEN_CLASSES:
            with self.subTest(prefix=prefix):
                self.assertEqual(github_writes.credential_class({"GH_TOKEN": prefix + "x"}), token_class)
        self.assertEqual(github_writes.INSTALLATION_TOKEN_CLASS, secret_scrub.GITHUB_INSTALLATION_TOKEN_CLASS)

    def test_a_refresh_token_is_a_user_credential(self) -> None:
        self.assertEqual(github_writes.credential_class({"GH_TOKEN": "gh" + "r_x"}), "refresh_token")
        with self.assertRaises(github_writes.GitHubWriteRefused):
            github_writes.require_installation_credential({"GH_TOKEN": "gh" + "r_x"})

    def test_habitat_flags_every_user_prefix_and_only_those(self) -> None:
        body = "Ab1" * 12
        for prefix, token_class in secret_scrub.GITHUB_TOKEN_CLASSES:
            with self.subTest(prefix=prefix):
                flagged = habitat._PERSONAL_TOKEN_RE.search(f"GH_TOKEN={prefix}{body}") is not None
                self.assertEqual(flagged, token_class != secret_scrub.GITHUB_INSTALLATION_TOKEN_CLASS)

    def test_every_prefix_is_redacted_at_the_boundary(self) -> None:
        body = "Cd2" * 12
        for prefix, _token_class in secret_scrub.GITHUB_TOKEN_CLASSES:
            with self.subTest(prefix=prefix):
                self.assertEqual(_surviving_runs(scrub_text(f"token {prefix}{body} end"), body), [])


class ThisFileCarriesNoCredential(unittest.TestCase):
    def test_this_file_matches_no_detection_shape(self) -> None:
        text = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual(sorted({row.name for row in secret_scrub.CREDENTIAL_SHAPES if row.detect.search(text)}), [])
        try:
            verify_no_secret_in_diff(text)
        except SecretLeakDetected as exc:  # pragma: no cover - the failure message is the evidence
            self.fail(str(exc))


if __name__ == "__main__":
    unittest.main()
