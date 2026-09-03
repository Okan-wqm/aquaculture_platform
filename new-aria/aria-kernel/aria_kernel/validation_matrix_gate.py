"""Plan 020 Phase 8 — validation matrix gate (risk-type-driven 3-layer enforcement).

WHY this module exists
----------------------
Pre-Plan-020 the change ledger validated chain was opt-in: `change_validated`
required `validation_run_refs` to be non-empty but did not enforce that the
refs actually targeted the risk class implied by the diff. An auth change
could land with a string ref like 'nx test:run-1' that targeted only an
unrelated unit; the chain looked closed but the security-critical path was
never exercised.

Operator gap #3 (Plan v3.3 §Phase 8): risk-type-driven test matrix with
three enforcement layers:

1. EXISTENCE  — required test files exist on disk.
2. PATTERN    — required test files contain the regex matching the
                risk class (e.g. cross-tenant negative test mentions
                `expect(...).rejects.toThrow.*tenant`).
3. RUN-PASS   — structured validation_run_refs (cmd + exit_code 0 + log_path
                + ran_at) prove the tests were EXECUTED.

All three layers must pass for change_validated to land in 'enforced' mode.
'historical_attestation' mode (Plan 019 backfill) bypasses the matrix
gate — those rows are audit trail only and do NOT count toward
aria_change_chain_validation_pct (Phase 9 metric).

4 risk types (Plan v3.3 §Phase 8.A)
------------------------------------
- auth_change      — apps/auth-service/, *.guard.ts, *.strategy.ts
                     required: @UseGuards test, JWT tenant-source negative
                     test, public_endpoint allowlist test.
- tenant_change    — tenant-context-middleware, *.tenant.repository.ts,
                     getScopedRepository callers
                     required: cross-tenant access negative test, scoped
                     repo unit test, RLS policy test.
- schema_change    — *.entity.ts, */migrations/*.ts
                     required: migration parity test, ADR-011 schema
                     invariant, blue-green safety (nullable → backfill →
                     NOT NULL) markers.
- event_change     — libs/event-contracts/src/**
                     required: JSON Schema validator test, upcaster test,
                     outbox transactional test, NATS publish test.

Path traversal heuristics intentionally use containment matches; a file
path that satisfies multiple heuristics surfaces as multiple risk types
so the matrix enforces them all.

Plan 020 surface gate
---------------------
validation_matrix is a writer-surface label (not a dedicated ledger file).
The gate emits a `validation_matrix_check` governance event + the gate
result is the load-bearing input that `change_ledger.emit_change_validated`
consumes before persisting the validated row. Frozen profile blocks the
write via enforce_profile_for_write('validation_matrix', ...).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
)

# Risk-type taxonomy locked per Plan v3.3 §Phase 8.A.
RISK_TYPES: tuple[str, ...] = (
    "auth_change",
    "tenant_change",
    "schema_change",
    "event_change",
)

# validation_mode locks: enforced (Plan 020+ default; gate fires) vs
# historical_attestation (Plan 019 backfill; audit trail only, no
# matrix gate). Phase 9 metric counter aria_change_chain_validation_pct
# only counts enforced rows in its numerator.
VALIDATION_MODES: tuple[str, ...] = (
    "enforced",
    "historical_attestation",
)
DEFAULT_VALIDATION_MODE: str = "enforced"

# Path heuristics for risk-type detection.
# Order is fixed so an audit reviewer can predict which risk types fire
# for a given file path. A file path may satisfy multiple heuristics —
# the matrix enforces every implicated risk class.
_RISK_PATH_HEURISTICS: dict[str, tuple[re.Pattern[str], ...]] = {
    "auth_change": (
        re.compile(r"^apps/auth-service/"),
        re.compile(r"\.guard\.ts$"),
        re.compile(r"\.strategy\.ts$"),
        re.compile(r"jwt[\-_]middleware|tenant[\-_]context[\-_]middleware"),
    ),
    "tenant_change": (
        re.compile(r"tenant[-_]context[-_]middleware"),
        re.compile(r"\.tenant\.repository\.ts$"),
        re.compile(r"getScopedRepository"),
    ),
    "schema_change": (
        re.compile(r"\.entity\.ts$"),
        re.compile(r"/migrations/.*\.ts$"),
    ),
    "event_change": (
        re.compile(r"^libs/event-contracts/src/"),
        re.compile(r"^platform/libs/event-contracts/src/"),
    ),
}

# Required-test patterns per risk type.
# Existence: at least one repo path containing the substring.
# Pattern: the matched files must contain the regex.
_REQUIRED_TESTS_BY_RISK: dict[str, tuple[dict[str, Any], ...]] = {
    "auth_change": (
        # Plan 023 v3 §R-3 — expected_cmd_substring binds the required
        # test to the validation_run_ref that satisfies it. Pre-fix
        # any run_ref with exit_code=0 satisfied any required test;
        # `cmd: "echo ok"` cleared the gate even when nx test
        # auth-service was the test that should have run. Post-fix:
        # _check_required_test_cmd_correlation requires at least one
        # run_ref whose cmd contains the expected_cmd_substring.
        {"name": "use_guards_test",
         "path_substr": "apps/auth-service",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test auth-service",
         "regex": re.compile(r"@UseGuards\(|UseGuards\(")},
        {"name": "jwt_tenant_source_negative",
         "path_substr": "apps/auth-service",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test auth-service",
         "regex": re.compile(r"tenant[-_]?(claim|source).*reject|reject.*tenant", re.I)},
        {"name": "public_endpoint_allowlist",
         "path_substr": "apps/auth-service",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test auth-service",
         "regex": re.compile(r"public[-_]?endpoint|allowlist", re.I)},
    ),
    "tenant_change": (
        # Plan 023 v3.1 §R-3-followup — expected_cmd_substring populated
        # for all tenant_change required tests so the cmd-correlation
        # gate fires (not only auth_change as in Plan 023 v3 first pass).
        {"name": "cross_tenant_access_negative",
         "path_substr": "apps/",
         "path_glob": "**/__tests__/**/*.spec.ts",
         "expected_cmd_substring": "nx affected --target=test",
         "regex": re.compile(r"cross[-_]?tenant|expect.*rejects.*tenant", re.I)},
        {"name": "scoped_repository_unit",
         "path_substr": "libs/backend-common",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test backend-common",
         "regex": re.compile(r"getScopedRepository|scoped[-_]repository", re.I)},
        {"name": "rls_policy_test",
         "path_substr": "apps/",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx affected --target=test",
         "regex": re.compile(r"row[-_]level[-_]security|RLS|rls[-_]policy", re.I)},
    ),
    "schema_change": (
        # Plan 023 v3.1 §R-3-followup — expected_cmd_substring populated.
        {"name": "migration_parity_test",
         "path_substr": "e2e/tests/integration",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "schema-invariants",
         "regex": re.compile(r"migration[-_]parity|schema[-_]invariants", re.I)},
        {"name": "adr_011_schema_invariant",
         "path_substr": "e2e/tests/integration",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "schema-invariants",
         "regex": re.compile(r"schema[-_]invariants?\.spec|@Entity.*schema", re.I)},
        {"name": "blue_green_safety_marker",
         "path_substr": "apps/",
         "path_glob": "**/migrations/*.ts",
         "expected_cmd_substring": "nx affected --target=test",
         "regex": re.compile(r"nullable|isNullable|backfill|NOT NULL|notNull", re.I)},
    ),
    "event_change": (
        # Plan 023 v3.1 §R-3-followup — expected_cmd_substring populated.
        {"name": "json_schema_validator_test",
         "path_substr": "libs/event-contracts",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test event-contracts",
         "regex": re.compile(r"validate|schema", re.I)},
        {"name": "upcaster_test",
         "path_substr": "libs/event-contracts",
         "path_glob": "**/upcasters/**/*.spec.ts",
         "expected_cmd_substring": "nx test event-contracts",
         "regex": re.compile(r"upcast", re.I)},
        {"name": "outbox_transactional_test",
         "path_substr": "platform/libs/outbox",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test outbox",
         "regex": re.compile(r"transactional|outbox", re.I)},
        {"name": "nats_publish_test",
         "path_substr": "platform/libs/event-bus",
         "path_glob": "**/*.spec.ts",
         "expected_cmd_substring": "nx test event-bus",
         "regex": re.compile(r"publish|nats", re.I)},
    ),
}


# Plan 031 Gate A — regression-anchor patterns.
# An autonomous fix MUST leave at least one durable test/fixture in its diff,
# regardless of risk type. This is the load-bearing "every autonomous fix
# leaves a regression test" guarantee: the deterministic floor under autonomy
# when the operator cannot be the code-correctness reviewer. The patterns cover
# both the TS/JS suite layout (__tests__, *.spec.*, *.test.*) and the Python
# kernel suite (test_*.py, *_test.py, tests/ dirs) plus fixture corpora
# (fixture_set/cases/*.json). Containment/regex matches — same heuristic style
# as the risk-path detector above.
_REGRESSION_ANCHOR_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(^|/)__tests__/"),
    re.compile(r"\.spec\.[cm]?[jt]sx?$"),
    re.compile(r"\.test\.[cm]?[jt]sx?$"),
    re.compile(r"(^|/)test_[^/]+\.py$"),
    re.compile(r"(^|/)[^/]+_test\.py$"),
    re.compile(r"(^|/)tests?/"),
    re.compile(r"fixture", re.I),
)


def has_regression_anchor(files: list[str]) -> bool:
    """Plan 031 Gate A — True iff ≥1 affected file is a test/fixture path.

    The single source of truth for "this diff leaves a regression anchor".
    Used by ``enforce_validation_matrix`` under ``require_regression_anchor``
    and reusable by any caller that needs the same determination.
    """
    return any(
        any(pattern.search(f) for pattern in _REGRESSION_ANCHOR_PATTERNS)
        for f in files
    )


def _resolve_affected_files(
    *,
    change_id: str,
    base_dir: str | Path | None,
    affected_files_override: list[str] | None,
) -> list[str]:
    """Resolve a change's affected files (override wins; else committed row).

    Mirrors the resolution inside ``detect_risk_types_for_change`` so the
    regression-anchor gate and the risk detector read the SAME file list from
    one lookup instead of fetching the change chain twice.
    """
    if affected_files_override is not None:
        return list(affected_files_override)
    from .change_ledger import get_change_chain
    chain = get_change_chain(change_id=change_id, base_dir=base_dir)
    committed = chain.get("committed") or {}
    return list(committed.get("actual_affected_files") or [])


def list_required_tests(risk_types: list[str]) -> list[dict[str, Any]]:
    """Return the union of required-test specs for the given risk types.

    Plan 024 v3 §B-5 — projection now preserves ``expected_cmd_substring``
    end-to-end. Pre-fix this function omitted the field during
    serialisation, so the downstream consumer
    ``_check_required_test_cmd_correlation`` saw None on
    ``spec.get('expected_cmd_substring')`` and silent-skipped every
    correlation check. ``cmd: 'echo ok'`` then satisfied any required
    test in production. Post-fix: the field travels every hop from
    ``_REQUIRED_TESTS_BY_RISK`` → projection → ``enforce_validation_-
    matrix`` → ``_check_required_test_cmd_correlation`` and a
    runtime guard surfaces drift in the spec table at first call.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rt in risk_types:
        for spec in _REQUIRED_TESTS_BY_RISK.get(rt, ()):
            key = f"{rt}:{spec['name']}"
            if key in seen:
                continue
            seen.add(key)
            substr = spec.get("expected_cmd_substring")
            if not isinstance(substr, str) or not substr.strip():
                # Plan 024 v3 §B-5 — fail-loud at the projection so a
                # future spec edit that drops the field cannot
                # silently re-open the bypass.
                raise GovernanceError(
                    f"required_test_spec_missing_expected_cmd_substring: "
                    f"{rt}/{spec.get('name')!r}"
                )
            out.append({
                "risk_type": rt,
                "name": spec["name"],
                "path_substr": spec["path_substr"],
                "path_glob": spec["path_glob"],
                "regex_pattern": spec["regex"].pattern,
                "expected_cmd_substring": substr,
            })
    return out


def detect_risk_types_for_change(
    *,
    change_id: str,
    base_dir: str | Path | None = None,
    affected_files_override: list[str] | None = None,
) -> list[str]:
    """Inspect a change_committed row for affected_files; detect risk types.

    Use affected_files_override to bypass change_ledger lookup (smoke tests).
    """
    if affected_files_override is not None:
        files = list(affected_files_override)
    else:
        from .change_ledger import get_change_chain
        chain = get_change_chain(change_id=change_id, base_dir=base_dir)
        committed = chain.get("committed") or {}
        files = list(committed.get("actual_affected_files") or [])
    detected: list[str] = []
    for rt in RISK_TYPES:
        for pattern in _RISK_PATH_HEURISTICS[rt]:
            if any(pattern.search(f) for f in files):
                detected.append(rt)
                break
    return detected


def _check_existence_layer(
    *,
    repo_root: Path,
    spec: dict[str, Any],
) -> tuple[bool, list[str]]:
    """Layer 1: at least one file matching path_substr + path_glob exists."""
    matches: list[str] = []
    if not repo_root.exists():
        return False, []
    for path in repo_root.glob(spec["path_glob"]):
        rel = path.relative_to(repo_root).as_posix()
        if spec["path_substr"] in rel:
            matches.append(rel)
    return bool(matches), matches


def _check_pattern_layer(
    *,
    repo_root: Path,
    spec: dict[str, Any],
    files: list[str],
) -> tuple[bool, list[str]]:
    """Layer 2: at least one of the matched files contains the regex."""
    pattern: re.Pattern[str] = spec["regex"]
    hits: list[str] = []
    for rel in files:
        path = repo_root / rel
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if pattern.search(content):
            hits.append(rel)
    return bool(hits), hits


def _check_required_test_cmd_correlation(
    *,
    required_tests: list[dict[str, Any]],
    candidate_refs: list[Any],
) -> list[str]:
    """Plan 023 v3 §R-3 — bind required test to validation_run_ref via
    expected_cmd_substring.

    Pre-Plan-023 _check_run_pass_layer accepted any run_ref with
    exit_code=0 as proof of "structured RUN-PASS". A cmd like
    'echo ok' satisfied required tests like 'nx test auth-service'
    because the validator never compared the cmd that ran to the cmd
    that SHOULD HAVE RUN.

    Post-fix: each required test gains an optional
    expected_cmd_substring field. When present, the validator
    requires at least one validation_run_ref whose cmd field contains
    the substring. Mismatches surface as
    'validation_run_ref_does_not_match_required_test_cmd' failures.

    Required tests without expected_cmd_substring are not yet
    enforced (legacy fallback so this fix is additive — future plan
    iterations migrate the rest of the spec table).
    """
    # Plan 024 v3 §B-5 — every spec now carries expected_cmd_substring
    # (the projection guard at list_required_tests guarantees this).
    # Field-missing → fail-loud, not silent-skip. Legacy fallback removed.
    failures: list[str] = []
    cmds: list[str] = []
    for ref in candidate_refs:
        if isinstance(ref, dict) and isinstance(ref.get("cmd"), str):
            cmds.append(ref["cmd"])
    for spec in required_tests:
        substring = spec.get("expected_cmd_substring")
        if not isinstance(substring, str) or not substring.strip():
            raise GovernanceError(
                f"validation_matrix_spec_missing_cmd_correlation_field: "
                f"{spec.get('risk_type')}/{spec.get('name')}"
            )
        if not any(substring in cmd for cmd in cmds):
            failures.append(
                f"validation_run_ref_does_not_match_required_test_cmd: "
                f"required test {spec.get('name')!r} expects cmd "
                f"containing {substring!r}; no candidate ref's cmd matched"
            )
    return failures


def _check_run_pass_layer(
    *,
    candidate_refs: list[Any],
) -> tuple[bool, list[dict[str, Any]], list[str]]:
    """Layer 3: structured validation_run_refs prove EXECUTION + zero exit."""
    failed: list[str] = []
    structured: list[dict[str, Any]] = []
    for ref in candidate_refs:
        if isinstance(ref, str):
            failed.append(f"string-only ref not permitted under enforced mode: {ref!r}")
            continue
        if not isinstance(ref, dict):
            failed.append(f"unexpected ref shape: {type(ref).__name__}")
            continue
        cmd = ref.get("cmd")
        exit_code = ref.get("exit_code")
        log_path = ref.get("log_path")
        ran_at = ref.get("ran_at")
        if not isinstance(cmd, str) or not cmd:
            failed.append(f"ref missing 'cmd': {ref!r}")
            continue
        if not isinstance(exit_code, int):
            failed.append(f"ref missing 'exit_code' (int): {ref!r}")
            continue
        if exit_code != 0:
            failed.append(f"ref exit_code != 0: cmd={cmd!r} exit={exit_code}")
            continue
        if not isinstance(log_path, str):
            failed.append(f"ref missing 'log_path': {ref!r}")
            continue
        if not isinstance(ran_at, str):
            failed.append(f"ref missing 'ran_at' ISO timestamp: {ref!r}")
            continue
        try:
            datetime.fromisoformat(ran_at.replace("Z", "+00:00"))
        except ValueError:
            failed.append(f"ref ran_at not ISO8601: {ran_at!r}")
            continue
        structured.append({
            "cmd": cmd, "exit_code": exit_code,
            "log_path": log_path, "ran_at": ran_at,
        })
    return (not failed and bool(structured)), structured, failed


def enforce_validation_matrix(
    *,
    change_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    candidate_refs: list[Any],
    affected_files_override: list[str] | None = None,
    validation_mode: str = DEFAULT_VALIDATION_MODE,
    require_regression_anchor: bool = False,
) -> dict[str, Any]:
    """3-layer matrix gate. Returns {passed, blocked, ...detail}.

    enforced mode: ALL three layers must pass. Returns blocked=True with
    missing_required_tests + failed_runs detail when any layer fails.
    Emits validation_matrix_check governance event with pass/blocked
    breakdown.

    historical_attestation mode: bypasses the matrix gate entirely; returns
    passed=True with a notice that the row will be audit-only (Phase 9
    metric counter excludes historical chains from the numerator).

    Plan 031 Gate A: when ``require_regression_anchor`` is True (the cycle's
    autonomous-fix path sets it), the diff MUST include at least one
    test/fixture file or the gate blocks before any risk-type branch — the
    deterministic "every autonomous fix leaves a regression test" floor.
    Bypassed under ``historical_attestation`` (audit-only replay).
    """
    if validation_mode not in VALIDATION_MODES:
        raise GovernanceError(
            f"unknown validation_mode {validation_mode!r}; expected one of {VALIDATION_MODES}"
        )

    enforce_profile_for_write("validation_matrix", base_dir=base_dir)

    repo = Path(repo_root or Path.cwd()).resolve()
    affected_files = _resolve_affected_files(
        change_id=change_id, base_dir=base_dir,
        affected_files_override=affected_files_override,
    )

    # Plan 031 Gate A — regression-anchor precondition (enforced mode only).
    # Tier-1 "make it impossible": an autonomous fix cannot reach
    # change_validated without leaving a durable test/fixture in its diff.
    if (
        require_regression_anchor
        and validation_mode == "enforced"
        and not has_regression_anchor(affected_files)
    ):
        blocked = {
            "change_id": change_id,
            "validation_mode": validation_mode,
            "passed": False,
            "blocked": True,
            "reason": "regression_anchor_required",
            "affected_files": affected_files,
        }
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "validation_matrix_check",
            {**blocked, "trigger": "regression_anchor_missing"},
        )
        raise GovernanceError(
            f"regression_anchor_required: change_id={change_id!r} affected "
            f"{len(affected_files)} file(s) but none is a test/fixture path; "
            f"every autonomous fix must leave a durable regression test"
        )

    risk_types = detect_risk_types_for_change(
        change_id=change_id, base_dir=base_dir,
        affected_files_override=affected_files,
    )

    if validation_mode == "historical_attestation":
        result = {
            "change_id": change_id,
            "validation_mode": validation_mode,
            "passed": True,
            "blocked": False,
            "risk_types": risk_types,
            "notice": "historical_attestation mode — matrix gate bypassed; row excluded from validation_pct numerator",
        }
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "validation_matrix_check",
            {**result, "trigger": "historical_attestation"},
        )
        return result

    if not risk_types:
        # Plan 026R §D.5 — under ``enforced`` mode + zero risk types
        # the matrix MUST STILL check that at least one verified
        # validation_run_ref backs the change. Pre-§D.5 the no-risk
        # path returned ``passed: True`` vacuously, which let a
        # change ship with ZERO test evidence as long as the
        # detector flagged no risk types. The ``historical_attestation``
        # mode preserves the vacuous-pass for legacy chain replay
        # (handled at line 432).
        from .validation_runs_ledger import (
            list_validation_runs_for_change,
            verify_validation_run,
        )
        runs = list_validation_runs_for_change(
            change_id, base_dir=base_dir,
        )
        verified_runs: list[str] = []
        verify_errors: list[str] = []
        for run in runs:
            run_id = str(run.get("validation_run_id") or "")
            try:
                verify_validation_run(run_id, base_dir=base_dir)
                verified_runs.append(run_id)
            except GovernanceError as exc:
                verify_errors.append(f"{run_id}: {exc}")
        if not verified_runs:
            blocked = {
                "change_id": change_id,
                "validation_mode": validation_mode,
                "passed": False,
                "blocked": True,
                "risk_types": [],
                "reason": "no_risk_evidence_required",
                "verify_errors": verify_errors,
            }
            append_tools_governance(
                ensure_tools_dir(base_dir),
                "validation_matrix_check",
                {**blocked, "trigger": "no_risk_types_empty_evidence"},
            )
            raise GovernanceError(
                f"no_risk_evidence_required: change_id={change_id!r} "
                f"has zero verified validation_run rows; enforced mode "
                f"requires at least one verified validation_run even "
                f"when risk_types is empty"
            )
        result = {
            "change_id": change_id,
            "validation_mode": validation_mode,
            "passed": True,
            "blocked": False,
            "risk_types": [],
            "verified_validation_run_ids": verified_runs,
            "notice": "no risk-type-implicating files in change diff; verified evidence present",
        }
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "validation_matrix_check",
            {**result, "trigger": "no_risk_types_verified"},
        )
        return result

    required = list_required_tests(risk_types)
    layer_results: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for spec_summary in required:
        # Resolve the underlying spec (with compiled regex) for layer 2.
        spec = next(
            s for s in _REQUIRED_TESTS_BY_RISK[spec_summary["risk_type"]]
            if s["name"] == spec_summary["name"]
        )
        existence_passed, existence_files = _check_existence_layer(
            repo_root=repo, spec=spec,
        )
        if not existence_passed:
            layer_results.append({**spec_summary, "existence_passed": False, "pattern_passed": False})
            missing.append({**spec_summary, "reason": "existence_layer_failed"})
            continue
        pattern_passed, pattern_files = _check_pattern_layer(
            repo_root=repo, spec=spec, files=existence_files,
        )
        if not pattern_passed:
            layer_results.append({
                **spec_summary, "existence_passed": True, "pattern_passed": False,
                "existence_files": existence_files,
            })
            missing.append({**spec_summary, "reason": "pattern_layer_failed",
                            "candidates": existence_files})
            continue
        layer_results.append({
            **spec_summary, "existence_passed": True, "pattern_passed": True,
            "matched_files": pattern_files,
        })

    run_passed, structured_refs, failed_runs = _check_run_pass_layer(
        candidate_refs=candidate_refs,
    )

    # Plan 023 v3 §R-3 — required-test ↔ run_ref cmd correlation. The
    # run-pass layer above only enforces that EVERY ref is structured
    # + zero-exit; this additional pass enforces that for each
    # required test with an expected_cmd_substring, at least ONE ref's
    # cmd actually matches. Pre-fix `cmd: 'echo ok'` cleared the gate
    # for any required test.
    cmd_correlation_failures = _check_required_test_cmd_correlation(
        required_tests=required, candidate_refs=candidate_refs,
    )
    if cmd_correlation_failures:
        run_passed = False
        failed_runs.extend(cmd_correlation_failures)

    blocked = bool(missing) or not run_passed
    result = {
        "change_id": change_id,
        "validation_mode": validation_mode,
        "risk_types": risk_types,
        "required_tests": required,
        "layer_results": layer_results,
        "missing_required_tests": missing,
        "structured_validation_run_refs": structured_refs,
        "failed_runs": failed_runs,
        "passed": not blocked,
        "blocked": blocked,
    }

    append_tools_governance(
        ensure_tools_dir(base_dir),
        "validation_matrix_check",
        {
            "change_id": change_id,
            "risk_types": risk_types,
            "missing_count": len(missing),
            "failed_run_count": len(failed_runs),
            "passed": not blocked,
            "blocked": blocked,
        },
    )

    if blocked:
        raise GovernanceError(
            f"validation_matrix_blocked: change_id={change_id!r} "
            f"missing={[m['name'] for m in missing]} "
            f"failed_runs={failed_runs}"
        )
    return result


__all__ = [
    "RISK_TYPES",
    "VALIDATION_MODES",
    "DEFAULT_VALIDATION_MODE",
    "list_required_tests",
    "detect_risk_types_for_change",
    "enforce_validation_matrix",
    "has_regression_anchor",
]
