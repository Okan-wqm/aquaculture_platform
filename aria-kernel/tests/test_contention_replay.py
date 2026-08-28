"""The loser of a publish race must not lose its rows.

PLAN Wave 1 PR 2.6. `publish_state` is a compare-and-swap: a plain `git push`
to a fast-forward-only branch, so when two lanes publish from the same tip the
server rejects the second. Today that refusal is where the story ends — the
commit is rolled back, the rows stay staged, and the caller is told to "fetch
and rebuild against the new tip" by hand.

Rebuilding is deterministic, so it should not be by hand. The loser's ledgers
are the winner's ledgers plus its own append-only suffix; replaying that suffix
onto the winner's tip reconstructs a state that contains BOTH lanes' work.

THE COMMON PREFIX IS PROVEN, NOT ASSUMED. Every ledger row carries
`ledger_hash` over the whole chain behind it, and the snapshot both lanes
published from records each surface's `row_count` and `tail_ledger_hash`. So
"these two files share the first N rows" is answerable exactly: the row at
index N-1 must carry the base's tail hash in BOTH files. A hash match at that
index implies the entire prefix matches — that is what a hash chain is for.
Anything else is a rewrite wearing an append's clothes, and it is refused.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import contention_replay as replay_module
from aria_kernel.contention_replay import (
    ReplayRefusal,
    append_only_suffix,
    replay_append_only_suffixes,
)
from aria_kernel.ledger import LedgerIntegrityError, canonical_json, read_jsonl, verify_jsonl
from aria_kernel.ledger_refs import find_row_by_source_ledger_ref, ledger_ref_for_row
from aria_kernel.state_store import _replay_payload_summary
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.declared_fixtures import append_declared_fixture

SURFACE = "cycles"
FILENAME = "cycles.jsonl"
SECOND_SURFACE = "memory_beliefs"
SECOND_RELPATH = "memory/beliefs.jsonl"


def _row(index: int) -> dict:
    return {
        "schema_version": 2,
        "cycle_id": f"cycle-{index}",
        "event": "started",
        "recorded_at": f"2026-08-03T00:{index:02d}:00Z",
    }


def _raw_ledger_hash(row: dict, previous_hash: str | None) -> str:
    payload = dict(row)
    payload.pop("ledger_hash", None)
    payload.pop("previous_ledger_hash", None)
    encoded = canonical_json({
        "previous_ledger_hash": previous_hash,
        "record": payload,
    })
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _rewrite_raw_chain(path: Path, rows: list[dict]) -> None:
    previous_hash: str | None = None
    encoded: list[str] = []
    for source in rows:
        row = dict(source)
        row["previous_ledger_hash"] = previous_hash
        row["ledger_hash"] = _raw_ledger_hash(row, previous_hash)
        previous_hash = row["ledger_hash"]
        encoded.append(json.dumps(row, sort_keys=True, separators=(",", ":")))
    path.write_text("\n".join(encoded) + "\n", encoding="utf-8")


class _Tree:
    """A real tools root with one declared ledger, written through the real appender.

    `ensure_tools_dir` rather than a bare temp directory: `append_declared_jsonl`
    resolves a path against the declared surface manifest, so a fixture written
    somewhere arbitrary is not the thing production writes.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        ensure_tools_dir(self.root)
        self.path = self.root / FILENAME

    def append(self, index: int) -> dict:
        return append_declared_fixture(self.path, _row(index), expected_surface=SURFACE)

    def rows(self) -> list[dict]:
        return read_jsonl(self.path)

    def tail_hash(self) -> str | None:
        rows = self.rows()
        return str(rows[-1]["ledger_hash"]) if rows else None

    def cycle_ids(self) -> list[str]:
        return [str(r["cycle_id"]) for r in self.rows()]


class SuffixExtractionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = _Tree(Path(self._tmp.name) / "tools")

    def test_the_suffix_is_everything_after_the_base(self) -> None:
        for i in range(3):
            self.tree.append(i)
        base_count, base_tail = 3, self.tree.tail_hash()
        for i in range(3, 5):
            self.tree.append(i)

        suffix = append_only_suffix(
            self.tree.rows(), base_row_count=base_count, base_tail_hash=base_tail
        )
        self.assertEqual([r["cycle_id"] for r in suffix], ["cycle-3", "cycle-4"])

    def test_an_empty_base_makes_every_row_suffix(self) -> None:
        for i in range(2):
            self.tree.append(i)
        suffix = append_only_suffix(self.tree.rows(), base_row_count=0, base_tail_hash=None)
        self.assertEqual(len(suffix), 2)

    def test_no_new_rows_is_an_empty_suffix_not_an_error(self) -> None:
        for i in range(2):
            self.tree.append(i)
        suffix = append_only_suffix(
            self.tree.rows(), base_row_count=2, base_tail_hash=self.tree.tail_hash()
        )
        self.assertEqual(suffix, [])

    def test_a_divergent_prefix_is_refused_not_replayed(self) -> None:
        """The check the whole design rests on.

        Two trees that do not share the base prefix are not a race — one of
        them rewrote history. Replaying a suffix onto a different prefix would
        splice unrelated rows into a chain and call the result continuous.
        """
        for i in range(3):
            self.tree.append(i)
        with self.assertRaises(ReplayRefusal) as caught:
            append_only_suffix(
                self.tree.rows(), base_row_count=3, base_tail_hash="sha256:" + "0" * 64
            )
        self.assertIn("prefix", str(caught.exception))

    def test_a_truncated_file_is_refused(self) -> None:
        """Fewer rows than the base means rows were REMOVED, which append-only
        replay has no honest answer for."""
        for i in range(2):
            self.tree.append(i)
        with self.assertRaises(ReplayRefusal):
            append_only_suffix(
                self.tree.rows(), base_row_count=5, base_tail_hash=self.tree.tail_hash()
            )


class ReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.winner = _Tree(base / "winner")
        self.loser = _Tree(base / "loser")

    def _fork(self, shared: int) -> tuple[int, str | None]:
        """Write `shared` rows into both trees; return the base coordinates."""
        for i in range(shared):
            self.winner.append(i)
            self.loser.append(i)
        return shared, self.winner.tail_hash()

    def test_both_lanes_work_survives_the_race(self) -> None:
        """The property the whole PR exists for."""
        base_count, base_tail = self._fork(2)
        self.winner.append(100)  # the winner published this
        self.loser.append(200)  # the loser had this staged when it was rejected

        result = replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            },
            replay_transaction_id="replay-both-lanes",
        )
        self.assertEqual(result.replayed_rows, 1)
        self.assertEqual(
            self.winner.cycle_ids(), ["cycle-0", "cycle-1", "cycle-100", "cycle-200"]
        )

    def test_the_replayed_chain_verifies(self) -> None:
        """A replayed row is re-chained, not copied.

        `ledger_hash` covers the chain behind it, so a row appended after a
        different predecessor MUST get a new hash. Copying the old one would
        produce a file that reads as valid to a naive eye and fails the real
        verifier.
        """
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        self.loser.append(200)
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            },
            replay_transaction_id="replay-chain-verification",
        )
        self.assertTrue(verify_jsonl(self.winner.path)["valid"], verify_jsonl(self.winner.path))

    def test_a_replayed_row_gets_a_new_outer_hash_and_keeps_producer_identity(self) -> None:
        """Transport re-chains storage without changing producer identity."""
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        self.loser.append(200)
        loser_hash_before = str(self.loser.rows()[-1]["ledger_hash"])
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            },
            replay_transaction_id="replay-new-hash",
        )
        raw = json.loads(self.winner.path.read_text(encoding="utf-8").splitlines()[-1])
        replayed = self.winner.rows()[-1]
        self.assertEqual(replayed["cycle_id"], "cycle-200")
        self.assertNotEqual(raw["ledger_hash"], loser_hash_before)
        self.assertEqual(replayed["ledger_hash"], loser_hash_before)

    def test_replayed_bytes_use_an_exact_versioned_transport_envelope(self) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        producer = self.loser.rows()[-1]

        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                },
            },
            replay_transaction_id="exact-envelope",
        )

        raw = json.loads(self.winner.path.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(
            set(raw),
            {
                "$schema",
                "schema_version",
                "surface",
                "surface_instance",
                "producer_event_id",
                "producer_previous_ledger_hash",
                "replay_transaction_id",
                "payload_sha256",
                "producer_payload",
                "previous_ledger_hash",
                "ledger_hash",
            },
        )
        self.assertEqual(raw["$schema"], "aria/ledger-replay-transport/v2")
        self.assertEqual(raw["schema_version"], 2)
        self.assertEqual(raw["surface"], SURFACE)
        self.assertEqual(raw["surface_instance"], FILENAME)
        self.assertEqual(raw["producer_event_id"], producer["ledger_hash"])
        self.assertEqual(
            raw["producer_previous_ledger_hash"],
            producer["previous_ledger_hash"],
        )
        expected_payload = {
            key: value
            for key, value in producer.items()
            if key not in {"ledger_hash", "previous_ledger_hash"}
        }
        self.assertEqual(raw["producer_payload"], expected_payload)
        logical = self.winner.rows()[-1]
        self.assertEqual(
            {
                key: value
                for key, value in logical.items()
                if key not in {"ledger_hash", "previous_ledger_hash"}
            },
            expected_payload,
        )
        self.assertEqual(logical["ledger_hash"], producer["ledger_hash"])
        self.assertEqual(
            logical["previous_ledger_hash"],
            producer["previous_ledger_hash"],
        )

    def test_source_ref_survives_replay_and_replay_again(self) -> None:
        producer = append_declared_fixture(
            self.loser.path,
            {
                "schema_version": 1,
                "row_id": "cycle:stable-ref",
                "row_type": "cycle_evidence",
                "cycle_id": "cycle-stable-ref",
                "event": "completed",
            },
            expected_surface=SURFACE,
        )
        source_ref = ledger_ref_for_row(
            surface=SURFACE,
            ledger_path=FILENAME,
            row_id="cycle:stable-ref",
            row_type="cycle_evidence",
            row=producer,
        )
        first_spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": 0,
                "base_tail_hash": None,
            }
        }
        replay_append_only_suffixes(
            surfaces=first_spec,
            replay_transaction_id="stable-ref-first-replay",
        )
        first_resolved = find_row_by_source_ledger_ref(self.winner.root, source_ref)
        self.assertEqual(first_resolved["cycle_id"], "cycle-stable-ref")

        second_winner = _Tree(Path(self._tmp.name) / "second-winner")
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": second_winner.path,
                    "loser_path": self.winner.path,
                    "base_row_count": 0,
                    "base_tail_hash": None,
                }
            },
            replay_transaction_id="stable-ref-second-replay",
        )
        second_resolved = find_row_by_source_ledger_ref(
            second_winner.root,
            source_ref,
        )
        self.assertEqual(second_resolved["ledger_hash"], source_ref["row_hash"])

    def test_malformed_transport_envelopes_fail_closed_after_valid_rechain(
        self,
    ) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                },
            },
            replay_transaction_id="malformed-envelope",
        )
        original = [
            json.loads(line)
            for line in self.winner.path.read_text(encoding="utf-8").splitlines()
        ]

        def nested_payload(row: dict) -> None:
            nested = dict(row)
            nested.pop("ledger_hash")
            nested.pop("previous_ledger_hash")
            row["producer_payload"] = nested
            row["payload_sha256"] = "sha256:" + hashlib.sha256(
                canonical_json(nested).encode("utf-8"),
            ).hexdigest()

        def unprovable_v1(row: dict) -> None:
            row["$schema"] = "aria/ledger-replay-transport/v1"
            row["schema_version"] = 1

        mutators = {
            "missing_field": lambda row: row.pop("replay_transaction_id"),
            "wrong_surface": lambda row: row.__setitem__(
                "surface",
                SECOND_SURFACE,
            ),
            "wrong_payload_hash": lambda row: row.__setitem__(
                "payload_sha256",
                "sha256:" + "f" * 64,
            ),
            "spoofed_producer_identity": lambda row: row.__setitem__(
                "producer_event_id",
                "sha256:" + "a" * 64,
            ),
            "nested_envelope": nested_payload,
            "unprovable_v1": unprovable_v1,
            "wrong_transport_version": lambda row: row.__setitem__(
                "$schema",
                "aria/ledger-replay-transport/v3",
            ),
        }
        for label, mutate in mutators.items():
            with self.subTest(label=label):
                rows = [dict(row) for row in original]
                mutate(rows[-1])
                _rewrite_raw_chain(self.winner.path, rows)
                with self.assertRaises(LedgerIntegrityError):
                    read_jsonl(self.winner.path)

    def test_plain_legacy_jsonl_reader_keeps_its_raw_shape(self) -> None:
        path = Path(self._tmp.name) / "legacy.jsonl"
        path.write_text('{"legacy":true,"value":7}\n', encoding="utf-8")

        self.assertEqual(read_jsonl(path), [{"legacy": True, "value": 7}])

    def test_a_retry_against_a_stale_base_does_not_double_append(self) -> None:
        """Written expecting a refusal; it duplicated instead, and that was real.

        Replay is not idempotent by construction: after a successful replay the
        winner holds the loser's rows but the LOSER's file is unchanged, so the
        same suffix is extracted again. The base only advances when the lane
        re-snapshots and re-publishes, and a retry between those two points
        appended every row twice. The guard recognises a winner suffix that
        already ends with the loser's entire suffix and does nothing.
        """
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        self.loser.append(200)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id="replay-operation-1",
        )
        before = self.winner.cycle_ids()
        retried = replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id="replay-operation-1",
        )
        self.assertEqual(self.winner.cycle_ids(), before)
        self.assertEqual(retried.replayed_rows, 0)

    def test_same_transaction_retry_finds_a_completed_replay_before_new_rows(
        self,
    ) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        transaction_id = "replay-operation-before-ordinary-row"
        replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id=transaction_id,
        )
        self.winner.append(300)
        before = self.winner.cycle_ids()

        retried = replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id=transaction_id,
        )

        self.assertEqual(retried.replayed_rows, 0)
        self.assertEqual(self.winner.cycle_ids(), before)
        self.assertEqual(self.winner.cycle_ids().count("cycle-200"), 1)

    def test_concurrent_default_retries_append_one_replay_sequence(self) -> None:
        """The public no-transaction path owns planning and append atomically."""
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        barrier = threading.Barrier(2)
        real_append = replay_module.append_declared_jsonl
        results: list[int] = []
        errors: list[BaseException] = []

        def pause_after_unlocked_planning(*args, **kwargs):
            barrier.wait(timeout=10)
            return real_append(*args, **kwargs)

        def replay() -> None:
            try:
                result = replay_append_only_suffixes(
                    surfaces=spec,
                    replay_transaction_id="concurrent-default-retry",
                )
                results.append(result.replayed_rows)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        with mock.patch.object(
            replay_module,
            "append_declared_jsonl",
            side_effect=pause_after_unlocked_planning,
        ):
            threads = [threading.Thread(target=replay, daemon=True) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)

        assert all(not thread.is_alive() for thread in threads)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(results), [0, 1])
        self.assertEqual(self.winner.cycle_ids().count("cycle-200"), 1)

    def test_same_transaction_partial_replay_fails_before_append(self) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        self.loser.append(201)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        transaction_id = "replay-operation-partial"
        replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id=transaction_id,
        )
        stored = [
            json.loads(line)
            for line in self.winner.path.read_text(encoding="utf-8").splitlines()
        ]
        _rewrite_raw_chain(self.winner.path, stored[:-1])
        before = self.winner.path.read_bytes()

        with self.assertRaisesRegex(ReplayRefusal, "partial"):
            replay_append_only_suffixes(
                surfaces=spec,
                replay_transaction_id=transaction_id,
            )

        self.assertEqual(self.winner.path.read_bytes(), before)

    def test_same_transaction_payload_spoof_fails_before_append(self) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        transaction_id = "replay-operation-payload-mismatch"
        replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id=transaction_id,
        )
        stored = [
            json.loads(line)
            for line in self.winner.path.read_text(encoding="utf-8").splitlines()
        ]
        replayed = stored[-1]
        producer_payload = dict(replayed["producer_payload"])
        producer_payload["cycle_id"] = "cycle-tampered"
        replayed["producer_payload"] = producer_payload
        replayed["payload_sha256"] = "sha256:" + hashlib.sha256(
            canonical_json(producer_payload).encode("utf-8"),
        ).hexdigest()
        _rewrite_raw_chain(self.winner.path, stored)
        before = self.winner.path.read_bytes()

        with self.assertRaisesRegex(
            ReplayRefusal,
            "producer_identity_mismatch",
        ):
            replay_append_only_suffixes(
                surfaces=spec,
                replay_transaction_id=transaction_id,
            )

        self.assertEqual(self.winner.path.read_bytes(), before)

    def test_same_transaction_reordered_replay_fails_before_append(self) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        self.loser.append(201)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        transaction_id = "replay-operation-reordered"
        replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id=transaction_id,
        )
        stored = [
            json.loads(line)
            for line in self.winner.path.read_text(encoding="utf-8").splitlines()
        ]
        stored[-2:] = reversed(stored[-2:])
        _rewrite_raw_chain(self.winner.path, stored)
        before = self.winner.path.read_bytes()

        with self.assertRaisesRegex(ReplayRefusal, "ordering_ambiguous"):
            replay_append_only_suffixes(
                surfaces=spec,
                replay_transaction_id=transaction_id,
            )

        self.assertEqual(self.winner.path.read_bytes(), before)

    def test_same_transaction_multiple_complete_occurrences_fail_closed(
        self,
    ) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }
        transaction_id = "replay-operation-duplicate-complete"
        replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id=transaction_id,
        )
        stored = [
            json.loads(line)
            for line in self.winner.path.read_text(encoding="utf-8").splitlines()
        ]
        _rewrite_raw_chain(self.winner.path, [*stored, dict(stored[-1])])
        before = self.winner.path.read_bytes()

        with self.assertRaisesRegex(ReplayRefusal, "identity_ambiguous"):
            replay_append_only_suffixes(
                surfaces=spec,
                replay_transaction_id=transaction_id,
            )

        self.assertEqual(self.winner.path.read_bytes(), before)

    def test_same_payload_distinct_producer_events_survive_one_replay_retry(
        self,
    ) -> None:
        """Payload equality cannot stand in for producer event identity."""
        base_count, base_tail = self._fork(1)
        self.winner.append(100)
        self.winner.append(200)
        self.loser.append(200)
        winner_identity = self.winner.rows()[-1]["ledger_hash"]
        loser_identity = self.loser.rows()[-1]["ledger_hash"]
        self.assertNotEqual(winner_identity, loser_identity)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }

        first = replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id="replay-operation-distinct-events",
        )
        after_first = self.winner.cycle_ids()
        second = replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id="replay-operation-distinct-events",
        )

        self.assertEqual(first.replayed_rows, 1)
        self.assertEqual(second.replayed_rows, 0)
        self.assertEqual(
            after_first,
            ["cycle-0", "cycle-100", "cycle-200", "cycle-200"],
        )
        self.assertEqual(self.winner.cycle_ids(), after_first)

    def test_identical_events_appended_on_both_lanes_are_deduplicated(self) -> None:
        """The stable producer event id, not its outer storage row, is unique."""
        base_count, base_tail = self._fork(1)
        winner_event = self.winner.append(200)
        loser_event = self.loser.append(200)
        self.assertEqual(winner_event["ledger_hash"], loser_event["ledger_hash"])

        result = replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            },
            replay_transaction_id="replay-identical-producer-event",
        )

        rows = self.winner.rows()
        self.assertEqual(result.replayed_rows, 0)
        self.assertEqual(self.winner.cycle_ids(), ["cycle-0", "cycle-200"])
        self.assertEqual(
            len({row["ledger_hash"] for row in rows}),
            len(rows),
        )

    def test_second_generation_replay_uses_the_stored_outer_base_boundary(
        self,
    ) -> None:
        """A replayed base has distinct logical and physical chain tips."""
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            },
            replay_transaction_id="first-generation-replay",
        )
        first_stored_tail = json.loads(
            self.winner.path.read_text(encoding="utf-8").splitlines()[-1]
        )["ledger_hash"]

        second_winner = _Tree(Path(self._tmp.name) / "second-winner")
        second_loser = _Tree(Path(self._tmp.name) / "second-loser")
        second_winner.path.write_bytes(self.winner.path.read_bytes())
        second_loser.path.write_bytes(self.winner.path.read_bytes())
        second_base_count = len(second_winner.rows())
        second_winner.append(300)
        second_loser.append(400)

        result = replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": second_winner.path,
                    "loser_path": second_loser.path,
                    "base_row_count": second_base_count,
                    "base_tail_hash": first_stored_tail,
                }
            },
            replay_transaction_id="second-generation-replay",
        )
        _count, _digest, observed_boundary = _replay_payload_summary(
            second_winner.root,
            FILENAME,
            expected_surface=SURFACE,
            expected_surface_instance=FILENAME,
            start_row=second_base_count,
        )

        self.assertEqual(result.replayed_rows, 1)
        self.assertEqual(observed_boundary, first_stored_tail)

    def test_common_extension_is_deduplicated_before_divergent_tail_replay(
        self,
    ) -> None:
        base_count, base_tail = self._fork(1)
        self.winner.append(200)
        self.loser.append(200)
        self.winner.append(300)
        self.loser.append(400)
        spec = {
            SURFACE: {
                "winner_path": self.winner.path,
                "loser_path": self.loser.path,
                "base_row_count": base_count,
                "base_tail_hash": base_tail,
            }
        }

        first = replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id="replay-common-extension",
        )
        after_first = self.winner.cycle_ids()
        second = replay_append_only_suffixes(
            surfaces=spec,
            replay_transaction_id="replay-common-extension",
        )

        self.assertEqual(first.replayed_rows, 1)
        self.assertEqual(first.per_surface, {SURFACE: 1})
        self.assertEqual(first.deduplicated_per_surface, {SURFACE: 1})
        self.assertEqual(
            after_first,
            ["cycle-0", "cycle-200", "cycle-300", "cycle-400"],
        )
        self.assertEqual(second.replayed_rows, 0)
        self.assertEqual(self.winner.cycle_ids(), after_first)

    def test_missing_replay_transaction_identity_fails_before_any_append(
        self,
    ) -> None:
        base_count, base_tail = self._fork(1)
        self.loser.append(200)
        before = self.winner.rows()

        with self.assertRaisesRegex(
            ReplayRefusal,
            "replay_transaction_identity_missing",
        ):
            replay_append_only_suffixes(
                surfaces={
                    SURFACE: {
                        "winner_path": self.winner.path,
                        "loser_path": self.loser.path,
                        "base_row_count": base_count,
                        "base_tail_hash": base_tail,
                    }
                },
                replay_transaction_id="",
            )

        self.assertEqual(self.winner.rows(), before)

    def test_glob_replay_refuses_cross_shard_transport(self) -> None:
        winner_root = ensure_tools_dir(Path(self._tmp.name) / "cost-winner")
        loser_root = ensure_tools_dir(Path(self._tmp.name) / "cost-loser")
        winner = winner_root / "cost-attribution" / "2026-09.jsonl"
        loser = loser_root / "cost-attribution" / "2026-08.jsonl"
        append_declared_fixture(
            loser,
            {
                "schema_version": 1,
                "recorded_at": "2026-08-22T00:00:00Z",
                "estimated_usd": 1.0,
            },
            expected_surface="cost_attribution",
        )

        with self.assertRaisesRegex(ReplayRefusal, "surface_instance_mismatch"):
            replay_append_only_suffixes(
                surfaces={
                    "cost_attribution:cost-attribution/2026-09.jsonl": {
                        "winner_path": winner,
                        "loser_path": loser,
                        "base_row_count": 0,
                        "base_tail_hash": None,
                    }
                },
                replay_transaction_id="cross-shard-refusal",
            )

        self.assertFalse(winner.exists())

    def test_two_surface_aliases_cannot_schedule_the_same_paths_twice(self) -> None:
        self.loser.append(200)
        spec = {
            "winner_path": self.winner.path,
            "loser_path": self.loser.path,
            "base_row_count": 0,
            "base_tail_hash": None,
        }

        with self.assertRaisesRegex(ReplayRefusal, "surface_path_alias"):
            replay_append_only_suffixes(
                surfaces={
                    "cycles:first": dict(spec),
                    "cycles:second": dict(spec),
                },
                replay_transaction_id="duplicate-surface-alias",
            )

        self.assertEqual(self.winner.rows(), [])

    def test_nothing_to_replay_leaves_the_winner_untouched(self) -> None:
        base_count, base_tail = self._fork(2)
        self.winner.append(100)
        result = replay_append_only_suffixes(
            surfaces={
                SURFACE: {
                    "winner_path": self.winner.path,
                    "loser_path": self.loser.path,
                    "base_row_count": base_count,
                    "base_tail_hash": base_tail,
                }
            },
            replay_transaction_id="replay-empty-suffix",
        )
        self.assertEqual(result.replayed_rows, 0)
        self.assertEqual(self.winner.cycle_ids(), ["cycle-0", "cycle-1", "cycle-100"])

    def test_neither_side_is_exempt_from_the_prefix_proof(self) -> None:
        """A base that matches NEITHER tree is refused.

        Weak on its own — it does not say which check fired — so the isolating
        case below carries the actual claim. Kept because it is the shape an
        operator hits when the base itself is wrong.
        """
        base_count, base_tail = self._fork(2)
        self.loser.append(200)
        with self.assertRaises(ReplayRefusal):
            replay_append_only_suffixes(
                surfaces={
                    SURFACE: {
                        "winner_path": self.winner.path,
                        "loser_path": self.loser.path,
                        "base_row_count": base_count,
                        "base_tail_hash": "sha256:" + "f" * 64,
                    }
                },
                replay_transaction_id="replay-both-prefixes-invalid",
            )

    def test_a_winner_that_rewrote_history_is_refused(self) -> None:
        """The winner is checked against the base TOO, and this isolates it.

        Written first as a both-sides-bad case, which passed while the winner
        check was mutated away — the loser's check was doing all the refusing.
        Here the LOSER descends from the base cleanly and only the WINNER does
        not, so the refusal can come from one place.

        Trusting the winner because it won is the tempting mistake: winning the
        push only means arriving first, and says nothing about descent. Without
        this check a lane that rewrote its own history would absorb the loser's
        rows into a chain neither of them shares.
        """
        for i in range(2):
            self.loser.append(i)
        base_count, base_tail = 2, self.loser.tail_hash()
        # The winner's own first two rows are DIFFERENT, so its row at the
        # base's last index carries a different chain hash.
        for i in (7, 8):
            self.winner.append(i)
        self.loser.append(200)

        with self.assertRaises(ReplayRefusal) as caught:
            replay_append_only_suffixes(
                surfaces={
                    SURFACE: {
                        "winner_path": self.winner.path,
                        "loser_path": self.loser.path,
                        "base_row_count": base_count,
                        "base_tail_hash": base_tail,
                    }
                },
                replay_transaction_id="replay-winner-prefix-invalid",
            )
        self.assertIn("diverged", str(caught.exception))
        self.assertEqual(self.winner.cycle_ids(), ["cycle-7", "cycle-8"])

    def test_a_refusal_on_one_surface_leaves_every_surface_unwritten(self) -> None:
        """All-or-nothing across surfaces.

        A partial replay would leave the tree in a state neither lane ever
        held, and no snapshot would describe it.
        """
        base_count, base_tail = self._fork(2)
        self.loser.append(200)
        good = {
            "winner_path": self.winner.path,
            "loser_path": self.loser.path,
            "base_row_count": base_count,
            "base_tail_hash": base_tail,
        }
        bad = dict(
            good,
            winner_path=self.winner.root / SECOND_RELPATH,
            loser_path=self.loser.root / SECOND_RELPATH,
            base_tail_hash="sha256:" + "f" * 64,
        )
        with self.assertRaises(ReplayRefusal):
            replay_append_only_suffixes(
                surfaces={SURFACE: good, SECOND_SURFACE: bad},
                replay_transaction_id="replay-all-or-nothing",
            )
        self.assertEqual(self.winner.cycle_ids(), ["cycle-0", "cycle-1"])


if __name__ == "__main__":
    unittest.main()
