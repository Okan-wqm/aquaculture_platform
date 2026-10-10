"""Plan 020 Phase 6 — agent eval harness; ARIA-HIGH-285 — real performance observation.

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
- run_agent_eval(...) checks one response of the agent, recorded by a
  ledger-bound invocation, against the fixture and records the run row to
  aria-tools/agent-evals/runs.jsonl.
- aggregate_eval_metrics(...) windows the runs over N days and computes the
  6-key summary (pass_rate, mean_rounds, false_positive_rate,
  false_negative_rate, mean_tokens, consistency_score).

No mock mode (ARIA-HIGH-285)
----------------------------
``mock_mode=True`` was the default here and in the CLI, and the weekly lane
never turned it off: every row on aria/state copied the fixture's expected
verdict and passed. The kernel can no longer write such a row; a test that
wants a fixture run builds a fake invocation ledger. Historical mock rows stay
readable and segregated by their recorded ``mock_mode``.

``observe_agent_performance`` is the cycle's real mode (reflection runs it):
one procedural ``performance_observed`` event per finished drafter / implementer
episode on ``memory/procedural.jsonl``, no LLM call; the implementer's
must-check and the doctor's ``learning`` organ read it.

Plan 020 surface gate
---------------------
agent_evals is in PLAN_020_WRITE_SURFACES (frozen blocks; observe blocks —
agent invocation mutates state beyond observation class).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Collection

from .artifact_safety import assert_real_mode_env_safe
from .failure_attribution import (
    Attribution,
    InvocationLedgersSource,
    attribute_evaluation,
    attribute_implementation_failure,
    attribute_self_revert,
)
from .independence_check import CROSS_REVIEW_SELF_AGREEMENT_REASON
from .ledger import LedgerIntegrityError, append_declared_jsonl, load_declared_jsonl
from .ledger_refs import find_row_by_source_ledger_ref
from .merge_record import lineage_credits_aria
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


# Keys a fixture's content hash must never cover. `recorded_at` is a timestamp,
# so including it would make every re-add look like a mutation. `fixture_hash`
# is the digest itself: a hash that covers its own output can be reproduced
# only from an input that lacks it, which is precisely the round trip the
# persisted file breaks — it comes back WITH the field.
_HASH_EXCLUDED_KEYS = frozenset({"recorded_at", "fixture_hash"})


def add_fixture(
    *,
    fixture: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Persist a fixture under aria-tools/agent-evals/fixtures/<fixture_id>.json.

    Idempotent on (fixture_id, sha256(canonical fixture JSON)) — re-adding
    the same fixture content returns the existing row; a content-changed
    re-add raises GovernanceError so accidental fixture mutation is caught.

    The canonical form excludes `_HASH_EXCLUDED_KEYS`. Keeping the digest out
    of its own input is what makes the idempotent path reachable at all for a
    fixture read back off disk.
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
        {k: v for k, v in fixture.items() if k not in _HASH_EXCLUDED_KEYS},
        sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    fixture_hash = hashlib.sha256(canonical).hexdigest()[:16]
    fixture["fixture_hash"] = fixture_hash

    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing.get("fixture_hash") == fixture_hash:
            ledger = _find_fixture_row(root, fixture_id=str(fixture["fixture_id"]))
            if ledger is not None:
                return ledger
            # The ledger row is DERIVED from the persisted file, so a missing
            # row is a gap to close, not a result to hand back. Returning
            # `existing` here reads as success and leaves `run` to fail later
            # with "ledger row not found" — the exact state the five committed
            # fixtures are in today: files in git, no ledger beside them. The
            # file is the authority for the reconstruction, not the argument,
            # so a re-add cannot rewrite history through this path.
            return _append_fixture_ledger_row(root, existing)
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


def run_agent_eval(
    *,
    fixture_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
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
    """Check one recorded agent response against a fixture; record pass/fail.

    The response must come from a ledger-bound invocation; every binding is
    re-validated here. There is no synthesized response (ARIA-HIGH-285).

    Pass criteria (Plan v3.3 §Phase 6.A):
    - response.verdict_class == fixture.expected_verdict_class.
    - response.evidence_refs is a SUPERSET of fixture.expected_evidence_refs.
    """
    enforce_profile_for_write("agent_evals", base_dir=base_dir)
    fixture = _read_fixture(fixture_id=fixture_id, base_dir=base_dir)
    root = ensure_tools_dir(base_dir)

    # ORPHAN-HIGH-573 — the real-mode ENVIRONMENT precondition, first,
    # because an unsafe debugger environment must be refused before this
    # run starts reading ledgers and binding provenance to it. Every run is
    # real since ARIA-HIGH-285, so this guards every call.
    assert_real_mode_env_safe(dict(os.environ))
    if real_response_envelope is None:
        raise GovernanceError(
            "real_eval_missing_response_envelope: a fixture run checks the "
            "real_response_envelope of a ledger-bound invocation"
        )
    if allow_legacy_envelope_feed:
        raise GovernanceError(
            "real_eval_legacy_envelope_feed_removed: use a ledger-bound "
            "invocation_id + transcript_hash recorded by submit_claim_result/"
            "record_transcript"
        )
    if not invocation_id or not transcript_hash:
        raise GovernanceError(
            "real_eval_missing_provenance_fields: a fixture run requires "
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
        "mock_mode": False,
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
        # to the upstream invocation (None only on historical mock rows).
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
        "provenance_mode": "real_invocation",
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
        "agent_eval_run_real",
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
    return _metrics_for_rows(
        target_agent=target_agent, rows=in_window,
        window_days=window_days, mock_mode=mock_mode,
    )


def _metrics_for_rows(
    *,
    target_agent: str,
    rows: list[dict[str, Any]],
    window_days: int,
    mock_mode: bool | None,
) -> dict[str, Any]:
    """The six-key summary for an already-selected set of runs.

    Extracted so window selection and metric computation stop being one
    function: `compare_eval_windows` needs the identical arithmetic over a
    DIFFERENT slice, and a second copy of the consistency formula is exactly
    how the variance bug would come back on one of the two paths.
    """
    if not rows:
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
    pass_count = sum(1 for r in rows if r.get("passed"))
    fail_count = len(rows) - pass_count
    pass_rate = pass_count / len(rows)
    mean_rounds = sum(int(r.get("rounds_used", 0)) for r in rows) / len(rows)
    mean_tokens = sum(int(r.get("tokens_used", 0)) for r in rows) / len(rows)
    fp = sum(1 for r in rows if r.get("passed") and not r.get("verdict_match"))
    fn = sum(1 for r in rows
             if not r.get("passed") and not r.get("missing_evidence_refs"))
    fp_rate = fp / len(rows)
    fn_rate = fn / len(rows)
    # Consistency: 1 - sample stdev of pass-flag (0..0.5 binary stdev).
    mean_pass = pass_rate
    # WHY the parentheses: the original `(1.0 if passed else 0.0 - mean) ** 2`
    # bound the conditional over the whole expression, so every PASSING run
    # contributed a constant 1.0 to the variance - a perfectly consistent
    # agent scored consistency ~0. Latent while runs.jsonl was empty; fixed
    # before the first real eval. stdev (not variance) per the docstring.
    variance = sum(((1.0 if r.get("passed") else 0.0) - mean_pass) ** 2
                   for r in rows) / len(rows)
    consistency = max(0.0, 1.0 - variance ** 0.5)
    return {
        "target_agent": target_agent,
        "window_days": window_days,
        "mock_mode": mock_mode,
        "run_count": len(rows),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "pass_rate": round(pass_rate, 6),
        "mean_rounds": round(mean_rounds, 6),
        "mean_tokens": round(mean_tokens, 6),
        "false_positive_rate": round(fp_rate, 6),
        "false_negative_rate": round(fn_rate, 6),
        "consistency_score": round(consistency, 6),
    }


#: Below this many runs in EITHER window, a difference between windows is
#: sampling noise wearing a trend's clothes. Five is the smallest count at
#: which one flipped run moves pass_rate by less than the quarter the
#: verdict treats as meaningful; the gate exists because the first real
#: baseline is five runs and the temptation to read a trend out of two is
#: real.
MIN_RUNS_FOR_TREND = 5


def compare_eval_windows(
    *,
    target_agent: str,
    base_dir: str | Path | None = None,
    window_days: int = 30,
    mock_mode: bool | None = None,
    min_runs: int = MIN_RUNS_FOR_TREND,
) -> dict[str, Any]:
    """Is round N+1 better than round N? - the program's own success test.

    The intelligence plan defines improvement as a MEASURED difference
    between consecutive windows, not a felt one. `aggregate_eval_metrics`
    could only ever describe one window, so "did it get better" had no
    answer except a human comparing two printouts.

    Windows are [now-2W, now-W) and [now-W, now]: adjacent, non-overlapping,
    half-open at the seam so a run on the boundary is counted once, in the
    current window.

    The verdict refuses to speak when either side is thin. That refusal is
    the point: a pass_rate that moved because a five-run baseline became a
    six-run one is noise, and a loop that celebrates noise never stops for
    the reason it should.
    """
    if window_days <= 0:
        raise GovernanceError("window_days must be positive")
    if min_runs < 1:
        raise GovernanceError("min_runs must be at least 1")

    now = datetime.now(timezone.utc)
    current_start = now - timedelta(days=window_days)
    previous_start = now - timedelta(days=2 * window_days)

    rows = list_eval_runs(base_dir=base_dir, target_agent=target_agent, mock_mode=mock_mode)
    current_rows: list[dict[str, Any]] = []
    previous_rows: list[dict[str, Any]] = []
    undated = 0
    for row in rows:
        try:
            recorded = datetime.fromisoformat(
                str(row.get("recorded_at", "")).replace("Z", "+00:00")
            )
        except (TypeError, ValueError):
            undated += 1
            continue
        if recorded >= current_start:
            current_rows.append(row)
        elif recorded >= previous_start:
            previous_rows.append(row)

    current = _metrics_for_rows(
        target_agent=target_agent, rows=current_rows,
        window_days=window_days, mock_mode=mock_mode,
    )
    previous = _metrics_for_rows(
        target_agent=target_agent, rows=previous_rows,
        window_days=window_days, mock_mode=mock_mode,
    )

    tracked = (
        "pass_rate",
        "consistency_score",
        "false_negative_rate",
        "mean_rounds",
        "mean_tokens",
    )
    deltas = {key: round(current[key] - previous[key], 6) for key in tracked}

    if current["run_count"] < min_runs or previous["run_count"] < min_runs:
        verdict = "insufficient_evidence"
        reason = (
            f"need {min_runs} runs per window, have "
            f"{previous['run_count']} then {current['run_count']}"
        )
    elif deltas["pass_rate"] > 0 or (
        deltas["pass_rate"] == 0 and deltas["consistency_score"] > 0
    ):
        verdict = "improved"
        reason = "pass_rate rose" if deltas["pass_rate"] > 0 else "pass_rate held, consistency rose"
    elif deltas["pass_rate"] < 0 or deltas["consistency_score"] < 0:
        verdict = "regressed"
        reason = "pass_rate fell" if deltas["pass_rate"] < 0 else "pass_rate held, consistency fell"
    else:
        verdict = "flat"
        reason = "no measured movement between windows"

    return {
        "schema_version": 1,
        "target_agent": target_agent,
        "window_days": window_days,
        "mock_mode": mock_mode,
        "min_runs": min_runs,
        "previous_window": previous,
        "current_window": current,
        "deltas": deltas,
        "verdict": verdict,
        "reason": reason,
        "undated_run_count": undated,
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


# ---------------------------------------------------------------------------
# ARIA-HIGH-285 — real mode for the cycle: drafter and implementer
# performance, measured from outcomes the plan ledger already records.
# ---------------------------------------------------------------------------

PERFORMANCE_SURFACE = "memory_procedural"
PERFORMANCE_OBSERVED_KIND = "performance_observed"
#: The program plan's lesson trigger: a failure mode the next actor must check.
LESSON_EPISODE_THRESHOLD = 3
#: A round-one plan no agent revised is the kernel's own seed.
PLAN_SYNTHESIZER_SUBJECT = "kernel:plan_synthesizer"
# ARIA-HIGH-370 — which failures are the agent's is no longer a list of lane
# tokens kept here: ``failure_attribution`` attributes a failure only when
# its own evidence names the work (an allowlist of evidence), and every
# other failure is recorded and kept off the scorecard.
# ARIA-HIGH-375 — ``cross_review_self_agreement`` (a reviewer-independence
# fault of the kernel's dispatch) is not on that allowlist, so it is never
# the drafter's must-check lesson.
#: The program plan's learning KPIs the recorded evidence cannot compute, and why.
NOT_COMPUTABLE_KPIS: dict[str, str] = {
    "repeat_failure_rate_by_class_key": "plans record no class_key (tool:rule); the live split is by failure_mode",
    "memory_ablation": "no replay lane runs a request with memory on and off",
    "precision_after_fp_label": "no signed false-positive label and no ARIA-authored detector precision series exist",
    "impact_miss_rate": "no recorded row places a post-merge regression's paths against the plan's impact closure",
    "implementer_scorecard_by_agent_version_hash": "implementation events record the agent name, not its version hash",
}


def _surface_file(root: Path, surface: str) -> Path:
    from .state_manifest import resolve_surface_path, surface_by_name

    return resolve_surface_path(root, surface_by_name(surface))


def _performance_rows(root: Path) -> list[dict[str, Any]]:
    path = _surface_file(root, PERFORMANCE_SURFACE)
    return load_declared_jsonl(path, expected_surface=PERFORMANCE_SURFACE) if path.is_file() else []


def _attributed_reverts(root: Path) -> dict[str, dict[str, Any]]:
    """merge_sha → the first self-revert row that attributes a bad outcome to it."""
    from .self_revert import DECISION_NOT_ATTRIBUTABLE, SELF_REVERTS_SURFACE

    path = _surface_file(root, SELF_REVERTS_SURFACE)
    rows = load_declared_jsonl(path, expected_surface=SELF_REVERTS_SURFACE) if path.is_file() else []
    reverts: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("decision") != DECISION_NOT_ATTRIBUTABLE:
            reverts.setdefault(str(row["merge_sha"]), row)
    return reverts


def _episode(
    role: str, subject: str, plan_id: str, source: dict[str, str], occurred_at: Any,
    outcome: str, failure_mode: str | None, supersedes: str | None = None,
    attribution: Attribution | None = None,
) -> dict[str, Any]:
    """One episode. ARIA-HIGH-370: a failure is ``attributable`` only when
    ``failure_attribution`` names the work from the failure's own evidence;
    the attribution's mode replaces the lane token the reason started with."""
    from .attribution_void import void_for

    canonical = json.dumps([role, plan_id, source], sort_keys=True).encode("utf-8")
    episode_id = "sha256:" + hashlib.sha256(canonical).hexdigest()
    # Review of #1829 (HIGH-2) — an attribution whose cause a kernel fix has
    # since removed is recorded unattributed, naming the fix.
    void = void_for(attribution.failure_mode, attribution.role, occurred_at) if attribution is not None else None
    voided_by = void.fixed_by if void is not None else None
    if void is not None:
        attribution = None
    mode = attribution.failure_mode if attribution is not None else failure_mode
    evidence = [source, *(dict(ref) for ref in attribution.evidence)] if attribution is not None else [source]
    return {
        "schema_version": 1, "row_id": episode_id, "row_type": PERFORMANCE_OBSERVED_KIND,
        "stream": "procedural", "kind": PERFORMANCE_OBSERVED_KIND, "episode_id": episode_id,
        "role": role, "subject": subject, "plan_id": plan_id, "outcome": outcome,
        "success": failure_mode is None, "failure_mode": mode,
        "attributable": failure_mode is None or attribution is not None,
        "attribution": attribution.as_row() if attribution is not None else None,
        **({"voided_by": voided_by} if voided_by is not None else {}),
        "occurred_at": occurred_at, "evidence": evidence, "supersedes": supersedes,
    }


def _performance_episodes(
    events: list[dict[str, Any]], reverts: dict[str, dict[str, Any]], ledgers: InvocationLedgersSource,
) -> list[dict[str, Any]]:
    """Every finished episode in plan-ledger order: the drafter's at evaluation
    or abandonment, the implementer's at merge or rejection (a request always
    precedes it), an attributed self-revert superseding its merge."""
    drafters: dict[str, str] = {}
    implementers: dict[str, str] = {}
    converged_episodes: dict[str, dict[str, Any]] = {}
    rejected_episodes: dict[str, dict[str, Any]] = {}
    episodes: list[dict[str, Any]] = []
    for event in events:
        plan_id, kind, payload = str(event["plan_id"]), event["event_type"], event["payload"]
        source = {"surface": "plan_convergence_events", "id": str(event["event_id"])}
        at = event["recorded_at"]
        drafter = drafters.get(plan_id, PLAN_SYNTHESIZER_SUBJECT)
        if kind == "revision_recorded":
            drafters[plan_id] = str(payload.get("revised_by_agent") or "aria-primary-planner")
        elif kind in ("implementation_requested", "implementation_started"):
            implementers[plan_id] = str(payload["implementer_agent"])
        elif kind == "plan_evaluated" and payload["terminal_state"] == "CONVERGED":
            converged = _episode("drafter", drafter, plan_id, source, at, "converged", None)
            converged_episodes[plan_id] = converged
            episodes.append(converged)
        elif kind == "plan_evaluated":
            # HUMAN_REQUIRED (the validator's only other terminal): the first
            # reason code, or the state itself when the evaluation named none.
            reasons = [*payload["reason_codes"], "human_required"]
            failure_mode = str(reasons[0]).split(":", 1)[0].strip()
            attribution = attribute_evaluation(payload, plan_id=plan_id, drafter=drafter, ledgers=ledgers)
            # ARIA-HIGH-375 — a convergence the independence migration later
            # withdrew (CONVERGED -> HUMAN_REQUIRED, self-agreement) was never
            # the drafter's success: its escalation supersedes the credit.
            withdrawn = converged_episodes.pop(plan_id, None) if (
                failure_mode == CROSS_REVIEW_SELF_AGREEMENT_REASON) else None
            episodes.append(_episode("drafter", drafter, plan_id, source, at, "escalated", failure_mode,
                                     supersedes=withdrawn["episode_id"] if withdrawn else None,
                                     attribution=attribution))
        elif kind == "plan_abandoned":
            # The stall reaper is the abandon writer; an abandon names no work.
            reason = str(payload["reason"]).split(":", 1)[0].strip()
            episodes.append(_episode("drafter", drafter, plan_id, source, at, "abandoned", reason))
        elif kind == "implementation_rejected":
            rejection = str(payload["rejection_class"])
            rejected = _episode(
                "implementer", implementers[plan_id], plan_id, source, at, "rejected", rejection,
                attribution=attribute_implementation_failure(rejection, implementer=implementers[plan_id]),
            )
            rejected_episodes[plan_id] = rejected
            episodes.append(rejected)
        elif kind == "implementation_merged":
            # Review of #1910, N5 — a merge whose head is not ARIA's change (a
            # person's commits, an unread head, a backfilled row) folds the
            # plan MERGED but is no implementer's merged episode.
            if not lineage_credits_aria(payload.get("head_lineage")):
                continue
            # ARIA-HIGH-390 (review of #1910, F6) — a person merged the PR of a
            # plan the kernel had ended: the merge supersedes the rejection,
            # so the implementer is not scored both ways for one change.
            prior = rejected_episodes.pop(plan_id, None) if payload.get("merged_after_rejection") else None
            merged = _episode("implementer", implementers[plan_id], plan_id, source, at, "merged", None,
                              supersedes=prior["episode_id"] if prior else None)
            episodes.append(merged)
            revert = reverts.get(str(payload["merge_sha"]))
            if revert is not None:
                episodes.append(_episode(
                    "implementer", merged["subject"], plan_id,
                    {"surface": "enterprise_self_reverts", "id": str(revert["key"])}, revert["recorded_at"],
                    "self_reverted", f"self_revert:{revert['trigger']}", supersedes=merged["episode_id"],
                    attribution=attribute_self_revert(str(revert["trigger"]), implementer=merged["subject"]),
                ))
    return episodes


def _judgement(row: dict[str, Any]) -> tuple[Any, ...]:
    return (row["failure_mode"], row["attributable"], json.dumps(row.get("attribution"), sort_keys=True),
            row.get("voided_by"))


def _unrecorded_episodes(root: Path) -> list[dict[str, Any]]:
    """The episodes to append: each one no row records yet, and each one a
    recorded row judged differently (ARIA-HIGH-370 — the 19 drafter episodes
    recorded before attribution existed). A re-judged episode keeps its
    lineage (the first row's id), takes a new id, and supersedes the row it
    corrects, so the ledger stays append-only and the current view is one
    row per episode."""
    from .plan_convergence import events_file

    rows = _performance_rows(root)
    recorded = {str(row["episode_id"]) for row in rows}
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        latest[str(row.get("lineage_id") or row["episode_id"])] = row
    events = load_declared_jsonl(events_file(root), expected_surface="plan_convergence_events")
    pending: list[dict[str, Any]] = []
    for episode in _performance_episodes(events, _attributed_reverts(root), InvocationLedgersSource(root)):
        lineage = str(episode["episode_id"])
        current = latest.get(lineage)
        if current is None:
            pending.append(episode)
            continue
        if _judgement(current) == _judgement(episode):
            continue
        # Review of #1829 (M) — the id names the TRANSITION (the row it
        # supersedes and the new judgement): a verdict that flaps A→B→A→B
        # gets a fresh row each time instead of colliding with the B already
        # recorded and sticking on A.
        transition = [lineage, str(current["episode_id"]), *_judgement(episode)]
        digest = hashlib.sha256(json.dumps(transition).encode("utf-8")).hexdigest()
        rejudged = {**episode, "episode_id": "sha256:" + digest, "row_id": "sha256:" + digest,
                    "lineage_id": lineage, "supersedes": str(current["episode_id"])}
        if rejudged["episode_id"] not in recorded:
            pending.append(rejudged)
    return pending


def _refuse(root: Path, cycle_id: str, reason: str, detail: str = "") -> dict[str, Any]:
    append_tools_governance(root, "agent_eval_real_refused", {"cycle_id": cycle_id, "reason": reason, "detail": detail})
    return {"verdict": "refused", "reason": reason, "appended": 0}


def observe_agent_performance(*, base_dir: str | Path | None = None, cycle_id: str) -> dict[str, Any]:
    """Real mode: record each finished drafter / implementer episode once.

    Reads the plan ledger and the self-revert ledger, appends one procedural
    ``performance_observed`` event per episode not yet on the memory ledger,
    and calls no LLM. With no plan ledger, or one that fails verification,
    there is nothing to measure and no other source to fall back to: the
    refusal is named in governance.
    """
    from .plan_convergence import events_file

    root = ensure_tools_dir(base_dir)
    if not events_file(root).is_file():
        return _refuse(root, cycle_id, "agent_eval_inputs_missing:plan_convergence_events")
    try:
        pending = _unrecorded_episodes(root)
    except LedgerIntegrityError as exc:
        # A ledger the measurement reads failed verification: none of it is evidence.
        return _refuse(root, cycle_id, "agent_eval_inputs_unverified", str(exc))
    path = _surface_file(root, PERFORMANCE_SURFACE)
    path.parent.mkdir(parents=True, exist_ok=True)
    from .attribution_void import gate_epoch

    for row in pending:
        append_declared_jsonl(path, {**row, "cycle_id": cycle_id, "recorded_at": utc_now(), "gate_epoch": gate_epoch()},
                              expected_surface=PERFORMANCE_SURFACE)
    return {"verdict": "observed", "appended": len(pending)}


def unobserved_episode_count(*, base_dir: str | Path | None = None) -> int:
    """Finished episodes the plan ledger holds that no observation recorded."""
    from .plan_convergence import events_file

    root = ensure_tools_dir_readonly(base_dir)
    if root is None or not events_file(root).is_file():
        return 0
    return len(_unrecorded_episodes(root))


def list_performance_observations(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """The current episodes, oldest first: one row per episode id (a row two
    racing lanes both appended counts once), minus every episode a later row
    superseded."""
    root = ensure_tools_dir_readonly(base_dir)
    unique: dict[str, dict[str, Any]] = {}
    for row in _performance_rows(root) if root is not None else []:
        unique.setdefault(str(row["episode_id"]), row)
    superseded = {row["supersedes"] for row in unique.values()}
    current = [row for row in unique.values() if row["episode_id"] not in superseded]
    return sorted(current, key=lambda row: str(row["occurred_at"]))


def recurring_failure_modes(
    *, base_dir: str | Path | None = None, role: str, subject: str | None,
    plan_ids: Collection[str] | None = None, threshold: int = LESSON_EPISODE_THRESHOLD,
) -> list[dict[str, Any]]:
    """The attributable failure modes ``subject`` hit in ``threshold`` or more
    current episodes of ``role`` — the input of the next actor's must-check.

    ``subject=None`` counts every subject of the role (a plan's outcome is the
    plan's, whoever drafted it); ``plan_ids`` limits the count to the episodes
    of those plans (ARIA-HIGH-309, the planner's scope). ARIA-HIGH-370 — a
    mode is counted per attributed role (``attributed_role``: the envelope
    role whose work the evidence named, ``role`` itself for a row recorded
    before attribution), so a challenger's refused output and the plan's own
    refusal are two lessons for two envelopes."""
    plans: dict[tuple[str, str], list[str]] = {}
    for row in list_performance_observations(base_dir=base_dir):
        if (row["role"] == role and (subject is None or row["subject"] == subject) and row["attributable"]
                and not row["success"] and (plan_ids is None or row["plan_id"] in plan_ids)):
            attributed = str((row.get("attribution") or {}).get("role") or role)
            plans.setdefault((str(row["failure_mode"]), attributed), []).append(str(row["plan_id"]))
    return [{"failure_mode": mode, "attributed_role": attributed, "episodes": len(ids), "plan_ids": sorted(ids)}
            for (mode, attributed), ids in sorted(plans.items()) if len(ids) >= threshold]


def _repeat_failures(episodes: list[dict[str, Any]], role: str) -> dict[str, Any]:
    seen: dict[str, int] = {}
    repeats = 0
    for row in episodes:
        if row["role"] == role and not row["success"]:
            mode = str(row["failure_mode"])
            repeats += 1 if mode in seen else 0
            seen[mode] = seen.get(mode, 0) + 1
    failures = sum(seen.values())
    # A ratio over no episodes is not zero, it is unmeasured: None.
    return {"failures": failures, "repeats": repeats, "rate": round(repeats / failures, 6) if failures else None,
            "by_failure_mode": dict(sorted(seen.items()))}


def _scorecard(episodes: list[dict[str, Any]], role: str) -> dict[str, dict[str, Any]]:
    cards: dict[str, dict[str, Any]] = {}
    for row in episodes:
        if row["role"] != role:
            continue
        card = cards.setdefault(str(row["subject"]), {"episodes": 0, "attributable": 0, "succeeded": 0, "outcomes": {}})
        card["episodes"] += 1
        card["outcomes"][row["outcome"]] = card["outcomes"].get(row["outcome"], 0) + 1
        card["attributable"] += 1 if row["attributable"] else 0
        card["succeeded"] += 1 if row["attributable"] and row["success"] else 0
    for card in cards.values():
        card["success_rate"] = round(card["succeeded"] / card["attributable"], 6) if card["attributable"] else None
    return cards


def performance_kpis(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """The learning KPIs the recorded episodes compute (K-10), and the ones
    they cannot, each with the missing evidence named."""
    episodes = list_performance_observations(base_dir=base_dir)
    return {
        "schema_version": 1,
        "episodes": len(episodes),
        "live": {
            "repeat_failure_rate": {role: _repeat_failures(episodes, role) for role in ("drafter", "implementer")},
            "drafter_scorecard": _scorecard(episodes, "drafter"),
            "implementer_scorecard": _scorecard(episodes, "implementer"),
        },
        "not_computable": dict(NOT_COMPUTABLE_KPIS),
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
    "compare_eval_windows",
    "MIN_RUNS_FOR_TREND",
    "count_eval_runs_by_mode",
    "sample_shadow_raw_findings",
    "PERFORMANCE_SURFACE",
    "PERFORMANCE_OBSERVED_KIND",
    "LESSON_EPISODE_THRESHOLD",
    "NOT_COMPUTABLE_KPIS",
    "observe_agent_performance",
    "unobserved_episode_count",
    "list_performance_observations",
    "recurring_failure_modes",
    "performance_kpis",
]
