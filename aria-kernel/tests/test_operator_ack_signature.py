"""ARIA-MEDIUM-254 slice A / ARIA-MEDIUM-512 — an operator ack authorizes one body of one draft.

WHY. The materialize gate consumed an ack by its id alone: ``consume_token``
never compared the minted row's draft, intent, target path or kind with the
materialization, so an ack the operator minted for draft X materialized
draft Y, and a body re-drafted under X's id after the mint was authorized
too. An autonomous row was consumable through the operator path by id.

WHAT these pin, through the real materialize path (only the dispatch
worktree is a fixture): the ack's scope (``AckScope``: draft, intent,
target, kind, body digest) is derived from the draft at mint by the same
function materialize derives it with, and consumption refuses any field that
differs; a row minted before scope binding is unconsumable; an autonomous row
is never consumable by id (its mint and consumption are one transaction).
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import ack_ledger
from aria_kernel.agent_genesis import materialize_agent_draft
from aria_kernel.auto_action_gate import gate_from_test_fixture
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.skill_genesis import materialize_skill
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import make_local_git_repo

_AGENT_TARGET = ".claude/agents/aria-scope-{}.md"
_SKILL_TARGET = ".claude/skills/scope-{}.md"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class _GenesisFixture(unittest.TestCase):
    """A tools store with drafts, passing sandboxes and one dispatch worktree."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-ack-scope-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.tools = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.tools)
        # Slice A keeps the HMAC custody; slice B (OP-signing-session) replaces it.
        ack_ledger.init_ack_ledger(base_dir=self.tools, reason="ack scope test ledger init",
                                   operator_approval_ref="RFC-ACK-SCOPE")
        self.worktree = self.tmp / "worktree"
        self.worktree.mkdir()
        append_declared_fixture(self.tools / "dispatch" / "requests.jsonl",
                                {"assignment_id": "as-1", "worktree_path": str(self.worktree)},
                                expected_surface="dispatch_requests")

    def agent_draft(self, draft_id: str, body: str) -> None:
        append_declared_fixture(self.tools / "agent-genesis" / "drafts.jsonl",
                                {"draft_id": draft_id, "target_path": _AGENT_TARGET.format(draft_id), "body": body},
                                expected_surface="agent_genesis_drafts")
        append_declared_fixture(self.tools / "genesis-sandbox" / "runs.jsonl",
                                {"draft_id": draft_id, "decision": "pass", "synthetic_test_mode": False},
                                expected_surface="genesis_sandbox_runs")

    def skill_draft(self, draft_id: str, body: str) -> None:
        append_declared_fixture(self.tools / "skill-genesis" / "drafts.jsonl",
                                {"draft_id": draft_id, "target_path": _SKILL_TARGET.format(draft_id), "body": body,
                                 "status": "approved_for_skill_pr"},
                                expected_surface="skill_genesis_drafts")
        append_declared_fixture(self.tools / "skill-genesis" / "sandbox.jsonl",
                                {"draft_id": draft_id, "decision": "pass", "synthetic_test_mode": False},
                                expected_surface="skill_genesis_sandbox")

    def mint(self, draft_id: str, *, kind: str = "agent") -> Any:
        return ack_ledger.mint_operator_ack(
            base_dir=self.tools, draft_id=draft_id, kind=kind, reason="ack scope binding test",
            operator_user_id="tester", profile_name="standard", profile_state_at_mint="standard:v1",
            commit_sha_at_mint="0" * 40,
        )

    def materialize(self, draft_id: str, ack_id: str, *, kind: str = "agent") -> dict[str, Any]:
        materializer = materialize_agent_draft if kind == "agent" else materialize_skill
        return materializer(draft_id=draft_id, assignment_id="as-1", workspace_root=self.tmp,
                            gate=gate_from_test_fixture(), base_dir=self.tools, ack_id=ack_id)

    def ledger_rows(self) -> list[dict[str, Any]]:
        return load_jsonl(self.tools / "acks" / "acks.jsonl")

    def consumptions(self, ack_id: str) -> list[dict[str, Any]]:
        return [row for row in self.ledger_rows() if row.get("ack_id") == ack_id and row.get("event") == "consumed"]

    def hand_signed_row(self, **fields: Any) -> dict[str, Any]:
        """A v1 HMAC row written past the minter (an older kernel's row, or a forged-shape one)."""
        key = ack_ledger._resolve_key(self.tools)
        row: dict[str, Any] = {
            "schema_version": 1, "ack_id": "ack-hand", "event_time": "2026-10-01T00:00:00+00:00",
            "actor_kind": "operator", "actor_user_id": "tester", "profile_name": "standard", "lane": None,
            "classifier_decision_hash": None, "draft_id": "drf-x", "intent_id": "",
            "target_path": _AGENT_TARGET.format("drf-x"), "kind": "agent", "reason": "hand-built row",
            "auto_reason_code": None, "signed_key_id": key["key_id"], "consumed_at": None,
            "consumed_by_event_id": None, "breaker_state_at_mint": "ok",
            "profile_state_at_mint": "standard:v1", "commit_sha_at_mint": "0" * 40,
            "parent_observation_id": None,
        }
        row.update(fields)
        row["signature"] = ack_ledger._hmac_sign(key["secret"], ack_ledger._canonical_row_bytes(row))
        append_declared_fixture(self.tools / "acks" / "acks.jsonl", row, expected_surface="ack_ledger")
        return row


class AckScopeBindingTests(_GenesisFixture):
    def test_an_ack_for_one_draft_does_not_materialize_another(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        self.agent_draft("drf-y", "# agent y body")
        ack = self.mint("drf-x")
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_scope_mismatch:draft_id\b"):
            self.materialize("drf-y", ack.ack_id)
        self.assertFalse((self.worktree / _AGENT_TARGET.format("drf-y")).exists(), "nothing was written for y")
        self.assertEqual(self.consumptions(ack.ack_id), [], "a refused consume does not spend the ack")
        self.assertEqual(self.materialize("drf-x", ack.ack_id)["status"], "accepted")

    def test_a_body_redrafted_after_the_mint_is_not_authorized(self) -> None:
        self.agent_draft("drf-x", "# agent x body, the one the operator read")
        ack = self.mint("drf-x")
        self.agent_draft("drf-x", "# agent x body, re-drafted after the mint")
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_scope_mismatch:body_sha256\b"):
            self.materialize("drf-x", ack.ack_id)
        self.assertEqual(self.consumptions(ack.ack_id), [])

    def test_a_skill_ack_binds_the_skill_draft(self) -> None:
        self.skill_draft("skl-x", "# skill x body")
        self.skill_draft("skl-y", "# skill y body")
        ack = self.mint("skl-x", kind="skill")
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_scope_mismatch:draft_id\b"):
            self.materialize("skl-y", ack.ack_id, kind="skill")
        self.assertEqual(self.materialize("skl-x", ack.ack_id, kind="skill")["status"], "accepted")

    def test_a_row_minted_before_scope_binding_is_unconsumable(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        row = self.hand_signed_row(ack_id="ack-pre-scope")
        self.assertNotIn("body_sha256", row)
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_scope_unbound\b"):
            self.materialize("drf-x", row["ack_id"])
        self.assertEqual(self.consumptions(row["ack_id"]), [])

    def test_an_autonomous_row_is_never_consumable_by_id(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        row = self.hand_signed_row(ack_id="ack-autonomous", actor_kind="autonomous_profile", actor_user_id=None,
                                   lane="L0-main", classifier_decision_hash="h", reason=None,
                                   auto_reason_code="classifier_pass", profile_name="autonomous",
                                   body_sha256=_sha256("# agent x body"))
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_not_operator_signed\b"):
            self.materialize("drf-x", row["ack_id"])
        self.assertEqual(self.consumptions(row["ack_id"]), [])

    def test_an_ack_is_consumed_once(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        ack = self.mint("drf-x")
        self.assertEqual(self.materialize("drf-x", ack.ack_id)["status"], "accepted")
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_already_consumed\b"):
            self.materialize("drf-x", ack.ack_id)
        self.assertEqual(len(self.consumptions(ack.ack_id)), 1)


class AckMintScopeTests(_GenesisFixture):
    """The mint names no subject of its own: it binds the draft as it stands."""

    def test_the_mint_derives_its_scope_from_the_draft(self) -> None:
        from aria_kernel.ack_row import AckScope

        self.agent_draft("drf-x", "# agent x body")
        ack = self.mint("drf-x")
        self.assertEqual(
            AckScope(draft_id=ack.draft_id, intent_id=ack.intent_id, target_path=ack.target_path, kind=ack.kind,
                     body_sha256=ack.body_sha256),
            AckScope(draft_id="drf-x", intent_id="", target_path=_AGENT_TARGET.format("drf-x"), kind="agent",
                     body_sha256=_sha256("# agent x body")),
        )
        self.assertTrue(ack_ledger.verify_row(self.ledger_rows()[0], base_dir=self.tools)["valid"],
                        "the scope is inside the signed subject")
        with self.assertRaisesRegex(GovernanceError, "agent draft not found"):
            self.mint("drf-missing")
        append_declared_fixture(self.tools / "agent-genesis" / "drafts.jsonl",
                                {"draft_id": "drf-bodyless", "target_path": _AGENT_TARGET.format("drf-bodyless")},
                                expected_surface="agent_genesis_drafts")
        with self.assertRaisesRegex(GovernanceError, "^materialize_requires_drafter_body"):
            self.mint("drf-bodyless")
        with self.assertRaisesRegex(GovernanceError, "^skill_materialize_draft_not_found"):
            self.mint("drf-x", kind="skill")

    def test_the_autonomous_path_mints_and_consumes_in_one_step(self) -> None:
        from aria_kernel.agent_genesis import ack_scope_for_draft

        self.agent_draft("drf-x", "# agent x body")
        outcome = ack_ledger.record_autonomous_ack(
            base_dir=self.tools, scope=ack_scope_for_draft("drf-x", self.tools), materialize_event_id="mat-1",
            profile_name="autonomous", lane="L0-main", classifier_decision_hash="h",
            auto_reason_code="classifier_pass", profile_state_at_mint="autonomous:v1",
            commit_sha_at_mint="0" * 40, breaker_state_at_mint="ok",
        )
        mint_row, consumption = self.ledger_rows()
        self.assertEqual((mint_row["actor_kind"], mint_row["ack_id"]), ("autonomous_profile", outcome["ack_id"]))
        self.assertEqual(consumption["parent_ack_ledger_hash"], mint_row["ledger_hash"])
        self.assertEqual(consumption["consumed_by_event_id"], "mat-1")
        self.assertEqual(outcome["consumed_at"], consumption["consumed_at"])
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_not_operator_signed\b"):
            self.materialize("drf-x", outcome["ack_id"])

    def test_the_cli_mint_takes_no_subject_and_records_a_commit(self) -> None:
        from aria_kernel.cli import main as cli_main

        repo = make_local_git_repo(self.tmp, name="checkout")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True,
                              text=True).stdout.strip()
        self.agent_draft("drf-x", "# agent x body")
        base = ["--tools-dir", str(self.tools), "ack", "mint", "--draft-id", "drf-x", "--kind", "agent",
                "--reason", "cli ack scope binding test", "--operator-user-id", "tester"]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main([*base, "--workspace-root", str(repo)])
        self.assertEqual(code, 0, err.getvalue())
        minted = json.loads(out.getvalue())
        self.assertEqual((minted["commit_sha_at_mint"], minted["body_sha256"]), (head, _sha256("# agent x body")))
        for refused in (["--intent-id", "i"], ["--target-path", _AGENT_TARGET.format("drf-y")],
                        ["--operator-approval-ref", "RFC-1"],
                        ["--workspace-root", str(repo), "--commit-sha", "no-such-revision"],
                        ["--workspace-root", str(repo), "--commit-sha=--output=/tmp/x"]):
            with self.subTest(argv=refused), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                cli_main([*base, *refused])
            self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
