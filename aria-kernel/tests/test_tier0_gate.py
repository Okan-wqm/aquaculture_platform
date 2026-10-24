"""WP-J slice A — tier0_gate: the full mechanical law (zero LLM, zero writes).

The seam exists (slice C's judgment funnel calls it before any mint and
early-stops on a reject); this file pins the WHOLE law the operator's
protocol step 2 names, on top of the refs-resolve check that landed first:

* falsifiability — a contract that declares no observable, for an item that
  carries no reproduction recipe, is refused by name
  (``CLAIM_NOT_FALSIFIABLE``, the rule_contract constant); a contract of
  ``None`` is not (the no-contract refusal already has an owner: the judge
  fan-out and the promotion gate refuse it downstream — no second copy);
* fingerprint dedup — the item's ``finding_fingerprint`` (the ONE owner,
  ``feedback_store.finding_fingerprint``) against a caller-supplied
  seen-set;
* quotes byte-match — ``evidence_trust.quote_matches_at`` against the
  pinned excerpts when the caller has them (a skip entry is a NAMED stale
  rejection; no row for the ref is a named unpinned rejection) and against
  the cited line's window in the blob at the SHA otherwise;
* static premise checks — the contract's per-family observable:
  ``cited_line_bytes_at_sha`` (every cited ref carries pinned bytes) and
  ``referenced_path_absent_at_sha`` (the path the doc-staleness id names is
  gone from the tree at the SHA — a path that CAME BACK refutes the claim
  at tier 0, for free);
* the tri-state law — no anchor or a git that does not answer is a PASS
  with a note, never a refusal (the paid tiers still verify);
* zero mints by construction — the gate writes nothing, ever.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.rule_contract import RuleContract


def _git_env() -> dict[str, str]:
    """Every GIT_* variable dropped (the hermetic-git rule, Python side)."""
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=str(root), text=True, capture_output=True, check=True, env=_git_env(),
    ).stdout.strip()


class _Repo(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        (self.repo / "src").mkdir()
        (self.repo / "src" / "a.ts").write_text("alpha\nconsole.log('x')\ngamma\n", encoding="utf-8")
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "a.md").write_text("see the module gone/path.ts for details\n", encoding="utf-8")
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "aria-test@example.invalid")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: tier-0 tree")
        self.target_sha = _git(self.repo, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- contracts and items ------------------------------------------------

    def _lint_contract(self, observable: str | None = "cited_line_bytes_at_sha") -> RuleContract:
        return RuleContract(
            tool_id="lint-rules-adapter", rule="no-console", claim_type="wrong_code",
            severity_cap="HIGH", defect_claim="The cited code keeps a console call.",
            premises=("The cited line runs in production code.",),
            declared_scope=("src/**",), observable=observable,
        )

    def _doc_contract(self) -> RuleContract:
        return RuleContract(
            tool_id="doc-staleness-adapter", rule="doc_references_missing_path",
            claim_type="currency_gap", severity_cap="MEDIUM",
            defect_claim="The document names a repository path that is gone.",
            premises=("The cited line claims the path exists.",),
            declared_scope=("docs/**",), observable="referenced_path_absent_at_sha",
        )

    def _lint_item(self, **extra) -> dict:
        item = {
            "id": "lint-rules:no-console:src/a.ts:2:1",
            "tool_id": "lint-rules-adapter", "rule": "no-console",
            "path": "src/a.ts", "line": 2,
            "evidence": [{"path": "src/a.ts", "line": 2}],
        }
        item.update(extra)
        return item

    def _doc_item(self, referenced: str = "gone/path.ts") -> dict:
        return {
            "id": f"doc-staleness:missing:docs/a.md:1:{referenced}",
            "tool_id": "doc-staleness-adapter", "rule": "doc_references_missing_path",
            "path": "docs/a.md", "line": 1,
            "evidence": [{"path": "docs/a.md", "line": 1}],
        }

    def _gate(self, item, contract, **kwargs):
        from aria_kernel.tier0 import tier0_gate
        return tier0_gate(item, contract, self.repo, self.target_sha, **kwargs)


class TheWholeLaw(_Repo):
    def test_no_contract_is_a_pass_not_a_second_copy_of_the_fanout_refusal(self) -> None:
        verdict = self._gate(self._lint_item(), None)
        self.assertEqual(verdict["status"], "pass")

    def test_no_anchor_is_a_pass_with_a_note_never_a_refusal(self) -> None:
        from aria_kernel.tier0 import tier0_gate
        verdict = tier0_gate({"path": "src/a.ts"}, None, None, None)
        self.assertEqual(verdict["status"], "pass")
        self.assertTrue(verdict.get("note"))

    def test_a_contract_without_observable_or_recipe_is_refused_by_name(self) -> None:
        verdict = self._gate(self._lint_item(), self._lint_contract(observable=None))
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "claim_not_falsifiable")

    def test_a_recipe_makes_the_claim_falsifiable_without_an_observable(self) -> None:
        verdict = self._gate(
            self._lint_item(reproduction={"recipe_id": "REC-1", "expected": "red"}),
            self._lint_contract(observable=None),
        )
        self.assertEqual(verdict["status"], "pass")

    def test_a_duplicate_fingerprint_is_refused_by_name(self) -> None:
        from aria_kernel.tier0 import tier0_gate
        first = tier0_gate(self._lint_item(), None, self.repo, self.target_sha)
        fingerprint = first.get("fingerprint")
        self.assertTrue(fingerprint)
        second = tier0_gate(
            self._lint_item(), None, self.repo, self.target_sha,
            seen_fingerprints={fingerprint},
        )
        self.assertEqual(second["status"], "reject")
        self.assertEqual(second["reason"], "tier0_fingerprint_duplicate")

    def test_a_missing_ref_is_refused(self) -> None:
        verdict = self._gate(self._lint_item(path="src/nope.ts"), None)
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "cited_path_absent_at_target_sha")

    def test_a_line_past_eof_does_not_resolve(self) -> None:
        item = self._lint_item()
        item["evidence"] = [{"path": "src/a.ts", "line": 99}]
        verdict = self._gate(item, None)
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_ref_line_out_of_range")

    def test_a_clean_lint_item_with_a_matching_quote_is_admitted(self) -> None:
        verdict = self._gate(
            self._lint_item(quotes={"src/a.ts:2": "console.log('x')"}),
            self._lint_contract(),
        )
        self.assertEqual(verdict["status"], "pass", verdict)

    def test_a_quote_the_tree_does_not_carry_is_refused(self) -> None:
        verdict = self._gate(
            self._lint_item(quotes={"src/a.ts:2": "bytes that are not in the tree"}),
            self._lint_contract(),
        )
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_quote_mismatch")

    def test_cited_line_bytes_requires_a_quote_per_ref(self) -> None:
        verdict = self._gate(self._lint_item(), self._lint_contract())
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_quote_required")

    def test_a_skipped_pinned_excerpt_is_a_named_stale_refusal(self) -> None:
        verdict = self._gate(
            self._lint_item(quotes={"src/a.ts:2": "console.log('x')"}),
            self._lint_contract(),
            pinned_excerpts=[{"path": "src/a.ts", "skipped": "unreadable"}],
        )
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_quote_stale_excerpt")
        self.assertIn("unreadable", str(verdict.get("note")))

    def test_a_quote_checked_against_pinned_excerpt_bytes(self) -> None:
        pinned = [{
            "path": "src/a.ts", "start_line": 1, "end_line": 3,
            "content": "alpha\nconsole.log('x')\ngamma\n", "content_hash": "sha256:x",
        }]
        good = self._gate(
            self._lint_item(quotes={"src/a.ts:2": "console.log('x')"}),
            self._lint_contract(), pinned_excerpts=pinned,
        )
        self.assertEqual(good["status"], "pass", good)
        bad = self._gate(
            self._lint_item(quotes={"src/a.ts:2": "not in the pinned bytes"}),
            self._lint_contract(), pinned_excerpts=pinned,
        )
        self.assertEqual(bad["status"], "reject")
        self.assertEqual(bad["reason"], "tier0_quote_mismatch")

    def test_a_quote_for_a_ref_nothing_was_pinned_for_is_refused(self) -> None:
        verdict = self._gate(
            self._lint_item(quotes={"src/a.ts:2": "console.log('x')"}),
            self._lint_contract(),
            pinned_excerpts=[{"path": "docs/a.md", "content": "other bytes"}],
        )
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_quote_unpinned")


class TheDocStalenessObservable(_Repo):
    def test_an_absent_referenced_path_holds_the_premise(self) -> None:
        verdict = self._gate(self._doc_item(referenced="gone/path.ts"), self._doc_contract())
        self.assertEqual(verdict["status"], "pass", verdict)

    def test_a_referenced_path_that_came_back_refutes_the_claim(self) -> None:
        verdict = self._gate(self._doc_item(referenced="src/a.ts"), self._doc_contract())
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_observable_premise_violated")

    def test_an_id_that_names_no_subject_is_refused_as_unreadable(self) -> None:
        item = self._doc_item()
        item["id"] = "doc-staleness"
        verdict = self._gate(item, self._doc_contract())
        self.assertEqual(verdict["status"], "reject")
        self.assertEqual(verdict["reason"], "tier0_observable_subject_unreadable")


class TheGateWritesNothing(_Repo):
    def test_no_mints_no_rows_no_files(self) -> None:
        before = sorted(str(p.relative_to(self.repo)) for p in self.repo.rglob("*") if ".git" not in p.parts)
        for item, contract in (
            (self._lint_item(), self._lint_contract()),
            (self._doc_item(), self._doc_contract()),
            (self._lint_item(path="src/nope.ts"), None),
        ):
            self._gate(item, contract)
        after = sorted(str(p.relative_to(self.repo)) for p in self.repo.rglob("*") if ".git" not in p.parts)
        self.assertEqual(before, after)
        self.assertFalse((self.repo / "aria-tools").exists())


class TheVocabularyIsClosed(_Repo):
    def test_every_refusal_reason_is_a_member_of_the_declared_tuple(self) -> None:
        from aria_kernel.tier0 import TIER0_REFUSAL_REASONS
        self.assertIn("claim_not_falsifiable", TIER0_REFUSAL_REASONS)
        self.assertIn("cited_path_absent_at_target_sha", TIER0_REFUSAL_REASONS)
        for item, contract in (
            (self._lint_item(), self._lint_contract(observable=None)),
            (self._lint_item(), self._lint_contract()),
            (self._lint_item(quotes={"src/a.ts:2": "nope"}), self._lint_contract()),
            (self._doc_item(referenced="src/a.ts"), self._doc_contract()),
        ):
            verdict = self._gate(item, contract)
            if verdict["status"] == "reject":
                self.assertIn(verdict["reason"], TIER0_REFUSAL_REASONS, verdict)


if __name__ == "__main__":
    unittest.main()
