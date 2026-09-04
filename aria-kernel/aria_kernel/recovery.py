"""Plan 032 Faz 032c — recovery is a classification, not a restart.

WHY: when an executor died mid-request the only mechanisms were "requeue"
(lease expiry, `reap_stale_claims`) and "wait for the outage reaper". Neither
asked what the agent had already DONE. A request whose agent pushed a branch
and opened a PR before the runner was killed would be re-run from scratch
and push again — the duplicate-external-effect failure the second review of
2026-09-02 named first.

WHAT:

* ``external-effects.jsonl`` — an INTENT is recorded before every external
  write the kernel performs on an agent's behalf (push, PR create) with an
  idempotency key and the intended postcondition; a RECEIPT is recorded after,
  with what the remote said. Intent without receipt is the ambiguous state
  this module exists to resolve.
* :func:`classify_recovery` — for a request about to be re-dispatched: read
  the journal (Faz 032b-2), the effects ledger and, for every intent without
  a receipt, ask the REMOTE (an injected reader; the production reader shells
  `gh`) whether the effect happened. The decision is one of
  ``idempotent_replay`` (nothing external happened — run again),
  ``resume`` (a session exists and the fingerprint matches — continue it),
  ``external_effect_check`` (an intent is unresolved but the remote answered —
  record the receipt and continue), ``human_required`` (an intent is
  unresolved and the remote could not say). Every decision lands on
  ``recovery/decisions.jsonl``.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import ensure_tools_dir, utc_now

EXTERNAL_EFFECTS_SURFACE = "external_effects"
EXTERNAL_EFFECTS_RELPATH = ("recovery", "external-effects.jsonl")
RECOVERY_DECISIONS_SURFACE = "recovery_decisions"
RECOVERY_DECISIONS_RELPATH = ("recovery", "decisions.jsonl")
EXTERNAL_EFFECT_KINDS: tuple[str, ...] = ("git_push", "pr_create", "pr_comment", "gh_api_write", "state_publish")
RECOVERY_DECISIONS: tuple[str, ...] = ("idempotent_replay", "resume", "external_effect_check", "human_required")

RemoteReader = Callable[[dict[str, Any]], dict[str, Any] | None]


@dataclass(frozen=True)
class RecoveryDecision:
    request_id: str
    decision: str
    reason: str
    unresolved_intents: tuple[str, ...]
    session_id: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id, "decision": self.decision, "reason": self.reason,
            "unresolved_intents": list(self.unresolved_intents), "session_id": self.session_id,
        }


def idempotency_key(*, effect_kind: str, target: str, intended: Mapping[str, Any]) -> str:
    payload = json.dumps({"kind": effect_kind, "target": target, "intended": dict(intended)}, sort_keys=True)
    return "idem:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def record_intent(
    *,
    request_id: str,
    effect_kind: str,
    target: str,
    intended_postcondition: Mapping[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if effect_kind not in EXTERNAL_EFFECT_KINDS:
        raise ValueError(f"external_effect_kind_unknown:{effect_kind}")
    key = idempotency_key(effect_kind=effect_kind, target=target, intended=intended_postcondition)
    return append_declared_jsonl(
        ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH),
        {
            "schema_version": 1, "event": "intent", "recorded_at": utc_now(), "request_id": request_id,
            "operation_id": f"{effect_kind}:{key}", "effect_kind": effect_kind, "target": target,
            "idempotency_key": key, "intended_postcondition": dict(intended_postcondition),
        },
        expected_surface=EXTERNAL_EFFECTS_SURFACE,
    )


def record_receipt(
    *,
    operation_id: str,
    request_id: str,
    observed: Mapping[str, Any],
    status: str = "confirmed",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if status not in ("confirmed", "failed", "absent"):
        raise ValueError(f"receipt_status_unknown:{status}")
    return append_declared_jsonl(
        ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH),
        {
            "schema_version": 1, "event": "receipt", "recorded_at": utc_now(), "request_id": request_id,
            "operation_id": operation_id, "status": status, "observed_receipt": dict(observed),
        },
        expected_surface=EXTERNAL_EFFECTS_SURFACE,
    )


def unresolved_intents(request_id: str, *, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH)
    if not path.exists():
        return []
    rows = [r for r in load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE) if r.get("request_id") == request_id]
    receipted = {r["operation_id"] for r in rows if r.get("event") == "receipt"}
    return [r for r in rows if r.get("event") == "intent" and r["operation_id"] not in receipted]


def gh_remote_reader(cwd: str | Path = ".") -> RemoteReader:
    """The production reader: asks GitHub whether an intent's postcondition holds.

    Returns the observed receipt, or None when the remote cannot answer (no
    `gh`, no token, API error) — None is what makes a decision `human_required`.
    """

    def read(intent: dict[str, Any]) -> dict[str, Any] | None:
        kind = intent.get("effect_kind")
        intended = intent.get("intended_postcondition") or {}
        try:
            if kind == "pr_create":
                head = str(intended.get("head_ref") or "")
                out = subprocess.run(
                    ["gh", "pr", "list", "--head", head, "--state", "all", "--json", "number,url,headRefOid,state", "--limit", "5"],
                    cwd=str(cwd), capture_output=True, text=True, timeout=60, check=False,
                )
                if out.returncode != 0:
                    return None
                prs = json.loads(out.stdout or "[]")
                return {"present": bool(prs), "prs": prs}
            if kind == "git_push":
                branch = str(intended.get("branch") or "")
                out = subprocess.run(
                    ["git", "ls-remote", "--heads", "origin", branch],
                    cwd=str(cwd), capture_output=True, text=True, timeout=60, check=False,
                )
                if out.returncode != 0:
                    return None
                sha = out.stdout.split()[0] if out.stdout.strip() else None
                return {"present": sha is not None, "remote_sha": sha}
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
        return None

    return read


def classify_recovery(
    request_id: str,
    *,
    base_dir: str | Path | None = None,
    fingerprint: str | None = None,
    remote_reader: RemoteReader | None = None,
) -> RecoveryDecision:
    """Decide how a re-dispatch of ``request_id`` must proceed. Records the decision."""
    from .session_continuity import last_session_for

    pending = unresolved_intents(request_id, base_dir=base_dir)
    unresolved_ids: list[str] = []
    resolved_by_remote = 0
    for intent in pending:
        observed = remote_reader(intent) if remote_reader is not None else None
        if observed is None:
            unresolved_ids.append(str(intent["operation_id"]))
            continue
        record_receipt(
            operation_id=str(intent["operation_id"]), request_id=request_id, observed=observed,
            status="confirmed" if observed.get("present") else "absent", base_dir=base_dir,
        )
        resolved_by_remote += 1
    session = last_session_for(request_id, base_dir=base_dir)
    if unresolved_ids:
        decision = RecoveryDecision(request_id, "human_required",
                                    f"unresolved_external_intents:{len(unresolved_ids)}",
                                    tuple(unresolved_ids), session.get("claude_session_id") if session else None)
    elif resolved_by_remote:
        decision = RecoveryDecision(request_id, "external_effect_check",
                                    f"receipts_recorded:{resolved_by_remote}", (), None)
    elif session and fingerprint and session.get("fingerprint") == fingerprint and session.get("journal_rows", 0) > 0:
        decision = RecoveryDecision(request_id, "resume", "fingerprint_match_with_progress", (),
                                    str(session.get("claude_session_id")))
    else:
        reason = "no_external_effects"
        if session and fingerprint and session.get("fingerprint") != fingerprint:
            reason = "fingerprint_changed"
        elif session and not session.get("journal_rows"):
            reason = "session_without_progress"
        decision = RecoveryDecision(request_id, "idempotent_replay", reason, (), None)
    append_declared_jsonl(
        ensure_tools_dir(base_dir).joinpath(*RECOVERY_DECISIONS_RELPATH),
        {"schema_version": 1, "recorded_at": utc_now(), **decision.to_dict()},
        expected_surface=RECOVERY_DECISIONS_SURFACE,
    )
    return decision


__all__ = [
    "EXTERNAL_EFFECTS_RELPATH", "EXTERNAL_EFFECTS_SURFACE", "EXTERNAL_EFFECT_KINDS", "RECOVERY_DECISIONS",
    "RECOVERY_DECISIONS_RELPATH", "RECOVERY_DECISIONS_SURFACE", "RecoveryDecision", "classify_recovery",
    "gh_remote_reader", "idempotency_key", "record_intent", "record_receipt", "unresolved_intents",
]
