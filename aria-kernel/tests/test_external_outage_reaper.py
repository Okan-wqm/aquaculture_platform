from __future__ import annotations

from contextlib import contextmanager
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest

from aria_kernel import external_outage_reaper as reaper
from aria_kernel.agent_invocations import derive_request_state
from aria_kernel.ledger import (
    LedgerIntegrityError,
    StateTransaction,
    read_jsonl,
    state_transaction,
    verify_jsonl,
)

from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    init_test_tools_root,
)


SURFACE = "agent_invocation_claims"
NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc)


def _claims_path(tmp_path: Path, name: str = "aria-tools") -> Path:
    root = init_test_tools_root(tmp_path / name)
    return root / "agent-invocations" / "claims.jsonl"


def _results_path(claims_path: Path) -> Path:
    return claims_path.with_name("results.jsonl")


def _append(
    path: Path,
    *,
    request_id: str,
    event: str,
    occurred_at: datetime,
    reason: str | None = None,
) -> None:
    row = {
        "schema_version": 1,
        "request_id": request_id,
        "event": event,
        "occurred_at": occurred_at.isoformat(),
    }
    if reason is not None:
        row["reason"] = reason
    append_declared_fixture(
        path,
        row,
        expected_surface=SURFACE,
    )


def _seed_outage(path: Path, request_id: str = "req-outage") -> None:
    _append(
        path,
        request_id=request_id,
        event="api_backoff_exhausted",
        occurred_at=NOW - timedelta(hours=1),
    )


def _append_result(
    claims_path: Path,
    *,
    request_id: str,
    status: str = "accepted",
) -> None:
    append_declared_fixture(
        _results_path(claims_path),
        {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "row_type": "result",
            "row_id": f"result:{request_id}:{status}",
            "request_id": request_id,
            "claim_id": f"claim:{request_id}",
            "status": status,
            "submitted_at": NOW.isoformat(),
        },
        expected_surface="agent_invocation_results",
    )


def test_reap_uses_one_governed_transaction_and_preserves_chain(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path)
    _seed_outage(claims)

    with mock.patch.object(
        reaper,
        "state_transaction",
        wraps=state_transaction,
        create=True,
    ) as transaction:
        result = reaper.reap_external_outage_requests(
            claims_path=claims,
            now=NOW,
        )

    assert transaction.call_count == 1
    assert set(transaction.call_args.args[0]) == {claims, _results_path(claims)}
    assert result == {
        "requeued_count": 1,
        "escalated_count": 0,
        "request_ids_requeued": ["req-outage"],
        "request_ids_escalated": [],
    }
    report = verify_jsonl(claims)
    assert report["valid"] is True, report
    rows = read_jsonl(claims)
    assert len(rows) == 2
    assert rows[-1]["previous_ledger_hash"] == rows[0]["ledger_hash"]
    assert rows[-1]["ledger_hash"].startswith("sha256:")


@pytest.mark.parametrize("status", ["accepted", "rejected", "completed"])
def test_reap_skips_terminal_result_histories(
    tmp_path: Path,
    status: str,
) -> None:
    claims = _claims_path(tmp_path, f"terminal-{status}")
    _seed_outage(claims, request_id="req-terminal")
    _append_result(claims, request_id="req-terminal", status=status)

    result = reaper.reap_external_outage_requests(
        claims_path=claims,
        now=NOW,
    )

    assert result["requeued_count"] == 0
    assert result["escalated_count"] == 0
    assert [row["event"] for row in read_jsonl(claims)] == [
        "api_backoff_exhausted",
    ]


def test_reap_skips_commit_pending_prepared_history(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path, "prepared-history")
    _seed_outage(claims, request_id="req-prepared")
    append_declared_fixture(
        claims,
        {
            "schema_version": 1,
            "request_id": "req-prepared",
            "claim_id": "claim:req-prepared",
            "event": "result_submission_prepared",
            # The durable journal uses prepared_at, not occurred_at.  The
            # outage fold must not sort it behind the older outage event.
            "prepared_at": NOW.isoformat(),
        },
        expected_surface=SURFACE,
    )

    result = reaper.reap_external_outage_requests(
        claims_path=claims,
        now=NOW,
    )

    assert result["requeued_count"] == 0
    assert result["escalated_count"] == 0
    assert read_jsonl(claims)[-1]["event"] == "result_submission_prepared"


def test_reap_respects_newer_release_and_requeue_timestamp_fields(
    tmp_path: Path,
) -> None:
    """A completed lifecycle transition must outrank an older outage row.

    Release/requeue producers use ``released_at`` and ``at`` rather than the
    outage producer's ``occurred_at``.  Treating those rows as timestamp-less
    resurrects the old outage and permits a duplicate requeue.
    """
    claims = _claims_path(tmp_path, "released-and-requeued")
    request_id = "req-released-and-requeued"
    _append(
        claims,
        request_id=request_id,
        event="api_backoff_exhausted",
        occurred_at=NOW - timedelta(hours=2),
    )
    append_declared_fixture(
        claims,
        {
            "schema_version": 1,
            "request_id": request_id,
            "claim_id": "claim:released-and-requeued",
            "event": "released",
            "released_at": (NOW - timedelta(hours=1)).isoformat(),
            "reason": "worker_retry",
        },
        expected_surface=SURFACE,
    )
    append_declared_fixture(
        claims,
        {
            "schema_version": 1,
            "request_id": request_id,
            "claim_id": "claim:released-and-requeued",
            "event": "requeued",
            "at": (NOW - timedelta(minutes=59)).isoformat(),
            "reason": "worker_retry",
        },
        expected_surface=SURFACE,
    )

    result = reaper.reap_external_outage_requests(
        claims_path=claims,
        now=NOW,
    )

    assert result["requeued_count"] == 0
    assert result["escalated_count"] == 0
    assert [row["event"] for row in read_jsonl(claims)] == [
        "api_backoff_exhausted",
        "released",
        "requeued",
    ]


def test_request_state_orders_claim_outage_and_requeue_by_producer_time(
    tmp_path: Path,
) -> None:
    """Every lifecycle reader must agree on producer-native event time."""
    tools = init_test_tools_root(tmp_path / "derive-state")
    request_id = "req-derived-outage"
    request = {"request_id": request_id, "state": "pending"}
    claimed = {
        "request_id": request_id,
        "claim_id": "claim:derived-outage",
        "event": "claimed",
        "claimed_at": (NOW - timedelta(hours=2)).isoformat(),
        "lease_expires_at": (NOW + timedelta(hours=1)).isoformat(),
    }
    outage = {
        "request_id": request_id,
        "claim_id": "claim:derived-outage",
        "event": "api_backoff_exhausted",
        "occurred_at": (NOW - timedelta(hours=1)).isoformat(),
    }

    assert derive_request_state(
        request_id=request_id,
        base_dir=tools,
        now=NOW,
        _ledgers=([request], [], [claimed, outage]),
    ) == "EXTERNAL_OUTAGE"

    requeued = {
        "request_id": request_id,
        "claim_id": "claim:derived-outage",
        "event": "requeued",
        "at": NOW.isoformat(),
        "reason": "external_outage_requeue",
    }
    assert derive_request_state(
        request_id=request_id,
        base_dir=tools,
        now=NOW,
        _ledgers=([request], [], [claimed, outage, requeued]),
    ) == "REQUEUED"


def test_terminal_result_wins_race_before_reaper_reload(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path, "terminal-wins")
    results_path = _results_path(claims)
    _seed_outage(claims, request_id="req-terminal-wins")
    attempted = threading.Event()
    outcome: list[dict[str, object]] = []

    @contextmanager
    def observed_transaction(paths):
        attempted.set()
        with state_transaction(paths) as transaction:
            yield transaction

    def run_reaper() -> None:
        outcome.append(
            reaper.reap_external_outage_requests(
                claims_path=claims,
                now=NOW,
            ),
        )

    with state_transaction([claims, results_path]) as transaction:
        thread = threading.Thread(target=run_reaper, daemon=True)
        with mock.patch.object(
            reaper,
            "state_transaction",
            side_effect=observed_transaction,
        ):
            thread.start()
            assert attempted.wait(timeout=5)
            transaction.append_declared_jsonl(
                results_path,
                {
                    "schema_version": 1,
                    "request_id": "req-terminal-wins",
                    "claim_id": "claim:req-terminal-wins",
                    "status": "accepted",
                    "submitted_at": NOW.isoformat(),
                },
                expected_surface="agent_invocation_results",
            )
    thread.join(timeout=10)

    assert not thread.is_alive()
    assert outcome[0]["requeued_count"] == 0
    assert sum(row.get("event") == "requeued" for row in read_jsonl(claims)) == 0


def test_reaper_wins_race_before_terminal_result_admission(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path, "reaper-wins")
    results_path = _results_path(claims)
    _seed_outage(claims, request_id="req-reaper-wins")
    reaper_locked = threading.Event()
    writer_attempted = threading.Event()
    writer_acquired = threading.Event()
    result_written: list[bool] = []
    real_find = reaper._find_external_outage_requests

    def pause_while_locked(*args, **kwargs):
        reaper_locked.set()
        assert writer_attempted.wait(timeout=5)
        assert not writer_acquired.wait(timeout=0.2)
        return real_find(*args, **kwargs)

    def submit_terminal() -> None:
        writer_attempted.set()
        with state_transaction([claims, results_path]) as transaction:
            writer_acquired.set()
            locked_claims = transaction.load_declared_jsonl(
                claims,
                expected_surface=SURFACE,
            )
            if any(row.get("event") == "requeued" for row in locked_claims):
                result_written.append(False)
                return
            transaction.append_declared_jsonl(
                results_path,
                {
                    "schema_version": 1,
                    "request_id": "req-reaper-wins",
                    "claim_id": "claim:req-reaper-wins",
                    "status": "accepted",
                    "submitted_at": NOW.isoformat(),
                },
                expected_surface="agent_invocation_results",
            )
            result_written.append(True)

    with mock.patch.object(
        reaper,
        "_find_external_outage_requests",
        side_effect=pause_while_locked,
    ):
        reaper_thread = threading.Thread(
            target=lambda: reaper.reap_external_outage_requests(
                claims_path=claims,
                now=NOW,
            ),
            daemon=True,
        )
        reaper_thread.start()
        assert reaper_locked.wait(timeout=5)
        writer_thread = threading.Thread(target=submit_terminal, daemon=True)
        writer_thread.start()
        reaper_thread.join(timeout=10)
        writer_thread.join(timeout=10)

    assert not reaper_thread.is_alive()
    assert not writer_thread.is_alive()
    assert result_written == [False]
    assert sum(row.get("event") == "requeued" for row in read_jsonl(claims)) == 1
    assert not results_path.exists()


def test_two_concurrent_reapers_append_one_transition(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path)
    _seed_outage(claims)
    barrier = threading.Barrier(2)
    real_find = reaper.find_external_outage_requests
    results: list[dict[str, object]] = []
    errors: list[BaseException] = []

    def force_both_stale_reads(**kwargs):
        candidates = real_find(**kwargs)
        barrier.wait(timeout=10)
        return candidates

    def run_reaper() -> None:
        try:
            results.append(
                reaper.reap_external_outage_requests(
                    claims_path=claims,
                    now=NOW,
                )
            )
        except BaseException as exc:  # noqa: BLE001 - thread handoff
            errors.append(exc)

    with mock.patch.object(
        reaper,
        "find_external_outage_requests",
        side_effect=force_both_stale_reads,
    ) as public_find:
        threads = [threading.Thread(target=run_reaper, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert public_find.call_count == 0
    assert sorted(result["requeued_count"] for result in results) == [0, 1]
    rows = read_jsonl(claims)
    assert sum(row.get("event") == "requeued" for row in rows) == 1
    assert verify_jsonl(claims)["valid"] is True


@pytest.mark.parametrize("operation", ["find", "reap"])
def test_reaper_refuses_tampered_claim_prefix(
    tmp_path: Path,
    operation: str,
) -> None:
    claims = _claims_path(tmp_path)
    _seed_outage(claims, request_id="req-tamper")
    claims.write_text(
        claims.read_text(encoding="utf-8").replace("req-tamper", "req-mutant"),
        encoding="utf-8",
    )

    with pytest.raises(LedgerIntegrityError, match="strict verification failed"):
        if operation == "find":
            reaper.find_external_outage_requests(
                claims_path=claims,
                now=NOW,
            )
        else:
            reaper.reap_external_outage_requests(
                claims_path=claims,
                now=NOW,
            )


def test_reap_append_failure_raises_without_false_healthy_summary(
    tmp_path: Path,
) -> None:
    claims = _claims_path(tmp_path)
    _seed_outage(claims)
    before = claims.read_bytes()

    with mock.patch.object(
        StateTransaction,
        "append_declared_jsonl",
        side_effect=OSError("injected append failure"),
    ), pytest.raises(OSError, match="injected append failure"):
        reaper.reap_external_outage_requests(
            claims_path=claims,
            now=NOW,
        )

    assert claims.read_bytes() == before


def test_reap_honors_call_specific_max_requeues(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path)
    request_id = "req-budget"
    _append(
        claims,
        request_id=request_id,
        event="api_backoff_exhausted",
        occurred_at=NOW - timedelta(hours=3),
    )
    _append(
        claims,
        request_id=request_id,
        event="requeued",
        occurred_at=NOW - timedelta(hours=2),
        reason="external_outage_requeue",
    )
    _append(
        claims,
        request_id=request_id,
        event="api_backoff_exhausted",
        occurred_at=NOW - timedelta(hours=1),
    )

    result = reaper.reap_external_outage_requests(
        claims_path=claims,
        now=NOW,
        max_requeues=1,
    )

    assert result == {
        "requeued_count": 0,
        "escalated_count": 1,
        "request_ids_requeued": [],
        "request_ids_escalated": [request_id],
    }
    assert read_jsonl(claims)[-1]["event"] == "human_required"
    assert verify_jsonl(claims)["valid"] is True


def test_absent_optional_claims_ledger_is_a_healthy_noop(tmp_path: Path) -> None:
    claims = _claims_path(tmp_path)

    assert reaper.find_external_outage_requests(claims_path=claims, now=NOW) == []
    assert reaper.reap_external_outage_requests(
        claims_path=claims,
        now=NOW,
    ) == {
        "requeued_count": 0,
        "escalated_count": 0,
        "request_ids_requeued": [],
        "request_ids_escalated": [],
    }
    assert not claims.exists()
