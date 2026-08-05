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

from .ledger import append_declared_jsonl, load_declared_jsonl
from .ledger_refs import find_row_by_source_ledger_ref
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    utc_now,
)

EVAL_RUNS_PATH = ("agent-evals", "runs.jsonl")
EVAL_FIXTURES_LEDGER_PATH = ("agent-evals", "fixtures.jsonl")
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


def _fixtures_ledger_path(tools_root: Path) -> Path:
    return tools_root.joinpath(*EVAL_FIXTURES_LEDGER_PATH)


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
            ledger = _find_fixture_row(root, fixture_id=str(fixture["fixture_id"]))
            return ledger or existing
        raise GovernanceError(
            f"fixture {fixture['fixture_id']} already exists with different "
            f"content hash; refusing accidental fixture mutation"
        )

    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return _append_fixture_ledger_row(root, fixture)


def list_fixtures(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    ledger_path = _fixtures_ledger_path(root)
    if ledger_path.exists():
        return load_declared_jsonl(ledger_path, expected_surface="agent_eval_fixtures")
    return []


def _read_fixture(*, fixture_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    if not _FIXTURE_ID_RE.match(fixture_id):
        raise GovernanceError(f"fixture_id {fixture_id!r} format invalid")
    root = ensure_tools_dir(base_dir)
    ledger = _find_fixture_row(root, fixture_id=fixture_id)
    if ledger is not None:
        return ledger
    raise GovernanceError(f"fixture {fixture_id} ledger row not found")


def _find_fixture_row(root: Path, *, fixture_id: str) -> dict[str, Any] | None:
    path = _fixtures_ledger_path(root)
    if not path.exists():
        return None
    matches = [
        row for row in load_declared_jsonl(path, expected_surface="agent_eval_fixtures")
        if row.get("fixture_id") == fixture_id
    ]
    if len(matches) > 1:
        raise GovernanceError(f"fixture_ledger_ambiguous:{fixture_id}")
    return matches[0] if matches else None


def _append_fixture_ledger_row(root: Path, fixture: dict[str, Any]) -> dict[str, Any]:
    fixture_id = str(fixture["fixture_id"])
    if _find_fixture_row(root, fixture_id=fixture_id) is not None:
        raise GovernanceError(f"fixture_ledger_duplicate:{fixture_id}")
    row = {
        "row_id": fixture_id,
        "row_type": "fixture",
        **dict(fixture),
    }
    return append_declared_jsonl(
        _fixtures_ledger_path(root),
        row,
        expected_surface="agent_eval_fixtures",
    )


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
    # Real-mode provenance binding. Real-mode runs require invocation_id
    # and transcript_hash so the eval row joins back to declared claim,
    # result and transcript ledgers. The legacy file-feed parameter is
    # retained only as a hard-fail compatibility guard.
    invocation_id: str | None = None,
    transcript_hash: str | None = None,
    request_ledger_ref: dict[str, Any] | None = None,
    claim_ledger_ref: dict[str, Any] | None = None,
    result_ledger_ref: dict[str, Any] | None = None,
    fixture_ledger_ref: dict[str, Any] | None = None,
    transcript_ledger_ref: dict[str, Any] | None = None,
    operator_approval_ledger_ref: dict[str, Any] | None = None,
    context_ledger_ref: dict[str, Any] | None = None,
    prompt_ledger_ref: dict[str, Any] | None = None,
    allow_legacy_envelope_feed: bool = False,
    operator_approval_ref: str | None = None,
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
    root = ensure_tools_dir(base_dir)

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
        if allow_legacy_envelope_feed:
            raise GovernanceError(
                "real_eval_legacy_envelope_feed_removed: use a ledger-bound "
                "invocation_id + transcript_hash recorded by submit_claim_result/"
                "record_transcript"
            )
        if not invocation_id or not transcript_hash:
            raise GovernanceError(
                "real_eval_missing_provenance_fields: mock_mode=False requires "
                "invocation_id and transcript_hash"
            )
        if not _is_sha256_digest(str(transcript_hash)):
            raise GovernanceError("real_eval_transcript_hash_must_be_sha256")
        _validate_real_eval_provenance(
            root,
            invocation_id=str(invocation_id),
            transcript_hash=str(transcript_hash),
            fixture_id=fixture_id,
            target_agent=str(fixture["target_agent"]),
            request_ledger_ref=request_ledger_ref,
            claim_ledger_ref=claim_ledger_ref,
            result_ledger_ref=result_ledger_ref,
            fixture_ledger_ref=fixture_ledger_ref,
            transcript_ledger_ref=transcript_ledger_ref,
            operator_approval_ledger_ref=operator_approval_ledger_ref,
            context_ledger_ref=context_ledger_ref,
            prompt_ledger_ref=prompt_ledger_ref,
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
        # Plan 023 v3 §A-8 — provenance fields binding the eval row
        # to the upstream invocation. invocation_id None for mock-mode
        # runs (the synthesized envelope has no lease).
        "invocation_id": invocation_id,
        "transcript_hash": transcript_hash,
        "request_ledger_ref": request_ledger_ref,
        "claim_ledger_ref": claim_ledger_ref,
        "result_ledger_ref": result_ledger_ref,
        "fixture_ledger_ref": fixture_ledger_ref,
        "transcript_ledger_ref": transcript_ledger_ref,
        "operator_approval_ledger_ref": operator_approval_ledger_ref,
        "context_ledger_ref": context_ledger_ref,
        "prompt_ledger_ref": prompt_ledger_ref,
        "provenance_mode": (
            "mock" if mock_mode
            else "real_invocation"
        ),
        "operator_approval_ref": operator_approval_ref,
    }

    _runs_path(root).parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(
        _runs_path(root),
        run_row,
        expected_surface="agent_evals",
    )
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


def _validate_real_eval_provenance(
    root: Path,
    *,
    invocation_id: str,
    transcript_hash: str,
    fixture_id: str,
    target_agent: str,
    request_ledger_ref: dict[str, Any] | None,
    claim_ledger_ref: dict[str, Any] | None,
    result_ledger_ref: dict[str, Any] | None,
    fixture_ledger_ref: dict[str, Any] | None,
    transcript_ledger_ref: dict[str, Any] | None,
    operator_approval_ledger_ref: dict[str, Any] | None,
    context_ledger_ref: dict[str, Any] | None = None,
    prompt_ledger_ref: dict[str, Any] | None = None,
) -> None:
    refs = {
        "request_ledger_ref": request_ledger_ref,
        "claim_ledger_ref": claim_ledger_ref,
        "context_ledger_ref": context_ledger_ref,
        "prompt_ledger_ref": prompt_ledger_ref,
        "result_ledger_ref": result_ledger_ref,
        "fixture_ledger_ref": fixture_ledger_ref,
        "transcript_ledger_ref": transcript_ledger_ref,
        "operator_approval_ledger_ref": operator_approval_ledger_ref,
    }
    missing_refs = [name for name, ref in refs.items() if ref is None]
    if missing_refs:
        raise GovernanceError("real_eval_missing_provenance_refs:" + ",".join(missing_refs))

    request = find_row_by_source_ledger_ref(
        root,
        request_ledger_ref or {},
        expected_surface="agent_invocation_requests",
        expected_row_type="request",
    )
    claim = find_row_by_source_ledger_ref(
        root,
        claim_ledger_ref or {},
        expected_surface="agent_invocation_claims",
        expected_row_type="claim",
    )
    result = find_row_by_source_ledger_ref(
        root,
        result_ledger_ref or {},
        expected_surface="agent_invocation_results",
        expected_row_type="result",
    )
    transcript = find_row_by_source_ledger_ref(
        root,
        transcript_ledger_ref or {},
        expected_surface="agent_invocation_transcripts",
        expected_row_type="transcript",
    )
    _validate_fixture_ledger_ref(
        root,
        fixture_ledger_ref or {},
        fixture_id=fixture_id,
        target_agent=target_agent,
    )
    operator = find_row_by_source_ledger_ref(
        root,
        operator_approval_ledger_ref or {},
        expected_surface="operator_provenance",
        expected_row_type="operator_approval",
    )
    _require_operator_approval_future(operator)
    find_row_by_source_ledger_ref(
        root,
        context_ledger_ref or {},
        expected_surface="agent_invocation_contexts",
        expected_row_type="context",
    )
    find_row_by_source_ledger_ref(
        root,
        prompt_ledger_ref or {},
        expected_surface="agent_invocation_prompts",
        expected_row_type="prompt",
    )

    request_id = str(request.get("request_id") or "")
    claim_id = str(claim.get("claim_id") or claim.get("invocation_id") or "")
    missing = []
    if not request_id:
        missing.append("request_row_id")
    if claim_id != invocation_id and str(claim.get("invocation_id") or "") != invocation_id:
        missing.append("claim_row_invocation")
    if str(claim.get("request_id") or "") != request_id:
        missing.append("claim_row_request")
    if (
        str(result.get("claim_id") or result.get("invocation_id") or "") != invocation_id
        and str(result.get("invocation_id") or "") != invocation_id
    ):
        missing.append("result_row_invocation")
    if result.get("request_id") and str(result.get("request_id")) != request_id:
        missing.append("result_row_request")
    if result.get("status") != "accepted":
        missing.append("result_row_status")
    if str(result.get("transcript_hash") or result.get("output_transcript_hash") or "") != transcript_hash:
        missing.append("result_row_transcript_hash")
    if str(transcript.get("transcript_hash") or transcript.get("output_transcript_hash") or "") != transcript_hash:
        missing.append("transcript_row_hash")
    if (
        str(transcript.get("invocation_id") or transcript.get("claim_id") or "") != invocation_id
        and str(transcript.get("claim_id") or "") != invocation_id
    ):
        missing.append("transcript_row_invocation")
    if transcript.get("request_id") and str(transcript.get("request_id")) != request_id:
        missing.append("transcript_row_request")
    if str(transcript.get("target_agent") or "") != target_agent:
        missing.append("transcript_row_target_agent")
    if transcript.get("fixture_run_id") and str(transcript.get("fixture_run_id")) != fixture_id:
        missing.append("transcript_row_fixture")
    _require_transcript_artifact_hash(transcript, transcript_hash=transcript_hash)
    if missing:
        raise GovernanceError("real_eval_provenance_unbound:" + ",".join(missing))


def _validate_fixture_ledger_ref(
    root: Path,
    ref: dict[str, Any],
    *,
    fixture_id: str,
    target_agent: str,
) -> None:
    row = find_row_by_source_ledger_ref(
        root,
        ref,
        expected_surface="agent_eval_fixtures",
        expected_row_type="fixture",
    )
    if row.get("fixture_id") != fixture_id:
        raise GovernanceError("fixture_ledger_ref_fixture_id_mismatch")
    if row.get("target_agent") != target_agent:
        raise GovernanceError("fixture_ledger_ref_target_agent_mismatch")


def _require_operator_approval_future(row: dict[str, Any]) -> None:
    expires_at = row.get("expires_at")
    if not isinstance(expires_at, str) or not expires_at.strip():
        raise GovernanceError("operator_approval_expiry_required")
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GovernanceError("operator_approval_expiry_invalid") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise GovernanceError("operator_approval_expired")


def _require_transcript_artifact_hash(
    row: dict[str, Any],
    *,
    transcript_hash: str,
) -> None:
    artifact = row.get("artifact_ref") or row.get("transcript_artifact_ref")
    if artifact is None:
        return
    if isinstance(artifact, dict):
        if artifact.get("sha256") != transcript_hash:
            raise GovernanceError("transcript_artifact_hash_mismatch")
        return
    if isinstance(artifact, str) and artifact.startswith("sha256:"):
        if artifact != transcript_hash:
            raise GovernanceError("transcript_artifact_hash_mismatch")
        return
    if isinstance(artifact, str):
        path = Path(artifact)
        if not path.is_file():
            raise GovernanceError("transcript_artifact_path_missing")
        observed = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        if observed != transcript_hash:
            raise GovernanceError("transcript_artifact_hash_mismatch")
        return
    raise GovernanceError("transcript_artifact_ref_invalid")


def _is_sha256_digest(value: str) -> bool:
    return (
        value.startswith("sha256:")
        and len(value) == len("sha256:") + 64
        and all(ch in "0123456789abcdef" for ch in value[len("sha256:"):])
    )


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
    # Plan 026R §A.3 — strict JSONL reader (was silent-skip).
    from .strict_jsonl_reader import read_strict_jsonl
    rows: list[dict[str, Any]] = []
    for row in read_strict_jsonl(path):
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
    # WHY the parentheses: the original `(1.0 if passed else 0.0 - mean) ** 2`
    # bound the conditional over the whole expression, so every PASSING run
    # contributed a constant 1.0 to the variance — a perfectly consistent
    # agent scored consistency ~0. Latent while runs.jsonl was empty; fixed
    # before the first real eval. stdev (not variance) per the docstring.
    variance = sum(((1.0 if r.get("passed") else 0.0) - mean_pass) ** 2
                   for r in in_window) / len(in_window)
    consistency = max(0.0, 1.0 - variance ** 0.5)
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


# Plan 022 §H-5 — SHADOW raw findings sampling threshold (24-hour window).
# When a SHADOW tool produces ≥ this many raw_findings in 24h, the
# sampling CLI emits a shadow_findings_sampled governance event per
# tool AND escalates via human_required_recorded so operators see the
# build-up instead of the raw findings rotting in runs.jsonl.
SHADOW_SAMPLE_THRESHOLD_24H: int = 5


def sample_shadow_raw_findings(
    *,
    base_dir: str | Path | None = None,
    threshold_24h: int = SHADOW_SAMPLE_THRESHOLD_24H,
) -> dict[str, Any]:
    """Plan 022 §H-5 — surface SHADOW raw_findings to operator review.

    Pre-Plan-022 SHADOW tools emitted empty operator-facing
    observations/findings (tool_runner.py:139-141 gates emission on
    can_emit_operator_facing). raw_findings landed in the ledger but
    operators never saw them; the dashboard's shadow_raw_delta pressure
    only triggered when the count was abnormal — base-rate buried.

    Fix: this function reads the last 24h of runs.jsonl, aggregates
    raw_findings_count per SHADOW tool_id, and:
    1. Emits a shadow_findings_sampled governance event per tool.
    2. If the count meets or exceeds threshold_24h, also files a
       human_required_recorded escalation so the operator dashboard
       surfaces it as actionable.

    Returns a summary dict {samples: [{tool_id, raw_findings_count_24h,
    escalated: bool}, ...], escalation_count: int}.
    """
    from datetime import datetime, timedelta, timezone
    from .human_required import record_human_required
    from .tool_health import runs_path
    from .runs_reader import read_runs_rows
    from .tool_registry import (
        append_tools_governance,
        ensure_tools_dir,
        get_tool,
    )

    enforce_profile_for_write("agent_evals", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    runs = list(read_runs_rows(runs_path(base_dir), base_dir=root))
    by_tool: dict[str, int] = {}
    # Plan 023 v3 §C-6 — track runs skipped due to scope_out_mutations
    # so the sampler output surfaces the suspect-run count separately
    # from the clean raw_findings aggregate.
    suspect_by_tool: dict[str, int] = {}
    for run in runs:
        recorded = run.get("recorded_at") or run.get("at")
        if not isinstance(recorded, str):
            continue
        try:
            ts = datetime.fromisoformat(recorded.replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts.astimezone(timezone.utc) < cutoff:
            continue
        tool_id = str(run.get("tool_id") or "")
        if not tool_id:
            continue
        # Only sample tools currently in SHADOW status — ACTIVE tools
        # already emit operator-facing findings, so sampling them
        # would double-surface.
        try:
            tool = get_tool(tool_id, base_dir)
        except GovernanceError:
            continue
        if tool.get("status") != "SHADOW":
            continue
        runner_block = run.get("runner") or {}
        # Plan 023 v3 §C-6 — skip runs that escaped their declared scope
        # from the SHADOW raw-findings aggregate. Scope-out mutations
        # already trigger immediate quarantine via record_run; their
        # raw findings are flagged invalid_evidence in raw-findings.jsonl
        # by feedback_store. Surfacing them via the sampler would
        # re-legitimize a sandbox-escape adapter's output. Track the
        # suspect_run_count separately so operators see the skip.
        if runner_block.get("scope_out_mutations"):
            suspect_by_tool[tool_id] = suspect_by_tool.get(tool_id, 0) + 1
            continue
        count = int(runner_block.get("raw_findings_count", 0) or 0)
        by_tool[tool_id] = by_tool.get(tool_id, 0) + count

    samples: list[dict[str, Any]] = []
    escalation_count = 0
    # Union of tool_ids seen in either clean or suspect path so the
    # sample list reflects every SHADOW tool with any 24h activity.
    all_tool_ids = sorted(set(by_tool) | set(suspect_by_tool))
    for tool_id in all_tool_ids:
        count = by_tool.get(tool_id, 0)
        suspect_run_count = suspect_by_tool.get(tool_id, 0)
        escalated = count >= threshold_24h
        samples.append({
            "tool_id": tool_id,
            "raw_findings_count_24h": count,
            "suspect_run_count_24h": suspect_run_count,
            "escalated": escalated,
            "threshold_24h": threshold_24h,
        })
        append_tools_governance(
            root,
            "shadow_findings_sampled",
            {
                "tool_id": tool_id,
                "raw_findings_count_24h": count,
                "threshold_24h": threshold_24h,
                "escalated": escalated,
            },
        )
        if escalated:
            escalation_count += 1
            record_human_required(
                request_id=f"shadow-sample-{tool_id}-{int(cutoff.timestamp())}",
                severity="MEDIUM",
                reason=(
                    f"SHADOW tool {tool_id!r} produced {count} raw_findings "
                    f"in the last 24h (threshold={threshold_24h}); operator "
                    f"review required to triage findings + decide on "
                    f"SHADOW->CALIBRATE transition."
                ),
                base_dir=base_dir,
            )
    return {
        "samples": samples,
        "escalation_count": escalation_count,
        "threshold_24h": threshold_24h,
    }


__all__ = [
    "EVAL_RUNS_PATH",
    "EVAL_FIXTURES_DIR",
    "EVAL_FIXTURE_SCHEMA",
    "EVAL_RUN_SCHEMA",
    "REQUIRED_FIXTURE_FIELDS",
    "VERDICT_CLASSES",
    "SHADOW_SAMPLE_THRESHOLD_24H",
    "add_fixture",
    "list_fixtures",
    "run_agent_eval",
    "list_eval_runs",
    "aggregate_eval_metrics",
    "count_eval_runs_by_mode",
    "sample_shadow_raw_findings",
]
