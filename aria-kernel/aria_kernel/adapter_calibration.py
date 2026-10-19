from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import uuid
from pathlib import Path
from typing import Any

from .git_object_id import ANY_OBJECT_FORMAT, is_object_id
from .ledger import append_declared_jsonl, load_jsonl as load_chained_jsonl
from .readiness import adapter_active_readiness
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, utc_now


__all__ = [
    "ACTIVE_EVIDENCE_FIELDS",
    "active_transition_evidence",
    "generate_adapter_calibration_report",
    "list_adapter_calibration_reports",
    "compute_auto_promote_token",
    "AutoPromoteIneligibleError",
    "verify_active_transition_evidence",
]

# ARIA-HIGH-004 — what a SHADOW -> ACTIVE transition binds: the calibration
# report that measured the tool (by id and ledger hash), the readiness verdict
# that report holds (by hash), the fixture run that verdict read, the tool
# version measured and the commit the report's cycle ran at. Built here
# (``active_transition_evidence``) and verified here
# (``verify_active_transition_evidence``), so the promotion callers and the
# registry's transition hold one definition of it.
ACTIVE_EVIDENCE_FIELDS: tuple[str, ...] = (
    "calibration_report_ref",
    "calibration_report_hash",
    "readiness_verdict_hash",
    "fixture_run_refs",
    "tool_version",
    "target_sha",
)


class AutoPromoteIneligibleError(Exception):
    """Plan ARIA-V6 §2e v2 — adapter does not meet auto-promote gates.

    Raised by ``compute_auto_promote_token`` when ANY of:
      * runtime profile not in policy.auto_promote.profiles
      * policy.auto_promote.enabled == False
      * precision_history.min() < policy.auto_promote.min_precision
      * len(precision_history) < policy.auto_promote.min_clean_cycles
      * critical_false_positives_count > 0 over the window
    """


def generate_adapter_calibration_report(
    *,
    tool_ids: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    target_sha: str | None = None,
) -> dict[str, Any]:
    """One calibration report over ``tool_ids``: each tool's readiness verdict.

    ARIA-HIGH-004 — the report is joinable: its own id, and the commit of the
    cycle that produced it (``target_sha`` from the caller's envelope; None
    when the caller names none, which no ACTIVE transition accepts).
    """
    if not tool_ids or not all(isinstance(tool_id, str) and tool_id.strip() for tool_id in tool_ids):
        raise GovernanceError("adapter calibration report requires tool_ids")
    if target_sha is not None and not is_object_id(target_sha, formats=ANY_OBJECT_FORMAT):
        raise GovernanceError("adapter calibration target_sha must be a full git object id")
    reports = [_tool_report(tool_id.strip(), base_dir) for tool_id in tool_ids]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "report_id": f"acal-{uuid.uuid4().hex[:24]}",
        "target_sha": target_sha,
        "cycle_id": cycle_id,
        "tool_ids": [report["tool_id"] for report in reports],
        "reports": reports,
        "active_ready_count": sum(1 for report in reports if report["active_ready"]),
        "blocked_count": sum(1 for report in reports if not report["active_ready"]),
        "status": "active_ready" if all(report["active_ready"] for report in reports) else "blocked",
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "calibration" / "adapter-calibration-reports.jsonl", row, expected_surface="calibration_adapter_reports")


def list_adapter_calibration_reports(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_chained_jsonl(ensure_tools_dir(base_dir) / "calibration" / "adapter-calibration-reports.jsonl")


def _tool_report(tool_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    if tool.get("kind") != "adapter":
        raise GovernanceError(f"tool is not an adapter: {tool_id}")
    return adapter_active_readiness(tool_id, base_dir=base_dir)


def _report_fixture_run_ref(report: dict[str, Any]) -> str | None:
    """The fixture run a readiness verdict read (its latest suite row)."""
    latest = (report.get("fixture_status") or {}).get("latest") or {}
    ref = latest.get("execution_run_id")
    return str(ref) if isinstance(ref, str) and ref.strip() else None


def _newest_tool_report(
    tool_id: str, base_dir: str | Path | None,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for row in reversed(list_adapter_calibration_reports(base_dir=base_dir)):
        for report in row.get("reports") or []:
            if isinstance(report, dict) and report.get("tool_id") == tool_id:
                return row, report
    return None


def active_transition_evidence(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The evidence a SHADOW -> ACTIVE transition of ``tool_id`` binds.

    Taken from the NEWEST calibration report that measured the tool — never
    an older green one past a newer red one. Raises GovernanceError naming
    the gap when no report measured the tool; everything else (a report that
    is not green, a stale fixture, an unbound commit) is refused by
    ``verify_active_transition_evidence`` with its own name.
    """
    found = _newest_tool_report(tool_id, base_dir)
    if found is None:
        raise GovernanceError(
            f"active_evidence_calibration_report_missing: no adapter calibration report measured {tool_id}"
        )
    row, report = found
    fixture_ref = _report_fixture_run_ref(report)
    return {
        "calibration_report_ref": row.get("report_id"),
        "calibration_report_hash": row.get("ledger_hash"),
        "readiness_verdict_hash": report.get("verdict_hash"),
        "fixture_run_refs": [fixture_ref] if fixture_ref else [],
        "tool_version": report.get("tool_version"),
        "target_sha": row.get("target_sha"),
    }


def verify_active_transition_evidence(
    tool_id: str,
    evidence: Any,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Refuse a SHADOW -> ACTIVE transition whose evidence is missing, stale
    or mismatched; return the verified evidence otherwise.

    Re-derived from the ledgers, never taken from the caller: the report is
    found by id and must carry the claimed ledger hash and be the newest
    report that measured the tool; its verdict for the tool must be green,
    hash to what it records and to what the evidence names, and describe the
    registered tool's current version and manifest; the fixture run it read
    must still be the tool's current passing suite; and the report must name
    the commit it measured, the commit the evidence names.
    """
    from .fixture_runner import latest_fixture_status, tool_manifest_hash
    from .readiness import readiness_verdict_hash

    def refuse(reason: str) -> GovernanceError:
        return GovernanceError(f"active_evidence_{reason}: tool_id={tool_id}")

    if evidence is None:
        raise refuse("missing")
    if not isinstance(evidence, dict) or set(evidence) != set(ACTIVE_EVIDENCE_FIELDS):
        raise refuse("malformed")
    tool = get_tool(tool_id, base_dir)
    found = _newest_tool_report(tool_id, base_dir)
    if found is None:
        raise refuse("calibration_report_missing")
    row, report = found
    if row.get("report_id") != evidence["calibration_report_ref"]:
        raise refuse("calibration_report_not_newest")
    if row.get("ledger_hash") != evidence["calibration_report_hash"]:
        raise refuse("calibration_report_hash_mismatch")
    target_sha = row.get("target_sha")
    if not is_object_id(target_sha, formats=ANY_OBJECT_FORMAT):
        raise refuse("calibration_report_target_unbound")
    if evidence["target_sha"] != target_sha:
        raise refuse("target_sha_mismatch")
    if report.get("active_ready") is not True:
        raise refuse("readiness_not_active_ready")
    recorded_hash = report.get("verdict_hash")
    if recorded_hash != readiness_verdict_hash(report) or evidence["readiness_verdict_hash"] != recorded_hash:
        raise refuse("readiness_verdict_hash_mismatch")
    if (
        report.get("tool_version") != tool.get("version")
        or evidence["tool_version"] != tool.get("version")
        or report.get("tool_manifest_hash") != tool_manifest_hash(tool)
    ):
        raise refuse("tool_changed_since_calibration")
    fixture_ref = _report_fixture_run_ref(report)
    if fixture_ref is None or evidence["fixture_run_refs"] != [fixture_ref]:
        raise refuse("fixture_run_mismatch")
    current = latest_fixture_status(tool_id, base_dir=base_dir)
    if not current["current_tool_passed"] or (current.get("latest") or {}).get("execution_run_id") != fixture_ref:
        raise refuse("fixture_run_stale")
    return {field: evidence[field] for field in ACTIVE_EVIDENCE_FIELDS}


def compute_auto_promote_token(
    *,
    tool_id: str,
    base_dir: str | Path | None,
    profile: str,
    cycle_id: str | None = None,
    base_commit_sha: str | None = None,
) -> str:
    """Plan ARIA-V6 §2e v2 — tamper-evident auto-promote token.

    Reads the adapter's precision_history from the calibration ledger,
    checks ALL policy.auto_promote gates, and returns an HMAC-SHA256
    token bound to (tool_id, cycle_id, base_commit_sha, last_N runs).

    Returns:
      A ``v1:<base64url(payload)>:<hmac>`` envelope token. The token is
      consumed by ``tool_registry.transition_tool(..., auto_promote_token=<token>)``
      which re-verifies the MAC and the tool binding at consume time
      (ORPHAN-HIGH-787) and treats it as equivalent to
      a resolved ``operator_approval_ref`` ONLY when ``evidence_chains_valid=True``
      (literal predicate pinned by I-V6.4-04).

    Raises:
      AutoPromoteIneligibleError: ANY policy gate fails. The adapter
        STAYS in SHADOW; operator_approval path remains the only
        path to ACTIVE.

    Why HMAC over raw hash:
      A raw SHA256 over public fields would let any caller fabricate
      a token. The HMAC key is derived from the base_dir contract
      hash (bound to the workspace identity), so the token is valid
      only inside the workspace that minted it. ORPHAN-HIGH-787 wired
      the consume-time half: the token is a self-describing envelope
      (``v1:<base64url(payload)>:<hmac>``) and
      ``transition_tool`` re-verifies the MAC against the SAME
      workspace key and the tool binding before treating it as an
      authority — replay across workspaces, tools, or a fabricated
      string all refuse. Pre-787 the consumer accepted any non-None
      token; that hole is closed, and the payload is inspectable at
      consume time for audit.
    """
    # Lazy import — genesis_policy reads the default JSON; importing
    # at module load would create a cycle with tool_registry.
    from .genesis_policy import auto_promote_policy
    policy = auto_promote_policy(repo_root=base_dir)
    if not policy["enabled"]:
        raise AutoPromoteIneligibleError(
            f"auto_promote_disabled_by_policy: tool_id={tool_id!r}"
        )
    if profile not in policy["profiles"]:
        raise AutoPromoteIneligibleError(
            f"auto_promote_profile_not_allowed: profile={profile!r} "
            f"allowed={policy['profiles']!r}"
        )

    history = _precision_history(tool_id, base_dir)
    min_cycles = int(policy["min_clean_cycles"])
    if len(history) < min_cycles:
        raise AutoPromoteIneligibleError(
            f"auto_promote_insufficient_history: tool_id={tool_id!r} "
            f"history_len={len(history)} min_required={min_cycles}"
        )
    window = history[-min_cycles:]
    min_precision = float(policy["min_precision"])
    for row in window:
        prec = float(row.get("precision") or 0.0)
        if prec < min_precision:
            raise AutoPromoteIneligibleError(
                f"auto_promote_precision_below_floor: tool_id={tool_id!r} "
                f"observed={prec} required={min_precision}"
            )
        cfps = int(row.get("critical_false_positives") or 0)
        if cfps > 0:
            raise AutoPromoteIneligibleError(
                f"auto_promote_critical_fp_present: tool_id={tool_id!r} "
                f"critical_false_positives={cfps}"
            )
    # ARIA-HIGH-125 — the window above is the judges' precision on the
    # adapter's findings; ARIA promoting itself also needs the number nobody
    # in its loop wrote: the newest fitness report's measurement against the
    # promoted gold corpus, current and at the adapter's floor.
    from .role_fitness import adapter_fitness_blocker

    fitness_blocker = adapter_fitness_blocker(tool_id, base_dir=base_dir)
    if fitness_blocker is not None:
        raise AutoPromoteIneligibleError(f"auto_promote_{fitness_blocker}: tool_id={tool_id!r}")

    # Tamper-evident HMAC token bound to workspace + cycle + commit.
    # ORPHAN-HIGH-787 — self-describing envelope so the CONSUMER can
    # recompute the MAC: the payload rides inside the token (base64url),
    # and verify_auto_promote_token re-derives key + MAC at consume time.
    root = ensure_tools_dir(base_dir)
    workspace_key = _derive_workspace_key(root)
    payload = json.dumps({
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "base_commit_sha": base_commit_sha,
        "profile": profile,
        "window_precision": [r.get("precision") for r in window],
        "window_recorded_at": [r.get("recorded_at") for r in window],
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    mac = hmac.new(workspace_key, payload, hashlib.sha256).hexdigest()
    import base64 as _base64

    body_b64 = _base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"v1:{body_b64}:{mac}"


def verify_auto_promote_token(
    token: str | None,
    *,
    tool_id: str,
    base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """ORPHAN-HIGH-787 — consume-time verification of the auto-promote token.

    Returns the authenticated payload, or None for ANY of: a token that is
    not a v1 envelope, a MAC that does not match this workspace's key, a
    tampered payload, or a payload minted for a different tool. The caller
    treats None as "no token presented" — no error message distinguishes
    the failure modes, because a forged token must not learn which check
    it failed.
    """
    if not isinstance(token, str):
        return None
    parts = token.split(":")
    if len(parts) != 3 or parts[0] != "v1":
        return None
    _, body_b64, mac = parts
    import base64 as _base64

    try:
        body = _base64.urlsafe_b64decode(body_b64 + "=" * (-len(body_b64) % 4))
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    root = ensure_tools_dir(base_dir)
    expected = hmac.new(_derive_workspace_key(root), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(mac)):
        return None
    if str(payload.get("tool_id") or "") != str(tool_id):
        return None
    return payload


def _precision_history(
    tool_id: str,
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V6 §2e v2 — read calibration ledger for tool_id."""
    root = ensure_tools_dir(base_dir)
    path = root / "calibration" / "adapter-calibration-reports.jsonl"
    if not path.exists():
        return []
    rows = load_chained_jsonl(path)
    out: list[dict[str, Any]] = []
    for row in rows:
        for report in row.get("reports") or []:
            if report.get("tool_id") != tool_id:
                continue
            out.append({
                "recorded_at": row.get("recorded_at"),
                "precision": report.get("precision"),
                "critical_false_positives": report.get("critical_false_positives", 0),
                "active_ready": report.get("active_ready", False),
            })
    return out


def _derive_workspace_key(root: Path) -> bytes:
    """Workspace-bound HMAC key made of SECRET material, never the path.

    Priority: the ``ARIA_WORKSPACE_HMAC_KEY`` external secret (hex, >=32
    bytes — CI injects it from the environment's secret store, and
    rotating it invalidates every outstanding token), then a per-store
    random secret persisted at ``.workspace-secret`` with 0600 (created
    on first use). A store recreated at the same path gets a NEW key, so
    a replayed token cannot ride public knowledge of the directory name —
    the exact forgery class the audit reproduced against the previous
    path-hash derivation. Both promotion lanes (auto and panel) share
    this one derivation (i1), so the property covers both token families.
    """
    external = os.environ.get("ARIA_WORKSPACE_HMAC_KEY", "").strip()
    if external:
        try:
            material = bytes.fromhex(external)
        except ValueError as exc:
            raise GovernanceError(
                "ARIA_WORKSPACE_HMAC_KEY must be hex-encoded secret material"
            ) from exc
        if len(material) < 32:
            raise GovernanceError(
                "ARIA_WORKSPACE_HMAC_KEY must carry at least 32 bytes"
            )
        return material
    secret_path = root / ".workspace-secret"
    try:
        material = bytes.fromhex(secret_path.read_text(encoding="utf-8").strip())
        if len(material) >= 32:
            return material
    except (OSError, ValueError):
        pass
    material = secrets.token_bytes(32)
    secret_path.write_text(material.hex() + "\n", encoding="utf-8")
    try:
        os.chmod(secret_path, 0o600)
    except OSError:  # pragma: no cover - platforms without POSIX modes
        pass
    return material
