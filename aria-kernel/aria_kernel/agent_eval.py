"""Plan 020 Phase 6 — agent eval harness (5 fixtures + mock/real metric segregation).

WHY this module exists
----------------------
ARIA's agent dispatch surface is rich (.claude/agents/aria-evidence-judge,
aria-adversarial-judge, aria-consensus-arbiter, architectural-arbiter,
auth-security-expert, ...) but pre-Plan-020 there was no closed-loop
evaluation: a judge could regress its verdict-class agreement with golden
fixtures and the kernel had no signal. Phase 6 introduces a fixture-driven
eval harness:

- Each fixture is a pinned (target_agent, input_envelope, expected_verdict
  _class, expected_evidence_refs) tuple stored under
  aria-tools/agent-evals/fixtures/*.json.
- run_agent_eval(...) executes the agent (mock or real) against the fixture
  and records the run row to aria-tools/agent-evals/runs.jsonl.
- aggregate_eval_metrics(...) windows the runs over N days and computes the
  6-key summary (pass_rate, mean_rounds, false_positive_rate,
  false_negative_rate, mean_tokens, consistency_score).

Mock vs real metric segregation (operator gap #5 — Plan 020 Phase 5/6 link)
----------------------------------------------------------------------------
Phase 5 left the OAuth contract closure as DEBT-2026-05-08-001
(operator-supervised). Until that debt closes, real-mode eval cannot run in
CI; mock-mode is the only available path. The kernel REFUSES to conflate
the two:

  mock_mode=True  → governance kind 'agent_eval_run_mock_only'    +
                    counter aria_agent_eval_mock_only_total += 1.
  mock_mode=False → governance kind 'agent_eval_run_real'         +
                    counter aria_agent_eval_real_total      += 1.

aggregate_eval_metrics filters by mock_mode so a future real-mode run does
NOT retroactively inflate or deflate historical mock-mode statistics.

Plan 020 surface gate
---------------------
agent_evals is in PLAN_020_WRITE_SURFACES (frozen blocks; observe blocks —
agent invocation mutates state beyond observation class).
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    utc_now,
)

EVAL_RUNS_PATH = ("agent-evals", "runs.jsonl")
EVAL_FIXTURES_DIR = ("agent-evals", "fixtures")
EVAL_FIXTURE_SCHEMA = "aria/agent-eval-fixture/v1"
EVAL_RUN_SCHEMA = "aria/agent-eval-run/v1"

# Schema fields locked per Plan v3.3 §Phase 6.A. Validation rejects
# fixtures missing any required field — typo guard at the API boundary.
REQUIRED_FIXTURE_FIELDS: tuple[str, ...] = (
    "fixture_id",
    "target_agent",
    "role",
    "pinned_commit_sha",
    "input_envelope",
    "expected_verdict_class",
    "expected_evidence_refs",
    "max_rounds",
    "max_tokens",
)

VERDICT_CLASSES: frozenset[str] = frozenset({
    "ACCEPTED",
    "REJECTED",
    "ESCALATE_HUMAN",
    "WITHDRAWN_AS_FALSE_POSITIVE",
    "TIGHTENED",
    "JUDGMENT_DISAGREEMENT",
    "PASS",
    "FAIL",
})

# Fixture-id regex prevents path traversal in the persist path.
_FIXTURE_ID_RE = re.compile(r"^[A-Z][A-Z0-9_-]{1,63}$")


def _runs_path(tools_root: Path) -> Path:
    return tools_root.joinpath(*EVAL_RUNS_PATH)


def _fixtures_dir(tools_root: Path) -> Path:
    return tools_root.joinpath(*EVAL_FIXTURES_DIR)


def _validate_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    missing = [f for f in REQUIRED_FIXTURE_FIELDS if f not in fixture]
    if missing:
        raise GovernanceError(f"fixture missing required fields: {missing}")
    fixture_id = str(fixture["fixture_id"])
    if not _FIXTURE_ID_RE.match(fixture_id):
        raise GovernanceError(
            f"fixture_id {fixture_id!r} must match {_FIXTURE_ID_RE.pattern}"
        )
    verdict = str(fixture["expected_verdict_class"])
    if verdict not in VERDICT_CLASSES:
        raise GovernanceError(
            f"expected_verdict_class {verdict!r} not in {sorted(VERDICT_CLASSES)}"
        )
    if not isinstance(fixture["expected_evidence_refs"], list):
        raise GovernanceError("expected_evidence_refs must be a list")
    if int(fixture["max_rounds"]) <= 0:
        raise GovernanceError("max_rounds must be positive")
    if int(fixture["max_tokens"]) <= 0:
        raise GovernanceError("max_tokens must be positive")
    return fixture


def add_fixture(
    *,
    fixture: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Persist a fixture under aria-tools/agent-evals/fixtures/<fixture_id>.json.

    Idempotent on (fixture_id, sha256(canonical fixture JSON)) — re-adding
    the same fixture content returns the existing row; a content-changed
    re-add raises GovernanceError so accidental fixture mutation is caught.
    """
    enforce_profile_for_write("agent_evals", base_dir=base_dir)
    fixture = _validate_fixture(dict(fixture))
    fixture.setdefault("$schema", EVAL_FIXTURE_SCHEMA)
    fixture.setdefault("schema_version", 1)
    fixture.setdefault("recorded_at", utc_now())

    root = ensure_tools_dir(base_dir)
    fixtures_dir = _fixtures_dir(root)
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    path = fixtures_dir / f"{fixture['fixture_id']}.json"

    canonical = json.dumps(
        {k: v for k, v in fixture.items() if k != "recorded_at"},
        sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    fixture_hash = hashlib.sha256(canonical).hexdigest()[:16]
    fixture["fixture_hash"] = fixture_hash

    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing.get("fixture_hash") == fixture_hash:
            return existing
        raise GovernanceError(
            f"fixture {fixture['fixture_id']} already exists with different "
            f"content hash; refusing accidental fixture mutation"
        )

    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return fixture


def list_fixtures(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    fixtures_dir = _fixtures_dir(root)
    if not fixtures_dir.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(fixtures_dir.glob("*.json")):
        try:
            rows.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return rows


def _read_fixture(*, fixture_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    if not _FIXTURE_ID_RE.match(fixture_id):
        raise GovernanceError(f"fixture_id {fixture_id!r} format invalid")
    root = ensure_tools_dir(base_dir)
    path = _fixtures_dir(root) / f"{fixture_id}.json"
    if not path.exists():
        raise GovernanceError(f"fixture {fixture_id} not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _mock_response_envelope(fixture: dict[str, Any]) -> dict[str, Any]:
    """Synthesise a deterministic envelope matching the fixture's expected
    verdict_class + evidence refs. Used by mock-mode eval runs so the
    pipeline (validate, persist, aggregate) gets full coverage even when
    the OAuth contract closure (DEBT-2026-05-08-001) is still operator-
    blocked.
    """
    return {
        "$schema": "aria/agent-response/v1",
        "schema_version": 1,
        "verdict_class": fixture["expected_verdict_class"],
        "evidence_refs": list(fixture["expected_evidence_refs"]),
        "rounds_used": min(1, int(fixture["max_rounds"])),
        "tokens_used": min(1024, int(fixture["max_tokens"])),
        "mock": True,
    }


def run_agent_eval(
    *,
    fixture_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    mock_mode: bool = True,
    real_response_envelope: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run an agent against a fixture; record pass/fail to runs.jsonl.

    mock_mode True (default): synthesise a deterministic envelope matching
    the fixture's expected verdict + evidence. Used for kernel pipeline
    coverage when DEBT-2026-05-08-001 (OAuth contract closure) is open.

    mock_mode False: caller MUST pass real_response_envelope (the response
    captured from a real Claude Code OAuth invocation; produced by the
    Phase 5 operator-supervised flow). Real-mode runs increment the
    aria_agent_eval_real_total counter; mock-mode runs increment
    aria_agent_eval_mock_only_total. The two streams stay segregated
    forever — historical mock data does not contaminate real-mode
    aggregates and vice versa.

    Pass criteria (Plan v3.3 §Phase 6.A):
    - response.verdict_class == fixture.expected_verdict_class.
    - response.evidence_refs is a SUPERSET of fixture.expected_evidence_refs.
    """
    enforce_profile_for_write("agent_evals", base_dir=base_dir)
    fixture = _read_fixture(fixture_id=fixture_id, base_dir=base_dir)

    if mock_mode:
        envelope = _mock_response_envelope(fixture)
        kind = "agent_eval_run_mock_only"
    else:
        if real_response_envelope is None:
            raise GovernanceError(
                "mock_mode=False requires real_response_envelope from operator-"
                "supervised CI executor; until DEBT-2026-05-08-001 closure, "
                "real-mode runs are operator-only."
            )
        envelope = dict(real_response_envelope)
        kind = "agent_eval_run_real"

    expected_refs = set(fixture["expected_evidence_refs"])
    actual_refs = set(envelope.get("evidence_refs", []))
    verdict_match = envelope.get("verdict_class") == fixture["expected_verdict_class"]
    evidence_match = expected_refs.issubset(actual_refs)
    passed = verdict_match and evidence_match

    run_row: dict[str, Any] = {
        "$schema": EVAL_RUN_SCHEMA,
        "schema_version": 1,
        "run_id": str(uuid.uuid4()),
        "fixture_id": fixture_id,
        "target_agent": fixture["target_agent"],
        "role": fixture["role"],
        "mock_mode": mock_mode,
        "passed": passed,
        "verdict_match": verdict_match,
        "evidence_match": evidence_match,
        "expected_verdict_class": fixture["expected_verdict_class"],
        "actual_verdict_class": envelope.get("verdict_class"),
        "expected_evidence_refs": sorted(expected_refs),
        "missing_evidence_refs": sorted(expected_refs - actual_refs),
        "rounds_used": int(envelope.get("rounds_used", 0)),
        "tokens_used": int(envelope.get("tokens_used", 0)),
        "recorded_at": utc_now(),
    }

    root = ensure_tools_dir(base_dir)
    _runs_path(root).parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(_runs_path(root), run_row)
    append_tools_governance(
        root,
        kind,
        {
            "fixture_id": fixture_id,
            "target_agent": fixture["target_agent"],
            "role": fixture["role"],
            "passed": passed,
            "rounds_used": run_row["rounds_used"],
            "tokens_used": run_row["tokens_used"],
        },
    )
    return run_row


def list_eval_runs(
    *,
    base_dir: str | Path | None = None,
    target_agent: str | None = None,
    fixture_id: str | None = None,
    mock_mode: bool | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = _runs_path(root)
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if target_agent is not None and row.get("target_agent") != target_agent:
            continue
        if fixture_id is not None and row.get("fixture_id") != fixture_id:
            continue
        if mock_mode is not None and bool(row.get("mock_mode")) != mock_mode:
            continue
        rows.append(row)
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


def aggregate_eval_metrics(
    *,
    target_agent: str,
    base_dir: str | Path | None = None,
    window_days: int = 30,
    mock_mode: bool | None = None,
) -> dict[str, Any]:
    """Compute the 6-key summary over runs for target_agent in the window.

    Returns:
      {
        target_agent, window_days, mock_mode,
        run_count, pass_count, fail_count,
        pass_rate, mean_rounds, mean_tokens,
        false_positive_rate,    # passed but verdict_class mismatch (impossible
                                  by current pass rule; preserved for
                                  contract clarity).
        false_negative_rate,    # failed though all evidence_refs matched.
        consistency_score,      # 1 - stdev(pass) over the window (0..1).
      }
    """
    if window_days <= 0:
        raise GovernanceError("window_days must be positive")
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    rows = list_eval_runs(base_dir=base_dir, target_agent=target_agent,
                          mock_mode=mock_mode)
    in_window: list[dict[str, Any]] = []
    for row in rows:
        try:
            ra = datetime.fromisoformat(str(row.get("recorded_at", "")).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if ra >= cutoff:
            in_window.append(row)
    if not in_window:
        return {
            "target_agent": target_agent,
            "window_days": window_days,
            "mock_mode": mock_mode,
            "run_count": 0,
            "pass_count": 0,
            "fail_count": 0,
            "pass_rate": 0.0,
            "mean_rounds": 0.0,
            "mean_tokens": 0.0,
            "false_positive_rate": 0.0,
            "false_negative_rate": 0.0,
            "consistency_score": 1.0,
        }
    pass_count = sum(1 for r in in_window if r.get("passed"))
    fail_count = len(in_window) - pass_count
    pass_rate = pass_count / len(in_window)
    mean_rounds = sum(int(r.get("rounds_used", 0)) for r in in_window) / len(in_window)
    mean_tokens = sum(int(r.get("tokens_used", 0)) for r in in_window) / len(in_window)
    fp = sum(1 for r in in_window if r.get("passed") and not r.get("verdict_match"))
    fn = sum(1 for r in in_window
             if not r.get("passed") and not r.get("missing_evidence_refs"))
    fp_rate = fp / len(in_window)
    fn_rate = fn / len(in_window)
    # Consistency: 1 - sample stdev of pass-flag (0..0.5 binary stdev).
    mean_pass = pass_rate
    variance = sum((1.0 if r.get("passed") else 0.0 - mean_pass) ** 2
                   for r in in_window) / len(in_window)
    consistency = max(0.0, 1.0 - variance)
    return {
        "target_agent": target_agent,
        "window_days": window_days,
        "mock_mode": mock_mode,
        "run_count": len(in_window),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "pass_rate": round(pass_rate, 6),
        "mean_rounds": round(mean_rounds, 6),
        "mean_tokens": round(mean_tokens, 6),
        "false_positive_rate": round(fp_rate, 6),
        "false_negative_rate": round(fn_rate, 6),
        "consistency_score": round(consistency, 6),
    }


def count_eval_runs_by_mode(*, base_dir: str | Path | None = None) -> dict[str, int]:
    """Plan 020 metric helper — used by plan_016_metrics 11th + 12th counters.

    Returns {'aria_agent_eval_mock_only_total': N, 'aria_agent_eval_real_total': M}.
    """
    rows = list_eval_runs(base_dir=base_dir)
    mock = sum(1 for r in rows if r.get("mock_mode") is True)
    real = sum(1 for r in rows if r.get("mock_mode") is False)
    return {
        "aria_agent_eval_mock_only_total": mock,
        "aria_agent_eval_real_total": real,
    }


__all__ = [
    "EVAL_RUNS_PATH",
    "EVAL_FIXTURES_DIR",
    "EVAL_FIXTURE_SCHEMA",
    "EVAL_RUN_SCHEMA",
    "REQUIRED_FIXTURE_FIELDS",
    "VERDICT_CLASSES",
    "add_fixture",
    "list_fixtures",
    "run_agent_eval",
    "list_eval_runs",
    "aggregate_eval_metrics",
    "count_eval_runs_by_mode",
]
