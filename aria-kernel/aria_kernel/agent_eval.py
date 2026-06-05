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

from .ledger import append_jsonl, load_jsonl
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
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def _runs_path(tools_root: Path) -> Path:
    return tools_root.joinpath(*EVAL_RUNS_PATH)


def _fixtures_dir(tools_root: Path) -> Path:
    return tools_root.joinpath(*EVAL_FIXTURES_DIR)


def _agent_results_path(tools_root: Path) -> Path:
    return tools_root / "agent-invocations" / "results.jsonl"


def _agent_transcripts_path(tools_root: Path) -> Path:
    return tools_root / "agent-invocations" / "transcripts.jsonl"


def _sha256_payload(payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=str,
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _is_sha256_digest(value: Any) -> bool:
    return isinstance(value, str) and _SHA256_RE.match(value) is not None


def _require_sha256(value: Any, field: str) -> str:
    if not _is_sha256_digest(value):
        raise GovernanceError(f"{field}_must_be_sha256")
    return str(value)


def _require_nonempty_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GovernanceError(f"{field}_required")
    return value.strip()


def _fixture_hash_payload(fixture: dict[str, Any]) -> dict[str, Any]:
    return {
        k: v
        for k, v in fixture.items()
        if k not in {"recorded_at", "fixture_hash"}
    }


def _compute_fixture_hash(fixture: dict[str, Any]) -> str:
    canonical = json.dumps(
        _fixture_hash_payload(fixture),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()[:16]


def _verified_rows(path: Path, *, proof_name: str) -> list[dict[str, Any]]:
    try:
        return load_jsonl(path, verify=True)
    except Exception as exc:
        raise GovernanceError(f"{proof_name}_ledger_unverified: {exc}") from exc


def _fixture_provenance(
    fixture: dict[str, Any], *, proof_prefix: str = "real_eval"
) -> dict[str, str]:
    fixture_hash = _require_nonempty_str(
        fixture.get("fixture_hash"), f"{proof_prefix}_fixture_hash"
    )
    expected_hash = _compute_fixture_hash(fixture)
    if fixture_hash != expected_hash:
        raise GovernanceError(
            f"{proof_prefix}_fixture_hash_mismatch: "
            f"expected={expected_hash} actual={fixture_hash}"
        )
    pinned_commit = _require_nonempty_str(
        fixture.get("pinned_commit_sha"),
        f"{proof_prefix}_fixture_pinned_commit_sha",
    )
    input_envelope = fixture.get("input_envelope")
    if not isinstance(input_envelope, dict):
        raise GovernanceError(f"{proof_prefix}_fixture_input_envelope_required")
    request_id = _require_nonempty_str(
        input_envelope.get("request_id"), f"{proof_prefix}_fixture_request_id"
    )
    context_hash = _require_sha256(
        input_envelope.get("context_hash"),
        f"{proof_prefix}_fixture_context_hash",
    )
    prompt_hash = _require_sha256(
        input_envelope.get("prompt_hash"), f"{proof_prefix}_fixture_prompt_hash"
    )
    return {
        "fixture_hash": fixture_hash,
        "pinned_commit_sha": pinned_commit,
        "request_id": request_id,
        "context_hash": context_hash,
        "prompt_hash": prompt_hash,
    }


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

    fixture_hash = _compute_fixture_hash(fixture)
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


def _verify_real_eval_provenance(
    *,
    root: Path,
    fixture: dict[str, Any],
    envelope: dict[str, Any],
    invocation_id: str | None,
    transcript_hash: str | None,
    operator_approval_ref: str | None,
) -> dict[str, Any]:
    """Bind a real eval to the strict invocation result proof chain.

    cabbfc038 made accepted invocation results context-proof: accepted
    results carry context/prompt hashes, context/prompt ledger hashes,
    transcript_hash, and transcript_ledger_hash. Real eval must join to
    that accepted result and its transcript row. A detached envelope, even
    with an operator ref, is still a file feed and is not real eval proof.
    """
    if envelope.get("mock") is True or envelope.get("mock_mode") is True:
        raise GovernanceError("real_eval_mock_output_rejected")

    operator_ref = _require_nonempty_str(
        operator_approval_ref, "real_eval_operator_approval_ref"
    )
    request_id = _require_nonempty_str(invocation_id, "real_eval_invocation_id")
    transcript_digest = _require_sha256(
        transcript_hash, "real_eval_transcript_hash"
    )

    fixture_proof = _fixture_provenance(fixture)
    if fixture_proof["request_id"] != request_id:
        raise GovernanceError(
            "real_eval_fixture_invocation_mismatch: "
            f"fixture_request_id={fixture_proof['request_id']} "
            f"invocation_id={request_id}"
        )

    result_hash = _sha256_payload(envelope)
    results = _verified_rows(
        _agent_results_path(root), proof_name="real_eval_accepted_result"
    )
    accepted = [
        row
        for row in results
        if row.get("status") == "accepted"
        and row.get("request_id") == request_id
    ]
    if not accepted:
        raise GovernanceError(
            f"real_eval_accepted_result_not_found:{request_id}"
        )
    result_row = next(
        (
            row for row in reversed(accepted)
            if row.get("envelope_evidence_hash") == result_hash
        ),
        None,
    )
    if result_row is None:
        raise GovernanceError(
            "real_eval_envelope_not_bound_to_accepted_result: "
            f"invocation_id={request_id} envelope_hash={result_hash}"
        )
    result_ledger_hash = _require_sha256(
        result_row.get("ledger_hash"), "real_eval_result_ledger_hash"
    )
    if result_row.get("context_hash") != fixture_proof["context_hash"]:
        raise GovernanceError("real_eval_context_hash_mismatch")
    if result_row.get("prompt_hash") != fixture_proof["prompt_hash"]:
        raise GovernanceError("real_eval_prompt_hash_mismatch")
    context_ledger_hash = _require_sha256(
        result_row.get("context_ledger_hash"), "real_eval_context_ledger_hash"
    )
    prompt_ledger_hash = _require_sha256(
        result_row.get("prompt_ledger_hash"), "real_eval_prompt_ledger_hash"
    )
    if result_row.get("transcript_hash") != transcript_digest:
        raise GovernanceError("real_eval_transcript_hash_mismatch")
    transcript_ledger_hash = _require_sha256(
        result_row.get("transcript_ledger_hash"),
        "real_eval_transcript_ledger_hash",
    )

    transcripts = _verified_rows(
        _agent_transcripts_path(root), proof_name="real_eval_transcript"
    )
    transcript_row = next(
        (
            row for row in reversed(transcripts)
            if row.get("ledger_hash") == transcript_ledger_hash
        ),
        None,
    )
    if transcript_row is None:
        raise GovernanceError(
            f"real_eval_transcript_row_not_found:{transcript_ledger_hash}"
        )
    if transcript_row.get("transcript_hash") != transcript_digest:
        raise GovernanceError("real_eval_transcript_row_hash_mismatch")
    if transcript_row.get("invocation_id") != request_id:
        raise GovernanceError("real_eval_transcript_row_invocation_id_mismatch")
    for field in ("request_id", "claim_id", "agent_id"):
        if transcript_row.get(field) != result_row.get(field):
            raise GovernanceError(
                f"real_eval_transcript_row_{field}_mismatch"
            )
    _require_nonempty_str(
        transcript_row.get("artifact_ref"), "real_eval_transcript_artifact_ref"
    )

    return {
        "provenance_mode": "real_invocation",
        "proof_mode": "ledger_bound_accepted_result",
        "operator_approval_ref": operator_ref,
        "invocation_id": request_id,
        "transcript_hash": transcript_digest,
        "result_ledger_hash": result_ledger_hash,
        "result_envelope_hash": result_hash,
        "context_ledger_hash": context_ledger_hash,
        "prompt_ledger_hash": prompt_ledger_hash,
        "transcript_ledger_hash": transcript_ledger_hash,
        "fixture_hash": fixture_proof["fixture_hash"],
        "fixture_pinned_commit_sha": fixture_proof["pinned_commit_sha"],
    }


def verify_shadow_eval_proof(
    *,
    run_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Verify that a SHADOW eval/sample row has auditable provenance.

    SHADOW findings are not operator-facing by default, so proof mode must
    fail closed before a sampled SHADOW result can be treated as actionable.
    The run row must carry a shadow_provenance block joining:
    - the hash-chained SHADOW tool run row,
    - transcript_hash + transcript_ledger_hash,
    - operator_approval_ref,
    - fixture_id + fixture_hash + fixture context/prompt hashes.
    """
    from .tool_health import runs_path
    from .tool_registry import get_tool

    root = ensure_tools_dir(base_dir)
    target_run_id = _require_nonempty_str(run_id, "shadow_eval_run_id")
    runs = _verified_rows(runs_path(root), proof_name="shadow_eval_run")
    run = next(
        (row for row in reversed(runs) if row.get("run_id") == target_run_id),
        None,
    )
    if run is None:
        raise GovernanceError(f"shadow_eval_run_not_found:{target_run_id}")
    run_ledger_hash = _require_sha256(
        run.get("ledger_hash"), "shadow_eval_run_ledger_hash"
    )
    tool_id = _require_nonempty_str(run.get("tool_id"), "shadow_eval_tool_id")
    tool = get_tool(tool_id, root)
    if tool.get("status") != "SHADOW":
        raise GovernanceError(
            f"shadow_eval_tool_not_shadow:{tool_id}:{tool.get('status')}"
        )

    provenance = run.get("shadow_provenance")
    if not isinstance(provenance, dict):
        raise GovernanceError("shadow_eval_provenance_required")
    operator_ref = _require_nonempty_str(
        provenance.get("operator_approval_ref"),
        "shadow_eval_operator_approval_ref",
    )
    fixture_id = _require_nonempty_str(
        provenance.get("fixture_id"), "shadow_eval_fixture_id"
    )
    fixture_hash = _require_nonempty_str(
        provenance.get("fixture_hash"), "shadow_eval_fixture_hash"
    )
    context_hash = _require_sha256(
        provenance.get("context_hash"), "shadow_eval_context_hash"
    )
    prompt_hash = _require_sha256(
        provenance.get("prompt_hash"), "shadow_eval_prompt_hash"
    )
    transcript_hash = _require_sha256(
        provenance.get("transcript_hash"), "shadow_eval_transcript_hash"
    )
    transcript_ledger_hash = _require_sha256(
        provenance.get("transcript_ledger_hash"),
        "shadow_eval_transcript_ledger_hash",
    )

    fixture = _read_fixture(fixture_id=fixture_id, base_dir=root)
    fixture_proof = _fixture_provenance(fixture, proof_prefix="shadow_eval")
    if fixture_hash != fixture_proof["fixture_hash"]:
        raise GovernanceError("shadow_eval_run_fixture_hash_mismatch")
    if context_hash != fixture_proof["context_hash"]:
        raise GovernanceError("shadow_eval_context_hash_mismatch")
    if prompt_hash != fixture_proof["prompt_hash"]:
        raise GovernanceError("shadow_eval_prompt_hash_mismatch")

    transcripts = _verified_rows(
        _agent_transcripts_path(root), proof_name="shadow_eval_transcript"
    )
    transcript_row = next(
        (
            row for row in reversed(transcripts)
            if row.get("ledger_hash") == transcript_ledger_hash
        ),
        None,
    )
    if transcript_row is None:
        raise GovernanceError(
            f"shadow_eval_transcript_row_not_found:{transcript_ledger_hash}"
        )
    if transcript_row.get("transcript_hash") != transcript_hash:
        raise GovernanceError("shadow_eval_transcript_row_hash_mismatch")
    if transcript_row.get("invocation_id") != fixture_proof["request_id"]:
        raise GovernanceError("shadow_eval_transcript_row_invocation_id_mismatch")
    if transcript_row.get("request_id") != fixture_proof["request_id"]:
        raise GovernanceError("shadow_eval_fixture_transcript_request_mismatch")
    _require_nonempty_str(
        transcript_row.get("artifact_ref"), "shadow_eval_transcript_artifact_ref"
    )

    return {
        "verified": True,
        "run_id": target_run_id,
        "tool_id": tool_id,
        "run_ledger_hash": run_ledger_hash,
        "operator_approval_ref": operator_ref,
        "fixture_id": fixture_id,
        "fixture_hash": fixture_hash,
        "context_hash": context_hash,
        "prompt_hash": prompt_hash,
        "transcript_hash": transcript_hash,
        "transcript_ledger_hash": transcript_ledger_hash,
    }


def run_agent_eval(
    *,
    fixture_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    mock_mode: bool = True,
    real_response_envelope: dict[str, Any] | None = None,
    # Plan 023 v3 §A-8 + cabbfc038 — real-mode provenance binding.
    # Real-mode runs require an invocation_id, transcript_hash, operator
    # approval ref, a ledger-bound accepted result row, and the transcript
    # ledger row referenced by that result. allow_legacy_envelope_feed is
    # retained only as a compatibility marker; it does not bypass proof.
    invocation_id: str | None = None,
    transcript_hash: str | None = None,
    allow_legacy_envelope_feed: bool = False,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    """Run an agent against a fixture; record pass/fail to runs.jsonl.

    mock_mode True (default): synthesise a deterministic envelope matching
    the fixture's expected verdict + evidence. Used for kernel pipeline
    coverage when DEBT-2026-05-08-001 (OAuth contract closure) is open.

    mock_mode False: caller MUST pass real_response_envelope and prove it
    is the same envelope accepted in agent-invocations/results.jsonl with
    joined transcript, operator, and fixture/context provenance. Real-mode
    runs increment the aria_agent_eval_real_total counter; mock-mode runs
    increment aria_agent_eval_mock_only_total. The two streams stay
    segregated forever — historical mock data does not contaminate
    real-mode aggregates and vice versa.

    Pass criteria (Plan v3.3 §Phase 6.A):
    - response.verdict_class == fixture.expected_verdict_class.
    - response.evidence_refs is a SUPERSET of fixture.expected_evidence_refs.
    """
    enforce_profile_for_write("agent_evals", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    fixture = _read_fixture(fixture_id=fixture_id, base_dir=root)
    provenance: dict[str, Any] = {
        "provenance_mode": "mock",
        "proof_mode": "mock",
        "operator_approval_ref": None,
        "invocation_id": None,
        "transcript_hash": None,
        "result_ledger_hash": None,
        "result_envelope_hash": None,
        "context_ledger_hash": None,
        "prompt_ledger_hash": None,
        "transcript_ledger_hash": None,
        "fixture_hash": fixture.get("fixture_hash"),
        "fixture_pinned_commit_sha": fixture.get("pinned_commit_sha"),
    }

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
        provenance = _verify_real_eval_provenance(
            root=root,
            fixture=fixture,
            envelope=envelope,
            invocation_id=invocation_id,
            transcript_hash=transcript_hash,
            operator_approval_ref=operator_approval_ref,
        )
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
        "invocation_id": provenance["invocation_id"],
        "transcript_hash": provenance["transcript_hash"],
        "provenance_mode": provenance["provenance_mode"],
        "proof_mode": provenance["proof_mode"],
        "operator_approval_ref": provenance["operator_approval_ref"],
        "result_ledger_hash": provenance["result_ledger_hash"],
        "result_envelope_hash": provenance["result_envelope_hash"],
        "context_ledger_hash": provenance["context_ledger_hash"],
        "prompt_ledger_hash": provenance["prompt_ledger_hash"],
        "transcript_ledger_hash": provenance["transcript_ledger_hash"],
        "fixture_hash": provenance["fixture_hash"],
        "fixture_pinned_commit_sha": provenance["fixture_pinned_commit_sha"],
        "legacy_envelope_feed_requested": bool(allow_legacy_envelope_feed),
    }

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
            "proof_mode": run_row["proof_mode"],
            "result_ledger_hash": run_row["result_ledger_hash"],
            "transcript_ledger_hash": run_row["transcript_ledger_hash"],
            "fixture_hash": run_row["fixture_hash"],
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
    "verify_shadow_eval_proof",
    "sample_shadow_raw_findings",
]
