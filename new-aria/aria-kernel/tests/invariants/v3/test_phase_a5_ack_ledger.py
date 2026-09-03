"""Plan ARIA-V3 Phase A5 — ack ledger + HMAC custody + CLI.

Locked invariants (9 cases, I-V3-18..20):

  * I-V3-18 — ack ledger is append-only AND every row is signed.
  * I-V3-19 — one-time consumption (second consume raises).
  * I-V3-19a — 17 mandatory ack-row fields present.
  * I-V3-19b — ``actor_kind`` distinguishes operator vs autonomous_profile.
  * I-V3-19c — ``aria-tools/secrets/`` covered by .gitignore.
  * I-V3-19d — HMAC key not committed to git history.
  * I-V3-19e — key rotation preserves historical row verification.
  * I-V3-19f — DR runbook present (aria-ack-key-rotation.md).
  * I-V3-20 — ``ack mint --reason`` validated via ``_validate_reason``.
"""

from __future__ import annotations

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


def _seed_init(tools_dir: Path) -> None:
    from aria_kernel.ack_ledger import init_ack_ledger
    init_ack_ledger(
        base_dir=tools_dir,
        reason="unit test seed initialisation",
        operator_approval_ref="RFC-TEST",
    )


def _mint_row(tools_dir: Path, *, draft_suffix: str = "1"):
    from aria_kernel.ack_ledger import mint_operator_ack
    return mint_operator_ack(
        base_dir=tools_dir,
        draft_id=f"draft-{draft_suffix}",
        intent_id=f"intent-{draft_suffix}",
        target_path=f".claude/agents/aria-test-{draft_suffix}.md",
        kind="agent",
        reason="unit test ack mint",
        operator_user_id="tester",
        profile_name="standard",
        profile_state_at_mint="standard:v1",
        commit_sha_at_mint="deadbeef",
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
            result_first = consume_token(
                base_dir=base,
                ack_id=row.ack_id,
                materialize_event_id="mat-evt-1",
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
                )
            self.assertIn("ack_token_already_consumed", str(ctx.exception))

    def test_i_v3_19a_ack_row_carries_all_required_fields(self) -> None:
        from aria_kernel.ack_ledger import _ledger_path
        from aria_kernel.ack_row import ACK_ROW_REQUIRED_FIELDS

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-19a-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            _mint_row(base)
            line = (
                _ledger_path(base)
                .read_text(encoding="utf-8")
                .splitlines()[0]
            )
            row = json.loads(line)
            missing = ACK_ROW_REQUIRED_FIELDS - set(row.keys())
            self.assertEqual(
                missing,
                set(),
                msg=f"required fields missing from ack row: {sorted(missing)}",
            )

    def test_i_v3_19b_actor_kind_distinguishes_operator_vs_autonomous(self) -> None:
        from aria_kernel.ack_ledger import mint_auto_ack
        from aria_kernel.ack_row import ACK_ACTOR_KINDS

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-19b-") as tmp:
            base = Path(tmp)
            _seed_init(base)
            op_row = _mint_row(base, draft_suffix="op")
            self.assertEqual(op_row.actor_kind, "operator")
            self.assertEqual(op_row.lane, None)
            self.assertIsNotNone(op_row.actor_user_id)
            self.assertIsNone(op_row.auto_reason_code)

            auto_row = mint_auto_ack(
                base_dir=base,
                draft_id="draft-auto",
                intent_id="intent-auto",
                target_path=".claude/agents/aria-auto.md",
                kind="agent",
                profile_name="autonomous",
                lane="L0-main",
                classifier_decision_hash="hash-abc",
                auto_reason_code="classifier_pass",
                profile_state_at_mint="autonomous:v1",
                commit_sha_at_mint="cafef00d",
            )
            self.assertEqual(auto_row.actor_kind, "autonomous_profile")
            self.assertEqual(auto_row.lane, "L0-main")
            self.assertIsNone(auto_row.actor_user_id)
            self.assertIsNone(auto_row.reason)
            self.assertEqual(auto_row.auto_reason_code, "classifier_pass")
            self.assertEqual(auto_row.classifier_decision_hash, "hash-abc")

            # Both actor_kinds are in the validated set.
            self.assertIn(op_row.actor_kind, ACK_ACTOR_KINDS)
            self.assertIn(auto_row.actor_kind, ACK_ACTOR_KINDS)

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
                "--intent-id",
                "i",
                "--target-path",
                ".claude/agents/aria-y.md",
                "--kind",
                "agent",
                "--reason",
                "short",  # <10 chars → argparse rejects
                "--operator-approval-ref",
                "RFC-T",
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


if __name__ == "__main__":
    unittest.main()
