"""Plan ARIA-V8 v2 §4 Phase 8.5 — independence + secret_scrub + telemetry.

Closes F-014-D5. 6 invariants:

- I-V8.5-01 — verify_claim_disjointness rejects overlapping claim_ids
- I-V8.5-02 — verify_revision_id_distinctness rejects collisions
- I-V8.5-03 — compute_jaccard_similarity bounded [0.0, 1.0]
- I-V8.5-04 — secret_scrub.scrub_text covers AKIA/ghp_/email/IPv4 patterns
- I-V8.5-05 — secret_scrub redaction_types are pattern names only (no raw values)
- I-V8.5-06 — verify_independence combines all 3 checks

ORPHAN-HIGH-421 additions — the three layers were non-functional in
production and two of the holes were invisible to this file's original
fixtures, which omitted ``agent_id`` entirely:

- same principal across all three roles is rejected (distinct claim_ids
  were never evidence of distinct agents)
- absent agent text is a violation, not a pass (Jaccard scores an empty
  side as 0.0, i.e. maximally diverse)
- a kernel-seeded primary is legitimate on round 1, but the challenger
  and reviewer must still be distinct principals
- a placeholder dispatch cannot be constructed at all
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import independence_check, secret_scrub


class TestVerifyClaimDisjointness(unittest.TestCase):

    def _seed_claims(self, base: Path, rows: list[dict]) -> None:
        d = base / "agent-invocations"
        d.mkdir(parents=True, exist_ok=True)
        (d / "claims.jsonl").write_text(
            "\n".join(json.dumps(r) for r in rows) + "\n",
            encoding="utf-8",
        )

    def test_disjoint_claim_ids_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._seed_claims(base, [
                {"request_id": "REQ-P", "claim_id": "claim-1", "agent_id": "agent-p"},
                {"request_id": "REQ-C", "claim_id": "claim-2", "agent_id": "agent-c"},
                {"request_id": "REQ-CR", "claim_id": "claim-3", "agent_id": "agent-cr"},
            ])
            ok, reasons = independence_check.verify_claim_disjointness(
                primary_request_id="REQ-P",
                challenger_request_id="REQ-C",
                cross_review_request_id="REQ-CR",
                base_dir=base,
            )
            self.assertTrue(ok, f"reasons={reasons}")

    def test_shared_claim_id_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Same claim_id reused — primary + challenger overlap
            self._seed_claims(base, [
                {"request_id": "REQ-P", "claim_id": "claim-shared", "agent_id": "agent-p"},
                {"request_id": "REQ-C", "claim_id": "claim-shared", "agent_id": "agent-c"},
                {"request_id": "REQ-CR", "claim_id": "claim-3", "agent_id": "agent-cr"},
            ])
            ok, reasons = independence_check.verify_claim_disjointness(
                primary_request_id="REQ-P",
                challenger_request_id="REQ-C",
                cross_review_request_id="REQ-CR",
                base_dir=base,
            )
            self.assertFalse(ok)
            self.assertIn("primary_challenger_claim_id_overlap", reasons)

    def test_missing_claims_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            ok, reasons = independence_check.verify_claim_disjointness(
                primary_request_id="REQ-P",
                challenger_request_id="REQ-C",
                cross_review_request_id="REQ-CR",
                base_dir=base,
            )
            self.assertFalse(ok)
            self.assertIn("claims_jsonl_missing", reasons)


class TestRevisionIdDistinctness(unittest.TestCase):

    def test_distinct_ids_pass(self):
        ok, reasons = independence_check.verify_revision_id_distinctness(
            primary_revision_id="rev-p",
            challenger_revision_id="rev-c",
            cross_review_revision_id="rev-cr",
        )
        self.assertTrue(ok, f"reasons={reasons}")

    def test_collision_fails(self):
        ok, reasons = independence_check.verify_revision_id_distinctness(
            primary_revision_id="rev-same",
            challenger_revision_id="rev-same",
            cross_review_revision_id="rev-cr",
        )
        self.assertFalse(ok)
        self.assertIn("primary_challenger_revision_id_collision", reasons)


class TestJaccardSimilarity(unittest.TestCase):

    def test_identical_text_returns_one(self):
        text = "the quick brown fox jumps over the lazy dog"
        self.assertEqual(independence_check.compute_jaccard_similarity(text, text), 1.0)

    def test_disjoint_text_returns_zero(self):
        a = "alpha beta gamma delta epsilon"
        b = "one two three four five"
        sim = independence_check.compute_jaccard_similarity(a, b)
        self.assertEqual(sim, 0.0)

    def test_partial_overlap(self):
        a = "alpha beta gamma delta epsilon zeta"
        b = "alpha beta gamma omega psi chi"
        sim = independence_check.compute_jaccard_similarity(a, b)
        self.assertGreater(sim, 0.0)
        self.assertLess(sim, 1.0)


class TestSecretScrubCoverage(unittest.TestCase):

    def test_aws_key_redacted(self):
        fake_aws_key = "AKIA" + "1234567890ABCDEF"
        s, types = secret_scrub.scrub_text(f"token={fake_aws_key}")
        self.assertNotIn(fake_aws_key, s)
        self.assertIn("aws_access_key", types)

    def test_github_pat_redacted(self):
        fake_pat = "ghp_" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"
        s, types = secret_scrub.scrub_text(f"auth: {fake_pat}")
        self.assertNotIn(fake_pat, s)
        self.assertIn("github_pat", types)

    def test_email_and_ipv4_redacted(self):
        s, types = secret_scrub.scrub_text("contact alice@example.com from 10.0.0.1")
        self.assertNotIn("alice@example.com", s)
        self.assertNotIn("10.0.0.1", s)
        self.assertIn("email", types)
        self.assertIn("ipv4_octet", types)

    def test_redaction_types_contain_no_raw_values(self):
        """Per I-V8.5-07 governance discipline: redaction_types list
        MUST contain pattern names only, never the original matched
        string."""
        raw_secret = "AKIA" + "0123456789ABCDEF"
        _, types = secret_scrub.scrub_text(f"x={raw_secret}")
        for t in types:
            self.assertNotIn(raw_secret, t,
                             "redaction_types MUST NOT leak raw secret values")


class TestVerifyIndependence(unittest.TestCase):

    def _seed_claims(self, base: Path, rows: list[dict]) -> None:
        d = base / "agent-invocations"
        d.mkdir(parents=True, exist_ok=True)
        (d / "claims.jsonl").write_text(
            "\n".join(json.dumps(r) for r in rows) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _dispatch(role: str, request_id: str | None, revision_id: str | None, text: str | None):
        return independence_check.RoundDispatch(
            role=role, request_id=request_id, revision_id=revision_id, agent_text=text,
        )

    def _three_distinct_principals(self, base: Path) -> None:
        self._seed_claims(base, [
            {"request_id": "REQ-P", "claim_id": "c1", "agent_id": "aria-primary-planner"},
            {"request_id": "REQ-C", "claim_id": "c2", "agent_id": "aria-challenger-planner"},
            {"request_id": "REQ-CR", "claim_id": "c3", "agent_id": "aria-cross-reviewer"},
        ])

    def test_full_independence_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._three_distinct_principals(base)
            ok, reasons = independence_check.verify_independence(
                primary=self._dispatch(
                    independence_check.PRIMARY_ROLE, "REQ-P", "rev-p",
                    "primary plan content one two three",
                ),
                challenger=self._dispatch(
                    independence_check.CHALLENGER_ROLE, "REQ-C", "rev-c",
                    "challenger plan totally different words apple pear",
                ),
                cross_review=self._dispatch(
                    independence_check.CROSS_REVIEW_ROLE, "REQ-CR", "rev-cr",
                    "cross review verdict apple pear primary one",
                ),
                base_dir=base,
            )
            self.assertTrue(ok, f"reasons={reasons}")

    def test_echo_chamber_detected_by_jaccard(self):
        """If primary + cross_review have near-identical text (>85%
        n-gram overlap), independence fails."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._three_distinct_principals(base)
            identical_text = "echo chamber identical content " * 20
            ok, reasons = independence_check.verify_independence(
                primary=self._dispatch(
                    independence_check.PRIMARY_ROLE, "REQ-P", "rev-p", identical_text,
                ),
                challenger=self._dispatch(
                    independence_check.CHALLENGER_ROLE, "REQ-C", "rev-c",
                    "completely different challenger words",
                ),
                cross_review=self._dispatch(
                    independence_check.CROSS_REVIEW_ROLE, "REQ-CR", "rev-cr", identical_text,
                ),
                base_dir=base,
            )
            self.assertFalse(ok)
            self.assertTrue(
                any("jaccard" in r and "above_ceiling" in r for r in reasons),
                f"expected jaccard_above_ceiling reason; got {reasons}",
            )

    # ORPHAN-HIGH-421 — one agent wearing three hats must be rejected.
    def test_same_principal_across_roles_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Distinct claim_ids — the pre-fix check passed on exactly this
            # shape, because every claim gets a fresh claim_id.
            self._seed_claims(base, [
                {"request_id": "REQ-P", "claim_id": "c1", "agent_id": "one-agent"},
                {"request_id": "REQ-C", "claim_id": "c2", "agent_id": "one-agent"},
                {"request_id": "REQ-CR", "claim_id": "c3", "agent_id": "one-agent"},
            ])
            ok, reasons = independence_check.verify_independence(
                primary=self._dispatch(
                    independence_check.PRIMARY_ROLE, "REQ-P", "rev-p", "alpha beta gamma",
                ),
                challenger=self._dispatch(
                    independence_check.CHALLENGER_ROLE, "REQ-C", "rev-c", "delta epsilon zeta",
                ),
                cross_review=self._dispatch(
                    independence_check.CROSS_REVIEW_ROLE, "REQ-CR", "rev-cr", "eta theta iota",
                ),
                base_dir=base,
            )
            self.assertFalse(ok)
            self.assertTrue(
                any("same_agent_id" in r for r in reasons),
                f"expected same_agent_id violation; got {reasons}",
            )

    # ORPHAN-HIGH-421 — absent text must not score as maximally diverse.
    def test_missing_agent_text_is_a_violation_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._three_distinct_principals(base)
            # compute_jaccard_similarity returns 0.0 for an empty side, so
            # pre-fix this shape passed the diversity layer outright.
            self.assertEqual(independence_check.compute_jaccard_similarity("", "x y z"), 0.0)
            ok, reasons = independence_check.verify_independence(
                primary=self._dispatch(
                    independence_check.PRIMARY_ROLE, "REQ-P", "rev-p", None,
                ),
                challenger=self._dispatch(
                    independence_check.CHALLENGER_ROLE, "REQ-C", "rev-c", "challenger words",
                ),
                cross_review=self._dispatch(
                    independence_check.CROSS_REVIEW_ROLE, "REQ-CR", "rev-cr", "reviewer words",
                ),
                base_dir=base,
            )
            self.assertFalse(ok)
            self.assertIn(
                f"{independence_check.PRIMARY_ROLE}_text_unavailable", reasons,
            )

    # ORPHAN-HIGH-421 — a kernel-seeded primary is legitimate on round 1,
    # but the challenger and reviewer must still be distinct principals.
    def test_seeded_primary_still_requires_two_distinct_principals(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._seed_claims(base, [
                {"request_id": "REQ-C", "claim_id": "c2", "agent_id": "aria-challenger-planner"},
                {"request_id": "REQ-CR", "claim_id": "c3", "agent_id": "aria-cross-reviewer"},
            ])
            common = {
                "primary": self._dispatch(
                    independence_check.PRIMARY_ROLE, None, "rev-p", "seeded plan alpha beta",
                ),
                "cross_review": self._dispatch(
                    independence_check.CROSS_REVIEW_ROLE, "REQ-CR", "rev-cr", "reviewer gamma delta",
                ),
                "base_dir": base,
            }
            ok, reasons = independence_check.verify_independence(
                challenger=self._dispatch(
                    independence_check.CHALLENGER_ROLE, "REQ-C", "rev-c", "challenger epsilon zeta",
                ),
                **common,
            )
            self.assertTrue(ok, f"reasons={reasons}")
            # Same principal for the two dispatched roles → rejected.
            self._seed_claims(base, [
                {"request_id": "REQ-C", "claim_id": "c2", "agent_id": "same-agent"},
                {"request_id": "REQ-CR", "claim_id": "c3", "agent_id": "same-agent"},
            ])
            ok, reasons = independence_check.verify_independence(
                challenger=self._dispatch(
                    independence_check.CHALLENGER_ROLE, "REQ-C", "rev-c", "challenger epsilon zeta",
                ),
                **common,
            )
            self.assertFalse(ok)
            self.assertTrue(any("same_agent_id" in r for r in reasons), reasons)

    # ORPHAN-HIGH-421 — a placeholder cannot be constructed.
    def test_blank_request_id_is_refused_at_construction(self):
        with self.assertRaises(independence_check.IndependenceInputError):
            self._dispatch(independence_check.PRIMARY_ROLE, "   ", "rev-p", "text")
        with self.assertRaises(independence_check.IndependenceInputError):
            self._dispatch(independence_check.PRIMARY_ROLE, "REQ-P", "  ", "text")
        with self.assertRaises(independence_check.IndependenceInputError):
            self._dispatch("", "REQ-P", "rev-p", "text")


if __name__ == "__main__":
    unittest.main()
