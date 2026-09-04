"""Deterministic routing: one closed action per event kind, every outcome on the inbox."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..tool_registry import append_tools_governance, ensure_tools_dir
from .inbox import mark_routed, pending_events
from .normalize import ARIA_ISSUE_LABEL, NormalizedEvent

ROUTE_ACTIONS: tuple[str, ...] = (
    "mission_open", "issue_command_recorded", "pr_event", "runtime_signal", "alert_resolved_recorded",
    "operator_control", "ignored",
)
ISSUE_MISSION_NEXT_ACTION = "triage_github_issue"
ISSUE_MISSION_SOURCE_KIND = "github_issue"


@dataclass(frozen=True)
class RouteOutcome:
    action: str
    refs: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


def _repo_hash(workspace_root: str | Path) -> str:
    from ..workspace import canonical_identity

    return canonical_identity(Path(workspace_root).resolve())


def route_event(event: NormalizedEvent, *, base_dir: str | Path | None, workspace_root: str | Path) -> RouteOutcome:
    """Apply the event's one action. Never raises: an error is an outcome row."""
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
        if ARIA_ISSUE_LABEL not in (subject.get("labels") or []):
            return RouteOutcome("ignored", {"reason": "label_missing"})
        from ..mission import open_mission

        number = subject.get("number")
        mission = open_mission(
            source_kind=ISSUE_MISSION_SOURCE_KIND, source_id=f"issue-{number}", repo_hash=_repo_hash(workspace_root),
            title=f"GitHub issue #{number}: {subject.get('title') or ''}"[:200],
            next_action=ISSUE_MISSION_NEXT_ACTION,
            wake_condition={"kind": "timer", "key": f"github_issue:{number}"},
            priority=1, base_dir=root,
        )
        return RouteOutcome("mission_open", {"mission_id": mission.get("mission_id"), "issue": number, "idempotent": bool(mission.get("idempotent"))})
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


def drain_inbox(*, base_dir: str | Path | None, workspace_root: str | Path, limit: int = 100) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for event in pending_events(base_dir)[:limit]:
        outcome = route_event(event, base_dir=base_dir, workspace_root=workspace_root)
        out.append({"delivery_id": event.delivery_id, "kind": event.kind, "action": outcome.action, "refs": outcome.refs, "error": outcome.error})
    return out


__all__ = ["ISSUE_MISSION_NEXT_ACTION", "ISSUE_MISSION_SOURCE_KIND", "ROUTE_ACTIONS", "RouteOutcome", "drain_inbox", "route_event"]
