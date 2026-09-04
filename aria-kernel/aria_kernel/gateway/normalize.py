"""Closed event vocabulary + normalizers for the three ingress families."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

EVENT_KINDS: tuple[str, ...] = (
    "github.issue_opened",
    "github.issue_labeled",
    "github.issue_comment",
    "github.pr_opened",
    "github.pr_synchronize",
    "github.pr_closed",
    "github.check_suite_failed",
    "github.workflow_run_failed",
    "alertmanager.firing",
    "alertmanager.resolved",
    "operator.command",
)
EVENT_SOURCES: tuple[str, ...] = ("github", "alertmanager", "operator", "cli")
ARIA_ISSUE_LABEL = "aria"


@dataclass(frozen=True)
class NormalizedEvent:
    kind: str
    delivery_id: str
    source: str
    occurred_at: str | None
    actor: str | None
    subject: dict[str, Any] = field(default_factory=dict)
    payload_digest: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def payload_digest(payload: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:32]


def _event(kind: str, delivery_id: str, source: str, *, occurred_at: Any, actor: Any, subject: dict[str, Any], payload: Any) -> NormalizedEvent:
    if kind not in EVENT_KINDS:
        raise ValueError(f"unknown event kind {kind!r}")
    return NormalizedEvent(
        kind=kind, delivery_id=str(delivery_id), source=source,
        occurred_at=str(occurred_at) if occurred_at else None, actor=str(actor) if actor else None,
        subject=subject, payload_digest=payload_digest(payload),
    )


def _labels(issue: Mapping[str, Any]) -> list[str]:
    return sorted(str(l.get("name") if isinstance(l, Mapping) else l) for l in (issue.get("labels") or []))


def normalize_github(event_name: str, delivery_id: str, payload: Mapping[str, Any]) -> NormalizedEvent | None:
    """Map a GitHub webhook (X-GitHub-Event + body) onto the vocabulary; None = ignored."""
    action = str(payload.get("action") or "")
    sender = (payload.get("sender") or {}).get("login")
    repo = (payload.get("repository") or {}).get("full_name")
    if event_name == "issues" and action in {"opened", "labeled"}:
        issue = payload.get("issue") or {}
        return _event(
            f"github.issue_{action}", delivery_id, "github", occurred_at=issue.get("updated_at") or issue.get("created_at"),
            actor=sender, payload=payload,
            subject={"repo": repo, "number": issue.get("number"), "title": str(issue.get("title") or "")[:200],
                     "labels": _labels(issue), "url": issue.get("html_url"), "body_digest": payload_digest(issue.get("body") or "")},
        )
    if event_name == "issue_comment" and action == "created":
        issue = payload.get("issue") or {}
        comment = payload.get("comment") or {}
        return _event(
            "github.issue_comment", delivery_id, "github", occurred_at=comment.get("created_at"), actor=sender, payload=payload,
            subject={"repo": repo, "number": issue.get("number"), "labels": _labels(issue),
                     "comment_digest": payload_digest(comment.get("body") or ""), "comment_preview": str(comment.get("body") or "")[:120]},
        )
    if event_name == "pull_request" and action in {"opened", "synchronize", "closed", "reopened"}:
        pr = payload.get("pull_request") or {}
        kind = {"opened": "github.pr_opened", "reopened": "github.pr_opened", "synchronize": "github.pr_synchronize", "closed": "github.pr_closed"}[action]
        return _event(
            kind, delivery_id, "github", occurred_at=pr.get("updated_at"), actor=sender, payload=payload,
            subject={"repo": repo, "number": pr.get("number"), "head_sha": (pr.get("head") or {}).get("sha"),
                     "base_sha": (pr.get("base") or {}).get("sha"), "head_ref": (pr.get("head") or {}).get("ref"),
                     "merged": bool(pr.get("merged")), "merged_at": pr.get("merged_at"), "labels": _labels(pr),
                     "author": (pr.get("user") or {}).get("login")},
        )
    if event_name == "check_suite" and action == "completed" and str((payload.get("check_suite") or {}).get("conclusion")) in {"failure", "timed_out"}:
        suite = payload.get("check_suite") or {}
        return _event(
            "github.check_suite_failed", delivery_id, "github", occurred_at=suite.get("updated_at"), actor=sender, payload=payload,
            subject={"repo": repo, "head_sha": suite.get("head_sha"), "head_branch": suite.get("head_branch"),
                     "conclusion": suite.get("conclusion"), "app": (suite.get("app") or {}).get("slug")},
        )
    if event_name == "workflow_run" and action == "completed" and str((payload.get("workflow_run") or {}).get("conclusion")) in {"failure", "timed_out"}:
        run = payload.get("workflow_run") or {}
        return _event(
            "github.workflow_run_failed", delivery_id, "github", occurred_at=run.get("updated_at"), actor=sender, payload=payload,
            subject={"repo": repo, "run_id": run.get("id"), "workflow": run.get("name"), "head_sha": run.get("head_sha"),
                     "head_branch": run.get("head_branch"), "conclusion": run.get("conclusion"), "url": run.get("html_url")},
        )
    return None


def normalize_alertmanager(delivery_id: str, payload: Mapping[str, Any]) -> list[NormalizedEvent]:
    """One event per alert in an Alertmanager webhook batch."""
    out: list[NormalizedEvent] = []
    for index, alert in enumerate(payload.get("alerts") or []):
        if not isinstance(alert, Mapping):
            continue
        status = str(alert.get("status") or payload.get("status") or "firing")
        kind = "alertmanager.firing" if status == "firing" else "alertmanager.resolved"
        labels = dict(alert.get("labels") or {})
        annotations = dict(alert.get("annotations") or {})
        out.append(_event(
            kind, f"{delivery_id}:{index}", "alertmanager", occurred_at=alert.get("startsAt"), actor=payload.get("receiver"), payload=alert,
            subject={"alertname": labels.get("alertname"), "severity": labels.get("severity"), "service": labels.get("service") or labels.get("job"),
                     "instance": labels.get("instance"), "summary": str(annotations.get("summary") or "")[:200],
                     "description": str(annotations.get("description") or "")[:400], "fingerprint": alert.get("fingerprint")},
        ))
    return out


def normalize_operator(delivery_id: str, payload: Mapping[str, Any], *, actor: str | None) -> NormalizedEvent:
    verb = str(payload.get("verb") or "")
    return _event(
        "operator.command", delivery_id, "operator", occurred_at=payload.get("issued_at"), actor=actor, payload=payload,
        subject={"verb": verb, "request_id": payload.get("request_id"), "reason": str(payload.get("reason") or "")[:200]},
    )


def event_from_dict(row: Mapping[str, Any]) -> NormalizedEvent:
    return NormalizedEvent(
        kind=str(row["kind"]), delivery_id=str(row["delivery_id"]), source=str(row.get("source") or "cli"),
        occurred_at=row.get("occurred_at"), actor=row.get("actor"), subject=dict(row.get("subject") or {}),
        payload_digest=str(row.get("payload_digest") or ""),
    )


__all__ = ["ARIA_ISSUE_LABEL", "EVENT_KINDS", "EVENT_SOURCES", "NormalizedEvent", "event_from_dict",
           "normalize_alertmanager", "normalize_github", "normalize_operator", "payload_digest"]
