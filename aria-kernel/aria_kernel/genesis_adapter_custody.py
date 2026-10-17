"""ARIA-HIGH-414 — custody of a skill-genesis drafted adapter, from the
drafter's accepted result to every run of it.

WHY. The bytes a drafter writes were trusted at every step and verified at none:

* Phase 2 calibrated ``python3 <draft_id>``: ``select_sandbox_runner`` ran
  ``adapter_path or draft_id`` and ``_normalize_drafter_response`` never set
  ``adapter_path``, so the drafted source never ran and ``authored_validated``
  could certify any file the drafter named;
* the materializer (draft PR #1900) wrote the source into the workspace and
  compared it against a sha256 it had just written itself, which proves
  nothing, and nothing re-hashed the file at dispatch;
* the import allowlist was a static walk of ``import`` statements, which the
  probe bypassed six ways;
* a drafted adapter could reach ACTIVE on the auto-promote token alone.

WHAT — one owner for the bytes:

* They come ONLY from the drafter's accepted result
  (``agent_invocations.accepted_result_for_request``, its artifact re-hashed
  against the row's ``output_hash``). That row is provenance the kernel
  records and the drafter cannot write. A draft field or a path never
  supplies them.
* They run ONLY through the kernel's launcher
  (``tools/aria-poc/genesis_adapter_launcher.py``) inside the adapter room.
  The bytes travel on stdin, their digest on the command line; the launcher
  re-hashes them and enforces the import allowlist at runtime.
* Calibration records the digest it ran (``skill-genesis/sandbox.jsonl``).
  Registration requires that digest to be the passing calibration's, and
  records the bytes themselves in custody
  (``skill-genesis/materializations.jsonl``, hash-chained). No adapter file is
  ever written, so nothing can be swapped under a path or follow a symlink,
  and a refused registration withdraws its custody row.
* Every dispatch (``verify_genesis_dispatch``: the tool runner and the
  fixture runner) re-hashes the custody bytes against the custody and
  calibration digests before they run. Promotion to ACTIVE needs the same,
  plus an operator act or the panel, each verified
  (``verify_genesis_promotion``).
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .adapter_room import prepare_adapter_spawn, run_adapter
# The checkout root is implementation_safety's: the one place it is derived
# (ARIA-HIGH-431, the anchor of the trusted-code rule).
from .implementation_safety import KERNEL_CHECKOUT_ROOT
from .ledger import append_declared_jsonl, load_declared_jsonl
from .skill_genesis_sandbox import ALLOWED_ADAPTER_IMPORTS, UnsafeAdapterImport, verify_adapter_imports
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    list_tools,
    utc_now,
)

GENESIS_LAUNCHER_RELPATH = "tools/aria-poc/genesis_adapter_launcher.py"
GENESIS_LAUNCHER_NAME = Path(GENESIS_LAUNCHER_RELPATH).name
# The runner a registered genesis adapter declares, in the argv policy's
# relative shape. Dispatch never runs a workspace copy of the launcher (a
# request worktree could edit one): it runs the kernel's own, with the
# custody digest appended.
GENESIS_RUNNER_BASE: Mapping[str, Any] = {
    "type": "subprocess", "argv": ["python3", GENESIS_LAUNCHER_RELPATH], "cwd": ".", "stdin_json": True,
}
# The calibration executor's budget; a seed may set its own `timeout_ms`.
# The drafter's manifest never chooses it.
GENESIS_ADAPTER_TIMEOUT_MS_DEFAULT = 300_000
# A detection adapter is small; the bound keeps a custody row far under the
# ledger's 1 MiB row cap.
GENESIS_ADAPTER_SOURCE_MAX_BYTES = 256 * 1024
GENESIS_TOOL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
GENESIS_TOOL_OWNER = "skill_genesis"
PRIMARY_DRAFTER_ROLE = "primary_authoring"
CALIBRATION_KIND = "adapter_calibration"
CUSTODY_KIND = "adapter_custody"
_SANDBOX_LEDGER = ("skill-genesis/sandbox.jsonl", "skill_genesis_sandbox")
_CUSTODY_LEDGER = ("skill-genesis/materializations.jsonl", "skill_genesis_materializations")
# Manifest fields only the kernel writes; a drafted value is dropped.
# ARIA-LOW-533 — `security_class` too: a drafter may not declare its adapter
# cuttable by the calibration actuator; undeclared, it reads as security class
# (`tool_registry.is_security_class`).
_KERNEL_OWNED_MANIFEST_FIELDS = (
    "quarantine", "last_transition", "parse_window_signature", "created_at", "updated_at", "security_class",
)


class GenesisCustodyRefusal(GovernanceError):
    """A drafted adapter's bytes, provenance or authority did not verify.
    The message starts with the reason's name."""


@dataclass(frozen=True)
class StagedAdapter:
    """The drafter's adapter as its accepted result delivered it."""

    source: str
    sha256: str
    manifest: dict[str, Any]
    provenance: dict[str, Any]


@dataclass(frozen=True)
class GenesisCommand:
    """The contained command that runs verified genesis bytes: the kernel's
    launcher with the digest, and the stdin header that carries the bytes."""

    argv: list[str]
    stdin_header: str
    sha256: str


def source_sha256(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def launcher_command(source: str, sha256: str) -> GenesisCommand:
    """The launcher command for ``source``; refuses bytes that are not ``sha256``."""
    if source_sha256(source) != sha256:
        raise GenesisCustodyRefusal(f"genesis_adapter_bytes_unverified: sha256 {sha256[:12]} does not match the bytes")
    # ensure_ascii keeps the header one ASCII line whatever the locale encodes.
    header = json.dumps({"source": source, "allowed_imports": sorted(ALLOWED_ADAPTER_IMPORTS)}) + "\n"
    return GenesisCommand(
        argv=["python3", str(KERNEL_CHECKOUT_ROOT / GENESIS_LAUNCHER_RELPATH), sha256],
        stdin_header=header,
        sha256=sha256,
    )


def stage_accepted_draft(invocation_request_id: Any, *, base_dir: str | Path | None) -> StagedAdapter:
    """Read the drafted adapter from the primary drafter's ACCEPTED result.

    The draft dict the authoring loop carries is not consulted for the bytes:
    the artifact is re-read and re-hashed against the result row's
    ``output_hash``. The static import check runs here, so a draft with an
    obvious forbidden import is refused by name before it reaches a room.
    """
    from .dispatcher_factory import accepted_response

    request_id = str(invocation_request_id or "")
    found = accepted_response(request_id, base_dir, role=PRIMARY_DRAFTER_ROLE)
    if found is None:
        raise GenesisCustodyRefusal(
            f"genesis_adapter_provenance_unresolved: request_id={request_id!r} has no accepted "
            f"{PRIMARY_DRAFTER_ROLE} result whose artifact matches its output_hash"
        )
    row, payload = found
    details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
    source = details.get("adapter_source")
    manifest = details.get("adapter_manifest")
    if not isinstance(source, str) or not source.strip():
        raise GenesisCustodyRefusal(f"genesis_adapter_source_missing: request_id={request_id!r}")
    if not isinstance(manifest, dict) or not manifest:
        raise GenesisCustodyRefusal(f"genesis_adapter_manifest_missing: request_id={request_id!r}")
    language = details.get("adapter_lang", "python")
    if language != "python":
        # The allowlist exists for Python only, and only Python is enforced.
        raise GenesisCustodyRefusal(f"genesis_adapter_lang_unsupported: {str(language)[:40]!r} (python only)")
    if len(source.encode("utf-8")) > GENESIS_ADAPTER_SOURCE_MAX_BYTES:
        raise GenesisCustodyRefusal(f"genesis_adapter_source_too_large: over {GENESIS_ADAPTER_SOURCE_MAX_BYTES} bytes")
    try:
        verify_adapter_imports(source)
    except UnsafeAdapterImport as exc:
        raise GenesisCustodyRefusal(f"unsafe_adapter_import: {exc}") from exc
    provenance = {
        "request_id": request_id,
        "role": row.get("role"),
        "agent_id": row.get("agent_id"),
        "output_hash": row.get("output_hash"),
        "transcript_hash": row.get("transcript_hash"),
        "result_ledger_hash": row.get("ledger_hash"),
    }
    return StagedAdapter(source=source, sha256=source_sha256(source), manifest=deepcopy(manifest), provenance=provenance)


def run_staged_adapter(
    staged: StagedAdapter,
    *,
    workspace_root: str | Path,
    input_text: str,
    timeout_seconds: float,
    store: str | Path | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run staged bytes in the adapter room through the launcher — the one
    place drafted bytes start. ``SandboxUnavailable`` and
    ``subprocess.TimeoutExpired`` propagate to the caller, which owns them."""
    command = launcher_command(staged.source, staged.sha256)
    workspace = Path(workspace_root).resolve()
    spawn = prepare_adapter_spawn(command.argv, workspace_root=workspace, cwd=workspace, store=store)
    return run_adapter(spawn, input_text=command.stdin_header + input_text, timeout_seconds=timeout_seconds)


def record_calibration(
    staged: StagedAdapter,
    *,
    metrics: Mapping[str, Any],
    corpus_path: str | Path,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    """Record a calibration of these bytes and its outcome (a run that never
    started carries its negative exit code). Registration reads this row back
    by its ledger hash, never the loop's in-memory result."""
    relpath, surface = _SANDBOX_LEDGER
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "kind": CALIBRATION_KIND,
        "invocation_request_id": staged.provenance["request_id"],
        "adapter_sha256": staged.sha256,
        "provenance": dict(staged.provenance),
        "corpus_path": str(corpus_path),
        **{key: metrics.get(key) for key in ("fixture_count", "precision", "recall", "critical_false_positives", "exit_code")},
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / relpath, row, expected_surface=surface)


def materialize_drafted_adapter(
    *,
    primary_draft: Mapping[str, Any],
    seed: Mapping[str, Any],
    base_dir: str | Path | None,
    sandbox_result: Mapping[str, Any] | None = None,
    evidence_pack: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Register a validated draft as a SHADOW tool — the authoring loop's
    ``materialize_fn``.

    Refuses unless the accepted result's bytes are exactly the bytes the
    passing calibration ran. The manifest's scope, timeout, runner, health
    thresholds, kind, owner and status are bound by the kernel and the seed;
    the drafter's values for them are not used. ``validate_generated_adapter`` then checks
    the drafter's contract (read paths, claim types, thresholds). Re-running
    for the same bytes is idempotent; a tool id another tool holds is refused.
    """
    del evidence_pack  # part of the materialize_fn contract; the bytes need only the result row
    from .skill_genesis import validate_generated_adapter
    from .tool_registry import register_tool

    root = ensure_tools_dir(base_dir)
    staged = stage_accepted_draft(primary_draft.get("invocation_request_id"), base_dir=root)
    calibration = _passing_calibration(root, sandbox_result, staged)
    manifest = _bound_manifest(staged, seed)
    verdict = validate_generated_adapter(adapter_manifest=manifest, seed=dict(seed))
    if verdict.get("status") != "ok":
        raise GenesisCustodyRefusal("validate_generated_adapter_failed: " + "; ".join(verdict.get("reasons") or []))
    tool_id = manifest["tool_id"]
    custody = genesis_custody(tool_id, base_dir=root)
    if any(str(tool.get("tool_id")) == tool_id for tool in list_tools(base_dir=root)):
        if custody is not None and custody.get("event") == "custody" and custody.get("adapter_sha256") == staged.sha256:
            return _materialized(tool_id, staged.sha256, custody, already_registered=True)
        raise GenesisCustodyRefusal(f"genesis_adapter_tool_id_taken: {tool_id!r} is registered with other bytes or no custody")
    relpath, surface = _CUSTODY_LEDGER
    custody = append_declared_jsonl(root / relpath, {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "kind": CUSTODY_KIND,
        "event": "custody",
        "tool_id": tool_id,
        "seed_id": seed.get("seed_id"),
        "adapter_sha256": staged.sha256,
        "adapter_source": staged.source,
        "provenance": dict(staged.provenance),
        "calibration_ledger_hash": calibration["ledger_hash"],
        "runner": deepcopy(manifest["runner"]),
        "declared_scope": list(manifest["declared_scope"]),
    }, expected_surface=surface)
    try:
        register_tool(manifest, base_dir=root)
    except Exception as exc:
        # Append-only cleanup: the custody row is superseded, so nothing can
        # dispatch these bytes under this tool id, and nothing is left on disk.
        append_declared_jsonl(root / relpath, {
            "schema_version": 1, "recorded_at": utc_now(), "kind": CUSTODY_KIND, "event": "withdrawn",
            "tool_id": tool_id, "adapter_sha256": staged.sha256, "reason": f"register_tool_failed: {str(exc)[:300]}",
        }, expected_surface=surface)
        raise
    append_tools_governance(root, "genesis_adapter_materialized", {
        "tool_id": tool_id, "adapter_sha256": staged.sha256, "custody_ledger_hash": custody.get("ledger_hash"),
        "calibration_ledger_hash": calibration["ledger_hash"], "drafter_request_id": staged.provenance["request_id"],
    })
    return _materialized(tool_id, staged.sha256, custody, already_registered=False)


def genesis_custody(tool_id: str, *, base_dir: str | Path | None) -> dict[str, Any] | None:
    """The latest custody row for ``tool_id`` (a ``custody`` or a ``withdrawn``
    event), or None when the kernel never took custody of it."""
    root = _existing_store(base_dir)
    relpath, surface = _CUSTODY_LEDGER
    if root is None or not (root / relpath).exists():
        return None
    path = root / relpath
    latest: dict[str, Any] | None = None
    for row in load_declared_jsonl(path, expected_surface=surface):
        if row.get("kind") == CUSTODY_KIND and row.get("tool_id") == tool_id:
            latest = row
    return latest


def verify_genesis_dispatch(tool: Mapping[str, Any], *, base_dir: str | Path | None) -> GenesisCommand | None:
    """The command a genesis tool runs as, verified now, or None for a curated tool.

    A tool is a genesis tool when the kernel holds custody of it, or when its
    runner names the launcher. Both are read from records only the kernel
    writes, never from what the drafter put in its manifest. For one, the
    registered runner must still be the custody runner, and the custody
    bytes must hash to the custody digest, which must be the digest of the
    calibration that passed. Any gap is a named refusal and nothing runs.
    """
    tool_id = str(tool.get("tool_id") or "")
    runner = tool.get("runner") if isinstance(tool.get("runner"), dict) else {}
    custody = genesis_custody(tool_id, base_dir=base_dir)
    names_launcher = any(Path(str(part)).name == GENESIS_LAUNCHER_NAME for part in runner.get("argv") or [])
    if custody is None:
        if names_launcher:
            raise GenesisCustodyRefusal(f"genesis_adapter_custody_missing: {tool_id!r} runs the genesis launcher without custody")
        return None
    if custody.get("event") != "custody":
        raise GenesisCustodyRefusal(f"genesis_adapter_custody_withdrawn: {tool_id!r} ({custody.get('reason')})")
    if dict(runner) != custody.get("runner"):
        raise GenesisCustodyRefusal(f"genesis_adapter_runner_drift: {tool_id!r} no longer declares its custody runner")
    sha256 = str(custody.get("adapter_sha256") or "")
    source = custody.get("adapter_source")
    if not isinstance(source, str) or source_sha256(source) != sha256:
        raise GenesisCustodyRefusal(f"genesis_adapter_bytes_unverified: {tool_id!r} custody bytes do not hash to {sha256[:12]}")
    store = _existing_store(base_dir)
    calibration_hash = str(custody.get("calibration_ledger_hash") or "")
    calibration = None if store is None else _ledger_row(store, _SANDBOX_LEDGER, calibration_hash)
    if calibration is None or calibration.get("adapter_sha256") != sha256:
        raise GenesisCustodyRefusal(f"genesis_adapter_calibration_unbound: {tool_id!r} bytes are not the calibrated bytes")
    return launcher_command(source, sha256)


def verify_genesis_promotion(
    tool_id: str,
    *,
    operator_approval: Mapping[str, Any] | None,
    panel_promote_verified: bool,
) -> None:
    """SHADOW -> ACTIVE authority for a genesis tool: an operator act or the
    panel, each as VERIFIED, never as a string's presence. The auto-promote
    token is never that authority: it vouches for precision, and nobody has
    looked at drafted code.

    ``operator_approval`` is the record ``transition_tool`` resolved
    (``resolve_transition_approval`` -> ``operator_approval.verify_operator_
    approval``), not the ref a caller typed; ``panel_promote_verified`` is
    ``promotion_veto.verify_panel_approval_token``'s verdict, not the token.
    The bytes are re-verified earlier, among the structural gates
    (``verify_genesis_dispatch``), so drifted bytes refuse before an act is
    spent; this check fires only when no act resolved, so it spends none.
    ARIA-HIGH-414 item 6 (the wave-2 reproduction): a garbage ref or a forged
    panel string beside a verified auto-promote token promoted drafted code.
    """
    if isinstance(operator_approval, Mapping) or panel_promote_verified is True:
        return
    raise GenesisCustodyRefusal(
        f"genesis_adapter_promotion_requires_operator_or_panel: {tool_id!r} is drafted code; "
        "SHADOW -> ACTIVE needs a resolved operator approval or a verified panel approval token, "
        "not the auto-promote token"
    )


def _passing_calibration(root: Path, sandbox_result: Mapping[str, Any] | None, staged: StagedAdapter) -> dict[str, Any]:
    """The recorded calibration that registration rests on: the row the
    sandbox result names, of these exact bytes, from this drafter result,
    and passing on its own recorded numbers."""
    ledger_hash = str((sandbox_result or {}).get("calibration_ledger_hash") or "")
    row = _ledger_row(root, _SANDBOX_LEDGER, ledger_hash)
    if row is None or row.get("kind") != CALIBRATION_KIND:
        raise GenesisCustodyRefusal(f"genesis_adapter_calibration_unrecorded: {ledger_hash[:16]!r}")
    if row.get("adapter_sha256") != staged.sha256 or row.get("invocation_request_id") != staged.provenance["request_id"]:
        raise GenesisCustodyRefusal(
            "genesis_adapter_calibration_mismatch: the registered bytes are not the bytes the passing calibration ran"
        )
    if row.get("exit_code") != 0 or float(row.get("precision") or 0.0) < 1.0 or int(row.get("critical_false_positives") or 0):
        raise GenesisCustodyRefusal("genesis_adapter_calibration_not_passing: the recorded calibration did not pass")
    return row


def _bound_manifest(staged: StagedAdapter, seed: Mapping[str, Any]) -> dict[str, Any]:
    manifest = deepcopy(staged.manifest)
    tool_id = manifest.get("tool_id")
    if not isinstance(tool_id, str) or not GENESIS_TOOL_ID_RE.match(tool_id):
        raise GenesisCustodyRefusal(f"genesis_adapter_tool_id_invalid: {str(tool_id)[:80]!r} (must match {GENESIS_TOOL_ID_RE.pattern})")
    scope = [str(path) for path in seed.get("declared_scope") or [] if str(path).strip()]
    if not scope:
        raise GenesisCustodyRefusal("genesis_adapter_seed_scope_missing: the seed declares no scope")
    timeout_ms = seed.get("timeout_ms", GENESIS_ADAPTER_TIMEOUT_MS_DEFAULT)
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms <= 0:
        raise GenesisCustodyRefusal(f"genesis_adapter_seed_timeout_invalid: {timeout_ms!r}")
    for field in _KERNEL_OWNED_MANIFEST_FIELDS:
        manifest.pop(field, None)
    forbidden = manifest.get("forbidden_read_globs")
    manifest.update({
        "kind": "adapter",
        "status": "SHADOW",
        "owner": GENESIS_TOOL_OWNER,
        "declared_scope": scope,
        "allowed_read_globs": list(scope),
        # Narrowing only: a drafted forbid list can shrink what is read, never widen it.
        "forbidden_read_globs": list(forbidden) if isinstance(forbidden, list) else [],
        "fixture_set": f"genesis/{tool_id}",
        # How the tool is judged is kernel policy: a drafted `precision_min`
        # would set its own SHADOW -> ACTIVE bar, and the range shape the
        # drafter contract asks for (`{"min", "max"}`) is not the number
        # tool_health reads (`float(max_cost_units)` raised on the first run).
        # The defaults of validate_tool_definition apply.
        "health_thresholds": {},
        "runner": {**deepcopy(dict(GENESIS_RUNNER_BASE)), "timeout_ms": timeout_ms},
        "schema_version": 1,
    })
    return manifest


def _existing_store(base_dir: str | Path | None) -> Path | None:
    """The tools root as it already exists, or None. Read-only: asking
    whether a tool is a genesis tool must not bootstrap a store, and a host
    with no store bound holds no custody (the same reading as
    ``adapter_room``'s masks)."""
    try:
        return ensure_tools_dir_readonly(base_dir)
    except GovernanceError:
        return None


def _ledger_row(root: Path, ledger: tuple[str, str], ledger_hash: str) -> dict[str, Any] | None:
    relpath, surface = ledger
    path = root / relpath
    if not ledger_hash or not path.exists():
        return None
    for row in load_declared_jsonl(path, expected_surface=surface):
        if row.get("ledger_hash") == ledger_hash:
            return row
    return None


def _materialized(tool_id: str, sha256: str, custody: Mapping[str, Any], *, already_registered: bool) -> dict[str, Any]:
    relpath, _surface = _CUSTODY_LEDGER
    return {
        "status": "ok",
        "tool_id": tool_id,
        "adapter_sha256": sha256,
        # Where the adapter lives: its custody row (no adapter file exists).
        "adapter_path": f"{relpath}#{custody.get('ledger_hash')}",
        "manifest_path": f"registry.json#{tool_id}",
        "already_registered": already_registered,
    }


__all__ = [
    "CALIBRATION_KIND",
    "CUSTODY_KIND",
    "GENESIS_ADAPTER_SOURCE_MAX_BYTES",
    "GENESIS_ADAPTER_TIMEOUT_MS_DEFAULT",
    "GENESIS_LAUNCHER_RELPATH",
    "GENESIS_RUNNER_BASE",
    "GenesisCommand",
    "GenesisCustodyRefusal",
    "StagedAdapter",
    "genesis_custody",
    "launcher_command",
    "materialize_drafted_adapter",
    "record_calibration",
    "run_staged_adapter",
    "source_sha256",
    "stage_accepted_draft",
    "verify_genesis_dispatch",
    "verify_genesis_promotion",
]
