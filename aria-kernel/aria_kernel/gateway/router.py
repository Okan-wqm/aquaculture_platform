"""Deterministic routing: one closed action per event kind, every outcome on the inbox."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from datetime import datetime as _datetime

from ..tool_registry import append_tools_governance, ensure_tools_dir
from ..tool_registry import GovernanceError as _GovernanceError
from ..file_lock import with_exclusive_lock as _with_exclusive_lock
from . import inbox as _inbox
from .inbox import mark_routed, pending_events
from .normalize import ARIA_ISSUE_LABEL, NormalizedEvent, event_from_dict as _event_from_dict

ROUTE_ACTIONS: tuple[str, ...] = (
    "mission_open", "issue_command_recorded", "pr_event", "runtime_signal", "alert_resolved_recorded",
    "operator_control", "ignored",
)
ISSUE_MISSION_NEXT_ACTION = "triage_github_issue"
ISSUE_MISSION_SOURCE_KIND = "github_issue"
_MISSION_ROUTE_NOT_PENDING = "mission_route_not_pending"


@dataclass(frozen=True)
class RouteOutcome:
    action: str
    refs: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


def _repo_hash(workspace_root: str | Path) -> str:
    from ..workspace import canonical_identity

    return canonical_identity(Path(workspace_root).resolve())


def _is_issue_mission(event: NormalizedEvent) -> bool:
    return (event.kind in {"github.issue_opened", "github.issue_labeled"}
            and ARIA_ISSUE_LABEL in (event.subject.get("labels") or []))


def _mission_outcome(
    *, attempt: dict[str, Any], status: str, issue: Any, error: str | None = None,
    mission_state: str | None = None, idempotent: bool = False,
) -> RouteOutcome:
    descriptor = attempt["mission_route"]
    refs = {"mission_id": descriptor["mission_id"], "issue": issue, "idempotent": idempotent,
            "mission_route": {**descriptor, "attempt_ledger_hash": attempt["ledger_hash"], "status": status}}
    if mission_state is not None:
        refs["mission_state"] = mission_state
    return RouteOutcome("mission_open", refs, error)


def _route_issue_mission(
    event: NormalizedEvent, *, base_dir: str | Path | None, workspace_root: str | Path, now: _datetime,
) -> RouteOutcome:
    from ..mission import _find_mission, mission_id_for, open_mission

    root = ensure_tools_dir(base_dir)
    # Resolve the repository before the local routing mutex. Native append
    # transactions then run individually: nesting their shared integrity lock
    # across inbox and mission writes would deadlock.
    repo_hash = _repo_hash(workspace_root)
    with _with_exclusive_lock(root / "gateway" / "mission-route"):
        states = [state for state in _inbox._fold_deliveries(_inbox.read_inbox(root))
                  if state.accepted["delivery_id"] == event.delivery_id]
        if len(states) != 1:
            raise _GovernanceError("mission_route_accepted_binding_unavailable")
        state = states[0]
        accepted_event = _event_from_dict(state.accepted)
        if state.invalid or event.to_dict() != accepted_event.to_dict():
            raise _GovernanceError("mission_route_accepted_binding_unavailable")
        number = accepted_event.subject.get("number")
        source_id = f"issue-{number}"
        binding = _inbox._MissionRouteBinding(
            accepted_ledger_hash=state.accepted["ledger_hash"], payload_digest=accepted_event.payload_digest,
            event_kind=accepted_event.kind, source_kind=ISSUE_MISSION_SOURCE_KIND,
            source_id=source_id, repo_hash=repo_hash,
            mission_id=mission_id_for(ISSUE_MISSION_SOURCE_KIND, source_id, repo_hash),
        )
        if state.binding is not None and state.binding != binding:
            raise _GovernanceError("mission_route_source_binding_unavailable")
        if not state.due(now):
            return RouteOutcome("ignored", {"reason": _MISSION_ROUTE_NOT_PENDING})
        outcome = None
        if state.attempts:
            # An interrupted call may already have created the mission. This
            # read includes terminal/held states and never heals or reopens it.
            existing = _find_mission(mission_id=binding.mission_id, base_dir=root)
            if existing is not None:
                if (existing["source_kind"], existing["source_id"], existing["repo_hash"]) != (
                    binding.source_kind, binding.source_id, binding.repo_hash,
                ):
                    raise _GovernanceError("mission_route_native_binding_unavailable")
                outcome = _mission_outcome(attempt=state.attempts[-1], status="reconciled", issue=number,
                                           mission_state=existing["state"], idempotent=True)
            elif len(state.attempts) >= _inbox._MISSION_MAX_ATTEMPTS:
                outcome = _mission_outcome(attempt=state.attempts[-1], status="exhausted", issue=number,
                                           error="mission_route_attempts_exhausted")
        if outcome is None:
            # If this append fails, no effect is attempted. Persisted attempts
            # count even when the following outcome append fails or we unwind.
            attempt = _inbox._reserve_mission_attempt(state=state, binding=binding, now=now, base_dir=root)
            try:
                mission = open_mission(
                    source_kind=binding.source_kind, source_id=binding.source_id, repo_hash=binding.repo_hash,
                    title=f"GitHub issue #{number}: {accepted_event.subject.get('title') or ''}"[:200],
                    next_action=ISSUE_MISSION_NEXT_ACTION,
                    wake_condition={"kind": "timer", "key": f"github_issue:{number}"}, priority=1, base_dir=root,
                )
            except OSError as exc:
                status = ("retryable_error" if attempt["mission_route"]["attempt"] < _inbox._MISSION_MAX_ATTEMPTS
                          else "reconciliation_required")
                outcome = _mission_outcome(attempt=attempt, status=status, issue=number,
                                           error=f"{type(exc).__name__}: {str(exc)[:300]}")
            except Exception as exc:  # noqa: BLE001 — only local mission-call errors are outcomes
                outcome = _mission_outcome(attempt=attempt, status="permanent_error", issue=number,
                                           error=f"{type(exc).__name__}: {str(exc)[:300]}")
            else:
                outcome = _mission_outcome(attempt=attempt, status="succeeded", issue=number,
                                           idempotent=bool(mission.get("idempotent")))
        mark_routed(event.delivery_id, base_dir=root, action=outcome.action, refs=outcome.refs, error=outcome.error)
        return outcome


def route_event(event: NormalizedEvent, *, base_dir: str | Path | None, workspace_root: str | Path,
                now: _datetime | None = None) -> RouteOutcome:
    """Apply one action; action errors are recorded, while persistence failures may raise."""
    if _is_issue_mission(event):
        return _route_issue_mission(event, base_dir=base_dir, workspace_root=workspace_root, now=_inbox._utc(now))
    try:
        outcome = _route(event, base_dir=base_dir, workspace_root=workspace_root)
    except Exception as exc:  # noqa: BLE001 — a routing failure is recorded, never lost
        outcome = RouteOutcome("ignored", error=f"{type(exc).__name__}: {str(exc)[:300]}")
    mark_routed(event.delivery_id, base_dir=base_dir, action=outcome.action, refs=outcome.refs, error=outcome.error)
    return outcome


def _route(event: NormalizedEvent, *, base_dir: str | Path | None, workspace_root: str | Path) -> RouteOutcome:
    kind, subject = event.kind, event.subject
    root = ensure_tools_dir(base_dir)
    if kind in {"github.issue_opened", "github.issue_labeled"}:
        return RouteOutcome("ignored", {"reason": "label_missing"})
    if kind == "github.issue_comment":
        append_tools_governance(root, "gateway_issue_command_recorded", {
            "issue": subject.get("number"), "actor": event.actor, "comment_digest": subject.get("comment_digest"),
        })
        return RouteOutcome("issue_command_recorded", {"issue": subject.get("number")})
    if kind in {"github.pr_opened", "github.pr_synchronize", "github.pr_closed"}:
        from ..pr_tracking import observe_pr_event

        pr_event = {"github.pr_opened": "opened", "github.pr_synchronize": "synchronize", "github.pr_closed": "closed"}[kind]
        if kind == "github.pr_closed" and subject.get("merged"):
            pr_event = "merged"
        row = observe_pr_event(payload={
            "event": pr_event, "pr_number": subject.get("number"), "head_sha": subject.get("head_sha"), "base_sha": subject.get("base_sha"),
            "author": subject.get("author"), "labels": subject.get("labels") or [], "merged_at": subject.get("merged_at"),
            "source": "github_webhook",
        }, base_dir=root)
        return RouteOutcome("pr_event", {"pr_number": subject.get("number"), "event": row.get("event")})
    if kind in {"github.check_suite_failed", "github.workflow_run_failed"}:
        from ..runtime_signal_bridge import ingest_runtime_signal

        workflow = subject.get("workflow") or subject.get("app") or "ci"
        row = ingest_runtime_signal(
            source="telemetry", service=str(subject.get("repo") or "repo"),
            summary=f"{workflow} {subject.get('conclusion')} on {subject.get('head_branch')} @ {str(subject.get('head_sha') or '')[:12]}",
            code_refs=[f".github/workflows:{workflow}"], severity="high", base_dir=root,
        )
        return RouteOutcome("runtime_signal", {"signal_id": row.get("signal_id") or row.get("id"), "workflow": workflow})
    if kind == "alertmanager.firing":
        from ..runtime_signal_bridge import ingest_runtime_signal

        row = ingest_runtime_signal(
            source="incident", service=str(subject.get("service") or subject.get("alertname") or "platform"),
            summary=f"{subject.get('alertname')}: {subject.get('summary') or subject.get('description') or ''}"[:300],
            code_refs=[f"alert:{subject.get('alertname')}"], severity="high" if str(subject.get("severity")) == "critical" else "medium",
            base_dir=root,
        )
        return RouteOutcome("runtime_signal", {"signal_id": row.get("signal_id") or row.get("id"), "alertname": subject.get("alertname")})
    if kind == "alertmanager.resolved":
        append_tools_governance(root, "gateway_alert_resolved", {"alertname": subject.get("alertname"), "fingerprint": subject.get("fingerprint")})
        return RouteOutcome("alert_resolved_recorded", {"alertname": subject.get("alertname")})
    if kind == "operator.command":
        from ..control import CONTROL_VERBS, record_control

        verb = str(subject.get("verb") or "")
        if verb not in CONTROL_VERBS:
            return RouteOutcome("ignored", {"reason": "unknown_verb", "verb": verb})
        row = record_control(verb, base_dir=root, request_id=subject.get("request_id"), operator_ref=event.actor, reason=str(subject.get("reason") or ""))
        return RouteOutcome("operator_control", {"command_id": row.get("command_id"), "verb": verb})
    return RouteOutcome("ignored", {"reason": "no_route"})


def drain_inbox(*, base_dir: str | Path | None, workspace_root: str | Path, limit: int = 100,
                now: _datetime | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    stamp = _inbox._utc(now)
    for event in pending_events(base_dir, now=stamp)[:limit]:
        outcome = route_event(event, base_dir=base_dir, workspace_root=workspace_root, now=stamp)
        if outcome.refs.get("reason") == _MISSION_ROUTE_NOT_PENDING:
            continue  # Another drain completed it, or the captured tick is not due.
        out.append({"delivery_id": event.delivery_id, "kind": event.kind, "action": outcome.action, "refs": outcome.refs, "error": outcome.error})
    return out


__all__ = ["ISSUE_MISSION_NEXT_ACTION", "ISSUE_MISSION_SOURCE_KIND", "ROUTE_ACTIONS", "RouteOutcome", "drain_inbox", "route_event"]
