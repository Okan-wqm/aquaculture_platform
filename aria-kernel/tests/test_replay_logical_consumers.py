from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

from aria_kernel.contention_replay import replay_append_only_suffixes
from aria_kernel.aria_watchdog import _load_jsonl as load_watchdog_rows
from aria_kernel.cost_telemetry import list_dispatch_rationales
from aria_kernel.governance_reader import (
    read_governance_rows,
    read_governance_rows_reverse,
)
from aria_kernel.instinct_candidate import list_candidates
from aria_kernel.handoff_ledger import list_handoffs
from aria_kernel.ledger import read_jsonl_reverse_verified
from aria_kernel.plan_synthesizer import scan_operator_feedback
from aria_kernel.planner_dispatch_hook import _release_abandoned_claim
from aria_kernel.reflection import _phase_digest_summary
from aria_kernel.report import _blocked_reasons, _read_sealed_cycle_ids, _roi_metrics
from aria_kernel.strict_jsonl_reader import read_strict_jsonl
from aria_kernel.surface_manifest_validator import list_surface_validations
from aria_kernel.trailer_scan import _previous_completed_head
from aria_kernel.tool_registry import GovernanceError

from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    init_test_tools_root,
)

ARIA_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(ARIA_POC) not in sys.path:
    sys.path.insert(0, str(ARIA_POC))
import ci_executor  # noqa: E402


def _replay_one(
    tmp_path: Path,
    *,
    case: str,
    surface: str,
    relative_path: str,
    payload: dict[str, object],
) -> tuple[Path, Path]:
    winner_root = init_test_tools_root(tmp_path / f"{case}-winner")
    loser_root = init_test_tools_root(tmp_path / f"{case}-loser")
    winner_path = winner_root / relative_path
    loser_path = loser_root / relative_path
    append_declared_fixture(
        loser_path,
        payload,
        expected_surface=surface,
    )
    result = replay_append_only_suffixes(
        surfaces={
            surface: {
                "winner_path": winner_path,
                "loser_path": loser_path,
                "base_row_count": 0,
                "base_tail_hash": None,
            },
        },
        replay_transaction_id=f"logical-consumer-{case}",
    )
    assert result.replayed_rows >= 1
    return winner_root, winner_path


def test_governance_readers_expose_replayed_producer_rows(tmp_path: Path) -> None:
    root, path = _replay_one(
        tmp_path,
        case="governance",
        surface="tools_governance",
        relative_path="governance.jsonl",
        payload={"schema_version": 1, "kind": "loser_only", "details": {}},
    )

    assert "loser_only" in [
        row.get("kind") for row in read_governance_rows(path, base_dir=root)
    ]
    assert "loser_only" in [
        row.get("kind")
        for row in read_governance_rows_reverse(base_dir=root, limit=10)
    ]


def test_reverse_governance_reader_verifies_old_replay_before_tail_payload(
    tmp_path: Path,
) -> None:
    root, path = _replay_one(
        tmp_path,
        case="governance-old-envelope",
        surface="tools_governance",
        relative_path="governance.jsonl",
        payload={"schema_version": 1, "kind": "replayed", "details": {}},
    )
    for index in range(5):
        append_declared_fixture(
            path,
            {"schema_version": 1, "kind": f"tail-{index}", "details": {}},
            expected_surface="tools_governance",
        )
    stored = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    stored[-1]["kind"] = "TAMPERED_BUT_MUST_NOT_BE_EXPOSED"
    path.write_text(
        "\n".join(json.dumps(row, sort_keys=True) for row in stored) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(GovernanceError, match="governance_replay_transport_corrupt"):
        read_governance_rows_reverse(base_dir=root, limit=3)


def test_reverse_governance_reader_rejects_malformed_old_replay_claim(
    tmp_path: Path,
) -> None:
    root, path = _replay_one(
        tmp_path,
        case="governance-malformed-old-envelope",
        surface="tools_governance",
        relative_path="governance.jsonl",
        payload={"schema_version": 1, "kind": "replayed", "details": {}},
    )
    for index in range(5):
        append_declared_fixture(
            path,
            {"schema_version": 1, "kind": f"tail-{index}", "details": {}},
            expected_surface="tools_governance",
        )
    lines = path.read_text(encoding="utf-8").splitlines()
    envelope_indexes = [
        index
        for index, line in enumerate(lines)
        if "aria/ledger-replay-transport/" in line
    ]
    assert envelope_indexes
    for envelope_index in envelope_indexes:
        lines[envelope_index] = lines[envelope_index][:-1]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(GovernanceError, match="governance_replay_transport_corrupt"):
        read_governance_rows_reverse(base_dir=root, limit=3)


def test_verified_reverse_reader_retains_only_a_bounded_tail() -> None:
    source = inspect.getsource(read_jsonl_reverse_verified)

    assert "deque" in source
    assert ".open(" in source
    assert "verify_jsonl_chunks" in source
    assert "read_text" not in source
    assert "_parse_jsonl_stored_text" not in source


def test_verified_reverse_reader_rejects_fifo_without_blocking(tmp_path: Path) -> None:
    fifo = tmp_path / "governance.jsonl"
    os.mkfifo(fifo)
    aria_kernel_root = Path(__file__).resolve().parents[1]
    script = """
from pathlib import Path
import sys
from aria_kernel.ledger import LedgerIntegrityError, read_jsonl_reverse_verified

try:
    read_jsonl_reverse_verified(
        Path(sys.argv[1]),
        expected_surface="tools_governance",
        limit=3,
        max_line_bytes=1024,
        max_rows=100,
    )
except LedgerIntegrityError as exc:
    if "ledger_not_regular_file" not in str(exc):
        raise
else:
    raise AssertionError("FIFO was accepted as a ledger")
"""

    completed = subprocess.run(
        [sys.executable, "-c", script, str(fifo)],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(aria_kernel_root)},
        capture_output=True,
        text=True,
        timeout=2,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr


def test_reverse_discovery_rejects_oversized_ancient_line(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import aria_kernel.governance_reader as governance_reader_module

    monkeypatch.setattr(
        governance_reader_module,
        "_MAX_GOVERNANCE_LEDGER_LINE_BYTES",
        128,
    )
    path = tmp_path / "governance.jsonl"
    rows = [
        {"kind": "ancient", "padding": "x" * 256},
        *({"kind": "tail", "index": index} for index in range(5)),
    ]
    path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(GovernanceError, match="governance_reverse_read_limit"):
        read_governance_rows_reverse(base_dir=tmp_path, limit=3)


def test_reverse_governance_reader_filters_before_bounded_replay_tail(
    tmp_path: Path,
) -> None:
    root, path = _replay_one(
        tmp_path,
        case="governance-filtered-old-envelope",
        surface="tools_governance",
        relative_path="governance.jsonl",
        payload={"schema_version": 1, "kind": "replayed", "details": {}},
    )
    for index in range(6):
        append_declared_fixture(
            path,
            {
                "schema_version": 1,
                "kind": "keep" if index % 2 == 0 else "noise",
                "details": {"index": index},
            },
            expected_surface="tools_governance",
        )

    rows = read_governance_rows_reverse(
        base_dir=root,
        limit=2,
        kind_filter=("keep",),
    )

    assert [row["details"]["index"] for row in rows] == [4, 2]


def test_generic_strict_reader_exposes_replayed_producer_rows(tmp_path: Path) -> None:
    root, path = _replay_one(
        tmp_path,
        case="strict-reader",
        surface="cost_telemetry",
        relative_path="cost-telemetry.jsonl",
        payload={"schema_version": 1, "request_id": "req-strict"},
    )

    rows = list(read_strict_jsonl(path, base_dir=root))

    assert [row.get("request_id") for row in rows] == ["req-strict"]


def test_direct_declared_consumers_expose_replayed_rows(tmp_path: Path) -> None:
    cost_root, _ = _replay_one(
        tmp_path,
        case="cost",
        surface="cost_telemetry",
        relative_path="cost-telemetry.jsonl",
        payload={"schema_version": 1, "request_id": "req-cost"},
    )
    validation_root, _ = _replay_one(
        tmp_path,
        case="validation",
        surface="surface_validations",
        relative_path="surface-validations.jsonl",
        payload={"schema_version": 1, "status": "loser-validation"},
    )
    instinct_root, _ = _replay_one(
        tmp_path,
        case="instinct",
        surface="instinct_candidates",
        relative_path="instinct-candidates.jsonl",
        payload={"schema_version": 1, "candidate_id": "IC-replayed", "status": "PROPOSED"},
    )
    cycle_root, _ = _replay_one(
        tmp_path,
        case="cycles",
        surface="cycles",
        relative_path="cycles.jsonl",
        payload={
            "schema_version": 1,
            "cycle_id": "cycle-before-current",
            "event": "completed",
            "git_head_sha_at_cycle": "a" * 40,
        },
    )
    metrics_root, _ = _replay_one(
        tmp_path,
        case="metrics",
        surface="observability_cycle_metrics",
        relative_path="observability/cycle-metrics.jsonl",
        payload={
            "schema_version": 1,
            "cycle_id": "cycle-metrics",
            "phase_digests": {"experiment_night": {"planned_problem": 1}},
        },
    )

    assert [row.get("request_id") for row in list_dispatch_rationales(base_dir=cost_root)] == [
        "req-cost",
    ]
    assert [row.get("status") for row in list_surface_validations(base_dir=validation_root)] == [
        "loser-validation",
    ]
    assert [row.get("candidate_id") for row in list_candidates(base_dir=instinct_root)] == [
        "IC-replayed",
    ]
    assert _previous_completed_head(cycle_root, "cycle-current") == "a" * 40
    assert _phase_digest_summary(metrics_root)["cycle_id"] == "cycle-metrics"


def test_planner_release_guard_sees_replayed_terminal_claim(tmp_path: Path) -> None:
    root, _ = _replay_one(
        tmp_path,
        case="planner-claim",
        surface="agent_invocation_claims",
        relative_path="agent-invocations/claims.jsonl",
        payload={
            "schema_version": 1,
            "claim_id": "claim-replayed",
            "request_id": "request-replayed",
            "event": "released",
        },
    )

    with mock.patch(
        "aria_kernel.agent_invocations.release_claim",
        side_effect=AssertionError("replayed release was not observed"),
    ), mock.patch(
        "aria_kernel.tool_registry.append_tools_governance",
        return_value={},
    ):
        released = _release_abandoned_claim(
            root=root,
            claim_id="claim-replayed",
            agent_id="agent-replayed",
            lease_token="secret-token",
            reason="test-retry",
        )

    assert released is False


def test_operator_handoff_watchdog_and_report_consumers_see_replayed_rows(
    tmp_path: Path,
) -> None:
    operator_workspace = tmp_path / "operator-workspace"
    operator_winner = init_test_tools_root(operator_workspace / "aria-tools")
    operator_loser = init_test_tools_root(tmp_path / "operator-loser" / "aria-tools")
    operator_path = operator_winner / "operator-feedback.jsonl"
    operator_loser_path = operator_loser / "operator-feedback.jsonl"
    append_declared_fixture(
        operator_loser_path,
        {
            "schema_version": 1,
            "id": "OP-replayed",
            "status": "unaddressed",
            "authored_at": "2026-08-22T01:00:00Z",
            "request": "preserve replayed operator authority",
            "priority": "high",
            "signature": "sig-test",
            "signature_kid": "operator-key-test",
        },
        expected_surface="operator_feedback",
    )
    replay_append_only_suffixes(
        surfaces={
            "operator_feedback": {
                "winner_path": operator_path,
                "loser_path": operator_loser_path,
                "base_row_count": 0,
                "base_tail_hash": None,
            }
        },
        replay_transaction_id="logical-consumer-operator-feedback",
    )

    handoff_root, _ = _replay_one(
        tmp_path,
        case="handoff",
        surface="handoffs",
        relative_path="handoffs.jsonl",
        payload={
            "schema_version": 1,
            "session_id": "session-replayed",
            "trigger": "session_stop",
        },
    )
    watchdog_root, watchdog_path = _replay_one(
        tmp_path,
        case="watchdog",
        surface="autonomy_state",
        relative_path="autonomy_state.jsonl",
        payload={
            "schema_version": 1,
            "phase": "bridge_warning",
            "ts": "2026-08-22T01:00:00Z",
        },
    )
    governance_root, governance_path = _replay_one(
        tmp_path,
        case="report-governance",
        surface="tools_governance",
        relative_path="governance.jsonl",
        payload={
            "schema_version": 1,
            "kind": "claude_auth_unavailable",
            "ts": "2026-08-22T01:00:00Z",
            "details": {"detail": "replayed auth refusal"},
        },
    )
    _unused = (watchdog_root, governance_root)
    cycle_root, cycle_path = _replay_one(
        tmp_path,
        case="report-cycles",
        surface="cycles",
        relative_path="cycles.jsonl",
        payload={
            "schema_version": 1,
            "cycle_id": "cycle-replayed-sealed",
            "event": "completed",
        },
    )
    _unused = cycle_root

    assert [row["candidate_id"] for row in scan_operator_feedback(operator_workspace)] == [
        "OP-replayed",
    ]
    assert [row["session_id"] for row in list_handoffs(base_dir=handoff_root)] == [
        "session-replayed",
    ]
    assert [row["phase"] for row in load_watchdog_rows(watchdog_path)] == [
        "bridge_warning",
    ]
    assert [row["kind"] for row in _blocked_reasons(governance_path, "2026-08-22")] == [
        "claude_auth_unavailable",
    ]
    assert _read_sealed_cycle_ids(cycle_path) == ["cycle-replayed-sealed"]


def test_roi_and_executor_anchor_consumers_keep_replayed_identity(tmp_path: Path) -> None:
    winner = init_test_tools_root(tmp_path / "joined-winner")
    loser = init_test_tools_root(tmp_path / "joined-loser")
    paths = {
        "cost_attribution": (
            winner / "cost-attribution" / "2026-08.jsonl",
            loser / "cost-attribution" / "2026-08.jsonl",
        ),
        "pr_lifecycle": (
            winner / "pr-lifecycle.jsonl",
            loser / "pr-lifecycle.jsonl",
        ),
        "agent_invocation_claims": (
            winner / "agent-invocations" / "claims.jsonl",
            loser / "agent-invocations" / "claims.jsonl",
        ),
        "agent_invocation_requests": (
            winner / "agent-invocations" / "requests.jsonl",
            loser / "agent-invocations" / "requests.jsonl",
        ),
    }
    append_declared_fixture(
        paths["cost_attribution"][1],
        {
            "schema_version": 1,
            "recorded_at": "2026-08-22T02:00:00Z",
            "cycle_id": "cycle-cost-replayed",
            "estimated_usd": 1.25,
        },
        expected_surface="cost_attribution",
    )
    append_declared_fixture(
        paths["pr_lifecycle"][1],
        {
            "schema_version": 1,
            "recorded_at": "2026-08-22T03:00:00Z",
            "event": "merged",
            "pr_number": 1322,
        },
        expected_surface="pr_lifecycle",
    )
    claim = append_declared_fixture(
        paths["agent_invocation_claims"][1],
        {
            "schema_version": 1,
            "claim_id": "claim-replayed-anchor",
            "request_id": "request-replayed-anchor",
            "event": "claimed",
        },
        expected_surface="agent_invocation_claims",
    )
    request = append_declared_fixture(
        paths["agent_invocation_requests"][1],
        {
            "schema_version": 1,
            "request_id": "request-replayed-anchor",
            "state": "pending",
        },
        expected_surface="agent_invocation_requests",
    )
    replay_append_only_suffixes(
        surfaces={
            surface: {
                "winner_path": winner_path,
                "loser_path": loser_path,
                "base_row_count": 0,
                "base_tail_hash": None,
            }
            for surface, (winner_path, loser_path) in paths.items()
        },
        replay_transaction_id="logical-consumer-roi-and-anchors",
    )

    roi = _roi_metrics(winner, "2026-08-22")
    anchors = ci_executor._on_disk_anchors(
        tools_dir=winner,
        claim_id="claim-replayed-anchor",
        request_id="request-replayed-anchor",
    )

    assert roi["day_cost_usd"] == 1.25
    assert roi["day_merged_prs"] == 1
    assert anchors == (claim["ledger_hash"], request["ledger_hash"])


def test_declared_logical_consumers_route_through_shared_readers() -> None:
    sources = {
        "operator feedback": inspect.getsource(scan_operator_feedback),
        "handoffs": inspect.getsource(list_handoffs),
        "watchdog": inspect.getsource(load_watchdog_rows),
        "report blocked": inspect.getsource(_blocked_reasons),
        "report cycles": inspect.getsource(_read_sealed_cycle_ids),
        "report roi": inspect.getsource(_roi_metrics),
        "executor anchors": inspect.getsource(ci_executor._on_disk_anchors),
    }

    assert all(
        any(
            reader in source
            for reader in (
                "read_jsonl(",
                "read_strict_jsonl(",
                "load_declared_jsonl(",
            )
        )
        for source in sources.values()
    ), sources


@pytest.mark.parametrize("reader", ["strict", "governance"])
def test_reserved_transport_shape_without_schema_fails_closed(
    tmp_path: Path,
    reader: str,
) -> None:
    surface = "cost_telemetry" if reader == "strict" else "tools_governance"
    relative_path = "cost-telemetry.jsonl" if reader == "strict" else "governance.jsonl"
    root = init_test_tools_root(tmp_path / f"reserved-{reader}")
    path = root / relative_path
    append_declared_fixture(
        path,
        {
            "schema_version": 1,
            "producer_event_id": "sha256:" + "a" * 64,
            "replay_transaction_id": "reserved-shape",
            "producer_payload": {"kind": "must-not-leak"},
        },
        expected_surface=surface,
    )

    with pytest.raises(GovernanceError, match="replay_transport"):
        if reader == "strict":
            list(read_strict_jsonl(path, base_dir=root))
        else:
            list(read_governance_rows(path, base_dir=root))
