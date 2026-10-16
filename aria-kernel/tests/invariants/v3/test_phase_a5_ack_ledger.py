"""Plan ARIA-V3 Phase A5 — ack ledger + HMAC custody + CLI.

Locked invariants (9 cases, I-V3-18..20):

  * I-V3-18 — ack ledger is append-only AND every row is signed.
  * I-V3-19 — one-time consumption (second consume raises).
  * I-V3-19a — a minted ack row carries exactly ACK_ROW_REQUIRED_FIELDS
    (+ the ledger hash-chain envelope), on both mint paths (the operator
    mint and the autonomous mint-and-consume, ARIA-MEDIUM-254 slice A).
  * I-V3-19b — ``actor_kind`` distinguishes operator vs autonomous_profile.
  * I-V3-19c — ``aria-tools/secrets/`` covered by .gitignore.
  * I-V3-19d — HMAC key not committed to git history.
  * I-V3-19e — key rotation preserves historical row verification.
  * I-V3-19f — DR runbook present (aria-ack-key-rotation.md).
  * I-V3-20 — ``ack mint --reason`` validated via ``_validate_reason``.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

_ACK_LEDGER_SOURCE = _KERNEL_ROOT / "aria_kernel" / "ack_ledger.py"


def _seed_init(tools_dir: Path) -> None:
    from aria_kernel.ack_ledger import init_ack_ledger
    init_ack_ledger(
        base_dir=tools_dir,
        reason="unit test seed initialisation",
        operator_approval_ref="RFC-TEST",
    )


def _seed_draft(tools_dir: Path, draft_id: str) -> None:
    """An agent draft with a drafter body: the ack's scope is derived from it (ARIA-MEDIUM-254 slice A)."""
    from tests._helpers.declared_fixtures import append_declared_fixture
    append_declared_fixture(
        tools_dir / "agent-genesis" / "drafts.jsonl",
        {
            "draft_id": draft_id,
            "intent": {"intent_id": f"intent-{draft_id}"},
            "target_path": f".claude/agents/aria-{draft_id}.md",
            "body": f"# {draft_id} body",
        },
        expected_surface="agent_genesis_drafts",
    )


def _scope(tools_dir: Path, draft_id: str):
    from aria_kernel.agent_genesis import ack_scope_for_draft
    return ack_scope_for_draft(draft_id, tools_dir)


def _mint_row(tools_dir: Path, *, draft_suffix: str = "1"):
    from aria_kernel.ack_ledger import mint_operator_ack
    _seed_draft(tools_dir, f"draft-{draft_suffix}")
    return mint_operator_ack(
        base_dir=tools_dir,
        draft_id=f"draft-{draft_suffix}",
        kind="agent",
        reason="unit test ack mint",
        operator_user_id="tester",
        profile_name="standard",
        profile_state_at_mint="standard:v1",
        commit_sha_at_mint="deadbeef",
        reviewed_body_sha256=_scope(tools_dir, f"draft-{draft_suffix}").body_sha256,
    )


def _record_auto(tools_dir: Path) -> dict:
    from aria_kernel.ack_ledger import record_autonomous_ack
    _seed_draft(tools_dir, "draft-auto")
    return record_autonomous_ack(
        base_dir=tools_dir,
        scope=_scope(tools_dir, "draft-auto"),
        materialize_event_id="mat-auto",
        profile_name="autonomous",
        lane="L0-main",
        classifier_decision_hash="hash-abc",
        auto_reason_code="classifier_pass",
        profile_state_at_mint="autonomous:v1",
        commit_sha_at_mint="cafef00d",
        breaker_state_at_mint="ok",
    )


class PhaseA5AckLedger(unittest.TestCase):
    def test_i_v3_18_ack_ledger_append_only_signed(self) -> None:
        from aria_kernel.ack_ledger import (
            _ledger_path,
            verify_range,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-18-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            for i in range(3):
                _mint_row(base, draft_suffix=str(i))
            ledger_file = _ledger_path(base)
            self.assertTrue(ledger_file.exists())
            rows = [
                json.loads(line)
                for line in ledger_file.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(rows), 3)
            # Every row carries a non-empty signature.
            for row in rows:
                self.assertIn("signature", row)
                self.assertIsInstance(row["signature"], str)
                self.assertTrue(row["signature"])
            # verify_range reports zero invalid.
            result = verify_range(base_dir=base)
            self.assertEqual(result["invalid_count"], 0)
            self.assertEqual(result["rows_checked"], 3)

    def test_i_v3_19_one_time_consumption(self) -> None:
        from aria_kernel.ack_ledger import consume_token
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-19-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            row = _mint_row(base)
            scope = _scope(base, row.draft_id)
            result_first = consume_token(
                base_dir=base,
                ack_id=row.ack_id,
                materialize_event_id="mat-evt-1",
                scope=scope,
            )
            self.assertEqual(result_first["status"], "ok")
            ledger_rows = [
                json.loads(line)
                for line in (base / "acks" / "acks.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(ledger_rows), 2)
            self.assertIsNone(ledger_rows[0].get("consumed_at"))
            self.assertEqual(ledger_rows[1].get("event"), "consumed")
            self.assertEqual(ledger_rows[1].get("consumed_by_event_id"), "mat-evt-1")
            with self.assertRaises(GovernanceError) as ctx:
                consume_token(
                    base_dir=base,
                    ack_id=row.ack_id,
                    materialize_event_id="mat-evt-2",
                    scope=scope,
                )
            self.assertIn("ack_token_already_consumed", str(ctx.exception))

    def test_i_v3_19a_ack_row_carries_all_required_fields(self) -> None:
        from aria_kernel.ack_ledger import _ledger_path, verify_row
        from aria_kernel.ack_row import ACK_ROW_REQUIRED_FIELDS
        from aria_kernel.ledger import _CHAIN_FIELDS

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-19a-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            _mint_row(base)
            _record_auto(base)
            # Mint rows only: the autonomous path also appends its
            # consumption transition in the same transaction.
            rows = [
                row
                for row in (
                    json.loads(line)
                    for line in _ledger_path(base).read_text(encoding="utf-8").splitlines()
                    if line.strip()
                )
                if row.get("event") != "consumed"
            ]
            self.assertEqual(
                [row["actor_kind"] for row in rows],
                ["operator", "autonomous_profile"],
            )
            # SET-EQUALITY, not a subset check: a subset check stayed green
            # while every mint wrote ``schema_version`` outside the declared
            # set. The chain envelope is the ledger's own addition at append
            # time (ledger._CHAIN_FIELDS owns those names).
            expected = set(ACK_ROW_REQUIRED_FIELDS) | set(_CHAIN_FIELDS)
            for row in rows:
                with self.subTest(actor_kind=row["actor_kind"]):
                    keys = set(row.keys())
                    self.assertEqual(
                        keys,
                        expected,
                        msg=(
                            f"missing={sorted(expected - keys)} "
                            f"extra={sorted(keys - expected)}"
                        ),
                    )
                    self.assertTrue(verify_row(row, base_dir=base)["valid"])

    def test_i_v3_19b_actor_kind_distinguishes_operator_vs_autonomous(self) -> None:
        from aria_kernel.ack_row import ACK_ACTOR_KINDS

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-19b-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            op_row = _mint_row(base, draft_suffix="op")
            self.assertEqual(op_row.actor_kind, "operator")
            self.assertEqual(op_row.lane, None)
            self.assertIsNotNone(op_row.actor_user_id)
            self.assertIsNone(op_row.auto_reason_code)

            auto_row = _record_auto(base)["row"]
            self.assertEqual(auto_row["actor_kind"], "autonomous_profile")
            self.assertEqual(auto_row["lane"], "L0-main")
            self.assertIsNone(auto_row["actor_user_id"])
            self.assertIsNone(auto_row["reason"])
            self.assertEqual(auto_row["auto_reason_code"], "classifier_pass")
            self.assertEqual(auto_row["classifier_decision_hash"], "hash-abc")

            # Both actor_kinds are in the validated set.
            self.assertIn(op_row.actor_kind, ACK_ACTOR_KINDS)
            self.assertIn(auto_row["actor_kind"], ACK_ACTOR_KINDS)

    def test_i_v3_19c_secrets_dir_gitignored(self) -> None:
        text = (_REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("aria-tools/secrets/", text)
        self.assertIn("aria-tools/acks/", text)

    def test_i_v3_19d_hmac_key_not_committed_to_git_history(self) -> None:
        """Plan ARIA-V3 AUDITTRAIL-CRITICAL-001 — the key file MUST
        NOT appear anywhere in git history. We allow the test to
        run against the live repo (read-only) and fail-closed if
        the file was ever tracked.
        """
        completed = subprocess.run(
            [
                "git",
                "-C",
                str(_REPO_ROOT),
                "log",
                "--all",
                "--full-history",
                "--",
                "aria-tools/secrets/ack_hmac.key",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"git log returned non-zero: {completed.stderr}",
        )
        self.assertEqual(
            completed.stdout.strip(),
            "",
            msg=(
                "aria-tools/secrets/ack_hmac.key was found in git history. "
                "Run emergency rotation per docs/runbooks/aria-ack-key-rotation.md."
            ),
        )

    def test_i_v3_19e_key_rotation_preserves_historical_verification(self) -> None:
        from aria_kernel.ack_ledger import rotate_key, verify_range

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-19e-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            # Mint a row signed under the first key.
            old_row = _mint_row(base, draft_suffix="old")
            # Rotate.
            rotate_key(
                base_dir=base,
                reason="key rotation invariant test",
                operator_approval_ref="RFC-ROT",
            )
            # Mint a row signed under the second key.
            new_row = _mint_row(base, draft_suffix="new")
            # Both rows must verify (rolling key list resolves).
            result = verify_range(base_dir=base)
            self.assertEqual(result["invalid_count"], 0)
            old_result = [
                r for r in result["results"]
                if r["ack_id"] == old_row.ack_id
            ]
            new_result = [
                r for r in result["results"]
                if r["ack_id"] == new_row.ack_id
            ]
            self.assertEqual(len(old_result), 1)
            self.assertEqual(len(new_result), 1)
            self.assertTrue(old_result[0]["valid"])
            self.assertTrue(new_result[0]["valid"])

    def test_i_v3_19f_dr_runbook_aria_ack_key_rotation_present(self) -> None:
        runbook = _REPO_ROOT / "docs" / "runbooks" / "aria-ack-key-rotation.md"
        self.assertTrue(runbook.exists())
        text = runbook.read_text(encoding="utf-8")
        # Smoke-check sections present (mirror Phase A0 invariant).
        for section in (
            "## 1. Key custody",
            "## 2. Scheduled rotation",
            "## 3. Emergency rotation",
            "## 4. Key loss",
        ):
            self.assertIn(section, text)

    def test_i_v3_20_ack_mint_cli_validates_reason(self) -> None:
        """``ack mint --reason`` must run through ``_validate_reason``
        (length >= 10, no PII tokens). Short/PII reasons fail at
        argparse-parse time with non-zero exit.
        """
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "aria_kernel",
                "--tools-dir",
                "/tmp/aria-i-v3-20-bogus",
                "ack",
                "mint",
                "--draft-id",
                "x",
                "--kind",
                "agent",
                "--reason",
                "short",  # <10 chars → argparse rejects
                "--operator-user-id",
                "tester",
            ],
            env={"PYTHONPATH": "aria-kernel"},
            check=False,
            capture_output=True,
            text=True,
            cwd=str(_REPO_ROOT),
            timeout=30,
        )
        self.assertNotEqual(
            result.returncode,
            0,
            msg=f"Short reason should have failed validation. stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        self.assertTrue(
            "reason" in (result.stderr or "").lower()
            or "argument --reason" in (result.stderr or "")
            or "argumenttypeerror" in (result.stderr or "").lower()
            or "invalid" in (result.stderr or "").lower(),
            msg=f"Expected reason-validation error in stderr: {result.stderr!r}",
        )


class AckLedgerSingleOwnerContracts(unittest.TestCase):
    """Structural pins: each ack-ledger concept has exactly one owner."""

    def _tree(self) -> ast.Module:
        return ast.parse(_ACK_LEDGER_SOURCE.read_text(encoding="utf-8"))

    def test_ack_ledger_has_no_private_json_encoder(self) -> None:
        # The HMAC subject must go through ledger.canonical_json, the
        # kernel's one canonicalizer; a private json.dumps copy can drift
        # from it (ensure_ascii, separators) without any test noticing.
        tree = self._tree()
        json_aliases = {
            alias.asname or alias.name
            for node in ast.walk(tree) if isinstance(node, ast.Import)
            for alias in node.names if alias.name == "json"
        }
        dumps_aliases = {
            alias.asname or alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module == "json"
            for alias in node.names if alias.name == "dumps"
        }
        private_encoders = [
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and (
                (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "dumps"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id in json_aliases
                )
                or (isinstance(node.func, ast.Name) and node.func.id in dumps_aliases)
            )
        ]
        self.assertEqual(
            private_encoders,
            [],
            msg=f"ack_ledger.py encodes JSON privately at lines {private_encoders}",
        )

    def test_signature_subject_bytes_are_pinned(self) -> None:
        # Persisted signatures were computed over these exact bytes; any
        # encoder change (non-ASCII escaping, key order, separators) would
        # invalidate every historical ack row.
        from aria_kernel.ack_ledger import _canonical_row_bytes
        from aria_kernel.ledger import canonical_json

        mint_row = {
            "ack_id": "a-1",
            "reason": "çalış ✓",
            "nested": {"b": 1, "a": [2, 1]},
            "signature": "sig",
            "ledger_hash": "h",
            "previous_ledger_hash": "p",
            "consumed_at": "t",
            "consumed_by_event_id": "e",
        }
        mint_subject = {
            k: v for k, v in mint_row.items()
            if k not in {
                "signature", "ledger_hash", "previous_ledger_hash",
                "consumed_at", "consumed_by_event_id",
            }
        }
        self.assertEqual(
            _canonical_row_bytes(mint_row),
            b'{"ack_id":"a-1","nested":{"a":[2,1],"b":1},'
            b'"reason":"\\u00e7al\\u0131\\u015f \\u2713"}',
        )
        self.assertEqual(
            _canonical_row_bytes(mint_row),
            canonical_json(mint_subject).encode("utf-8"),
        )
        consumed_row = {
            "event": "consumed",
            "ack_id": "a-1",
            "consumed_at": "t",
            "consumed_by_event_id": "e",
            "signature": "sig",
        }
        self.assertEqual(
            _canonical_row_bytes(consumed_row),
            b'{"ack_id":"a-1","consumed_at":"t","consumed_by_event_id":"e",'
            b'"event":"consumed"}',
        )

    def test_ack_mint_row_is_built_in_one_place(self) -> None:
        # Two hand-written mint-row literals can drift apart field by
        # field; one shared builder makes operator and autonomous rows
        # structurally identical.
        row_literals = [
            node.lineno
            for node in ast.walk(self._tree())
            if isinstance(node, ast.Dict) and any(
                isinstance(key, ast.Constant) and key.value == "commit_sha_at_mint"
                for key in node.keys
            )
        ]
        self.assertEqual(
            len(row_literals),
            1,
            msg=f"ack mint row literals at lines {row_literals}",
        )

    def test_a_row_key_the_dataclass_does_not_declare_refuses_before_any_write(self) -> None:
        # The dataclass is the row schema's owner. A drift between the row
        # dict and it must refuse the mint with nothing persisted: a signed
        # row already on acks.jsonl is a consumable token the caller never
        # received.
        import dataclasses
        from unittest import mock

        from aria_kernel import ack_ledger
        from aria_kernel.ack_row import AckLedgerRow
        from aria_kernel.ledger import load_jsonl

        narrowed = dataclasses.make_dataclass(
            "NarrowedAckLedgerRow",
            [
                (field.name, field.type, field)
                for field in dataclasses.fields(AckLedgerRow)
                if field.name != "parent_observation_id"
            ],
            frozen=True,
        )
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            tools.mkdir()
            _seed_init(tools)
            ledger_path = ack_ledger._ledger_path(tools)
            rows_before = load_jsonl(ledger_path) if ledger_path.exists() else []
            governance = tools / "governance.jsonl"
            with mock.patch.object(ack_ledger, "AckLedgerRow", narrowed):
                with self.assertRaises(TypeError):
                    _mint_row(tools)
            rows_after = load_jsonl(ledger_path) if ledger_path.exists() else []
            self.assertEqual(rows_after, rows_before)
            self.assertEqual(
                [
                    row for row in load_jsonl(governance)
                    if row.get("kind") == "ack_token_minted"
                ],
                [],
            )


if __name__ == "__main__":
    unittest.main()
