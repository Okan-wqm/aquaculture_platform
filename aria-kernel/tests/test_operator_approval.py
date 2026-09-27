"""Operator approval — an authority grant is proven by a GitHub act.

ARIA-CRITICAL-216: ``gov:<id>`` resolved against ANY governance event,
including ARIA's own, ``review:<path>#<x>`` against any file that carried the
text, and ``ack-env:`` against a variable a workflow can set for itself. None
of them proves an act the governed system cannot author, yet each one granted
authority (merge lane, profile, unfreeze, tool promotion).

The operator decision of 2026-09-26: approval is a comment or PR review by an
operator's GitHub account, verified through the GitHub API. These tests pin
every rule of that verifier against a fake GitHub (never the network), and
pin that the recorded-reference grammar survives only on the surfaces that
grant no authority.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.operator_approval import (
    APPROVAL_CONSUMED_EVENT,
    AUTHORITY_RAISING_SURFACES,
    RECORD_SURFACES,
    OperatorApprovalUnrecorded,
    approval_line,
    load_operators_policy,
    verify_operator_approval,
    verify_recorded_reference,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests._helpers.operator_acts import REPOSITORY, github_operator_acts

GRANT_SCOPE = {"lane": "L1", "expires": "2026-10-10T00:00:00Z"}


class GitHubOperatorApprovalTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.root = ensure_tools_dir(self._tmp / "aria-tools")
        acts = github_operator_acts()
        self.github = acts.__enter__()
        self.addCleanup(acts.__exit__, None, None, None)

    def _verify(self, ref: str, *, surface: str = "merge_lane_grant", scope: dict | None = None, **kwargs):
        return verify_operator_approval(
            ref, surface=surface, scope=scope or GRANT_SCOPE, base_dir=self.root, **kwargs,
        )

    def test_an_operator_comment_carrying_the_exact_line_is_authority(self) -> None:
        ref = self.github.approve("merge_lane_grant", GRANT_SCOPE)
        proof = self._verify(ref)
        self.assertEqual(proof["kind"], "gh")
        self.assertEqual(proof["login"], "Okan-wqm")
        self.assertEqual(proof["act"], "comment")
        self.assertEqual(proof["scope"], GRANT_SCOPE)
        self.assertEqual(proof["surface"], "merge_lane_grant")

    def test_an_operator_pull_request_review_is_authority(self) -> None:
        ref = self.github.review(approval_line("merge_lane_grant", GRANT_SCOPE))
        self.assertEqual(self._verify(ref)["act"], "review")

    def test_the_recorded_reference_grammar_is_refused_on_every_raising_surface(self) -> None:
        event = append_tools_governance(self.root, "operator_action", {"action": "approve"})
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1 approved\n", encoding="utf-8")
        os.environ["ARIA_TEST_ACK"] = "operator-approved"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK", None)
        # Each of these RESOLVES under the recorded grammar — which is exactly
        # why none of them may grant authority: ARIA can author all three.
        for ref in (f"gov:{event['event_id']}", f"review:{doc}#OP-1", "ack-env:ARIA_TEST_ACK"):
            for surface, keys in AUTHORITY_RAISING_SURFACES.items():
                with self.subTest(ref=ref, surface=surface):
                    with self.assertRaisesRegex(OperatorApprovalUnrecorded, "gh:<owner>/<repo>#<number>"):
                        verify_operator_approval(
                            ref, surface=surface, scope={key: "x" for key in keys}, base_dir=self.root,
                        )

    def test_bare_strings_refuse(self) -> None:
        for bogus in ("", "   ", "yes", "gh:", "gh:Okan-wqm/aquaculture_platform#1/comment/",
                      "gh:Okan-wqm/aquaculture_platform#1/issue/5", "gh:Okan-wqm/aquaculture_platform/comment/5"):
            with self.subTest(ref=bogus), self.assertRaises(OperatorApprovalUnrecorded):
                self._verify(bogus)

    def test_the_author_must_be_a_listed_operator_and_a_user(self) -> None:
        stranger = self.github.comment(approval_line("merge_lane_grant", GRANT_SCOPE), login="aria-machine")
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "not a listed operator"):
            self._verify(stranger)
        bot = self.github.comment(approval_line("merge_lane_grant", GRANT_SCOPE), user_type="Bot")
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "type 'Bot'"):
            self._verify(bot)

    def test_an_edited_comment_is_refused(self) -> None:
        # Write access lets another account edit an operator's comment; an
        # edit is exactly how an old comment would acquire an approval line.
        created = datetime.now(timezone.utc) - timedelta(hours=2)
        ref = self.github.comment(
            approval_line("merge_lane_grant", GRANT_SCOPE),
            created_at=created, edited_at=created + timedelta(minutes=5),
        )
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "edited after it was posted"):
            self._verify(ref)

    def test_an_edited_review_is_refused(self) -> None:
        ref = self.github.review(
            approval_line("merge_lane_grant", GRANT_SCOPE),
            last_edited_at=datetime.now(timezone.utc),
        )
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "edited after it was posted"):
            self._verify(ref)

    def test_a_review_must_be_submitted_and_standing(self) -> None:
        for state in ("PENDING", "DISMISSED", "CHANGES_REQUESTED"):
            ref = self.github.review(approval_line("merge_lane_grant", GRANT_SCOPE), state=state)
            with self.subTest(state=state), self.assertRaisesRegex(OperatorApprovalUnrecorded, "review state"):
                self._verify(ref)

    def test_an_act_older_than_the_policy_max_age_is_refused(self) -> None:
        max_age = timedelta(hours=load_operators_policy()["approval_max_age_hours"])
        stale = self.github.approve(
            "merge_lane_grant", GRANT_SCOPE, created_at=datetime.now(timezone.utc) - max_age - timedelta(minutes=1),
        )
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "older than"):
            self._verify(stale)
        future = self.github.approve(
            "merge_lane_grant", GRANT_SCOPE, created_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "in the future"):
            self._verify(future)

    def test_every_scope_field_must_match(self) -> None:
        cases = {
            "wrong_value": approval_line("merge_lane_grant", {"lane": "L2", "expires": GRANT_SCOPE["expires"]}),
            "missing_field": "ARIA-APPROVE surface=merge_lane_grant lane=L1",
            "extra_field": approval_line("merge_lane_grant", GRANT_SCOPE) + " profile=autonomous",
            "wrong_surface": approval_line("runtime_profile", {"profile": "strict", "ceiling": "strict"}),
            "duplicate_field": approval_line("merge_lane_grant", GRANT_SCOPE) + " lane=L1",
        }
        for name, line in cases.items():
            ref = self.github.comment(line)
            with self.subTest(case=name), self.assertRaises(OperatorApprovalUnrecorded):
                self._verify(ref)

    def test_exactly_one_approval_line(self) -> None:
        line = approval_line("merge_lane_grant", GRANT_SCOPE)
        for body in ("LGTM, ship it", f"{line}\n{line}\n"):
            ref = self.github.comment(body)
            with self.subTest(body=body), self.assertRaisesRegex(OperatorApprovalUnrecorded, "exactly one"):
                self._verify(ref)

    def test_an_equivalent_expiry_spelling_matches(self) -> None:
        ref = self.github.comment(
            "ARIA-APPROVE surface=merge_lane_grant lane=L1 expires=2026-10-10T00:00:00+00:00",
        )
        self.assertEqual(self._verify(ref)["scope"], GRANT_SCOPE)

    def test_the_ref_must_name_the_policy_repository(self) -> None:
        ref = self.github.approve("merge_lane_grant", GRANT_SCOPE)
        forged = ref.replace(REPOSITORY, "someone/else")
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "policy repository"):
            self._verify(forged)

    def test_the_ref_number_must_be_where_the_act_was_posted(self) -> None:
        ref = self.github.approve("merge_lane_grant", GRANT_SCOPE, issue=7)
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "was not posted on #8"):
            self._verify(ref.replace("#7/", "#8/"))

    def test_one_act_authorizes_one_grant(self) -> None:
        ref = self.github.approve("merge_lane_grant", GRANT_SCOPE)
        proof = self._verify(ref)
        rows = [
            json.loads(line) for line in (self.root / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        consumed = [row for row in rows if row.get("kind") == APPROVAL_CONSUMED_EVENT]
        self.assertEqual(len(consumed), 1)
        self.assertEqual(consumed[0]["details"]["scope"], GRANT_SCOPE)
        self.assertEqual(consumed[0]["details"]["login"], "Okan-wqm")
        self.assertEqual(consumed[0]["event_id"], proof["consumed_event_id"])
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "already consumed"):
            self._verify(ref)
        with self.assertRaises(OperatorApprovalUnrecorded):
            self._verify(ref, scope={"lane": "L1", "expires": "2026-12-01T00:00:00Z"})

    def test_an_unreadable_act_refuses(self) -> None:
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "could not be read"):
            self._verify(f"gh:{REPOSITORY}#1/comment/999999")

    def test_a_reader_for_another_repository_refuses(self) -> None:
        ref = self.github.approve("merge_lane_grant", GRANT_SCOPE)
        self.github.repo = "fork"
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "reader reads Okan-wqm/fork"):
            self._verify(ref)

    def test_an_unknown_surface_or_scope_shape_is_a_caller_error(self) -> None:
        ref = self.github.approve("merge_lane_grant", GRANT_SCOPE)
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "not an authority-raising surface"):
            self._verify(ref, surface="consensus_finding_promotion")
        with self.assertRaisesRegex(OperatorApprovalUnrecorded, "scope keys"):
            self._verify(ref, scope={"lane": "L1"})


class ApprovalTemplateTests(unittest.TestCase):
    def test_the_line_names_the_surface_then_its_scope_in_declared_order(self) -> None:
        self.assertEqual(
            approval_line("merge_lane_grant", {"expires": "2026-10-10T00:00:00+00:00", "lane": "L1"}),
            "ARIA-APPROVE surface=merge_lane_grant lane=L1 expires=2026-10-10T00:00:00Z",
        )
        self.assertEqual(
            approval_line("runtime_profile", {"profile": "strict", "ceiling": "strict"}),
            "ARIA-APPROVE surface=runtime_profile profile=strict ceiling=strict",
        )

    def test_a_value_with_whitespace_cannot_be_written(self) -> None:
        with self.assertRaises(OperatorApprovalUnrecorded):
            approval_line("self_merge_unfreeze", {"freeze_id": "freeze a"})

    def test_the_cli_prints_the_line_to_paste(self) -> None:
        import io
        from contextlib import redirect_stderr, redirect_stdout

        from aria_kernel import cli

        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.main([
                "operator", "approval-template", "--surface", "tool_promote",
                "tool=adapter-x", "target=ACTIVE",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().strip(), "ARIA-APPROVE surface=tool_promote tool=adapter-x target=ACTIVE")
        err = io.StringIO()
        with redirect_stderr(err):
            code = cli.main(["operator", "approval-template", "--surface", "tool_promote", "tool=adapter-x"])
        self.assertEqual(code, 2)
        self.assertIn("scope keys", err.getvalue())


class OperatorsPolicyTests(unittest.TestCase):
    def test_the_checked_in_policy_names_the_operator_and_the_repository(self) -> None:
        policy = load_operators_policy()
        self.assertEqual(policy["operator_logins"], ["Okan-wqm"])
        self.assertEqual(policy["repository"], "Okan-wqm/aquaculture_platform")
        self.assertGreater(policy["approval_max_age_hours"], 0)

    def test_a_malformed_policy_refuses(self) -> None:
        good = load_operators_policy()
        for bad in (
            {**good, "$schema": "aria/operators/v0"},
            {**good, "operator_logins": []},
            {**good, "operator_logins": ["ok", ""]},
            {**good, "repository": "no-slash"},
            {**good, "approval_max_age_hours": 0},
        ):
            with self.subTest(bad=bad), self.assertRaises(GovernanceError):
                load_operators_policy(bad)


class RecordedReferenceTests(unittest.TestCase):
    """The recorded grammar attests decisions that grant no authority."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-rec-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.root = ensure_tools_dir(self._tmp / "aria-tools")

    def test_bare_strings_refuse(self) -> None:
        for bogus in ("", "   ", "yes", "approved-by-bob", "x" * 40):
            with self.subTest(ref=bogus), self.assertRaises(OperatorApprovalUnrecorded):
                verify_recorded_reference(bogus, base_dir=self.root, surface="surface_reset")

    def test_gov_reference_resolves_only_when_recorded(self) -> None:
        append_tools_governance(self.root, "operator_action", {"event_id": "evt-123", "action": "approve"})
        proof = verify_recorded_reference("gov:evt-123", base_dir=self.root, surface="surface_reset")
        self.assertEqual(proof["kind"], "gov")
        with self.assertRaises(OperatorApprovalUnrecorded):
            verify_recorded_reference("gov:evt-forged", base_dir=self.root, surface="surface_reset")

    def test_review_reference_requires_the_anchor_on_disk(self) -> None:
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1 approved\n", encoding="utf-8")
        proof = verify_recorded_reference(f"review:{doc}#OP-1", base_dir=self.root, surface="surface_reset")
        self.assertEqual(proof["anchor"], "OP-1")
        with self.assertRaises(OperatorApprovalUnrecorded):
            verify_recorded_reference(f"review:{doc}#OP-2", base_dir=self.root, surface="surface_reset")

    def test_ack_env_requires_a_nonempty_variable(self) -> None:
        os.environ["ARIA_TEST_ACK"] = "operator-approved"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK", None)
        proof = verify_recorded_reference("ack-env:ARIA_TEST_ACK", base_dir=self.root, surface="surface_reset")
        self.assertEqual(proof["kind"], "ack-env")
        with self.assertRaises(OperatorApprovalUnrecorded):
            verify_recorded_reference("ack-env:ARIA_TEST_ACK_UNSET", base_dir=self.root, surface="surface_reset")

    def test_an_authority_raising_surface_cannot_take_a_recorded_reference(self) -> None:
        append_tools_governance(self.root, "operator_action", {"event_id": "evt-1", "action": "approve"})
        for surface in AUTHORITY_RAISING_SURFACES:
            with self.subTest(surface=surface), self.assertRaisesRegex(
                OperatorApprovalUnrecorded, "grants no authority",
            ):
                verify_recorded_reference("gov:evt-1", base_dir=self.root, surface=surface)

    def test_the_two_surface_sets_are_disjoint(self) -> None:
        self.assertFalse(set(AUTHORITY_RAISING_SURFACES) & RECORD_SURFACES)

    def test_runtime_artifacts_promotion_refuses_unresolvable_refs(self) -> None:
        from aria_kernel.runtime_artifacts import approve_runtime_v2_promotion

        bundle = self.root / "runtime" / "v2" / "bundle.json"
        bundle.parent.mkdir(parents=True, exist_ok=True)
        bundle.write_text("{}", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            approve_runtime_v2_promotion(
                evidence_bundle=bundle,
                operator_approval_ref="approved-by-producer",
                base_dir=self.root,
            )
        self.assertIn("operator_approval", str(ctx.exception))

    def test_knowledge_graph_signature_refuses_bare_strings(self) -> None:
        from aria_kernel.knowledge_graph import (
            KnowledgeGraphSignatureMissing,
            record_anti_pattern,
        )

        with self.assertRaises((KnowledgeGraphSignatureMissing, OperatorApprovalUnrecorded)):
            record_anti_pattern(
                {"pattern_type": "anti_pattern", "expression": "getRepository("},
                workspace_root=self._tmp,
                reason_class="tool_design",
                operator_signature="looks-legit-signature-16chars",
            )

    def test_anti_pattern_approval_and_append_use_the_same_explicit_root(self) -> None:
        from aria_kernel import knowledge_graph as kg

        tools = ensure_tools_dir(self._tmp / "store/tools")
        workspace = self._tmp / "checkout"
        legacy = ensure_tools_dir(workspace / "aria-tools")
        append_tools_governance(legacy, "operator_action", {"event_id": "legacy-only", "action": "approve"})
        pattern = kg.Pattern(
            pattern_id="avoid-duplicate-store", pattern_type="anti_pattern", confidence=1.0,
            evidence_refs=("docs/aria/SPEC.md:1",), discovered_by_cycle_id="approval-root",
            observed_at="2026-09-10T00:00:00Z",
        )
        with self.assertRaises(kg.KnowledgeGraphSignatureMissing):
            kg.record_anti_pattern(
                pattern, base_dir=tools, workspace_root=workspace,
                reason_class="architecture_class", operator_signature="gov:legacy-only",
            )
        self.assertFalse((tools / "knowledge-graph/anti-patterns.jsonl").exists())
        append_tools_governance(tools, "operator_action", {"event_id": "canonical-only", "action": "approve"})
        path = kg.record_anti_pattern(
            pattern, base_dir=tools, workspace_root=workspace,
            reason_class="architecture_class", operator_signature="gov:canonical-only",
        )
        self.assertEqual(path, tools / "knowledge-graph/anti-patterns.jsonl")
        self.assertEqual(
            [r["pattern_id"] for r in kg.anti_patterns_for_paths(
                base_dir=tools, workspace_root=workspace, paths=["docs/aria/SPEC.md"],
            )], [pattern.pattern_id],
        )
        self.assertFalse((legacy / "knowledge-graph/anti-patterns.jsonl").exists())

    def test_anti_pattern_cli_forwards_the_resolved_tools_root(self) -> None:
        import io
        from contextlib import redirect_stdout

        from aria_kernel import cli
        from aria_kernel.ledger import load_declared_jsonl

        tools = ensure_tools_dir(self._tmp / "store/tools")
        workspace = self._tmp / "checkout"
        workspace.mkdir()
        append_tools_governance(tools, "operator_action", {"event_id": "cli-approval", "action": "approve"})
        self.assertEqual(
            verify_recorded_reference(
                "gov:cli-approval", base_dir=tools, surface="knowledge_graph_anti_pattern",
            )["kind"],
            "gov",
        )
        output = io.StringIO()
        with redirect_stdout(output):
            code = cli.main([
                "anti-pattern", "record", "--tools-dir", str(tools),
                "--workspace-root", str(workspace), "--pattern-id", "avoid-shadow-state",
                "--reason-class", "architecture_class", "--evidence-ref", "docs/aria/SPEC.md:1",
                "--cycle-id", "cli-root", "--operator-signature", "gov:cli-approval",
            ])
        self.assertEqual(code, 0)
        path = tools / "knowledge-graph/anti-patterns.jsonl"
        self.assertEqual(json.loads(output.getvalue())["written"], str(path))
        self.assertEqual(
            [r["pattern_id"] for r in load_declared_jsonl(path, expected_surface="kg_anti_patterns")],
            ["avoid-shadow-state"],
        )
        self.assertFalse((workspace / "aria-tools").exists())


if __name__ == "__main__":
    unittest.main()
