"""ARIA-HIGH-278 — what a publish consumes as evidence stays bounded at any age.

Every aria/state publish verifies its own commit against the evidence-input
budget (`autonomy_evidence._MAX_EVIDENCE_INPUT_BYTES`). It used to consume
every counted ledger in full, every segment of a rolled-over family included,
so ledger age alone would refuse publishing. A carried ledger's published
prefix is now carried by a checkpoint row (`evidence_checkpoints`) that the
commit adding it verifies, and a publish consumes only the rows after it:
sealed segments cost nothing however many there are, the counters equal a
full re-read, a rewritten prefix or a forged checkpoint refuses, and the
budget still refuses what the unconsumed rows alone exceed.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import tempfile
import unittest
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import autonomy_evidence as evidence
from aria_kernel import ledger, state_store
from aria_kernel.autonomy_state import AutonomyStateAccumulator
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl, rewrite_declared_jsonl
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    checkout_state_store,
    publish_with_contention_replay,
    tools_root,
)
from aria_kernel.tool_registry import append_tools_governance
from tests.test_state_store import REPO_HASH, _EnvPatch, _git as _git_raw

OCT = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
REQUESTS = "agent_invocation_requests"
SEGMENTS = "agent_invocation_request_segments"
SEGMENT_BYTES = 32 * 1024
PAD = "x" * 6000


def _git(cwd: Path, *args: str) -> str:
    return _git_raw(cwd, *args).strip()


def _request(number: int) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "row_type": "request",
        "row_id": f"request:{number:06d}",
        "request_id": f"AIR-{number:06d}",
        "role": "judge",
        "evidence_refs": [PAD],
    }


class EvidenceCheckpointTests(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        # Every published prefix is checkpointed by the next publish.
        for patcher in (
            mock.patch.object(evidence, "EVIDENCE_CHECKPOINT_STRIDE_BYTES", 1),
            mock.patch.object(ledger, "SEGMENT_ROLLOVER_BYTES", SEGMENT_BYTES),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.published = 0
        self.requests = 0

    # -- a bound aria/state store, as the restore action leaves every lane's --

    def _store(self) -> Any:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        remote, repo = base / "remote.git", base / "work"
        remote.mkdir()
        repo.mkdir()
        _git(remote, "init", "--bare", "--initial-branch=main", ".")
        _git(repo, "init", "--initial-branch=main", ".")
        for key, value in (("user.email", "aria@example.invalid"), ("user.name", "ARIA Test"), ("commit.gpgsign", "false")):
            _git(repo, "config", key, value)
        _git(repo, "remote", "add", "origin", str(remote))
        (repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(repo, "add", "README.md")
        _git(repo, "commit", "-m", "seed")
        _git(repo, "push", "origin", "main")
        self.repo, self.target = repo, _git(repo, "rev-parse", "HEAD")
        with _EnvPatch({BOOTSTRAP_ACK_ENV: state_store._repository_identity(repo)}):
            store = checkout_state_store(repo, store_dir=base / "store")
            from aria_kernel.tools_binding import bind_tools_root

            with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
                bind_tools_root(tools_dir=str(tools_root(store)), workspace_root=str(repo), reason="bind for test")
        return store

    def _publish(self, store: Any) -> dict[str, Any]:
        self.published += 1
        with _EnvPatch({BOOTSTRAP_ACK_ENV: state_store._repository_identity(self.repo)}):
            return publish_with_contention_replay(
                store,
                snapshot_id=f"snap-{self.published}",
                cycle_id=f"cycle-{self.published}",
                lane="test",
                repo_hash=REPO_HASH,
            )

    def _verify(self, store: Any, ref: str = "HEAD") -> Any:
        commit = _git(store.root, "rev-parse", ref)
        return evidence._verify_snapshot_and_collect_evidence(
            store=store,
            repo_identity=REPO_HASH,
            state_commit=commit,
            expected_snapshot_object_id=_git(store.root, "rev-parse", f"{commit}:snapshot.json"),
        )

    def _claims(self, store: Any) -> dict[str, dict[str, Any]]:
        return json.loads(_git(store.root, "show", "HEAD:snapshot.json"))["surfaces"]

    # -- rows on every carried ledger, and on one that is not carried --

    def _append_requests(self, store: Any, count: int) -> None:
        for _ in range(count):
            self.requests += 1
            ledger.append_segment_rows(
                tools_root(store), [_request(self.requests)],
                expected_surface=REQUESTS, now=OCT, bypass_profile_gate=True,
            )

    def _seal(self, store: Any, sealed: int) -> None:
        """Append requests until ``sealed`` monthly segments are sealed."""
        directory = tools_root(store) / "agent-invocations" / "requests"
        while len(list(directory.glob("*.jsonl")) if directory.is_dir() else []) < sealed + 1:
            self._append_requests(store, 1)

    def _append_other_evidence(self, store: Any, round_number: int) -> None:
        tools = tools_root(store)
        append_tools_governance(
            tools, "executor_drain_completed", {"attempted": 2, "succeeded": round_number, "failed": 1},
        )
        rows = {
            ("autonomy_state.jsonl", "autonomy_state"): {
                "schema_version": 1, "phase": "cycle_completed", "status": "ok",
                "cycle_id": f"c-{round_number}", "planner_claims_delta": 1,
            },
            ("fixture-runs.jsonl", "agent_eval_fixture_runs"): {
                "schema_version": 1, "$schema": "aria/agent-eval-fixture-run/v1",
                "row_type": "fixture_run_suite", "execution_run_id": f"run-{round_number}",
                "passed": round_number % 2 == 0, "actual_status": "pass",
            },
            ("auto-merge-decisions.jsonl", "auto_merge_decisions"): {
                "schema_version": 1, "decision": "blocked", "stage": "pre_merge",
            },
            ("cycles.jsonl", "cycles"): {
                "schema_version": 3, "cycle_id": f"cycle-row-{round_number}", "event": "completed",
                "status": "completed", "git_head_sha_at_cycle": self.target,
            },
        }
        for (path, surface), row in rows.items():
            append_declared_jsonl(tools / path, row, expected_surface=surface, bypass_profile_gate=True)

    def _carried_world(self, sealed: int) -> Any:
        """Publish ``sealed`` sealed segments, then carry them by checkpoint.

        P1 publishes them, P2 records their checkpoints (verified on P2), P3
        adds one open-segment row: P3's parent trusts every checkpoint.
        """
        store = self._store()
        self._seal(store, sealed)
        self._append_other_evidence(store, 1)
        self.assertTrue(self._publish(store)["published"])
        self._append_other_evidence(store, 2)
        self.assertTrue(self._publish(store)["published"])
        self._append_requests(store, 1)
        self.assertTrue(self._publish(store)["published"])
        return store

    @staticmethod
    def _sealed_bytes(claims: dict[str, dict[str, Any]]) -> int:
        segments = sorted(key for key in claims if key.startswith(f"{SEGMENTS}:"))
        return sum(claims[key]["size_bytes"] for key in segments[:-1])

    @staticmethod
    def _counted_bytes(claims: dict[str, dict[str, Any]]) -> int:
        counted = {name for spec in evidence.CAPABILITY_SPECS.values() for name in spec.count_surfaces}
        return sum(
            claim["size_bytes"] for key, claim in claims.items()
            if ledger.segment_family(key.split(":", 1)[0]) in counted
        )

    # -- the four properties --

    def test_sealed_segments_cost_nothing_however_many_there_are(self) -> None:
        consumed: dict[int, int] = {}
        for sealed in (1, 4):
            with self.subTest(sealed=sealed):
                store = self._carried_world(sealed)
                claims = self._claims(store)
                checkpoint_bytes = claims[evidence.EVIDENCE_CHECKPOINT_SURFACE]["size_bytes"]
                # The commit consumes the open row, not the sealed history: a
                # budget below what the old full read charged still admits it.
                budget = self._counted_bytes(claims) - self._sealed_bytes(claims) + checkpoint_bytes
                self.assertGreater(self._sealed_bytes(claims), checkpoint_bytes)
                with mock.patch.object(evidence, "_MAX_EVIDENCE_INPUT_BYTES", budget):
                    accumulator = self._verify(store)
                consumed[sealed] = accumulator.evidence_input_bytes - checkpoint_bytes
        self.assertEqual(consumed[1], consumed[4], "ledger input must not grow with sealed segments")

    def test_counters_equal_a_full_re_read(self) -> None:
        for sealed in (0, 2, 3):
            with self.subTest(sealed=sealed):
                self.requests = 0
                store = self._store()
                commits: list[str] = []
                for round_number in range(1, 5):
                    self._seal(store, sealed + round_number // 3)
                    self._append_requests(store, 1)
                    self._append_other_evidence(store, round_number)
                    self.assertTrue(self._publish(store)["published"])
                    commits.append(_git(store.root, "rev-parse", "HEAD"))
                self.assertGreater(
                    len(load_declared_jsonl(
                        tools_root(store) / "evidence-checkpoints.jsonl",
                        expected_surface=evidence.EVIDENCE_CHECKPOINT_SURFACE,
                    )),
                    sealed,
                )
                for commit in commits:
                    accumulator = self._verify(store, commit)
                    with mock.patch.object(evidence, "_carried_claim_cursors", lambda **_: ({}, 0)):
                        full = self._projection(self._verify(store, commit))
                    self.assertEqual(self._projection(accumulator), full, commit)
                # The last commit really started from trusted checkpoints.
                self.assertLess(accumulator.evidence_input_bytes, self._counted_bytes(self._claims(store)))

    def test_a_rewritten_sealed_segment_refuses_the_publish(self) -> None:
        store = self._carried_world(2)
        sealed = sorted((tools_root(store) / "agent-invocations" / "requests").glob("*.jsonl"))[0]
        rows = load_declared_jsonl(sealed, expected_surface=SEGMENTS)
        stripped = [
            {key: value for key, value in row.items() if key not in {"ledger_hash", "previous_ledger_hash"}}
            for row in rows
        ]
        stripped[1]["role"] = "planner"
        rewrite_declared_jsonl(
            sealed, stripped, expected_surface=SEGMENTS, migration_id="tamper", bypass_profile_gate=True,
        )
        self._append_requests(store, 1)
        with self.assertRaises(StateStoreRefusal) as refused:
            self._publish(store)
        self.assertIn(
            f"state_commit_evidence_checkpoint_mismatch:{SEGMENTS}:"
            f"agent-invocations/requests/{sealed.name}",
            str(refused.exception),
        )

    def test_budget_refuses_exactly_when_the_unconsumed_rows_exceed_it(self) -> None:
        store = self._carried_world(3)
        open_segment = sorted((tools_root(store) / "agent-invocations" / "requests").glob("*.jsonl"))[-1]
        before = open_segment.stat().st_size
        self._append_requests(store, 3)
        unconsumed = open_segment.stat().st_size - before
        self.assertTrue(self._publish(store)["published"])
        claims = self._claims(store)
        carried_budget = (
            self._counted_bytes(claims) - self._sealed_bytes(claims)
            + claims[evidence.EVIDENCE_CHECKPOINT_SURFACE]["size_bytes"]
        )
        with mock.patch.object(evidence, "_MAX_EVIDENCE_INPUT_BYTES", carried_budget):
            self._verify(store)
        with mock.patch.object(evidence, "_MAX_EVIDENCE_INPUT_BYTES", unconsumed - 1):
            with self.assertRaisesRegex(RuntimeError, "^state_commit_evidence_budget_exceeded$"):
                self._verify(store)

    def test_a_forged_checkpoint_refuses_the_publish(self) -> None:
        store = self._carried_world(1)
        recorded = load_declared_jsonl(
            tools_root(store) / "evidence-checkpoints.jsonl", expected_surface=evidence.EVIDENCE_CHECKPOINT_SURFACE,
        )
        forged = {
            key: value for key, value in recorded[-1].items() if key not in {"ledger_hash", "previous_ledger_hash"}
        }
        forged["row_id"] += ":forged"
        forged["evidence"]["ordinal"] += 1
        append_declared_jsonl(
            tools_root(store) / "evidence-checkpoints.jsonl", forged,
            expected_surface=evidence.EVIDENCE_CHECKPOINT_SURFACE, bypass_profile_gate=True,
        )
        with self.assertRaises(StateStoreRefusal) as refused:
            self._publish(store)
        self.assertIn(f"state_commit_evidence_checkpoint_mismatch:{forged['surface_key']}", str(refused.exception))

    def test_rewritten_checkpoint_history_refuses_the_publish(self) -> None:
        store = self._carried_world(1)
        path = tools_root(store) / "evidence-checkpoints.jsonl"
        kept = [
            {key: value for key, value in row.items() if key not in {"ledger_hash", "previous_ledger_hash"}}
            for row in load_declared_jsonl(path, expected_surface=evidence.EVIDENCE_CHECKPOINT_SURFACE)[1:]
        ]
        rewrite_declared_jsonl(
            path, kept, expected_surface=evidence.EVIDENCE_CHECKPOINT_SURFACE,
            migration_id="drop", bypass_profile_gate=True,
        )
        self._append_requests(store, 1)
        with self.assertRaises(StateStoreRefusal) as refused:
            self._publish(store)
        self.assertIn("state_commit_evidence_checkpoints_rewritten", str(refused.exception))

    def test_the_fold_version_is_pinned_to_the_fold(self) -> None:
        """A change to how a carried row folds must bump the fold version, or
        checkpoints recorded under the old fold would be merged as if current."""
        accumulator = evidence._StreamingEvidenceAccumulator
        parts = [
            inspect.getsource(function)
            for function in (
                accumulator.consume, accumulator._consume_counts, accumulator.carried_state,
                accumulator.merge_carried, evidence._summarize_native_rows, AutonomyStateAccumulator.consume,
                evidence._CarriedClaimCursor,
            )
        ]
        parts.append(repr(sorted(evidence._CARRIED_COUNT_SURFACES)))
        for spec in evidence.CAPABILITY_SPECS.values():
            for contract in spec.contracts:
                if contract.surface in evidence._CARRIED_COUNT_SURFACES:
                    parts.append(repr((
                        contract.surface, contract.schema_id, sorted(contract.schema_versions),
                        contract.identity_field, contract.integrity_hash_field, contract.authoritative_sha_field,
                        inspect.getsource(contract.terminal_predicate), inspect.getsource(contract.upcaster),
                    )))
        fold = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
        self.assertEqual(
            (evidence.EVIDENCE_CHECKPOINT_FOLD_VERSION, fold),
            (1, "b4459dab2c7d7d421a3102f3f9544a2f5b393af1b31af0a8916e8e1d0d89a63c"),
            "the carried fold changed: bump EVIDENCE_CHECKPOINT_FOLD_VERSION and re-pin this digest",
        )

    def _projection(self, accumulator: Any) -> str:
        counts, blockers = accumulator.capability_counts(repo_root=self.repo, target_sha=self.target)
        native = {
            capability: {
                "counts": dict(summary.counts),
                "blockers": list(summary.blockers),
                "budgets": [summary.distinct_target_budget_exceeded, summary.global_target_budget_exceeded],
                "targets": {
                    contract.surface: [
                        [
                            target.candidate.row_id, target.candidate.row_hash,
                            target.candidate.evidence_target_sha, target.admissible_count,
                            sorted(target.admissible_by_schema.items()), target.ordinal,
                        ]
                        for target in targets
                    ]
                    for contract, targets in summary.targets_by_contract.items()
                },
            }
            for capability, summary in accumulator.native_summaries().items()
        }
        return json.dumps({
            "counts": counts,
            "blockers": blockers,
            "native": native,
            "surface_counts": {name: value for name, value in accumulator.surface_counts.items() if value},
            "metrics": {name: value for name, value in accumulator.metrics.items() if value},
            "ordinal": accumulator.ordinal,
            "autonomy_state": asdict(accumulator.autonomy_state),
            "count_rejected": sorted(accumulator.count_rejected),
        }, sort_keys=True)


if __name__ == "__main__":
    unittest.main()
