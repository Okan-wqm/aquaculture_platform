"""WP-J slice A — the verbatim-quote law: one owner, both callers.

The defect (wpj-a-1): ``typed_judgment`` checks a judge's quote against the
bytes the mint pinned, but the UNTYPED submit path re-grades refs only — a
``satisfaction_matrix`` assertion can quote bytes that appear nowhere in the
pinned excerpt and still passes ``validate_agent_response_evidence``. The law
also lives privately inside the typed module, so no second caller can share
it (the ARIA-HIGH-195 lesson: two copies of a grammar drift).

The pins here:

* ``evidence_trust.quote_matches_at`` is THE law — tri-state (``None`` when
  nothing was pinned), bounded by ``QUOTE_MAX_CHARS``, containment-only;
* the untyped entry point (``validate_agent_response_evidence``) re-grades
  every matrix-entry quote against the request's pinned excerpts, refusing
  by name on mismatch, on a skipped (stale) excerpt, and on a quote for a
  ref nothing was pinned for — while a request that carries no excerpt block
  at all (legacy wire) keeps quotes unverifiable-but-accepted, exactly as
  the typed path carries an unpinned quote unverified;
* the typed parse (``parse_single_answer``) and the law agree on every
  (quote, pinned bytes) pair — one law, two callers, provably the same.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any


def _git_env() -> dict[str, str]:
    """Every GIT_* variable dropped — the Python side of the hermetic-git rule.

    A linked worktree hands a hooked git an absolute GIT_DIR; a fixture that
    inherits it writes into the real repository instead of the temp one.
    """
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=str(root), text=True, capture_output=True, check=True, env=_git_env(),
    ).stdout.strip()


class _RepoAtSha(unittest.TestCase):
    """A temp repository with one committed file, pinned at its SHA."""

    FILE_CONTENT = "alpha\nbeta line with marker_token\ngamma\n"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        (self.repo / "src.txt").write_text(self.FILE_CONTENT, encoding="utf-8")
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "aria-test@example.invalid")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "add", "src.txt")
        _git(self.repo, "commit", "-q", "-m", "fixture: pinned bytes")
        self.target_sha = _git(self.repo, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _request(self, excerpts: list[dict[str, Any]] | None) -> dict[str, Any]:
        request: dict[str, Any] = {
            "request_id": "REQ-1",
            "target_sha": self.target_sha,
            "allowed_scope": ["**"],
            "evidence_refs": ["src.txt:2"],
        }
        if excerpts is not None:
            request["evidence_excerpts"] = excerpts
        return request

    def _response(self, quote: str | None) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "id": "MS-1",
            "verdict": "satisfied",
            "evidence_refs": ["src.txt:2"],
        }
        if quote is not None:
            entry["quotes"] = [quote]
        return {"evidence_refs": [], "satisfaction_matrix": [entry]}


PINNED_EXCERPTS = [{
    "path": "src.txt", "start_line": 1, "end_line": 3,
    "content": "alpha\nbeta line with marker_token\ngamma\n",
    "content_hash": "sha256:fixture", "truncated": False,
}]
SKIPPED_EXCERPTS = [{"path": "src.txt", "skipped": "unreadable"}]


class QuoteMatchesAtIsTheLaw(unittest.TestCase):
    """The pure law itself: tri-state, bounded, containment-only."""

    def _law(self, quote: Any, content: Any) -> Any:
        from aria_kernel.evidence_trust import quote_matches_at
        return quote_matches_at(quote, excerpt_content=content)

    def test_a_verbatim_substring_matches(self) -> None:
        self.assertIs(self._law("marker_token", "beta line with marker_token\n"), True)

    def test_bytes_the_excerpt_does_not_contain_do_not_match(self) -> None:
        self.assertIs(self._law("marker_token", "beta line with something_else\n"), False)

    def test_nothing_pinned_is_unverifiable_never_a_match(self) -> None:
        self.assertIs(self._law("marker_token", None), None)

    def test_an_empty_or_overlong_quote_is_never_a_match(self) -> None:
        from aria_kernel.typed_judgment import QUOTE_MAX_CHARS
        self.assertIs(self._law("   ", "any bytes"), False)
        overlong = "x" * (QUOTE_MAX_CHARS + 1)
        self.assertIs(self._law(overlong, overlong), False)

    def test_a_non_string_quote_is_never_a_match(self) -> None:
        self.assertIs(self._law(None, "any bytes"), False)
        self._law  # referenced for clarity


class UntypedSubmitRegradesQuotes(_RepoAtSha):
    """The real entry point: matrix-entry quotes are checked at submit."""

    def _codes(self, result: dict[str, Any]) -> set[str]:
        return {str(error["code"]) for error in result["errors"]}

    def test_a_quote_outside_the_pinned_bytes_is_refused_by_name(self) -> None:
        from aria_kernel.evidence_validator import validate_agent_response_evidence
        result = validate_agent_response_evidence(
            response=self._response("bytes that appear nowhere in the excerpt"),
            workspace_root=self.repo,
            request=self._request(list(PINNED_EXCERPTS)),
        )
        self.assertFalse(result["valid"], result)
        self.assertIn("agent_evidence_quote_mismatch", self._codes(result))

    def test_a_skipped_pinned_excerpt_is_a_named_stale_refusal(self) -> None:
        from aria_kernel.evidence_validator import validate_agent_response_evidence
        result = validate_agent_response_evidence(
            response=self._response("marker_token"),
            workspace_root=self.repo,
            request=self._request(list(SKIPPED_EXCERPTS)),
        )
        self.assertFalse(result["valid"], result)
        self.assertIn("agent_evidence_quote_stale", self._codes(result))
        stale = [error for error in result["errors"] if error["code"] == "agent_evidence_quote_stale"]
        self.assertIn("unreadable", str(stale[0].get("reason")))

    def test_a_quote_for_a_ref_nothing_was_pinned_for_is_refused_by_name(self) -> None:
        from aria_kernel.evidence_validator import validate_agent_response_evidence
        excerpts = [dict(PINNED_EXCERPTS[0], path="other.txt")]
        result = validate_agent_response_evidence(
            response=self._response("marker_token"),
            workspace_root=self.repo,
            request=self._request(excerpts),
        )
        self.assertFalse(result["valid"], result)
        self.assertIn("agent_evidence_quote_unpinned", self._codes(result))

    def test_a_verbatim_quote_passes(self) -> None:
        from aria_kernel.evidence_validator import validate_agent_response_evidence
        result = validate_agent_response_evidence(
            response=self._response("marker_token"),
            workspace_root=self.repo,
            request=self._request(list(PINNED_EXCERPTS)),
        )
        self.assertTrue(result["valid"], result)

    def test_a_request_without_an_excerpt_block_keeps_quotes_unverified(self) -> None:
        from aria_kernel.evidence_validator import validate_agent_response_evidence
        result = validate_agent_response_evidence(
            response=self._response("marker_token"),
            workspace_root=self.repo,
            request=self._request(None),
        )
        self.assertTrue(result["valid"], result)


class TypedParseAndTheLawAgree(unittest.TestCase):
    """One law, two callers: the typed parse decides exactly as the law does."""

    CONTENT = "  @Public()\n  async setupMfa(@Args() input: SetupMfaInput) {\n"

    def _question(self):
        from aria_kernel.typed_judgment import ChoiceQuestion
        return ChoiceQuestion(
            question_id="AIR-1", prompt="Judge whether this finding is a true_positive or false_positive.",
            options=("true_positive", "false_positive"),
            evidence_refs=("apps/auth/src/mfa.resolver.ts:128",),
            evidence_excerpts=({
                "path": "apps/auth/src/mfa.resolver.ts", "start_line": 120, "end_line": 130,
                "content_hash": "sha256:feedface", "content": self.CONTENT,
            },),
        )

    def _answer(self, quote: str) -> dict[str, Any]:
        return {
            "question_id": "AIR-1", "primitive": "choice", "value": "false_positive",
            "confidence": 0.8,
            "evidence": [{"index": 0, "quote": quote}],
            "rationale": "The endpoint is public by declaration.",
        }

    def _parse_outcome(self, quote: str) -> str:
        from aria_kernel.typed_judgment import parse_single_answer
        outcome = parse_single_answer(self._question(), self._answer(quote))
        return outcome.reason_code if hasattr(outcome, "reason_code") else "accepted"

    def _law(self, quote: str) -> Any:
        from aria_kernel.evidence_trust import quote_matches_at
        return quote_matches_at(quote, excerpt_content=self.CONTENT)

    def test_inside_the_bytes_parses_and_the_law_matches(self) -> None:
        self.assertEqual(self._parse_outcome("@Public()"), "accepted")
        self.assertIs(self._law("@Public()"), True)

    def test_outside_the_bytes_is_refused_and_the_law_does_not_match(self) -> None:
        self.assertEqual(self._parse_outcome("bytes never pinned anywhere"), "evidence_quote_mismatch")
        self.assertIs(self._law("bytes never pinned anywhere"), False)


if __name__ == "__main__":
    unittest.main()
