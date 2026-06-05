from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.ledger import (
    LedgerIntegrityError,
    LegacyLedgerContext,
    append_declared_jsonl,
    append_jsonl,
    load_declared_jsonl,
    load_jsonl,
    read_jsonl,
    rewrite_declared_json,
    rewrite_declared_jsonl,
    rewrite_jsonl,
    state_transaction,
)
from aria_kernel.next_cycle_queue import append_pending, read_pending
from aria_kernel.state_manifest import StateSurface, surface_for_path, surface_by_name, validate_manifest_invariants
from aria_kernel.tool_registry import ensure_tools_binding, ensure_tools_dir


_REPO_ROOT = Path(__file__).resolve().parents[2]


def _bound_tools_root(tmp: str | Path) -> Path:
    return ensure_tools_binding(Path(tmp) / "aria-tools", workspace_root=_REPO_ROOT)


def _legacy_context(
    path: Path,
    *,
    expected_surface: str = "context_audits",
    migration_id: str = "MIG-ctx-001",
    operator_ack_ref: str = "ACK-ctx-001",
    expires_at: str = "2099-01-01T00:00:00+00:00",
    operation: str = "rewrite_jsonl",
) -> LegacyLedgerContext:
    return LegacyLedgerContext(
        migration_id=migration_id,
        expected_surface=expected_surface,
        exact_path_scope=path,
        operator_ack_ref=operator_ack_ref,
        expires_at=expires_at,
        reason="unit migration context",
        operation=operation,  # type: ignore[arg-type]
    )


class StateManifestTransactionTests(unittest.TestCase):
    def test_manifest_resolves_ack_and_queue_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-manifest-") as tmp:
            root = _bound_tools_root(tmp)
            ack = root / "acks" / "acks.jsonl"
            queue = root / "queues" / "next_cycle_queue.jsonl"
            self.assertEqual(surface_for_path(ack)[0].name, "ack_ledger")
            self.assertEqual(surface_for_path(queue)[0].name, "next_cycle_queue")
            self.assertEqual(
                surface_by_name("ack_ledger").path_pattern,
                "acks/acks.jsonl",
            )

    def test_manifest_rejects_unbound_rogue_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-rogue-") as tmp:
            rogue = Path(tmp) / "rogue" / "context-audits.jsonl"
            self.assertIsNone(surface_for_path(rogue))

    def test_manifest_rejects_malformed_unbound_hash_drift_and_symlink_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-identity-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            self.assertEqual(surface_for_path(target)[0].name, "context_audits")

            identity_path = root / "repo_identity.json"
            original = identity_path.read_text(encoding="utf-8")
            identity_path.write_text("{bad json", encoding="utf-8")
            self.assertIsNone(surface_for_path(target))

            identity_path.write_text(original, encoding="utf-8")
            root_index = json.loads((root / "integrity_index.json").read_text(encoding="utf-8"))
            root_index["file_hashes"]["repo_identity"] = "wrong"
            (root / "integrity_index.json").write_text(json.dumps(root_index), encoding="utf-8")
            self.assertIsNone(surface_for_path(target))

        with tempfile.TemporaryDirectory(prefix="aria-state-unbound-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertIsNone(surface_for_path(root / "context-audits.jsonl"))

        with tempfile.TemporaryDirectory(prefix="aria-state-symlink-") as tmp:
            root = _bound_tools_root(Path(tmp) / "real")
            link = Path(tmp) / "linked-tools"
            link.symlink_to(root, target_is_directory=True)
            self.assertIsNone(surface_for_path(link / "context-audits.jsonl"))

    def test_declared_context_audit_append_and_load(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-ledger-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            stored = append_declared_jsonl(
                target,
                {"event": "audit", "schema_version": 1},
                expected_surface="context_audits",
            )
            rows = load_declared_jsonl(target, expected_surface="context_audits")
            self.assertEqual(rows, [stored])
            self.assertTrue(rows[0]["ledger_hash"].startswith("sha256:"))

    def test_raw_context_audit_append_load_and_rewrite_reject(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-raw-declared-reject-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_append_api"):
                append_jsonl(target, {"event": "raw"})
            append_declared_jsonl(
                target,
                {"event": "declared", "schema_version": 1},
                expected_surface="context_audits",
            )
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_load_declared_jsonl"):
                load_jsonl(target, verify=True)
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_load_declared_jsonl"):
                read_jsonl(target)
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_rewrite_api"):
                rewrite_jsonl(target, [{"event": "raw-rewrite"}])

    def test_declared_strict_read_rejects_verify_false(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-strict-read-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            append_declared_jsonl(target, {"event": "declared", "schema_version": 1}, expected_surface="context_audits")
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_jsonl_strict_read_required"):
                load_declared_jsonl(target, expected_surface="context_audits", verify=False)
            with state_transaction([target]) as txn:
                with self.assertRaisesRegex(LedgerIntegrityError, "declared_jsonl_strict_read_required"):
                    txn.load_declared_jsonl(target, expected_surface="context_audits", verify=False)

    def test_declared_append_rejects_corrupt_existing_chain_before_write(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-corrupt-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            target.write_text(json.dumps({"event": "hashless"}) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(LedgerIntegrityError, "strict verification failed"):
                append_declared_jsonl(target, {"event": "next", "schema_version": 1}, expected_surface="context_audits")
            self.assertEqual(target.read_text(encoding="utf-8").count("\n"), 1)

    def test_declared_rewrite_requires_legacy_context(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-rewrite-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "legacy_context_migration_id_missing"):
                rewrite_declared_jsonl(
                    target,
                    [{"event": "rewrite"}],
                    expected_surface="context_audits",
                    legacy_context=_legacy_context(target, migration_id=""),
                )
            rewrite_declared_jsonl(
                target,
                [{"event": "rewrite"}],
                expected_surface="context_audits",
                legacy_context=_legacy_context(target),
            )
            rows = load_declared_jsonl(target, expected_surface="context_audits")
            self.assertEqual(rows[0]["event"], "rewrite")

    def test_legacy_context_rejects_expired_wrong_scope_and_missing_ack(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-legacy-context-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            cases = (
                ("legacy_context_expired", _legacy_context(target, expires_at="2000-01-01")),
                ("legacy_context_path_scope_mismatch", _legacy_context(root / "other.jsonl")),
                ("legacy_context_operator_ack_ref_missing", _legacy_context(target, operator_ack_ref="")),
            )
            for expected, legacy_context in cases:
                with self.subTest(expected=expected):
                    with self.assertRaisesRegex(LedgerIntegrityError, expected):
                        rewrite_declared_jsonl(
                            target,
                            [{"event": "rewrite"}],
                            expected_surface="context_audits",
                            legacy_context=legacy_context,
                        )

    def test_declared_api_rejects_wrong_operation_type(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-operation-") as tmp:
            root = _bound_tools_root(tmp)
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_append_requires_append_ledger"):
                append_declared_jsonl(root / "registry.json", {"event": "bad"}, expected_surface="tool_registry")
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_json_rewrite_requires_json_surface"):
                rewrite_declared_json(
                    target,
                    {"event": "bad"},
                    expected_surface="context_audits",
                    legacy_context=_legacy_context(target, operation="rewrite_json"),
                )

    def test_manifest_invariants_reject_duplicate_authority(self) -> None:
        validate_manifest_invariants()
        duplicate = StateSurface(
            "context_audits_duplicate",
            "context-audits.jsonl",
            "ledger",
            "context",
            "tools",
            True,
            "append_fsync",
            True,
        )
        with self.assertRaisesRegex(ValueError, "duplicate_authoritative_path_pattern"):
            validate_manifest_invariants((surface_by_name("context_audits"), duplicate))

    def test_state_transaction_appends_hash_chained_rows(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-txn-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "queues" / "next_cycle_queue.jsonl"
            with state_transaction([target]) as txn:
                txn.append_jsonl(target, {"event": "one"})
                txn.append_jsonl(target, {"event": "two"})
            rows = load_jsonl(target, verify=True)
            self.assertEqual([row["event"] for row in rows], ["one", "two"])
            self.assertEqual(rows[1]["previous_ledger_hash"], rows[0]["ledger_hash"])

    def test_transaction_raw_declared_append_rejects(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-txn-declared-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            with state_transaction([target]) as txn:
                with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_append_api"):
                    txn.append_jsonl(target, {"event": "raw"})
                stored = txn.append_declared_jsonl(
                    target,
                    {"event": "declared", "schema_version": 1},
                    expected_surface="context_audits",
                )
            rows = load_declared_jsonl(target, expected_surface="context_audits")
            self.assertEqual(rows, [stored])

    def test_declared_api_rejects_wrong_expected_surface(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-surface-mismatch-") as tmp:
            root = _bound_tools_root(tmp)
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_mismatch"):
                append_declared_jsonl(
                    target,
                    {"event": "wrong-surface"},
                    expected_surface="agent_invocation_contexts",
                )

    def test_queue_depth_check_runs_under_transaction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-queue-txn-") as tmp:
            root = Path(tmp) / "aria-tools"
            with patch.dict(os.environ, {"ARIA_NEXT_CYCLE_QUEUE_DEPTH": "1"}):
                first = append_pending(
                    root,
                    source_cycle_id="cycle-1",
                    pressure_id="p-1",
                )
                second = append_pending(
                    root,
                    source_cycle_id="cycle-2",
                    pressure_id="p-2",
                )
            self.assertIsNotNone(first)
            self.assertIsNotNone(second)
            self.assertEqual(second["state"], "blocked")
            self.assertEqual(second["reason"], "queue_depth_exceeded")
            self.assertEqual(len(read_pending(root)), 1)
            governance = load_jsonl(root / "governance.jsonl", verify=True)
            self.assertEqual(governance[-1]["kind"], "next_cycle_queue_overflow_blocked")


if __name__ == "__main__":
    unittest.main()
