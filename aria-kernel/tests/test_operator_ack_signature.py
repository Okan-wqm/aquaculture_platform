"""ARIA-MEDIUM-254 / ARIA-MEDIUM-512 — an operator ack is the operator's signed act for one body of one draft.

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

ARIA-MEDIUM-254 slice B — the ack's signature. It was an HMAC under a key in
the store's untracked ``secrets/``, which aria/state never carries and every
self-hosted job sweeps, so an ack minted in one job never verified in the
next. An operator ack is now signed with the operator's ed25519 key and
verified against the allowed-signers file committed on main
(``OperatorAckSignatureTests``): no kernel-held key mints one, and no secret
is needed to verify it.
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
from datetime import datetime, timedelta, timezone
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
from tests._helpers.operator_acks import OperatorAckSigner
from tests._helpers.operator_requests import mint_ed25519_key

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
        # ARIA-MEDIUM-254 — no HMAC key: an operator ack is signed with the
        # operator's key and verified against this checkout on main.
        self.signer = OperatorAckSigner(self.tmp / "operator")
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

    def mint(self, draft_id: str, *, kind: str = "agent", reviewed_body_sha256: str | None = None,
             **overrides: Any) -> Any:
        """Mint as the operator does: review the draft as it stands, then sign an ack for that body."""
        return self.signer.mint(base_dir=self.tools, draft_id=draft_id, kind=kind,
                                reviewed_body_sha256=reviewed_body_sha256, **overrides)

    def materialize(self, draft_id: str, ack_id: str, *, kind: str = "agent",
                    workspace_root: Path | None = None) -> dict[str, Any]:
        """The real materializer; the dispatch worktree is absolute, the checkout on main is the signer's."""
        materializer = materialize_agent_draft if kind == "agent" else materialize_skill
        return materializer(draft_id=draft_id, assignment_id="as-1",
                            workspace_root=self.signer.repo if workspace_root is None else workspace_root,
                            gate=gate_from_test_fixture(), base_dir=self.tools, ack_id=ack_id)

    def init_hmac_key(self) -> None:
        """The HMAC key only autonomous rows, and operator rows minted before slice B, were signed with."""
        if not (self.tools / "secrets" / "ack_hmac.key").exists():
            from tests._helpers.operator_acts import bind_github_operator_acts

            if not hasattr(self, "_acts"):
                self._acts = bind_github_operator_acts(self)
            ack_ledger.init_ack_ledger(
                base_dir=self.tools, reason="ack scope test ledger init",
                operator_approval_ref=self._acts.approve(
                    "ack_key_operation", {"operation": "init"},
                ),
            )

    def ledger_rows(self) -> list[dict[str, Any]]:
        return load_jsonl(self.tools / "acks" / "acks.jsonl")

    def consumptions(self, ack_id: str) -> list[dict[str, Any]]:
        return [row for row in self.ledger_rows() if row.get("ack_id") == ack_id and row.get("event") == "consumed"]

    def hand_signed_row(self, **fields: Any) -> dict[str, Any]:
        """A v1 HMAC row written past the minter (an older kernel's row, or a forged-shape one)."""
        self.init_hmac_key()
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


class RefusedMaterializationKeepsTheAckTests(_GenesisFixture):
    """ARIA-MEDIUM-512 — a materialization the kernel refuses never spends the operator's ack.

    The ack is the operator's one authorization for one body; spending it on
    a write that is then refused (a target that resolves outside the
    worktree, a drafter below the model-tier floor) left the operator to
    mint again for a body nothing ever wrote.
    """

    def test_a_target_outside_the_worktree_refuses_before_the_ack_is_spent(self) -> None:
        escaping = ".claude/agents/aria-escape/../../../../escaped.md"
        append_declared_fixture(self.tools / "agent-genesis" / "drafts.jsonl",
                                {"draft_id": "drf-esc", "target_path": escaping, "body": "# escaping body"},
                                expected_surface="agent_genesis_drafts")
        append_declared_fixture(self.tools / "genesis-sandbox" / "runs.jsonl",
                                {"draft_id": "drf-esc", "decision": "pass", "synthetic_test_mode": False},
                                expected_surface="genesis_sandbox_runs")
        ack = self.mint("drf-esc")
        with self.assertRaisesRegex(GovernanceError, r"^target_path_escapes_worktree$"):
            self.materialize("drf-esc", ack.ack_id)
        self.assertEqual(self.consumptions(ack.ack_id), [], "a refused write does not spend the ack")

    def test_a_skill_target_outside_the_worktree_refuses_before_the_ack_is_spent(self) -> None:
        escaping = ".claude/skills/../../../escaped-skill.md"
        append_declared_fixture(self.tools / "skill-genesis" / "drafts.jsonl",
                                {"draft_id": "skl-esc", "target_path": escaping, "body": "# escaping skill",
                                 "status": "approved_for_skill_pr"},
                                expected_surface="skill_genesis_drafts")
        append_declared_fixture(self.tools / "skill-genesis" / "sandbox.jsonl",
                                {"draft_id": "skl-esc", "decision": "pass", "synthetic_test_mode": False},
                                expected_surface="skill_genesis_sandbox")
        ack = self.mint("skl-esc", kind="skill")
        with self.assertRaisesRegex(GovernanceError, r"^target_path_escapes_worktree$"):
            self.materialize("skl-esc", ack.ack_id, kind="skill")
        self.assertEqual(self.consumptions(ack.ack_id), [], "a refused write does not spend the ack")

    def test_a_drafter_below_the_authoring_floor_refuses_before_the_ack_is_spent(self) -> None:
        from unittest import mock

        self.agent_draft("drf-x", "# agent x body")
        ack = self.mint("drf-x")
        with mock.patch("aria_kernel.agent_genesis._authoring_model", return_value="sonnet"), \
                self.assertRaisesRegex(GovernanceError, r"agent_authoring_tier_too_low"):
            self.materialize("drf-x", ack.ack_id)
        self.assertEqual(self.consumptions(ack.ack_id), [], "a refused write does not spend the ack")
        self.assertFalse((self.worktree / _AGENT_TARGET.format("drf-x")).exists())
        self.assertEqual(self.materialize("drf-x", ack.ack_id)["status"], "accepted",
                         "the same ack still authorizes the body once the refusal is gone")


class AckMintBindsTheReviewedBodyTests(_GenesisFixture):
    """ARIA-MEDIUM-512 — the operator authorizes the body they read, not whatever the draft holds at mint.

    ``ack mint`` derived its scope from the draft's LATEST row, so a body
    re-drafted between the operator's review and the mint was the body the
    ack authorized. The operator now names the digest of the body they
    reviewed (``ack scope`` prints the body and that digest together) and the
    mint refuses any other.
    """

    def run_cli(self, *argv: str) -> tuple[int, str]:
        from aria_kernel.cli import main

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            try:
                code = main(["--tools-dir", str(self.tools), *argv])
            except SystemExit as exc:
                code = int(exc.code or 0)
        return code, out.getvalue()

    def test_a_body_redrafted_after_the_review_is_not_minted(self) -> None:
        self.agent_draft("drf-x", "# agent x body, the one the operator read")
        reviewed = ack_ledger.review_draft(base_dir=self.tools, draft_id="drf-x", kind="agent")
        self.assertEqual(reviewed["body"], "# agent x body, the one the operator read")
        self.assertEqual(reviewed["scope"]["body_sha256"], _sha256(reviewed["body"]))
        self.agent_draft("drf-x", "# agent x body, re-drafted after the review")
        with self.assertRaisesRegex(GovernanceError, r"^ack_mint_body_not_reviewed\b"):
            self.mint("drf-x", reviewed_body_sha256=reviewed["scope"]["body_sha256"])
        self.assertEqual(self.ledger_rows(), [], "nothing is minted for a body the operator did not read")
        ack = self.mint("drf-x")
        self.assertEqual(ack.body_sha256, _sha256("# agent x body, re-drafted after the review"))

    def test_the_review_surface_prints_the_body_with_its_digest(self) -> None:
        self.skill_draft("skl-x", "# skill x body")
        code, out = self.run_cli("ack", "scope", "--draft-id", "skl-x", "--kind", "skill")
        self.assertEqual(code, 0)
        printed = json.loads(out)
        self.assertEqual(printed["body"], "# skill x body")
        self.assertEqual(printed["scope"], {"draft_id": "skl-x", "intent_id": "", "kind": "skill",
                                            "target_path": _SKILL_TARGET.format("skl-x"),
                                            "body_sha256": _sha256("# skill x body")})

    def signing_flags(self) -> list[str]:
        return ["--signing-key", str(self.signer.key), "--signer-principal", self.signer.principal,
                "--actor-class", "T0"]

    def test_the_cli_mint_requires_the_reviewed_digest(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        base = ["ack", "mint", "--draft-id", "drf-x", "--kind", "agent", "--reason", "cli reviewed-body test",
                "--operator-user-id", "tester", "--workspace-root", str(self.signer.repo), *self.signing_flags()]
        self.assertEqual(self.run_cli(*base)[0], 2, "argparse refuses a mint that names no reviewed body")
        self.assertEqual(self.ledger_rows(), [])
        code, _ = self.run_cli(*base, "--body-sha256", _sha256("# agent x body"))
        self.assertEqual(code, 0)
        self.assertEqual([row["body_sha256"] for row in self.ledger_rows()], [_sha256("# agent x body")])


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
        self.assertTrue(ack_ledger.verify_row(self.ledger_rows()[0], base_dir=self.tools,
                                              workspace_root=self.signer.repo)["valid"],
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
        self.init_hmac_key()
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

        repo = self.signer.repo
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True,
                              text=True).stdout.strip()
        self.agent_draft("drf-x", "# agent x body")
        base = ["--tools-dir", str(self.tools), "ack", "mint", "--draft-id", "drf-x", "--kind", "agent",
                "--reason", "cli ack scope binding test", "--operator-user-id", "tester",
                "--body-sha256", _sha256("# agent x body"), "--signing-key", str(self.signer.key),
                "--signer-principal", self.signer.principal, "--actor-class", "T0"]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main([*base, "--workspace-root", str(repo)])
        self.assertEqual(code, 0, err.getvalue())
        minted = json.loads(out.getvalue())
        self.assertEqual((minted["commit_sha_at_mint"], minted["body_sha256"]), (head, _sha256("# agent x body")))
        self.assertEqual(minted["signer_principal"], self.signer.principal)
        for refused in (["--intent-id", "i"], ["--target-path", _AGENT_TARGET.format("drf-y")],
                        ["--operator-approval-ref", "RFC-1"],
                        ["--workspace-root", str(repo), "--commit-sha", "no-such-revision"],
                        ["--workspace-root", str(repo), "--commit-sha=--output=/tmp/x"]):
            with self.subTest(argv=refused), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                cli_main([*base, *refused])
            self.assertEqual(ctx.exception.code, 2)



class OperatorAckSignatureTests(_GenesisFixture):
    """ARIA-MEDIUM-254 — an operator ack verifies in any later job, and only the operator's key mints one."""

    def operator_row(self, draft_id: str, *, key: Path | None = None, principal: str | None = None,
                     after_signing: dict[str, Any] | None = None, drop: tuple[str, ...] = (),
                     **fields: Any) -> dict[str, Any]:
        """An operator-ack row signed past the minter with the production signer, appended as a runner could.

        ``after_signing`` overwrites fields of the signed row and ``drop``
        removes some: what a process that can write the ledger, but holds no
        enrolled key, could do to a signed ack.
        """
        from aria_kernel.ack_row import ACK_ROW_SCHEMA_VERSION, OPERATOR_ACK_ROW_KIND
        from aria_kernel.operator_request_signature import REQUEST_DOMAIN_TAG, SIGNATURE_NAMESPACE, sign_operator_subject
        from tests._helpers.operator_requests import AUDIENCE

        now = datetime.now(timezone.utc).replace(microsecond=0)
        scope = ack_ledger.review_draft(base_dir=self.tools, draft_id=draft_id, kind="agent")["scope"]
        row: dict[str, Any] = {
            "schema_version": ACK_ROW_SCHEMA_VERSION, "row_kind": OPERATOR_ACK_ROW_KIND, "ack_id": f"ack-{draft_id}",
            "event_time": now.isoformat(), "actor_kind": "operator", "actor_user_id": "tester",
            "profile_name": "standard", "lane": None, "classifier_decision_hash": None, **scope,
            "reason": "hand-signed operator ack", "auto_reason_code": None, "signed_key_id": None,
            "consumed_at": None, "consumed_by_event_id": None, "breaker_state_at_mint": "ok",
            "profile_state_at_mint": "standard:v1", "commit_sha_at_mint": "0" * 40, "parent_observation_id": None,
            "actor_class": "T0", "audience": AUDIENCE, "expires_at": (now + timedelta(hours=1)).isoformat(),
        }
        row.update(fields)
        signed = sign_operator_subject(row, namespace=SIGNATURE_NAMESPACE, domain_tag=REQUEST_DOMAIN_TAG,
                                       signing_key=key or self.signer.key,
                                       signer_principal=principal or self.signer.principal)
        signed.update(after_signing or {})
        stored = {field: value for field, value in signed.items() if field not in drop}
        append_declared_fixture(self.tools / "acks" / "acks.jsonl", stored, expected_surface="ack_ledger")
        return stored

    def test_an_ack_minted_in_one_job_materializes_in_a_later_one(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        ack = self.mint("drf-x")
        self.assertTrue(ack.signature.startswith("-----BEGIN SSH SIGNATURE-----"))
        self.assertIsNone(ack.signed_key_id, "no kernel-held key signed the operator's ack")
        self.assertIn('"row_kind":"operator_ack"', self.signer.subjects.getvalue(),
                      "the operator read the subject before ssh-keygen ran")
        # The next self-hosted job: git clean -ffdx swept the store's
        # untracked secrets/ before aria/state was restored; acks.jsonl, a
        # declared surface, came back with the store.
        shutil.rmtree(self.tools / "secrets", ignore_errors=True)
        self.assertFalse((self.tools / "secrets").exists())
        self.assertEqual(self.materialize("drf-x", ack.ack_id)["status"], "accepted")
        (consumption,) = self.consumptions(ack.ack_id)
        self.assertNotIn("signature", consumption, "the runner's transition is bound by the chain, not signed")
        self.assertEqual(consumption["parent_ack_ledger_hash"], self.ledger_rows()[0]["ledger_hash"])
        audit = ack_ledger.verify_range(base_dir=self.tools, workspace_root=self.signer.repo)
        self.assertEqual((audit["rows_checked"], audit["invalid_count"]), (2, 0), audit)
        self.assertFalse((self.tools / "secrets").exists(), "verifying an operator ack needs no secret")

    def test_no_key_but_an_enrolled_operator_key_mints_an_ack(self) -> None:
        self.agent_draft("drf-hmac", "# hmac body")
        self.agent_draft("drf-foreign", "# foreign body")
        self.agent_draft("drf-tampered", "# tampered body")
        self.agent_draft("drf-expired", "# expired body")
        self.agent_draft("drf-unsigned", "# unsigned body")
        hmac_row = self.hand_signed_row(ack_id="ack-hmac", draft_id="drf-hmac", body_sha256=_sha256("# hmac body"),
                                        target_path=_AGENT_TARGET.format("drf-hmac"))
        intruder = mint_ed25519_key(self.tmp / "intruder")
        self.operator_row("drf-foreign", key=intruder)
        self.operator_row("drf-tampered", after_signing={"reason": "a reason the operator never signed"})
        self.operator_row("drf-expired", expires_at="2026-01-01T00:00:00+00:00")
        self.operator_row("drf-unsigned", drop=("signature",))
        cases = {
            "drf-hmac": (hmac_row["ack_id"], "operator_signature_required"),
            "drf-foreign": ("ack-drf-foreign", "signature_invalid"),
            "drf-tampered": ("ack-drf-tampered", "signature_invalid"),
            "drf-expired": ("ack-drf-expired", "signed_subject_expired"),
            "drf-unsigned": ("ack-drf-unsigned", "signature_missing"),
        }
        for draft_id, (ack_id, reason) in cases.items():
            with self.subTest(draft=draft_id):
                with self.assertRaisesRegex(GovernanceError, rf"^ack_token_signature_invalid: .*reason={reason}$"):
                    self.materialize(draft_id, ack_id)
                self.assertEqual(self.consumptions(ack_id), [], "a refused ack is not spent")
                self.assertFalse((self.worktree / _AGENT_TARGET.format(draft_id)).exists())

    def test_an_ack_is_verified_only_against_a_checkout_on_main(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        ack = self.mint("drf-x")
        nowhere = self.tmp / "not-a-checkout"
        nowhere.mkdir()
        with self.assertRaisesRegex(GovernanceError, r"^ack_token_signature_invalid: .*reason=anchor_"):
            self.materialize("drf-x", ack.ack_id, workspace_root=nowhere)
        self.assertEqual(self.consumptions(ack.ack_id), [])
        audit = ack_ledger.verify_range(base_dir=self.tools)
        self.assertEqual(audit["results"][0]["reason"], "anchor_unavailable:anchor_unbound",
                         "an audit with no checkout is no pass")
        self.assertEqual(self.materialize("drf-x", ack.ack_id)["status"], "accepted")

    def test_the_mint_refuses_what_consumption_would_refuse(self) -> None:
        self.agent_draft("drf-x", "# agent x body")
        intruder = mint_ed25519_key(self.tmp / "intruder")
        refusals = {
            "unenrolled_key": ({"signing_key": intruder}, r"^ack_mint_signature_unverified: signature_invalid$"),
            "lifetime_past_the_bound": ({"expires_in_hours": 169}, r"^ack_mint_expiry_out_of_range: 169$"),
            "runner_class": ({"actor_class": "T2"}, r"^ack_mint_actor_class_invalid: 'T2'$"),
            # As root the signing-environment rule (ARIA-LOW-266) refuses a
            # directory that is no root-only checkout first; otherwise the anchor does.
            "no_checkout_on_main": ({"workspace_root": self.tmp},
                                    r"^(ack_mint_anchor_unavailable: |operator_ack_signing_environment_untrusted: "
                                    r"checkout:)"),
        }
        for name, (overrides, pattern) in refusals.items():
            with self.subTest(case=name), self.assertRaisesRegex(GovernanceError, pattern):
                self.mint("drf-x", **overrides)
        self.assertEqual(self.ledger_rows(), [], "nothing is written for an ack that would not verify")

    def test_the_cli_mint_requires_the_operators_key(self) -> None:
        from aria_kernel.cli import main as cli_main

        self.agent_draft("drf-x", "# agent x body")
        base = ["--tools-dir", str(self.tools), "ack", "mint", "--draft-id", "drf-x", "--kind", "agent",
                "--reason", "cli operator key test", "--operator-user-id", "tester",
                "--body-sha256", _sha256("# agent x body"), "--workspace-root", str(self.signer.repo)]
        for missing in ("--signing-key", "--signer-principal", "--actor-class"):
            flags = {"--signing-key": str(self.signer.key), "--signer-principal": self.signer.principal,
                     "--actor-class": "T0"}
            flags.pop(missing)
            with self.subTest(missing=missing), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                cli_main([*base, *(token for pair in flags.items() for token in pair)])
            self.assertEqual(ctx.exception.code, 2)
        self.assertEqual(self.ledger_rows(), [])


if __name__ == "__main__":
    unittest.main()
