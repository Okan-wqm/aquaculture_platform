from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from .adapter_room import adapter_stderr_sample, prepare_adapter_spawn, run_adapter
from .confidence import confidence_in_unit_interval
from .evidence_validator import validate_tool_output_evidence
from .genesis_adapter_custody import verify_genesis_dispatch
from .ledger import LEDGER_ROW_MAX_BYTES, LEDGER_ROW_NESTING_MAX_DEPTH, canonical_json, json_nesting_within_limit
from .implementation_safety import (
    BashAllowlistMiss,
    BashDenylistHit,
    KERNEL_CHECKOUT_ROOT,
    SandboxUnavailable,
    verify_bash_command_allowed,
)
from .ledger_inline import INLINE_ROW_FIELD_MAX_BYTES, spill_oversized_inline
from .runtime_profile import enforce_profile_for_write
from .canonical_path import lexical_repo_path
from .snapshot import build_repo_snapshot, ignored_dirty_path, snapshot_allowed_set
from .tool_health import RUNS_ROW_RECOVERY, can_emit_operator_facing, find_scope_violations, record_run
from .tool_registry import GovernanceError, ensure_tools_binding, get_tool, missing_repo_local_dependencies
from .digest import sha256_digest


MINIMUM_OUTPUT_FIELDS = ("observations", "findings", "read_paths", "evidence_sources")
RAW_SAMPLE_LIMIT = 50
# Measured (2026-08-13): tenant-scoping over the full repo emits 5.84 MB
# (66 findings + 11,471 observations) — 17% over the old 5 MB cap, which
# made every night's cycle "failed" via budget_exceeded/output_too_large.
# 12 MB = measured reality × 2 headroom; the adapter-side per-type
# observation cap (tenant-scoping-adapter) bounds the growth class itself.
STDOUT_PARSE_MAX_BYTES = 12 * 1024 * 1024
# ARIA-HIGH-617 — the deepest a kernel ledger row stores a value of a tool's
# parsed output, counted from where stdout holds it. A fixture-runs case keeps
# a finding's id three levels deeper (cases[i] > evidence_validation >
# errors[j] > finding_id, fixture_runner); a runs row keeps it one level
# deeper (runner.raw_findings_sample[i], evidence_validation.errors[j]
# .finding_id and .belief_id, evidence_validation.evidence_sources[i]); every
# other row stores less of it.
TOOL_OUTPUT_ROW_NESTING_LEVELS = 3
# The deepest output the parser accepts: the producer-row bound
# (ledger.LEDGER_ROW_NESTING_MAX_DEPTH, which keeps contention replay's level
# free) less those levels, so whatever a row stores of accepted output is a
# line the strict readers and the replay accept. No JSON file under
# tools/aria-adapters or aria-kernel/tests/fixtures is deeper than 8 levels
# (2026-10-19), so the bound costs a real adapter nothing.
TOOL_OUTPUT_NESTING_MAX_DEPTH = LEDGER_ROW_NESTING_MAX_DEPTH - TOOL_OUTPUT_ROW_NESTING_LEVELS
# ARIA-HIGH-617 — the most canonical-JSON bytes one finding may take. record_run
# stores each finding in rows of its own before it decides the run's health: a
# raw-findings row (the finding inline in v1; its id as finding_id, and str()
# of its id and rule as finding_summary), and for an ACTIVE tool a findings row
# (the finding, its id, the services its paths name) and a seeding row. str()
# at most doubles a value's JSON spelling (a backslash is escaped by repr, then
# by JSON), so none of those rows holds more than three times a finding's
# bytes besides its own fields, and an eighth of the row cap leaves each one
# under it. ORPHAN-HIGH-798 measured 27,853 inline findings at about 2 KB
# each, so the bound costs a real adapter nothing.
TOOL_OUTPUT_FINDING_MAX_BYTES = LEDGER_ROW_MAX_BYTES // 8


def run_tool(
    tool_id: str,
    input_payload: Any,
    cycle_id: str,
    run_id: str | None = None,
    workspace_root: str | os.PathLike[str] | None = None,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    # Plan 020 Phase 1.B — runtime profile write gate (single chokepoint).
    # Why: every adapter / spine_orchestrator invocation routes through
    # run_tool, and each invocation appends to runs.jsonl. Frozen profile
    # forbids tool-run writes; observe profile blocks all tool runs since
    # adapters mutate scan output beyond observation class. Gating at the
    # top of run_tool is the single chokepoint that covers Phase 4 spine
    # orchestrator + Phase 10 agent-harness-security adapter + every
    # backend adapter without each call site having to remember the gate.
    root = Path(workspace_root or os.getcwd()).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=root)
    enforce_profile_for_write("tool_runs", base_dir=tools_root)
    tool = get_tool(tool_id, tools_root)
    if tool["status"] == "QUARANTINED":
        raise GovernanceError("QUARANTINED tool cannot be run by the normal runner")
    runner = tool.get("runner")
    if not runner:
        raise GovernanceError(f"tool has no runner configuration: {tool_id}")
    if runner.get("type") != "subprocess":
        raise GovernanceError(f"unsupported runner type: {runner.get('type')}")
    try:
        # An adapter's absolute program is trusted only as the running
        # kernel's own code (ARIA-HIGH-431; the room binds by the same rule).
        verify_bash_command_allowed(
            list(runner.get("argv") or []),
            cwd=str(runner.get("cwd") or "."),
            checkout_root=KERNEL_CHECKOUT_ROOT,
        )
    except (BashAllowlistMiss, BashDenylistHit) as exc:
        raise GovernanceError(f"runner_argv_policy_rejected:{exc}") from exc
    # ARIA-HIGH-414 — a skill-genesis drafted adapter runs only as the bytes
    # the kernel holds in custody, re-hashed now against the custody and
    # calibration digests, through the kernel's own launcher. A gap is a named
    # refusal before anything starts, like the argv policy above; a curated
    # tool gets None and runs its manifest argv.
    genesis = verify_genesis_dispatch(tool, base_dir=tools_root)

    # The snapshot evidence is judged against comes from the CALLER or is
    # built here from the workspace, never from the manifest: a
    # `repo_snapshot` declared in default_input would otherwise list files
    # the workspace does not hold as "in the snapshot" (the cycle's own merge
    # used to let one through). It is read before the merge below and
    # written over whatever the merge carried.
    repo_snapshot = _input_repo_snapshot(input_payload)
    if repo_snapshot is None:
        repo_snapshot = build_repo_snapshot(workspace_root=root, mode="working-tree", enforce_clean=False)
    repo_snapshot = _snapshot_for_tool(tool, repo_snapshot)
    if isinstance(input_payload, dict):
        # ARIA-MEDIUM-516 — the manifest's declared input is merged HERE, the
        # one chokepoint every caller passes (cycle tools phase, spine
        # refresh, `aria-kernel tool run`, gateway scheduler). It used to be
        # merged only by the cycle's tools phase, so every other caller ran
        # tenant-scoping and security-boundary without their roots and they
        # exited 1 in requireScanRoots (adapter-fs.ts). Caller keys win over
        # the declaration. `default_input` is optional; the registry refuses
        # a non-object one (tool_registry.validate_tool_definition).
        input_payload = {**tool.get("default_input", {}), **input_payload, "repo_snapshot": repo_snapshot}
    cwd = (root / runner["cwd"]).resolve()
    try:
        cwd.relative_to(root)
    except ValueError as exc:
        raise GovernanceError("runner.cwd must stay within workspace root") from exc
    if not cwd.exists() or not cwd.is_dir():
        raise GovernanceError(f"runner.cwd does not exist: {runner['cwd']}")

    input_bytes = _canonical_json_bytes(input_payload)
    # Plan 022 §C-5 — the raw view exists so a buggy/malicious adapter
    # mutating files OUTSIDE its declared scope (package.json, CI
    # configs, registry.json) stays visible; the diff is partitioned
    # into scoped vs scope_out mutations and the latter is a hard
    # quarantine signal. ORPHAN-MEDIUM-526 — both views of one
    # observation moment come from a SINGLE `git status` invocation:
    # separate calls per view let git's racy-stat heuristic hand two
    # witnesses of the same moment different answers, and the mutation
    # verdict then compared internally inconsistent moments.
    before, before_raw = _workspace_snapshots(root, tool)
    started = time.monotonic()
    stdout = ""
    stderr = ""
    exit_code: int | None = None
    timed_out = False
    status = "ok"
    output: dict[str, Any] | None = None
    # Plan 023 v3 §C-2 — runner envelope carries the specific parse
    # error code so observability sees the field-level reason instead
    # of a generic "schema_error" status. Default None (parser
    # succeeded or did not run); populated with codes from
    # PARSE_ERROR_CODES on rejection.
    parse_error: str | None = None
    # ARIA-CRITICAL-399 — the room the adapter ran in and the environment it
    # saw, by name; both stay None when the adapter never started.
    sandbox_backend: str | None = None
    spawn_environment: dict[str, Any] | None = None

    try:
        missing_dependencies = missing_repo_local_dependencies(runner, workspace_root=root)
        if missing_dependencies:
            # The WORKSPACE is missing the runner's dependency; the tool never
            # executed and this run says nothing about the tool. Its own
            # status keeps it out of the quarantine trigger — six adapters
            # were quarantined on 2026-08-10 for exactly this, an environment
            # fault priced as tool guilt (the requeue counter's defect, one
            # layer up; MISSION_SPEC M-2.5). ARIA-MEDIUM-508 — the registry
            # names every runner's dependencies, declared or derived, so a
            # python adapter that spawns the repository's ts-node
            # (banned-phrase-adapter) is no longer priced `crash` here.
            stderr = "missing repo-local dependency: " + ", ".join(missing_dependencies)
            status = "environment_unavailable"
            exit_code = None
            output = {}
        else:
            # ARIA-CRITICAL-399 — the adapter runs ONLY inside the room
            # (`adapter_room`): an environment BUILT from the validation
            # allowlist (it used to be `dict(os.environ)`: the job token,
            # the OIDC request token and GITHUB_ENV), no network, a
            # read-only workspace with the store masked, private PID
            # namespace. The tool's memory budget is a CONTRACT, not an
            # accident of the host: Node's default old-space (~1 GB)
            # OOM-crashed the two widest-scope adapters the first time they
            # executed, so `runner.node_max_old_space_mb` (default 2048)
            # travels into the room's NODE_OPTIONS, composed with an
            # operator's own flags.
            spawn = prepare_adapter_spawn(
                genesis.argv if genesis is not None else runner["argv"],
                workspace_root=root,
                cwd=cwd,
                node_heap_mb=runner.get("node_max_old_space_mb"),
                store=tools_root,
            )
            sandbox_backend = spawn.backend
            spawn_environment = spawn.spawn_environment
            stdin_text = input_bytes.decode("utf-8") if runner.get("stdin_json") else None
            completed = run_adapter(
                spawn,
                # The custody runner reads JSON on stdin (runner equality is
                # part of the dispatch check); the bytes ride in front of it.
                input_text=genesis.stdin_header + (stdin_text or "") if genesis is not None else stdin_text,
                timeout_seconds=runner["timeout_ms"] / 1000,
            )
            stdout = completed.stdout or ""
            stderr = completed.stderr or ""
            exit_code = completed.returncode
            if len(stdout.encode("utf-8")) > STDOUT_PARSE_MAX_BYTES:
                status = "budget_exceeded"
                parse_error = "output_too_large"
                output = {}
            elif completed.returncode != 0:
                status = "crash"
            else:
                output, parse_error = _parse_tool_output(stdout, tool)
                if output is None:
                    status = "schema_error"
    except SandboxUnavailable as exc:
        # No room, no run: the adapter never started. Like a missing node
        # dependency above, the HOST could not run the tool, so the run is
        # environment_unavailable — it never quarantines the tool — and the
        # reason is named for the night's degraded-tool record.
        stderr = f"adapter_sandbox_unavailable: {exc}"
        status = "environment_unavailable"
        output = {}
    except subprocess.TimeoutExpired as exc:
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
        timed_out = True
        status = "budget_exceeded"
    except OSError as exc:
        stderr = str(exc)
        status = "tool_unhealthy" if getattr(exc, "filename", None) else "crash"

    duration_ms = int(round((time.monotonic() - started) * 1000))
    after, after_raw = _workspace_snapshots(root, tool)
    # Plan 022 §C-5 — partition every mutated path into scoped vs
    # scope-out using the raw before/after. `mutated` retains its
    # original semantic for backward-compat with downstream consumers
    # that only care whether ANY files changed.
    scoped_mutations, scope_out_mutations = _partition_mutations(
        before_raw=before_raw, after_raw=after_raw, tool=tool,
    )
    mutated = before != after or bool(scope_out_mutations)

    if output is None:
        output = {}
    evidence_validation = {
        "evidence_sources": _array_or_empty(output.get("evidence_sources")),
        "repository_mutation_attempt": mutated,
    }
    if status == "ok":
        evidence_validation.update(validate_tool_output_evidence(tool, output, root, repo_snapshot=repo_snapshot))
        memory_errors = _memory_candidate_snapshot_errors(output.get("belief_candidates", []), repo_snapshot)
        if memory_errors:
            evidence_validation.setdefault("errors", [])
            evidence_validation["errors"].extend(memory_errors)
            evidence_validation["valid"] = False
        evidence_validation["repository_mutation_attempt"] = mutated
    raw_observations = output.get("observations", [])
    raw_findings = output.get("findings", [])
    memory_candidates = _array_or_empty(output.get("belief_candidates"))
    can_emit = can_emit_operator_facing(tool_id, base_dir=tools_root)
    envelope = {
        "schema_version": 1,
        "run_id": run_id or str(uuid.uuid4()),
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "status": status,
        "input_hash": _sha256(input_bytes),
        "output_hash": _sha256(stdout.encode("utf-8")),
        # The ENVELOPE carries the full read set: record_run judges scope
        # against it in memory (validate_run_envelope requires an array).
        # The stored ROW names it by content address once the run artifact
        # holds it (ARIA-HIGH-523, tool_health._ledger_row_fields): inline it
        # grew to 536 KB a run (test-gap, 2026-10-15) and 66% of runs.jsonl.
        # Readers take it from runs_reader.run_read_paths.
        "read_paths": _array_or_empty(output.get("read_paths")),
        "emitted_observations": _array_or_empty(raw_observations) if can_emit else [],
        "emitted_findings": _array_or_empty(raw_findings) if can_emit else [],
        "raw_findings": _array_or_empty(raw_findings),
        # Bounded by record_run, after its scrub: the order a stored value
        # takes (ARIA-HIGH-617).
        "evidence_validation": evidence_validation,
        "operator_feedback_refs": [],
        "memory_candidates": _valid_memory_candidates(memory_candidates, tool_id),
        "duration_ms": duration_ms,
        # ORPHAN-HIGH-801 — the DECLARED budget travels with the measurement.
        # A duration alone cannot answer "was this close to timing out"; the
        # budget lives in the manifest and the row lived in the store, so the
        # two were never in the same place and no operator, and no adapter
        # author, could see a tool creeping toward its ceiling. They only ever
        # learned it had crossed, as a dead cycle.
        "timeout_ms": int(runner["timeout_ms"]),
        "cost_units": _non_negative_number(output.get("cost_units"), default=0),
        "runner": {
            "type": runner["type"],
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stderr_hash": _sha256(stderr.encode("utf-8")),
            "stderr_sample": adapter_stderr_sample(stderr, store_root=tools_root),
            "raw_observations_count": len(_array_or_empty(raw_observations)),
            "raw_findings_count": len(_array_or_empty(raw_findings)),
            "raw_findings_sample": _raw_finding_sample(_array_or_empty(raw_findings)),
            # Plan 022 §C-5 — partitioned mutation lists.
            # scoped_mutations: paths inside the tool's declared scope
            # (expected/permitted writes). scope_out_mutations: writes
            # outside the declared scope — a hard signal that the
            # adapter exceeded its sandbox. tool_health.record_run
            # treats non-empty scope_out_mutations as a quarantine
            # trigger via the immediate_quarantine_reason path.
            "scoped_mutations": list(scoped_mutations),
            "scope_out_mutations": list(scope_out_mutations),
            # Plan 023 v3 §C-2 — specific parser rejection code, or None
            # when the parser succeeded. Closed vocabulary listed in
            # PARSE_ERROR_CODES (plus dynamic missing_field:<f> /
            # field_not_list:<f> shapes for minimum-output fields).
            "parse_error": parse_error,
            # ARIA-CRITICAL-399 — the containment and the environment the
            # adapter ran with, by NAME (never a value, never a host path).
            "sandbox_backend": sandbox_backend,
            "spawn_environment": spawn_environment,
            # ARIA-HIGH-414 — which custody bytes ran (None: a curated tool).
            "genesis_adapter_sha256": genesis.sha256 if genesis is not None else None,
        },
        "repo_snapshot": _compact_snapshot(repo_snapshot),
        "_runtime_artifact_payload": {
            "stdout": stdout,
            "stderr": stderr,
            "parsed_output": output,
            "raw_observations": _array_or_empty(raw_observations),
            "raw_findings": _array_or_empty(raw_findings),
        },
    }
    recorded = record_run(envelope, base_dir=tools_root)
    decision = recorded.health_decision
    # Plan 024 v3 §B-7 — return contract split: the run under "envelope",
    # the registry-side health decision under "health_decision" and merged
    # at the top level (callers read result["status"] == "ACTIVE").
    # ARIA-MEDIUM-516 — "envelope" is the row record_run STORED, never the
    # dict built above: record_run validates a copy and may downgrade its
    # status (scope_violation, evidence_error, integrity_failed), and the
    # CLI exit code, the gateway scheduler and the spine refresh all judged
    # the run by the status of this local dict, one the store never held.
    # The stored row drops the runtime-artifact payload (stdout, parsed
    # output); a caller that needs it reads the run's artifact_ref.
    return {**decision, "envelope": recorded.row, "health_decision": decision}


def _input_repo_snapshot(input_payload: Any) -> dict[str, Any] | None:
    if isinstance(input_payload, dict) and isinstance(input_payload.get("repo_snapshot"), dict):
        return input_payload["repo_snapshot"]
    return None


def _compact_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": snapshot.get("schema_version", 1),
        "snapshot_mode": snapshot.get("snapshot_mode"),
        "repo_state_id": snapshot.get("repo_state_id"),
        "snapshot_hash": snapshot.get("snapshot_hash"),
        "dirty_snapshot": snapshot.get("dirty_snapshot", False),
        "file_counts": snapshot.get("file_counts", {}),
        "tracked_file_count": snapshot.get("tracked_file_count"),
        "legacy_tracked_file_count": snapshot.get("legacy_tracked_file_count", snapshot.get("tracked_file_count")),
        "tool_scope_allowed_count": snapshot.get("tool_scope_allowed_count"),
        "tool_scope_path_count": snapshot.get("tool_scope_path_count"),
    }


def _snapshot_for_tool(tool: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    allowed = snapshot.get("allowed_paths")
    if not isinstance(allowed, list):
        return snapshot
    filtered = [path for path in allowed if isinstance(path, str) and not find_scope_violations(tool, [path])]
    narrowed = dict(snapshot)
    narrowed["allowed_paths"] = sorted(filtered)
    narrowed["tool_scope_allowed_count"] = len(filtered)
    narrowed["tool_scope_path_count"] = len(filtered)
    return narrowed


def _memory_candidate_snapshot_errors(candidates: Any, repo_snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(candidates, list):
        return []
    allowed = snapshot_allowed_set(repo_snapshot)
    if not allowed:
        return []
    errors = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for ref in _array_or_empty(candidate.get("evidence_refs")):
            if not isinstance(ref, str) or _is_glob_ref(ref):
                continue
            normalized = ref.replace("\\", "/")
            if normalized not in allowed:
                errors.append(
                    {
                        "code": "memory_evidence_outside_snapshot",
                        "belief_id": candidate.get("belief_id"),
                        "path": normalized,
                    },
                )
    return errors


def _is_glob_ref(ref: str) -> bool:
    return any(char in ref for char in "*?[]")


# Plan 023 v3 §C-2 — closed error-code vocabulary for tool-output parse
# rejection. Returned in the tuple second slot so the runner envelope
# carries `runner.parse_error = <code>` and observability / operator
# audit see the specific reason instead of a generic "schema_error".
PARSE_ERROR_CODES: frozenset[str] = frozenset({
    "output_not_json",
    # ARIA-HIGH-617: nested past TOOL_OUTPUT_NESTING_MAX_DEPTH.
    "output_nesting_too_deep",
    # ARIA-HIGH-617: JSON the decoder refuses to build a value from (an
    # integer longer than the interpreter's integer string limit).
    "output_value_not_decodable",
    # ARIA-HIGH-617: a findings entry past TOOL_OUTPUT_FINDING_MAX_BYTES.
    "output_finding_too_large",
    "output_not_dict",
    "cost_units_invalid",
    "metadata_not_dict",
    "belief_candidates_not_list",
    # Plus dynamic codes:
    #   missing_field:<field>
    #   field_not_list:<field>
    # produced by the parser when a required minimum-output field is
    # absent or wrong-typed. The closed set above lists the static
    # codes; the dynamic shape is asserted at the caller via prefix.
})


def _parse_tool_output(
    stdout: str, tool: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Plan 023 v3 §C-2 — discriminated parse result.

    Pre-Plan-023 this returned `dict | None`; rejection lost the reason.
    Post-fix: `(payload, None)` on success, `(None, error_code)` on
    rejection. The runner-envelope writer carries `runner.parse_error`
    so operators and observability layers see the specific failure
    mode.

    ARIA-HIGH-617 — this is where the adapter's stdout, already text, becomes
    a value the kernel stores, and the refusals below are output the later
    steps could not store. Each one otherwise left ``run_tool`` before
    ``record_run``, or wrote a row every publish refused, so the run went
    unrecorded or unpublishable, and a tool whose report held a ``.env`` read
    was never quarantined. Refused here, the run is ``schema_error``,
    recorded and quarantined like any other. (The bytes-to-text step comes
    before this one: ``adapter_room.run_adapter`` decodes stdout and stderr as
    strict UTF-8, and a byte that is not UTF-8 still raises out of
    ``run_tool``, ARIA-HIGH-654.)

    * nesting past TOOL_OUTPUT_NESTING_MAX_DEPTH, measured before decoding by
      the kernel's one lexical scan (``ledger.json_nesting_within_limit``).
      ``json.loads`` raised RecursionError past about 20,000 levels, the
      scrub (``artifact_safety.scrub_json``, one frame per level) past about
      1,000, and a row nests a parsed value up to
      TOOL_OUTPUT_ROW_NESTING_LEVELS deeper than stdout does. Text the scan
      cannot pair (unclosed brackets or strings) is not JSON at all, and
      keeps that code;
    * a value the decoder refuses to build: ``json.loads`` raises a plain
      ValueError, not a JSONDecodeError, for an integer longer than the
      interpreter's integer string limit (4,300 digits by default);
    * a findings entry past TOOL_OUTPUT_FINDING_MAX_BYTES, measured in
      ``ledger.canonical_json``, the spelling a row is written in: each
      finding gets rows of its own, appended before the run's health is
      decided, and one oversized row refused the whole batch.

    The decoded output's other properties are checked by the shape checks
    below and by the evidence validator, not here.
    """
    if not json_nesting_within_limit(stdout, max_depth=TOOL_OUTPUT_NESTING_MAX_DEPTH):
        if json_nesting_within_limit(stdout, max_depth=len(stdout)):
            return None, "output_nesting_too_deep"
        return None, "output_not_json"
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return None, "output_not_json"
    except ValueError:
        return None, "output_value_not_decodable"
    if not isinstance(payload, dict):
        return None, "output_not_dict"
    required = set(MINIMUM_OUTPUT_FIELDS)
    required.update(tool.get("output_schema", {}).get("required", []))
    # Deterministic order for missing-field detection — the caller's
    # `parse_error` then encodes a stable single field name when
    # multiple are missing (the first in sorted order). Stable ordering
    # makes test assertions reliable and reproducible.
    for field in sorted(required):
        if field not in payload:
            return None, f"missing_field:{field}"
    for field in MINIMUM_OUTPUT_FIELDS:
        if not isinstance(payload.get(field), list):
            return None, f"field_not_list:{field}"
    if any(len(canonical_json(finding)) > TOOL_OUTPUT_FINDING_MAX_BYTES for finding in payload["findings"]):
        return None, "output_finding_too_large"
    if "cost_units" in payload and _non_negative_number(payload["cost_units"], default=None) is None:
        return None, "cost_units_invalid"
    if "metadata" in payload and not isinstance(payload["metadata"], dict):
        return None, "metadata_not_dict"
    if "belief_candidates" in payload and not isinstance(payload["belief_candidates"], list):
        return None, "belief_candidates_not_list"
    return payload, None


def _workspace_snapshots(root: Path, tool: dict[str, Any] | None = None) -> tuple[Any, Any]:
    """One observation moment, two projections: (scoped, raw).

    ORPHAN-MEDIUM-526 — the scoped and raw snapshots used to come from
    SEPARATE ``git status`` invocations, taken several statements apart.
    Git's racy-stat heuristic can change porcelain output between two
    back-to-back calls with no real file change, so a single observation
    moment had two witnesses that could disagree — and the mutation
    verdict (``before != after``) then compared internally inconsistent
    moments, flagging phantom mutations under load. One invocation per
    moment removes the intra-moment divergence class structurally; both
    projections here are pure functions of the same stdout. The raw
    projection keeps the aria-tools content-hash overlay (Plan ARIA-V2
    §3.4) exactly as before.
    """
    git_dir = root / ".git"
    if git_dir.exists():
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            scoped = ("git", _normalized_git_status(completed.stdout, tool))
            combined: list[str] = list(_normalized_git_status_raw(completed.stdout))
            for rel, size, content_hash in _aria_tools_dir_overlay(root):
                combined.append(f"-- {rel} size={size} {content_hash}")
            return scoped, ("git", tuple(sorted(combined)))
    snapshot = ("dir", _directory_snapshot(root))
    return snapshot, snapshot


def _workspace_snapshot(root: Path, tool: dict[str, Any] | None = None) -> Any:
    git_dir = root / ".git"
    if git_dir.exists():
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            return ("git", _normalized_git_status(completed.stdout, tool))
    return ("dir", _directory_snapshot(root))


def _workspace_snapshot_raw(root: Path) -> Any:
    """Plan 022 §C-5 — unfiltered workspace snapshot.

    Mirrors _workspace_snapshot but does NOT apply the tool-scope
    filter. The raw view is the load-bearing input for scope-out
    mutation detection: comparing before_raw vs after_raw catches
    every mutation regardless of declared scope.

    Plan ARIA-V2 §3.4 + I-24 — once ``aria-tools/`` runtime ledgers
    are gitignored, ``git status --porcelain`` reports them as
    nothing-to-see. Scope-out detection would then go blind to
    ledger mutations, defeating the load-bearing audit contract.
    Augmenting the git output with a content-hashed directory
    snapshot of ``aria-tools/`` keeps the contract: ANY mutation
    under ``aria-tools/`` (tracked or ignored) shows up in the
    before/after delta. The augmentation runs alongside git status,
    not instead — tracked-file mutations elsewhere remain visible
    via the porcelain channel.
    """
    git_dir = root / ".git"
    if git_dir.exists():
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            # Plan ARIA-V2 §3.4 + I-24 — augment with content-hashed
            # aria-tools/ overlay so gitignored runtime mutations stay
            # visible. Overlay rows use a synthetic ``--`` status code
            # (non-conflicting with git's two-letter porcelain codes),
            # carry size + sha256, and join the git status rows in a
            # SINGLE flat string tuple to preserve the load-bearing
            # shape ``("git", tuple_of_strings)`` consumed by
            # ``_partition_mutations`` and downstream scope-out audit.
            combined: list[str] = list(_normalized_git_status_raw(completed.stdout))
            for rel, size, content_hash in _aria_tools_dir_overlay(root):
                combined.append(f"-- {rel} size={size} {content_hash}")
            return ("git", tuple(sorted(combined)))
    return ("dir", _directory_snapshot(root))


def _aria_tools_dir_overlay(root: Path) -> tuple[tuple[str, int, str], ...]:
    """Plan ARIA-V2 §3.4 + I-24 — content-hashed view of aria-tools/.

    Returns a stable, sorted tuple of (relative_path, size_bytes,
    sha256). Used to augment the git-mode workspace snapshot so
    gitignored runtime writes (governance.jsonl append, runs.jsonl
    append, …) still produce a before/after delta and stay audit-
    visible to scope-out detection.
    """
    base = root / "aria-tools"
    if not base.exists() or not base.is_dir():
        return ()
    rows: list[tuple[str, int, str]] = []
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
            rel = path.relative_to(root).as_posix()
            rows.append((rel, stat.st_size, _sha256(path.read_bytes())))
        except OSError:
            continue
    rows.sort()
    return tuple(rows)


def _normalized_git_status_raw(stdout: bytes) -> tuple[str, ...]:
    """Like _normalized_git_status but never applies the tool-scope filter."""
    entries = [entry.decode("utf-8", errors="replace") for entry in stdout.split(b"\0") if entry]
    paths: list[str] = []
    skip_next = False
    for entry in entries:
        if skip_next:
            skip_next = False
            continue
        status = entry[:2]
        path = entry[3:] if len(entry) > 3 else entry
        if status.startswith("R") or status.startswith("C"):
            skip_next = True
        normalized = lexical_repo_path(path)
        if normalized and not ignored_dirty_path(normalized):
            paths.append(f"{status} {normalized}")
    return tuple(sorted(paths))


def _partition_mutations(
    *,
    before_raw: Any,
    after_raw: Any,
    tool: dict[str, Any] | None,
) -> tuple[list[str], list[str]]:
    """Plan 022 §C-5 — partition raw mutation diff into scoped vs scope-out.

    Both before_raw and after_raw are the tuple-shaped output of
    _workspace_snapshot_raw. The diff is the symmetric difference
    interpreted as path-string set; partitioning applies the tool's
    allowed_read_globs / declared_scope via find_scope_violations.

    Returns (scoped, scope_out) lists sorted for stable envelope shape.
    """
    if before_raw == after_raw:
        return [], []
    before_set = set(before_raw[1] if isinstance(before_raw, tuple) and len(before_raw) > 1 else ())
    after_set = set(after_raw[1] if isinstance(after_raw, tuple) and len(after_raw) > 1 else ())
    diff = sorted(before_set ^ after_set)
    scoped: list[str] = []
    scope_out: list[str] = []
    for entry in diff:
        # entry shape from _normalized_git_status_raw mirrors git status
        # --porcelain output: "<2-char status><space><path>". Strip the
        # 3-char prefix to recover the path; fall back to the rsplit
        # result for any unexpected shape.
        if len(entry) > 3 and entry[2] == " ":
            path = entry[3:]
        else:
            path = entry.rsplit(" ", 1)[-1]
        if _mutation_path_in_tool_scope(tool, path):
            scoped.append(entry)
        else:
            scope_out.append(entry)
    return scoped, scope_out


def _normalized_git_status(stdout: bytes, tool: dict[str, Any] | None = None) -> tuple[str, ...]:
    entries = [entry.decode("utf-8", errors="replace") for entry in stdout.split(b"\0") if entry]
    paths: list[str] = []
    skip_next = False
    for entry in entries:
        if skip_next:
            skip_next = False
            continue
        status = entry[:2]
        path = entry[3:] if len(entry) > 3 else entry
        if status.startswith("R") or status.startswith("C"):
            skip_next = True
        normalized = lexical_repo_path(path)
        if normalized and not ignored_dirty_path(normalized) and _mutation_path_in_tool_scope(tool, normalized):
            paths.append(f"{status} {normalized}")
    return tuple(sorted(paths))


def _mutation_path_in_tool_scope(tool: dict[str, Any] | None, path: str) -> bool:
    if not isinstance(tool, dict):
        return True
    scoped = tool.get("allowed_read_globs") or tool.get("declared_scope")
    if not isinstance(scoped, list) or not scoped:
        return True
    return not find_scope_violations(tool, [path])


def _directory_snapshot(root: Path) -> dict[str, tuple[int, str]]:
    snapshot: dict[str, tuple[int, str]] = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
            relative = path.relative_to(root).as_posix()
            snapshot[relative] = (stat.st_size, _sha256(path.read_bytes()))
        except OSError:
            continue
    return snapshot


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


# ARIA-HIGH-017 — the runs.jsonl row is an append-only, hash-chained
# INDEX, not a payload store: the full parsed output already persists in
# the run's runtime artifact (tool_health splits _runtime_artifact_payload
# out before the row is written). Derived inline fields larger than the
# cap are replaced by a digest stub so one verbose run can never make
# every future reader pay for it — and never trip the ledger row cap.
# The discipline itself lives in ``ledger_inline`` (ARIA-HIGH-034: one
# implementation for every writer); ``tool_health.RUNS_ROW_RECOVERY`` names
# where a runs.jsonl reader recovers the bulk.
def _spill_oversized_inline(field: str, value):
    return spill_oversized_inline(field, value, recovery=RUNS_ROW_RECOVERY)


def _sha256(payload: bytes) -> str:
    return sha256_digest(payload)


def _array_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _non_negative_number(value: Any, *, default: int | None) -> int | float | None:
    if value is None:
        return default
    if isinstance(value, (int, float)) and value >= 0:
        return value
    return None


def _valid_memory_candidates(candidates: list[Any], tool_id: str) -> list[dict[str, Any]]:
    valid = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        belief_id = candidate.get("belief_id")
        claim = candidate.get("claim")
        # ORPHAN-HIGH-541 — out-of-range confidence DROPS the candidate.
        # The previous clamp (`min(float(confidence), 1.0)`) failed open: an
        # adapter emitting a count or a severity as `confidence` was promoted
        # to 1.0, maximum certainty, and recorded as a belief weight.
        confidence = confidence_in_unit_interval(candidate.get("confidence"))
        evidence_refs = candidate.get("evidence_refs")
        if (
            not isinstance(belief_id, str)
            or not belief_id.strip()
            or not isinstance(claim, str)
            or not claim.strip()
            or confidence is None
            or not isinstance(evidence_refs, list)
        ):
            continue
        valid.append(
            {
                "belief_id": belief_id,
                "claim": claim,
                "confidence": confidence,
                "evidence_refs": [str(ref) for ref in evidence_refs if isinstance(ref, str) and ref.strip()],
                "source_tool_id": str(candidate.get("source_tool_id") or tool_id),
            },
        )
    return valid


def _raw_finding_sample(findings: list[Any]) -> list[dict[str, Any]]:
    sample = []
    for finding in findings[:RAW_SAMPLE_LIMIT]:
        if isinstance(finding, dict):
            sample.append(finding)
    return sample


def _decode_timeout_stream(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
