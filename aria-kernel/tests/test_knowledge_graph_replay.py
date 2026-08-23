from __future__ import annotations

import shutil
import threading
from pathlib import Path
from unittest import mock

import pytest

from aria_kernel.contention_replay import ReplayRefusal, replay_append_only_suffixes
from aria_kernel import knowledge_graph
from aria_kernel.knowledge_graph import _append_row, verify_chain_or_quarantine
from aria_kernel.ledger import read_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


def test_replayed_knowledge_graph_keeps_its_native_chain(tmp_path: Path) -> None:
    loser_root = ensure_tools_dir(tmp_path / "loser")
    winner_root = ensure_tools_dir(tmp_path / "winner")
    loser = loser_root / "knowledge-graph" / "conventions.jsonl"
    winner = winner_root / "knowledge-graph" / "conventions.jsonl"
    _append_row(
        loser,
        {
            "schema_version": 1,
            "pattern_id": "pattern-one",
            "kind": "convention",
        },
    )
    _append_row(
        loser,
        {
            "schema_version": 1,
            "pattern_id": "pattern-two",
            "kind": "convention",
        },
    )
    assert verify_chain_or_quarantine(loser) == (True, 2)

    result = replay_append_only_suffixes(
        surfaces={
            "kg_conventions": {
                "winner_path": winner,
                "loser_path": loser,
                "base_row_count": 0,
                "base_tail_hash": None,
            },
        },
        replay_transaction_id="knowledge-graph-native-chain",
    )

    assert result.replayed_rows == 2
    assert verify_chain_or_quarantine(winner) == (True, 2)

    _append_row(
        winner,
        {
            "schema_version": 1,
            "pattern_id": "pattern-three",
            "kind": "convention",
        },
    )
    assert verify_chain_or_quarantine(winner) == (True, 3)


def test_outer_hashless_native_kg_requires_migration_without_mutating_winner(
    tmp_path: Path,
) -> None:
    loser_root = ensure_tools_dir(tmp_path / "legacy-loser")
    winner_root = ensure_tools_dir(tmp_path / "legacy-winner")
    loser = loser_root / "knowledge-graph" / "conventions.jsonl"
    winner = winner_root / "knowledge-graph" / "conventions.jsonl"
    loser.parent.mkdir(parents=True, exist_ok=True)
    first = {
        "schema_version": 1,
        "pattern_id": "legacy-one",
        "kind": "convention",
        "prev_row_hash": knowledge_graph.GENESIS_PREV_HASH,
    }
    second = {
        "schema_version": 1,
        "pattern_id": "legacy-two",
        "kind": "convention",
        "prev_row_hash": knowledge_graph._row_hash(first),
    }
    loser.write_bytes(
        b"".join(knowledge_graph._canonical_json(row) + b"\n" for row in (first, second)),
    )
    assert verify_chain_or_quarantine(loser) == (True, 2)
    winner_before = winner.read_bytes() if winner.exists() else None

    with pytest.raises(ReplayRefusal, match="ledger_hash_missing"):
        replay_append_only_suffixes(
            surfaces={
                "kg_conventions": {
                    "winner_path": winner,
                    "loser_path": loser,
                    "base_row_count": 0,
                    "base_tail_hash": None,
                },
            },
            replay_transaction_id="legacy-kg-requires-canonical-migration",
        )

    assert (winner.read_bytes() if winner.exists() else None) == winner_before


def test_divergent_native_chains_refuse_before_any_surface_is_written(
    tmp_path: Path,
) -> None:
    base_root = ensure_tools_dir(tmp_path / "base")
    winner_root = ensure_tools_dir(tmp_path / "winner")
    loser_root = ensure_tools_dir(tmp_path / "loser")
    base = base_root / "knowledge-graph" / "conventions.jsonl"
    winner = winner_root / "knowledge-graph" / "conventions.jsonl"
    loser = loser_root / "knowledge-graph" / "conventions.jsonl"
    _append_row(
        base,
        {
            "schema_version": 1,
            "pattern_id": "pattern-base",
            "kind": "convention",
        },
    )
    winner.parent.mkdir(parents=True, exist_ok=True)
    loser.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(base, winner)
    shutil.copyfile(base, loser)
    _append_row(
        winner,
        {
            "schema_version": 1,
            "pattern_id": "pattern-winner",
            "kind": "convention",
        },
    )
    _append_row(
        loser,
        {
            "schema_version": 1,
            "pattern_id": "pattern-loser",
            "kind": "convention",
        },
    )
    base_rows = read_jsonl(base)
    cycle_winner = winner_root / "cycles.jsonl"
    cycle_loser = loser_root / "cycles.jsonl"
    append_declared_fixture(
        cycle_loser,
        {
            "schema_version": 1,
            "cycle_id": "cycle-loser",
            "event": "completed",
        },
        expected_surface="cycles",
    )
    winner_before = winner.read_bytes()
    cycle_before = cycle_winner.read_bytes() if cycle_winner.exists() else None

    with pytest.raises(ReplayRefusal, match="dual_chain_semantic_merge_required"):
        replay_append_only_suffixes(
            surfaces={
                "cycles": {
                    "winner_path": cycle_winner,
                    "loser_path": cycle_loser,
                    "base_row_count": 0,
                    "base_tail_hash": None,
                },
                "kg_conventions": {
                    "winner_path": winner,
                    "loser_path": loser,
                    "base_row_count": len(base_rows),
                    "base_tail_hash": base_rows[-1]["ledger_hash"],
                },
            },
            replay_transaction_id="knowledge-graph-divergent-native-chain",
        )

    assert winner.read_bytes() == winner_before
    assert (cycle_winner.read_bytes() if cycle_winner.exists() else None) == cycle_before
    assert verify_chain_or_quarantine(winner) == (True, 2)


def test_native_writer_and_replay_share_one_ledger_lock_domain(tmp_path: Path) -> None:
    winner_root = ensure_tools_dir(tmp_path / "winner-lock")
    loser_root = ensure_tools_dir(tmp_path / "loser-lock")
    winner = winner_root / "knowledge-graph" / "conventions.jsonl"
    loser = loser_root / "knowledge-graph" / "conventions.jsonl"
    _append_row(
        winner,
        {
            "schema_version": 1,
            "pattern_id": "pattern-base",
            "kind": "convention",
        },
    )
    loser.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(winner, loser)
    base_rows = read_jsonl(winner)
    tail_read = threading.Event()
    allow_writer = threading.Event()
    replay_finished = threading.Event()
    errors: list[BaseException] = []
    real_reader = knowledge_graph._read_jsonl_strict

    def blocked_reader(path: Path):
        rows = list(real_reader(path))
        tail_read.set()
        if not allow_writer.wait(timeout=10):
            raise TimeoutError("writer release was not signalled")
        yield from rows

    def write_native_row() -> None:
        try:
            _append_row(
                winner,
                {
                    "schema_version": 1,
                    "pattern_id": "pattern-writer",
                    "kind": "convention",
                },
            )
        except BaseException as exc:  # noqa: BLE001 - thread handoff
            errors.append(exc)

    def replay() -> None:
        try:
            replay_append_only_suffixes(
                surfaces={
                    "kg_conventions": {
                        "winner_path": winner,
                        "loser_path": loser,
                        "base_row_count": len(base_rows),
                        "base_tail_hash": base_rows[-1]["ledger_hash"],
                    }
                },
                replay_transaction_id="knowledge-graph-writer-lock-domain",
            )
        except BaseException as exc:  # noqa: BLE001 - thread handoff
            errors.append(exc)
        finally:
            replay_finished.set()

    with mock.patch.object(
        knowledge_graph,
        "_read_jsonl_strict",
        side_effect=blocked_reader,
    ):
        writer = threading.Thread(target=write_native_row, daemon=True)
        writer.start()
        assert tail_read.wait(timeout=10)
        recovery = threading.Thread(target=replay, daemon=True)
        recovery.start()
        assert not replay_finished.wait(timeout=0.5)
        allow_writer.set()
        writer.join(timeout=10)
        recovery.join(timeout=10)

    assert not writer.is_alive()
    assert not recovery.is_alive()
    assert errors == []
    assert verify_chain_or_quarantine(winner) == (True, 2)
