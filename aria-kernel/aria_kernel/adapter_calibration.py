from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_jsonl as load_chained_jsonl
from .readiness import adapter_active_readiness
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, utc_now


__all__ = [
    "generate_adapter_calibration_report",
    "list_adapter_calibration_reports",
    "compute_auto_promote_token",
    "AutoPromoteIneligibleError",
]


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
) -> dict[str, Any]:
    if not tool_ids or not all(isinstance(tool_id, str) and tool_id.strip() for tool_id in tool_ids):
        raise GovernanceError("adapter calibration report requires tool_ids")
    reports = [_tool_report(tool_id.strip(), base_dir) for tool_id in tool_ids]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
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
      ``operator_approval=True`` ONLY when ``evidence_chains_valid=True``
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
    """Workspace-bound HMAC key.

    Uses the contract hash from ``tools_contract_version`` if available;
    falls back to a sha256 of the resolved aria-tools root path. Either
    way, tokens minted in workspace A do not verify in workspace B —
    the consume-time half is wired since ORPHAN-HIGH-787
    (``verify_auto_promote_token`` re-derives this same key).
    """
    return hashlib.sha256(str(root.resolve()).encode("utf-8")).digest()
