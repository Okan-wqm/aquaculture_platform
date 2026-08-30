from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .evidence_trust import EvidencePolicy, classify_evidence_ref
from .tool_health import SELF_OUTPUT_MARKERS, find_scope_violations, normalize_path
from .tool_registry import GovernanceError
from .snapshot import snapshot_allowed_set
from .ledger import load_declared_jsonl


# Plan 016 Faz C7 — agent response evidence revalidation regex.
# Why a separate path-parser: agent envelopes ship refs as plain strings
# ("apps/foo.ts:42") whereas tool output uses {path, line} dicts. We keep
# the existing dict-based validator unchanged for backward compatibility
# and add a string-aware revalidator below.
#
# ORPHAN-HIGH-081 (2026-05-18) — the previous pattern
#     ^(?P<path>[^\s:][^\s:]*(?:[^\s:][^\s:]*)*?)(?::(?P<line>\d+))?$
# was a textbook catastrophic-backtracking shape: `[^\s:][^\s:]*(?:[^\s:][^\s:]*)*?`
# reduces to `X+(X+)*?` with the same character class repeated in overlapping
# groups. On any rejected input (e.g. plan_synthesizer's `path:line:content`
# format, which adds a SECOND colon the regex never expected), the engine
# explores 2^N partitions of the path before failing. Benchmarked: a 29-char
# rejected input exceeds 2 seconds; a 49-char rejected input (typical kernel
# paths) burns ~120 seconds at 100% CPU — exactly the submit_claim_result
# hang observed during V8 verification.
#
# The replacement below matches the canonical evidence-ref languages
# (path | path:line | path:line:content) with no overlapping
# quantifiers. Worst-case time stays linear in input length even for
# pathological inputs that the pre-V8.3 ReDoS pattern hung on.
#
# Plan ARIA-V8.6 — accept the third `path:line:content` form. The
# `plan_synthesizer` (V7.9) emits evidence_refs as
# `path:line:<excerpt>` triplets so operators can spot-check the
# claimed line text without opening every file. The pre-V8.6 regex
# rejected those refs as malformed because it only allowed the
# 2-part `path:line` form, so the agent's response evidence_refs
# (which echo the request's refs) hit `agent_evidence_ref_malformed`
# at the kernel validator. The `(?::.*)?` clause captures the
# trailing `:<excerpt>` non-greedily without backtracking risk
# (atomic alternation; the path group is anchored by `[^\s:]+`).
_AGENT_REF_RE = re.compile(r"^(?P<path>[^\s:]+)(?::(?P<line>\d+)(?::.*)?)?$")


def validate_tool_output_evidence(
    tool: dict[str, Any],
    output: dict[str, Any],
    workspace_root: str | Path,
    repo_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    errors: list[dict[str, Any]] = []
    checked_sources: list[str] = []
    evidence_envelopes: list[dict[str, Any]] = []
    allowed_paths = snapshot_allowed_set(repo_snapshot)
    target_sha = _snapshot_target_sha(repo_snapshot)
    require_repo_verified = _snapshot_requires_repo_verified(repo_snapshot)

    # Plan 023 v3 §C-2 — distinguish "read_paths not in envelope" (None
    # from .get on an absent key) from "read_paths declared empty" (a
    # list of length zero). Pre-Plan-023 a `.get("read_paths", [])`
    # default merged the two cases: the runtime never knew whether the
    # tool actually declared "I read nothing" vs forgot the field, and
    # the subset enforcement loop below was further gated on the
    # truthiness of the derived `declared_read_paths` set, so an empty
    # list silently bypassed the subset check. Plan 023 v3 §C-2 +
    # Plan 022 §M-2 together: shape check (read_paths is a list, even
    # empty) gates subset enforcement; missing key surfaces a specific
    # error code distinct from non-array.
    raw_read_paths: Any = output.get("read_paths") if isinstance(output, dict) else None
    declared_read_paths: set[str] = set()
    read_paths_present = isinstance(raw_read_paths, list)
    if raw_read_paths is None:
        errors.append({"code": "read_paths_field_missing_in_output"})
    elif read_paths_present:
        for path in raw_read_paths:
            normalized = normalize_path(path)
            declared_read_paths.add(normalized)
            if allowed_paths and normalized not in allowed_paths:
                errors.append({"code": "read_path_outside_snapshot", "path": normalized})
    else:
        errors.append({"code": "read_paths_not_array"})

    findings = output.get("findings", [])
    if isinstance(findings, list):
        for finding in findings:
            if not isinstance(finding, dict):
                continue
            evidence = finding.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                errors.append(
                    {
                        "code": "finding_evidence_missing",
                        "finding_id": finding.get("id"),
                    },
                )
                continue
            for ref in evidence:
                envelope = validate_evidence_ref(
                    tool,
                    root,
                    ref,
                    errors,
                    checked_sources,
                    allowed_paths=allowed_paths,
                    target_sha=target_sha,
                    require_repo_verified=require_repo_verified,
                )
                if envelope is not None:
                    evidence_envelopes.append(envelope)
                # Plan 022 §M-2 — additionally enforce evidence path is
                # within the tool's declared read_paths. read_paths is
                # the load-bearing self-report for what the adapter
                # actually inspected; an evidence_ref outside this set
                # is a contract violation.
                if (
                    isinstance(ref, dict)
                    and isinstance(ref.get("path"), str)
                    and read_paths_present
                ):
                    # Plan 023 v3 §C-2 — shape check (the list exists)
                    # gates the subset, not truthiness. Empty
                    # declared_read_paths set with an evidence path is a
                    # contract violation, not a free pass.
                    norm = normalize_path(ref["path"])
                    if norm not in declared_read_paths:
                        errors.append({
                            "code": "evidence_outside_declared_read_paths",
                            "path": norm,
                            "finding_id": finding.get("id"),
                        })

    sources = output.get("evidence_sources", [])
    if isinstance(sources, list):
        for source in sources:
            envelope = validate_evidence_path(
                tool,
                root,
                source,
                None,
                errors,
                checked_sources,
                allowed_paths=allowed_paths,
                target_sha=target_sha,
                require_repo_verified=require_repo_verified,
            )
            if envelope is not None:
                evidence_envelopes.append(envelope)
            # Plan 023 v3 §C-2 — shape check on read_paths_present so
            # evidence_sources outside an empty-list declaration is also
            # rejected (not bypassed by the empty-set falsy gate).
            if isinstance(source, str) and read_paths_present:
                norm = normalize_path(source)
                if norm not in declared_read_paths:
                    errors.append({
                        "code": "evidence_outside_declared_read_paths",
                        "path": norm,
                    })
    else:
        errors.append({"code": "evidence_sources_not_array"})

    self_output = any(
        normalize_path(error.get("path", "")).startswith(SELF_OUTPUT_MARKERS)
        for error in errors
    )
    return {
        "valid": not errors,
        "errors": errors,
        "checked_sources": sorted(set(checked_sources)),
        "self_output_evidence": self_output,
        "evidence_envelopes": evidence_envelopes,
    }


def validate_evidence_ref(
    tool: dict[str, Any],
    root: Path,
    ref: Any,
    errors: list[dict[str, Any]],
    checked_sources: list[str],
    allowed_paths: set[str] | None = None,
    target_sha: str | None = None,
    require_repo_verified: bool = False,
) -> dict[str, Any] | None:
    if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
        errors.append({"code": "invalid_evidence_ref"})
        return None
    line = ref.get("line")
    return validate_evidence_path(
        tool,
        root,
        ref["path"],
        line,
        errors,
        checked_sources,
        allowed_paths=allowed_paths,
        target_sha=target_sha,
        require_repo_verified=require_repo_verified,
    )


def validate_evidence_path(
    tool: dict[str, Any],
    root: Path,
    raw_path: Any,
    line: Any,
    errors: list[dict[str, Any]],
    checked_sources: list[str],
    allowed_paths: set[str] | None = None,
    target_sha: str | None = None,
    require_repo_verified: bool = False,
) -> dict[str, Any] | None:
    # Plan 024 v3 §H-5 — canonical-resolve BEFORE the SELF_OUTPUT
    # prefix check, mirroring _check_agent_ref. Pre-fix this code
    # path applied normalize_path (lexical) and prefix-matched on
    # the lexical form; the resolved absolute path was only used
    # later for relative_to + existence checks. The shared helper
    # now produces the canonical posix-relative form which the
    # SELF_OUTPUT match consumes.
    from .tool_registry import GovernanceError as _GE
    raw_path_str = normalize_path(raw_path)  # keep checked_sources entry consistent with legacy callers
    checked_sources.append(raw_path_str)
    envelope = classify_evidence_ref(
        raw_path_str if line is None else f"{raw_path_str}:{line}",
        workspace_root=root,
        source_hint="tool_output",
        context=str(tool.get("id") or tool.get("name") or "tool"),
        target_sha=target_sha,
    ).to_dict()

    if allowed_paths and raw_path_str not in allowed_paths:
        errors.append({"code": "evidence_outside_snapshot", "path": raw_path_str})
        return envelope
    try:
        rel_str, absolute = _canonical_evidence_path(raw_path_str, root)
    except _GE as exc:
        msg = str(exc)
        if msg.startswith("evidence_path_outside_repo"):
            errors.append({"code": "evidence_path_escapes_workspace", "path": raw_path_str})
        else:
            errors.append({"code": "evidence_path_unresolvable", "path": raw_path_str,
                           "error": msg})
        return envelope
    if any(rel_str.startswith(marker) for marker in SELF_OUTPUT_MARKERS):
        errors.append({"code": "self_output_evidence", "path": rel_str})
        return envelope
    scope_violations = find_scope_violations(tool, [rel_str])
    if scope_violations:
        errors.append({"code": "evidence_scope_violation", "path": rel_str})
        return envelope
    if not absolute.exists() or not absolute.is_file():
        errors.append({"code": "evidence_path_missing", "path": raw_path_str})
        return envelope
    if require_repo_verified and target_sha is None:
        errors.append({
            "code": "tool_output_repo_snapshot_target_sha_missing",
            "path": raw_path_str,
        })
        return envelope
    if require_repo_verified and envelope.get("trust_grade") != "repo_verified":
        # Two different failures used to share one code, and only one of them
        # is about the agent. `baseline_unavailable` means the CALLER threaded
        # no target_sha, so no comparison was ever attempted; reporting that as
        # "your evidence is not repo-verified" sends the reader hunting a
        # fabricating agent that does not exist. Still rejected — nothing was
        # verified — but under a name that says whose gap it is.
        code = (
            "tool_output_evidence_baseline_unavailable"
            if envelope.get("trust_grade") == "baseline_unavailable"
            else "tool_output_evidence_not_repo_verified"
        )
        errors.append({
            "code": code,
            "path": raw_path_str,
            "grade": envelope.get("trust_grade"),
        })
        return envelope
    path = rel_str  # remainder of function expects local `path` variable
    if line is None:
        return envelope
    if not isinstance(line, int) or line <= 0:
        errors.append({"code": "evidence_line_invalid", "path": path, "line": line})
        return envelope
    line_count = len(absolute.read_text(encoding="utf-8", errors="replace").splitlines())
    if line > line_count:
        errors.append({"code": "evidence_line_missing", "path": path, "line": line})
    return envelope


def _parse_agent_ref(ref: str) -> tuple[str, int | None] | None:
    """Parse a string ref like 'path/to/file.ts:42' into (path, line) or None on malformed input."""
    match = _AGENT_REF_RE.match(ref.strip())
    if not match:
        return None
    line = match.group("line")
    return match.group("path"), int(line) if line is not None else None


# Plan 026R §E.5 — canonical-resolve helper promoted to the
# shared `canonical_path` module so memory.update_memory FATES
# recompute (E.7) + this evidence-validator path share ONE
# resolver identity. Re-export here keeps the existing import
# surface (`evidence_validator._canonical_evidence_path`) stable
# for the validate_evidence_path + _check_agent_ref callsites
# below; new code MUST import from `.canonical_path` directly.
from .canonical_path import _canonical_evidence_path  # noqa: F401


def _is_ledger_pointer_ref(ref: str) -> bool:
    """Z2 (ORPHAN-708 follow-through) — THE single definition of a kernel
    ledger pointer. First live panel drain showed three law layers each
    discovering the pointer separately: malformed passed (Z0 fix), then
    repo-verified and allowed-scope each rejected the same ref. Every
    layer now asks this one question; the load-bearing verification of
    what the pointer NAMES stays at fold time."""
    return ref.startswith("human-required:") and len(ref) > len("human-required:")


# ORPHAN-CRITICAL-734 — the arbitration classes read agent output BY
# DESIGN, and the law had no way to say so. The consensus arbiter's whole
# job is to weigh two judge envelopes; the kernel hands it their artifact
# paths, and every submit died `evidence_ref_not_repo_verified:
# …:worktree_candidate` (measured live, drain 32212069072). "Agent output
# is untrusted" stays true for ordinary claims — an adapter may not cite
# its own prose as proof of a repo fact. What changes is that a role whose
# SUBJECT is another agent's verdict may cite that verdict, and the law
# verifies provenance the strongest way available: the artifact must be a
# kernel-RECORDED result whose content hash still matches the ledger row.
# Unaltered-by-construction beats repo-committed here; a tampered or
# invented artifact fails.
ARBITRATION_ROLES: frozenset[str] = frozenset({
    "consensus_arbitration",
    "human_required_adjudication",
})


def _artifact_results_ledger(artifact: Path) -> Path | None:
    """The results ledger that owns an outputs/ artifact, derived from the
    artifact itself.

    Deriving beats configuration here: the store lives at different roots
    on the runner, in the operator clone and in a test fixture, and the
    ledger is ALWAYS `<…>/agent-invocations/results.jsonl` beside the
    `outputs/` tree the artifact sits in. Asking a tools-dir resolver
    instead would make admissibility depend on ambient environment.
    """
    for parent in artifact.parents:
        if parent.name == "agent-invocations":
            if "outputs" not in artifact.relative_to(parent).parts[:1]:
                return None
            return parent / "results.jsonl"
    return None


def _kernel_artifact_verdict(ref: str, root: Path) -> tuple[bool, str]:
    """(admissible, reason) for a ref naming a kernel-recorded agent output.

    Admissible only when the results ledger beside the artifact records
    it AND the bytes still hash to the recorded value: provenance by
    content address, which a fabricated or edited artifact cannot forge.
    """
    import hashlib

    raw = ref
    if ref.count(":") >= 1 and ref.rsplit(":", 1)[-1].isdigit():
        raw = ref.rsplit(":", 1)[0]
    candidate = Path(raw) if Path(raw).is_absolute() else (root / raw)
    try:
        candidate = candidate.resolve()
    except OSError:
        return False, "artifact_unresolvable"
    ledger = _artifact_results_ledger(candidate)
    if ledger is None:
        return False, "artifact_not_recorded_in_results_ledger"
    if not ledger.exists():
        return False, "artifact_not_recorded_in_results_ledger"
    recorded: str | None = None
    for row in load_declared_jsonl(ledger, expected_surface="agent_invocation_results"):
        output_path = row.get("output_path")
        output_hash = row.get("output_hash")
        if not isinstance(output_path, str) or not isinstance(output_hash, str):
            continue
        # Rows carry both spellings in the wild: Y6 made new rows
        # store-relative; older rows (and the live drain that surfaced
        # this defect) carry the runner's absolute path. Compare by the
        # file named, never by how the row spelled it.
        try:
            row_path = Path(output_path)
            resolved = (
                row_path.resolve()
                if row_path.is_absolute()
                else (ledger.parent.parent / output_path).resolve()
            )
        except OSError:
            continue
        if resolved == candidate:
            recorded = output_hash
            break
    if recorded is None:
        return False, "artifact_not_recorded_in_results_ledger"
    if not candidate.exists() or not candidate.is_file():
        return False, "artifact_missing"
    digest = "sha256:" + hashlib.sha256(candidate.read_bytes()).hexdigest()
    if digest != recorded:
        return False, "artifact_hash_mismatch"
    return True, "kernel_artifact_verified"


def _check_agent_ref(
    ref: str,
    *,
    root: Path,
    errors: list[dict[str, Any]],
    checked: list[str],
    allow_self_output: bool = False,
    allow_kernel_artifacts: bool = False,
) -> None:
    # Y7 follow-through (ORPHAN-708) — the kernel's OWN adjudication mint
    # (human_required_adjudication.open_adjudication) issues
    # ``human-required:<request-id>`` refs, and the first real panel drain
    # showed this validator rejecting them: mint-side and law-side of the
    # same kernel disagreed, every panel opinion died submit_rejected, and
    # the rejection BURNED the envelope's requeue budget. The ref is a
    # LEDGER POINTER, not a repo path — the load-bearing verification
    # happens at fold time (fold_adjudication / adjudicate_human_required
    # resolve the record from the store before any disposition acts), so
    # the law admits the pointer as checked rather than pretending a repo
    # check that cannot exist for state-store records.
    if _is_ledger_pointer_ref(ref):
        checked.append(ref)
        return
    if allow_kernel_artifacts:
        admissible, reason = _kernel_artifact_verdict(ref, root)
        if admissible:
            checked.append(ref)
            return
        if reason != "artifact_not_recorded_in_results_ledger":
            # It IS an artifact path — just not one the ledger vouches for.
            # Naming the failure is the point: a silent fall-through to the
            # repo check would report "not repo verified" about a file that
            # was never meant to be in the repo.
            errors.append({
                "code": "agent_evidence_artifact_unverifiable",
                "ref": ref,
                "reason": reason,
            })
            return
    parsed = _parse_agent_ref(ref)
    if parsed is None:
        errors.append({"code": "agent_evidence_ref_malformed", "ref": ref})
        return
    path, line = parsed
    # Plan 024 v3 §H-5 — canonical-resolve BEFORE the SELF_OUTPUT
    # prefix check. Pre-fix the prefix match operated on the
    # lexically-normalized string; a `src/../aria-tools/...` traversal
    # could bypass detection if normalize_path didn't fully collapse
    # it. Post-fix the resolution runs first, then SELF_OUTPUT is
    # decided on the canonical posix-relative form.
    from .tool_registry import GovernanceError as _GE
    try:
        rel_str, absolute = _canonical_evidence_path(path, root)
    except _GE as exc:
        msg = str(exc)
        if msg.startswith("evidence_path_outside_repo"):
            errors.append({"code": "agent_evidence_path_escapes_workspace", "path": path})
        else:
            errors.append({"code": "agent_evidence_path_unresolvable", "path": path,
                           "error": msg})
        return
    # ARIA self-output / runtime artefacts are NOT admissible evidence
    # for an agent claim (CLAUDE.md L1, Plan 016 §Agent output untrusted).
    if not allow_self_output and rel_str.startswith(SELF_OUTPUT_MARKERS):
        errors.append({"code": "agent_evidence_self_output", "path": rel_str})
        return
    if not absolute.exists() or not absolute.is_file():
        errors.append({"code": "agent_evidence_path_missing", "path": path})
        return
    checked.append(rel_str)
    if line is None:
        return
    if line <= 0:
        errors.append({"code": "agent_evidence_line_invalid", "path": path, "line": line})
        return
    line_count = len(absolute.read_text(encoding="utf-8", errors="replace").splitlines())
    if line > line_count:
        errors.append({"code": "agent_evidence_line_missing", "path": path, "line": line, "line_count": line_count})


def validate_agent_response_evidence(
    *,
    response: dict[str, Any],
    workspace_root: str | Path,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-fetch every evidence ref claimed by an agent response and verify it exists in the repo.

    Why: Plan 016 V-24 — agent output is data, not truth. The contract
    layer (agent_contract.validate_response) checks the SHAPE of the
    satisfaction matrix and the response envelope. This function checks
    that every evidence_ref the agent attached to its verdicts actually
    points at a real file (and line, when given) at the workspace SHA.
    A response that passes both gates is contractually safe to publish
    as a CONVERGED plan / promoted finding.

    Returns: {
        "valid": bool,
        "errors": [{"code": ..., "path": ..., ...}],
        "checked_refs": [<sorted unique paths>],
    }
    """
    root = Path(workspace_root).resolve()
    errors: list[dict[str, Any]] = []
    checked: list[str] = []
    evidence_envelopes: list[dict[str, Any]] = []
    # ORPHAN-CRITICAL-734 — role-scoped, not global. Only a role whose
    # SUBJECT is another agent's verdict may cite that verdict's artifact,
    # and only when the results ledger still vouches for its bytes.
    allow_kernel_artifacts = str(
        (request or {}).get("role") or "",
    ) in ARBITRATION_ROLES

    response_refs = response.get("evidence_refs") or []
    if not isinstance(response_refs, list):
        errors.append({"code": "agent_evidence_refs_not_list"})
        response_refs = []
    for ref in response_refs:
        if not isinstance(ref, str) or not ref.strip():
            errors.append({"code": "agent_evidence_ref_not_string"})
            continue
        _check_agent_ref(
            ref, root=root, errors=errors, checked=checked,
            allow_kernel_artifacts=allow_kernel_artifacts,
        )
        if _is_ledger_pointer_ref(ref):
            continue  # Z2 — a ledger pointer has no repo classification
        if allow_kernel_artifacts and _kernel_artifact_verdict(ref, root)[0]:
            # Verified by content hash against the results ledger — the
            # repo classification below cannot describe it (the artifact
            # is state-store-owned and was never meant to be committed).
            continue
        envelope = classify_evidence_ref(
            ref,
            workspace_root=root,
            source_hint="agent_output",
            target_sha=_request_target_sha(request),
        )
        evidence_envelopes.append(envelope.to_dict())
        try:
            EvidencePolicy.require_repo_verified(envelope)
        except GovernanceError as exc:
            errors.append({"code": "agent_evidence_not_repo_verified", "ref": ref, "reason": str(exc)})

    # Plan 024 §B-2 — satisfaction_matrix non-empty enforcement.
    # Pre-fix an agent response with `satisfaction_matrix: []` passed
    # consensus because the matrix-iteration loop simply never ran.
    # Combined with the empty-allowed_scope skip (line below), a judge
    # could rubber-stamp a request with zero criteria checked. The
    # request can opt out via `allow_empty_satisfaction_matrix=True`
    # for the rare judge-only domain that explicitly does not produce
    # per-criterion evidence — operator-approval-gated; not a default.
    matrix = response.get("satisfaction_matrix") or []
    allow_empty_matrix = bool(request and request.get("allow_empty_satisfaction_matrix"))
    if not matrix and not allow_empty_matrix:
        errors.append({"code": "evidence_satisfaction_matrix_must_be_non_empty"})
    if isinstance(matrix, list):
        for entry in matrix:
            if not isinstance(entry, dict):
                continue
            entry_refs = entry.get("evidence_refs") or []
            if not isinstance(entry_refs, list):
                errors.append({"code": "agent_matrix_evidence_refs_not_list", "id": entry.get("id")})
                continue
            for ref in entry_refs:
                if not isinstance(ref, str) or not ref.strip():
                    errors.append(
                        {"code": "agent_matrix_evidence_ref_not_string", "id": entry.get("id")}
                    )
                    continue
                _check_agent_ref(
                    ref, root=root, errors=errors, checked=checked,
                    allow_kernel_artifacts=allow_kernel_artifacts,
                )
                if _is_ledger_pointer_ref(ref):
                    continue  # Z2 — same single definition as above
                if allow_kernel_artifacts and _kernel_artifact_verdict(ref, root)[0]:
                    continue  # ORPHAN-734 — same single definition as above
                envelope = classify_evidence_ref(
                    ref,
                    workspace_root=root,
                    source_hint="agent_output",
                    target_sha=_request_target_sha(request),
                )
                evidence_envelopes.append(envelope.to_dict())
                try:
                    EvidencePolicy.require_repo_verified(envelope)
                except GovernanceError as exc:
                    errors.append({"code": "agent_evidence_not_repo_verified", "ref": ref, "reason": str(exc)})

    # Cross-check: when a request is provided, every ref the agent
    # claims must either live inside `allowed_scope` OR be one of the
    # request's evidence_refs (the canonical bounding box). Refs
    # outside the box are rejected as scope leakage.
    #
    # Plan 024 §B-2 — allowed_scope MUST be provided when a request is
    # supplied. Pre-fix the empty-list case skipped scope enforcement
    # entirely under "preserves backward compatibility with legacy
    # aria/agent-invocation-request/v1 rows that pre-date Plan 016".
    # That path is now closed: legacy rows are caught at
    # _strict_request_view (line ~964); by the time validate_agent_-
    # response_evidence sees the request the strict fields are
    # present.
    if request is not None:
        if "allowed_scope" not in request:
            errors.append({"code": "evidence_request_missing_allowed_scope"})
        else:
            allowed_globs = list(request.get("allowed_scope") or [])
            allowed_request_refs = {
                (_parse_agent_ref(r) or ("", None))[0]
                for r in (request.get("evidence_refs") or [])
                if isinstance(r, str)
            }
            for path in checked:
                if _is_ledger_pointer_ref(path):
                    continue  # Z2 — pointer identity is bound at mint, not by glob
                if allow_kernel_artifacts and _kernel_artifact_verdict(path, root)[0]:
                    # ORPHAN-734 — an arbitrated artifact's identity is bound
                    # by the results ledger's content hash, not by a repo glob
                    # (the same reason the pointer above skips this check).
                    continue
                if path in allowed_request_refs:
                    continue
                if not _path_matches_any_glob(path, allowed_globs):
                    errors.append(
                        {
                            "code": "agent_evidence_outside_allowed_scope",
                            "path": path,
                            "allowed_scope": allowed_globs,
                        }
                    )

    return {
        "valid": not errors,
        "errors": errors,
        "checked_refs": sorted(set(checked)),
        "evidence_envelopes": evidence_envelopes,
    }


def _request_target_sha(request: dict[str, Any] | None) -> str | None:
    if not request:
        return None
    # ARIA-HIGH-022 — an executor may ground the evidence check at the AGENT's
    # committed HEAD (`evidence_target_sha`) instead of the request's base:
    # implementer agents cite the POST-FIX lines of files they changed, which
    # can never match the pre-edit blob, so every genuine fix graded
    # worktree_candidate and the submit was rejected. The override is only
    # honoured when submit_claim_result PROVED it descends from the request's
    # base (fail-closed there); a commit that contains the base's tree plus
    # the agent's proven work is a strictly stronger anchor than the base.
    override = request.get("evidence_target_sha")
    if isinstance(override, str) and override.strip():
        return override.strip()
    value = request.get("target_sha") or request.get("base_commit_sha") or request.get("pinned_commit_sha")
    return str(value).strip() if isinstance(value, str) and value.strip() else None


def _snapshot_target_sha(snapshot: dict[str, Any] | None) -> str | None:
    if not isinstance(snapshot, dict):
        return None
    value = snapshot.get("target_sha") or snapshot.get("base_commit_sha") or snapshot.get("pinned_commit_sha")
    return str(value).strip() if isinstance(value, str) and value.strip() else None


def _snapshot_requires_repo_verified(snapshot: dict[str, Any] | None) -> bool:
    if not isinstance(snapshot, dict):
        return False
    if snapshot.get("require_repo_verified_evidence") is True:
        return True
    mode = str(snapshot.get("snapshot_mode") or "").replace("-", "_")
    return mode == "committed"


def _path_matches_any_glob(path: str, globs: list[str]) -> bool:
    """Cheap fnmatch-based glob match for `aria-kernel/**` style scope rules."""
    import fnmatch

    for pattern in globs:
        # Translate `dir/**` into `dir/*` for fnmatch (single-level), and try
        # both — operators commonly mean recursive, but fnmatch only does
        # single-segment matching. Recursive emulation: walk parents.
        if fnmatch.fnmatchcase(path, pattern):
            return True
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            if path == prefix or path.startswith(prefix + "/"):
                return True
        if pattern.endswith("/*"):
            prefix = pattern[:-2]
            head, _, _ = path.rpartition("/")
            if head == prefix:
                return True
    return False
