"""ARIA-HIGH-104 (4) — the commit trailer is the kernel's to derive, printed
on the envelope, and verified at pre-PR-open.

Pre-fix: the implementer prompt mandated ``Closes: aria-findings/F-V9-NN.json#F-V9-NN``
— a form ``tools/gates/commit-msg-validator.ts`` never accepted — for a change
the ledger keyed ``plan:<plan_id>``, and no kernel gate read what the agent
wrote. The kernel derives the trailer from the plan's origin now, the plan
records its origin, and the pre-PR-open perimeter refuses a branch whose
commits carry anything else.
"""
from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import implementation_safety as _is
from aria_kernel.plan_candidate_source import PlanCandidateSource
from aria_kernel.plan_origin import (
    CLOSES_TRAILER_RE,
    COMMIT_TYPES,
    F_AUTO_FINDING_ID_RE,
    ORIGIN_F_FINDING,
    ORIGIN_ORPHAN_FINDING,
    ORIGIN_PLAN,
    REQUIRE_CLOSES_SUBJECT_RE,
    TRAILERLESS_COMMIT_TYPES,
    commit_contract_for_plan,
    plan_origin,
    render_commit_contract_section,
    validate_commit_contract,
    verify_commits_honour_contract,
)
from aria_kernel.plan_synthesizer import convert_candidate_to_plan_content
from aria_kernel.tool_registry import GovernanceError

_REPO_ROOT = Path(__file__).resolve().parents[2]
_GATE = _REPO_ROOT / "tools" / "gates" / "commit-msg-validator.ts"


def _ts_regex_literal(name: str) -> str:
    """The body of ``const <name> =\\n  /.../;`` (or same-line) in the gate source."""
    source = _GATE.read_text(encoding="utf-8")
    match = re.search(rf"const {name} =\s*/(.+?)/;", source, re.DOTALL)
    assert match is not None, name
    return match.group(1)


class MirrorsThePythonCannotDriftFrom(unittest.TestCase):
    """The kernel mirrors two rules of the TypeScript gate; the mirror is
    compared to the gate's source, byte for byte, so a gate edit is a red
    test here rather than an envelope the gate refuses."""

    def test_require_closes_types_mirror(self) -> None:
        self.assertEqual(REQUIRE_CLOSES_SUBJECT_RE.pattern, _ts_regex_literal("REQUIRE_CLOSES_TYPES"))

    def test_closes_trailer_regex_mirror(self) -> None:
        self.assertEqual(CLOSES_TRAILER_RE.pattern, _ts_regex_literal("CLOSES_TRAILER_REGEX"))

    def test_trailerless_types_are_derived_from_the_gate_rule(self) -> None:
        self.assertEqual(TRAILERLESS_COMMIT_TYPES, ("refactor", "test", "chore"))
        self.assertEqual(set(COMMIT_TYPES) - set(TRAILERLESS_COMMIT_TYPES), {"fix", "feat", "security"})

    def test_the_f_auto_form_mirrors_the_gate_and_the_sequential_form_is_the_kernel_s(self) -> None:
        """ARIA-HIGH-104 round 3 (R4) — the sequential F form is READ from
        the kernel's allocator (`finding.FINDING_ID_RE`, `F-\\d{3,}`), not
        copied from the gate (`F-\\d{3}`): the allocator emits F-1000 after
        F-999 and a plan from that finding must converge. The gate's form is
        narrower and stays so here on purpose — it never binds a kernel-minted
        commit because no trailer is minted for an F origin — and this pin
        names the divergence so a gate that widens is a stale note here, not
        a silent one."""
        from aria_kernel.finding import FINDING_ID_RE

        source = _GATE.read_text(encoding="utf-8")
        gate_forms = re.search(r"function isAriaFindingId\(id: string\): boolean \{(.+?)\n\}", source, re.DOTALL)
        assert gate_forms is not None
        forms = re.findall(r"/(\^[^/]+\$)/\.test\(id\)", gate_forms.group(1))
        self.assertIn(F_AUTO_FINDING_ID_RE.pattern, forms)
        gate_sequential = next(form for form in forms if form.startswith("^F-\\d"))
        self.assertEqual(gate_sequential, r"^F-\d{3}$")
        self.assertEqual(FINDING_ID_RE.pattern, r"^F-\d{3,}$")
        self.assertIsNotNone(FINDING_ID_RE.match("F-1000"))
        self.assertIsNone(re.match(gate_sequential, "F-1000"))


class OriginAndContractTests(unittest.TestCase):
    def test_an_orphan_origin_gets_the_exact_trailer_the_gate_resolves(self) -> None:
        contract = commit_contract_for_plan({"finding_id": "ORPHAN-HIGH-104"}, plan_id="plan-1")
        self.assertEqual(contract["origin_kind"], ORIGIN_ORPHAN_FINDING)
        self.assertEqual(contract["trailer"], "Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-104")
        self.assertEqual(contract["commit_types"], list(COMMIT_TYPES))
        self.assertIsNotNone(CLOSES_TRAILER_RE.match(contract["trailer"]))
        validate_commit_contract(contract)

    def test_an_f_finding_origin_gets_no_trailer_because_the_gate_cannot_resolve_one(self) -> None:
        # aria-findings/ is gitignored: the CI range check's existsSync on the
        # cited file fails, so a trailer the kernel knows will be refused is
        # not minted. The origin is still recorded.
        self.assertIn("aria-findings/", (_REPO_ROOT / ".gitignore").read_text(encoding="utf-8"))
        contract = commit_contract_for_plan({"finding_id": "F-019"}, plan_id="plan-2")
        self.assertEqual(contract["origin_kind"], ORIGIN_F_FINDING)
        self.assertEqual(contract["origin_finding_id"], "F-019")
        self.assertIsNone(contract["trailer"])
        self.assertEqual(contract["commit_types"], list(TRAILERLESS_COMMIT_TYPES))

    def test_an_f_1000_origin_is_recognised_and_converges(self) -> None:
        """The id the allocator emits after F-999 — a plan from it was refused
        at submission (`plan_origin_unrecognised`) and could never converge."""
        import tempfile

        from aria_kernel.finding import _allocate_finding_id, _events_path
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.plan_contract import plan_contract_violations

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            events = _events_path(repo)
            events.parent.mkdir(parents=True, exist_ok=True)
            append_declared_jsonl(events, {"event": "finding_emitted", "finding_id": "F-999"},
                                  expected_surface="repo_finding_events")
            allocated = _allocate_finding_id(repo)
            self.assertEqual(allocated, "F-1000")
            origin = plan_origin({"finding_id": allocated})
            self.assertEqual((origin.kind, origin.finding_id), (ORIGIN_F_FINDING, "F-1000"))
            contract = commit_contract_for_plan({"finding_id": allocated}, plan_id="plan-f1000")
            self.assertIsNone(contract["trailer"])
            self.assertEqual(contract["origin_finding_id"], "F-1000")
            body = {"architectural_tier": 1, "validation_commands": [], "key_changes": ["x"], "finding_id": allocated}
            self.assertEqual(plan_contract_violations(body, base_dir=repo / "aria-tools"), [])
        for finding_id in ("F-AUTO-V10.6-SELF-FEED", "F-019"):
            with self.subTest(finding_id=finding_id):
                self.assertEqual(plan_origin({"finding_id": finding_id}).kind, ORIGIN_F_FINDING)
        # Fewer than three digits is not an id the allocator ever emits.
        with self.assertRaisesRegex(GovernanceError, "plan_origin_finding_id_unrecognised"):
            plan_origin({"finding_id": "F-19"})

    def test_a_plan_with_no_finding_gets_no_trailer_and_trailer_free_types(self) -> None:
        contract = commit_contract_for_plan({"title": "git-diff synthesis"}, plan_id="plan-3")
        self.assertEqual(contract["origin_kind"], ORIGIN_PLAN)
        self.assertIsNone(contract["trailer"])
        self.assertEqual(contract["commit_types"], list(TRAILERLESS_COMMIT_TYPES))

    def test_an_origin_the_kernel_cannot_contract_is_refused_at_derivation(self) -> None:
        for finding_id in ("plan:plan-3", "F-V9-01", "ARIA-HIGH-104", "FARM-HIGH-083"):
            with self.subTest(finding_id=finding_id), self.assertRaisesRegex(
                GovernanceError, "plan_origin_finding_id_unrecognised",
            ):
                plan_origin({"finding_id": finding_id})

    def test_the_plan_contract_refuses_such_an_origin_at_submission(self) -> None:
        """ARIA-HIGH-104 verifier — a registry-form id (`ARIA-HIGH-104`, which
        the TS gate resolves through findings.jsonl) CONVERGED and was then
        refused at the implementation mint, after staging. The plan contract
        now makes the same `plan_origin` read at submission, so the plan
        never converges; the ORPHAN and F forms and a plan with no finding
        still pass."""
        import tempfile

        from aria_kernel.plan_contract import REASON_ORIGIN_UNRECOGNISED, plan_contract_violations

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            body = {"architectural_tier": 1, "validation_commands": [], "key_changes": ["x"]}
            violations = plan_contract_violations({**body, "finding_id": "ARIA-HIGH-104"}, base_dir=tools)
            self.assertEqual(len(violations), 1)
            self.assertTrue(violations[0].startswith(f"{REASON_ORIGIN_UNRECOGNISED}:"), violations)
            self.assertIn("ARIA-HIGH-104", violations[0])
            for finding_id in ("ORPHAN-HIGH-104", "F-019", None):
                with self.subTest(finding_id=finding_id):
                    accepted = dict(body, **({"finding_id": finding_id} if finding_id else {}))
                    self.assertEqual(plan_contract_violations(accepted, base_dir=tools), [])

    def test_a_hand_built_contract_that_breaks_the_gate_rule_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "not a form the commit-msg gate accepts"):
            validate_commit_contract({"schema_version": 1, "plan_id": "p", "origin_kind": ORIGIN_PLAN,
                                      "trailer": "Closes: aria-findings/F-V9-01.json#F-V9-01", "commit_types": ["fix"]})
        with self.assertRaisesRegex(GovernanceError, "admits a commit type the gate requires one for"):
            validate_commit_contract({"schema_version": 1, "plan_id": "p", "origin_kind": ORIGIN_PLAN,
                                      "trailer": None, "commit_types": ["fix"]})

    def test_the_prompt_section_prints_the_trailer_verbatim_or_forbids_one(self) -> None:
        with_trailer = render_commit_contract_section(commit_contract_for_plan({"finding_id": "ORPHAN-HIGH-104"}, plan_id="p"))
        self.assertIn("## Commit contract", with_trailer)
        self.assertIn("`Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-104`", with_trailer)
        without = render_commit_contract_section(commit_contract_for_plan({}, plan_id="p"))
        self.assertIn("Never invent one", without)
        self.assertEqual(render_commit_contract_section(None), "")


class CommitsAreJudgedTests(unittest.TestCase):
    ORPHAN = commit_contract_for_plan({"finding_id": "ORPHAN-HIGH-104"}, plan_id="plan-1")
    PLAIN = commit_contract_for_plan({}, plan_id="plan-3")

    def test_exactly_the_trailer_and_nothing_else(self) -> None:
        good = [{"sha": "a" * 40, "subject": "fix(farm): x", "body": "why\n\nCloses: docs/reviews/orphan-findings.md#ORPHAN-HIGH-104\n"}]
        self.assertTrue(verify_commits_honour_contract(good, self.ORPHAN).honoured)
        wrong = [{"sha": "b" * 40, "subject": "fix(farm): x", "body": "Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-105\n"}]
        verdict = verify_commits_honour_contract(wrong, self.ORPHAN)
        self.assertFalse(verdict.honoured)
        self.assertIn("trailer_mismatch", verdict.violations[0])
        none = [{"sha": "c" * 40, "subject": "fix(farm): x", "body": ""}]
        self.assertFalse(verify_commits_honour_contract(none, self.ORPHAN).honoured)
        self.assertFalse(verify_commits_honour_contract([], self.ORPHAN).honoured)

    def test_no_invented_trailer_and_no_type_that_demands_one(self) -> None:
        good = [{"sha": "a" * 40, "subject": "chore(farm): apply plan-3", "body": "why\n"}]
        self.assertTrue(verify_commits_honour_contract(good, self.PLAIN).honoured)
        invented = [{"sha": "b" * 40, "subject": "chore(farm): x", "body": "Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-001\n"}]
        self.assertIn("invented_trailer", verify_commits_honour_contract(invented, self.PLAIN).violations[0])
        demanding = [{"sha": "c" * 40, "subject": "fix(farm): x", "body": ""}]
        self.assertIn("subject_type_requires_trailer", verify_commits_honour_contract(demanding, self.PLAIN).violations[0])
        agentic = [{"sha": "d" * 40, "subject": "refactor(agentic,phase-2): x", "body": ""}]
        self.assertFalse(verify_commits_honour_contract(agentic, self.PLAIN).honoured)


class PerimeterCheckTests(unittest.TestCase):
    def test_the_pre_pr_open_check_reads_the_branch_commits(self) -> None:
        contract = commit_contract_for_plan({"finding_id": "ORPHAN-HIGH-104"}, plan_id="plan-1")
        honoured = _is.HardFailContext(
            commit_contract=contract,
            branch_commits=({"sha": "a" * 40, "subject": "fix(x): y", "body": contract["trailer"] + "\n"},),
        )
        self.assertTrue(_is._check_commit_contract_honoured(honoured).passed)
        dishonoured = _is.HardFailContext(
            commit_contract=contract,
            branch_commits=({"sha": "a" * 40, "subject": "fix(x): y", "body": "Closes: aria-findings/F-V9-01.json#F-V9-01\n"},),
        )
        self.assertFalse(_is._check_commit_contract_honoured(dishonoured).passed)
        self.assertEqual(_is._check_commit_contract_honoured(_is.HardFailContext(commit_contract=contract)).reason, "branch_commits_absent")
        operator = _is._check_commit_contract_honoured(_is.HardFailContext(branch_commits=()))
        self.assertTrue(operator.passed)
        self.assertIn("operator_lane", operator.reason)
        self.assertIn("commit_contract_honoured", {check.name for check in _is.HARD_FAIL_CHECKS if check.gate == _is.GATE_PRE_PR_OPEN})
        self.assertIn("branch_commits", _is._STAGE_ONLY_CONTEXT_FIELDS)

    def test_pr_manager_reads_the_branch_commits_from_git(self) -> None:
        from aria_kernel.pr_manager import _branch_commits_for_action

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git = lambda *argv: subprocess.run(["git", *argv], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            git("init", "-q")
            git("config", "user.email", "t@t.invalid")
            git("config", "user.name", "t")
            (repo / "a").write_text("a\n")
            git("add", "a")
            git("commit", "-q", "-m", "base")
            base = git("rev-parse", "HEAD")
            (repo / "b").write_text("b\n")
            git("add", "b")
            git("commit", "-q", "-m", "fix(x): first\n\nbody line\n\nCloses: docs/reviews/orphan-findings.md#ORPHAN-HIGH-104")
            (repo / "c").write_text("c\n")
            git("add", "c")
            git("commit", "-q", "-m", "chore(x): second")
            head = git("rev-parse", "HEAD")
            commits = _branch_commits_for_action(workspace_path=repo, base_sha=base, head_sha=head)
            self.assertEqual([c["subject"] for c in commits], ["fix(x): first", "chore(x): second"])
            self.assertIn("Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-104", commits[0]["body"])
            self.assertEqual(commits[1]["sha"], head)
            self.assertIsNone(_branch_commits_for_action(workspace_path=repo, base_sha=None, head_sha=head))
            self.assertIsNone(_branch_commits_for_action(workspace_path=repo, base_sha="0" * 40, head_sha=head))


class TheSynthesizerRecordsTheOriginTests(unittest.TestCase):
    def test_finding_sourced_candidates_stamp_finding_id(self) -> None:
        orphan = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.ORPHAN_FINDING.value, "candidate_id": "ORPHAN-HIGH-104",
            "severity": "HIGH", "raw_id": "104", "title_hint": "Address ORPHAN-HIGH-104",
        })
        self.assertEqual(orphan.content["finding_id"], "ORPHAN-HIGH-104")
        self.assertEqual(commit_contract_for_plan(orphan.content, plan_id="p")["trailer"],
                         "Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-104")
        f_finding = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.F_FINDING.value, "candidate_id": "F-099",
            "mtime": 1.0, "path": "/nonexistent/F-099.json", "title_hint": "Process F-099",
        })
        self.assertEqual(f_finding.content["finding_id"], "F-099")
        ci = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.FAILING_CI.value, "candidate_id": "run-1",
            "workflow_name": "ci", "head_sha": "abc", "title_hint": "Fix CI",
        })
        self.assertNotIn("finding_id", ci.content)


if __name__ == "__main__":
    unittest.main()
