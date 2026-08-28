from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import inspect
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import aria_kernel.agent_invocations as agent_invocations
import aria_kernel.ledger as ledger_module
import aria_kernel.worker_dispatch as worker_dispatch
from aria_kernel.ledger import (
    append_declared_jsonl,
    append_jsonl,
    load_jsonl,
    rewrite_declared_json,
    rewrite_declared_jsonl,
    rewrite_jsonl,
    state_transaction,
    write_index,
)
from aria_kernel.next_cycle_queue import append_pending, read_pending
import aria_kernel.state_manifest as state_manifest
from aria_kernel.state_manifest import surface_for_path, surface_by_name
from aria_kernel.tool_registry import ensure_tools_dir


class StateManifestTransactionTests(unittest.TestCase):
    def test_component_matcher_matches_path_glob_without_crossing_slashes(self) -> None:
        cases = {
            ("dispatch/direct.jsonl", "dispatch/*.jsonl"): True,
            ("dispatch/nested/rejected.jsonl", "dispatch/*.jsonl"): False,
            ("agent-invocations/outputs/direct.md", "agent-invocations/outputs/**/*.md"): True,
            ("agent-invocations/outputs/group/one.md", "agent-invocations/outputs/**/*.md"): True,
            ("agent-invocations/outputs/group/deep/two.md", "agent-invocations/outputs/**/*.md"): True,
        }
        for (relative, pattern), expected in cases.items():
            with self.subTest(relative=relative, pattern=pattern):
                self.assertEqual(
                    state_manifest.surface_path_matches(relative, pattern),
                    expected,
                )
        self.assertIsNone(
            state_manifest.surface_for_relative_path(
                "dispatch/nested/rejected.jsonl",
            ),
        )

    def test_pathological_match_input_is_rejected_by_named_limits(self) -> None:
        deep = "/".join(["component"] * 129)
        with self.assertRaisesRegex(ValueError, "surface_path_too_deep"):
            state_manifest.surface_path_matches(deep, "**/*.jsonl")
        overlong = "x" * 4097
        with self.assertRaisesRegex(ValueError, "surface_path_too_long"):
            state_manifest.surface_path_matches(overlong, "*.jsonl")

    def test_manifest_pattern_grammar_and_duplicate_ambiguity_are_invariant(self) -> None:
        state_manifest.validate_state_surface_patterns()
        runs = surface_by_name("runs")
        duplicate = replace(runs, name="duplicate_runs")
        with self.assertRaisesRegex(ValueError, "state_surface_pattern_ambiguous"):
            state_manifest.validate_state_surface_patterns((runs, duplicate))
        invalid = replace(
            runs,
            name="invalid_recursive_pattern",
            path_pattern="runs/**suffix/*.jsonl",
        )
        with self.assertRaisesRegex(ValueError, "state_surface_pattern_invalid"):
            state_manifest.validate_state_surface_patterns((invalid,))

    def test_manifest_resolves_ack_and_queue_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-manifest-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            ack = root / "acks" / "acks.jsonl"
            queue = root / "queues" / "next_cycle_queue.jsonl"
            self.assertEqual(surface_for_path(ack)[0].name, "ack_ledger")
            self.assertEqual(surface_for_path(queue)[0].name, "next_cycle_queue")
            self.assertEqual(
                surface_by_name("ack_ledger").path_pattern,
                "acks/acks.jsonl",
            )

    def test_state_transaction_appends_hash_chained_rows(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-txn-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "queues" / "next_cycle_queue.jsonl"
            with state_transaction([target]) as txn:
                txn.append_declared_jsonl(target, {"event": "one"}, expected_surface="next_cycle_queue")
                txn.append_declared_jsonl(target, {"event": "two"}, expected_surface="next_cycle_queue")
            rows = load_jsonl(target, verify=True)
            self.assertEqual([row["event"] for row in rows], ["one", "two"])
            self.assertEqual(rows[1]["previous_ledger_hash"], rows[0]["ledger_hash"])

    def test_transaction_lock_order_is_globally_deduplicated_by_bucket(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-lock-order-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            cycles = root / "cycles.jsonl"
            index = root / "integrity_index.json"
            observed = ledger_module._transaction_lock_paths([cycles, index])

            group = ledger_module._state_group_lock_path(cycles)
            self.assertIsNotNone(group)
            self.assertEqual(len(observed), len(set(observed)))
            self.assertEqual(
                observed,
                [
                    group.resolve(),
                    index.resolve(),
                    cycles.resolve(),
                ],
            )

    def test_all_public_state_writers_take_group_index_file_order(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-writer-lock-order-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            queue = root / "queues" / "next_cycle_queue.jsonl"
            profile = root / "runtime-profile.json"
            cycles = root / "cycles.jsonl"
            index = root / "integrity_index.json"
            acquired: list[Path] = []

            @contextmanager
            def record_lock(path, *args, **kwargs):
                acquired.append(Path(path).resolve())
                yield None

            cases = (
                (
                    "append_declared",
                    [queue],
                    lambda: append_declared_jsonl(
                        queue,
                        {"event": "declared"},
                        expected_surface="next_cycle_queue",
                        bypass_profile_gate=True,
                    ),
                ),
                (
                    "append_raw_fixture",
                    [queue],
                    lambda: append_jsonl(
                        queue,
                        {"event": "raw"},
                        test_fixture=True,
                    ),
                ),
                (
                    "rewrite_declared_json",
                    [profile],
                    lambda: rewrite_declared_json(
                        profile,
                        {"schema_version": 1, "profile": "observe"},
                        expected_surface="runtime_profile_state",
                        bypass_profile_gate=True,
                    ),
                ),
                (
                    "rewrite_declared_jsonl",
                    [queue],
                    lambda: rewrite_declared_jsonl(
                        queue,
                        [{"event": "declared-rewrite"}],
                        expected_surface="next_cycle_queue",
                        bypass_profile_gate=True,
                    ),
                ),
                (
                    "rewrite_raw_fixture",
                    [queue],
                    lambda: rewrite_jsonl(
                        queue,
                        [{"event": "raw-rewrite"}],
                        test_fixture=True,
                    ),
                ),
                (
                    "write_index",
                    [cycles, index],
                    lambda: write_index(index, {}, {"cycles": cycles}),
                ),
            )

            with patch.object(
                ledger_module,
                "with_exclusive_lock",
                side_effect=record_lock,
            ):
                for label, paths, writer in cases:
                    with self.subTest(writer=label):
                        acquired.clear()
                        writer()
                        self.assertEqual(
                            acquired,
                            ledger_module._transaction_lock_paths(paths),
                        )

    def test_claim_and_result_cas_writers_use_state_transactions(self) -> None:
        functions = (
            worker_dispatch.claim_assignment,
            worker_dispatch.release_claim_assignment,
            agent_invocations.claim_request,
            agent_invocations.submit_claim_result,
        )
        for function in functions:
            with self.subTest(function=function.__qualname__):
                source = inspect.getsource(function)
                self.assertIn("state_transaction(", source)
                self.assertNotIn("with_exclusive_lock(", source)

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
