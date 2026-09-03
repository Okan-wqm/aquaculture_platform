from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .feedback import list_feedback_without_integrity
from .batch_containment import guard_item, with_item_failures
from .phase2_utils import record_workspace_governance_once
from .workspace import WorkspacePaths


def trust_escalation_derive(paths: WorkspacePaths, *, cycle_id: str) -> dict[str, Any]:
    grouped: dict[str, set[str]] = {}
    for row in list_feedback_without_integrity(paths):
        gap = row.get("capability_gap_key")
        source = row.get("source")
        if isinstance(gap, str) and isinstance(source, str):
            grouped.setdefault(gap, set()).add(source)
    escalated = 0
    item_failures: list[dict[str, Any]] = []
    for gap, sources in sorted(grouped.items()):
        if len(sources) < 3:
            continue
        if any(row.get("details", {}).get("capability_gap_key") == gap for row in _governance(paths, "feedback_escalated_to_trusted")):
            continue
        ok, _recorded = guard_item(
            item_failures,
            item_kind="capability_gap",
            item_id=gap,
            work=lambda gap=gap, sources=sources: record_workspace_governance_once(
                paths,
                "feedback_escalated_to_trusted",
                {
                    "capability_gap_key": gap,
                    "trusted_at_cycle": cycle_id,
                    "source_values": sorted(sources),
                },
            ),
        )
        if not ok:
            continue
        escalated += 1
    return with_item_failures(
        {"schema_version": 1, "cycle_id": cycle_id, "escalated_count": escalated},
        item_failures,
    )


def ref_staleness_check(paths: WorkspacePaths, *, cycle_id: str, sample_limit: int = 100) -> dict[str, Any]:
    samples = _feedback_ref_samples(paths, sample_limit)
    counts = {"fresh": 0, "stale": 0, "missing": 0, "unknown": 0}
    item_failures: list[dict[str, Any]] = []
    for sample in samples:
        # `_ref_status` shells out to git per sample. One unreadable ref used to
        # end the sweep, so the staleness counts reported a subset of the sample
        # as if it were the sample.
        ok, status = guard_item(
            item_failures,
            item_kind="feedback_ref",
            item_id=str(sample.get("ref") or ""),
            work=lambda sample=sample: _ref_status(
                paths.repo_root, sample["ref"], sample.get("observed_commit"),
            ),
        )
        if not ok or status is None:
            continue
        counts[status] = counts.get(status, 0) + 1
        if status in {"stale", "missing", "unknown"}:
            guard_item(
                item_failures,
                item_kind="ref_stale_event",
                item_id=str(sample.get("ref") or ""),
                work=lambda sample=sample, status=status: record_workspace_governance_once(
                    paths,
                    "ref_stale_detected",
                    {
                        "ref": sample["ref"],
                        "observed_commit": sample.get("observed_commit"),
                        "current_blame_commit": _current_commit(paths.repo_root, sample["ref"]) if status == "stale" else None,
                        "pressure_event_id": None,
                        "feedback_event_id": sample.get("feedback_event_id"),
                        "status": status,
                        "cycle_id": cycle_id,
                    },
                ),
            )
    return with_item_failures(
        {"schema_version": 1, "cycle_id": cycle_id, "sampled_count": len(samples), "counts": counts},
        item_failures,
    )


def trusted_gap_keys(paths: WorkspacePaths) -> set[str]:
    direct = {
        str(row.get("details", {}).get("capability_gap_key"))
        for row in _governance(paths, "feedback_escalated_to_trusted")
        if row.get("details", {}).get("capability_gap_key")
    }
    grouped: dict[str, set[str]] = {}
    for row in list_feedback_without_integrity(paths):
        gap = row.get("capability_gap_key")
        source = row.get("source")
        if isinstance(gap, str) and isinstance(source, str):
            grouped.setdefault(gap, set()).add(source)
    direct.update(gap for gap, sources in grouped.items() if len(sources) >= 3)
    return direct


def ref_status_by_feedback_id(paths: WorkspacePaths) -> dict[str, str]:
    status: dict[str, str] = {}
    for row in _governance(paths, "ref_stale_detected"):
        details = row.get("details", {})
        feedback_id = details.get("feedback_event_id")
        value = details.get("status")
        if isinstance(feedback_id, str) and isinstance(value, str):
            status[feedback_id] = value
    return status


def _feedback_ref_samples(paths: WorkspacePaths, sample_limit: int) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for row in sorted(list_feedback_without_integrity(paths), key=lambda item: str(item.get("event_id") or "")):
        feedback_id = str(row.get("event_id") or "")
        for ref in row.get("refs", []):
            if not isinstance(ref, str) or not ref.strip():
                continue
            key = (feedback_id, ref)
            if key in seen:
                continue
            seen.add(key)
            samples.append({"feedback_event_id": feedback_id, "ref": ref, "observed_commit": row.get("observed_commit")})
            if len(samples) >= sample_limit:
                return samples
    return samples


def _ref_status(repo_root: Path, ref: str, observed_commit: Any) -> str:
    if not isinstance(observed_commit, str) or not observed_commit.strip():
        return "unknown"
    path = _ref_path(ref)
    if not path or not (repo_root / path).exists():
        return "missing"
    current = _current_commit(repo_root, ref)
    if not current:
        return "unknown"
    return "fresh" if current == observed_commit else "stale"


def _current_commit(repo_root: Path, ref: str) -> str | None:
    path = _ref_path(ref)
    line_no = _ref_line(ref)
    if not path:
        return None
    if line_no is not None:
        blame = _git(repo_root, ["git", "blame", "-L", f"{line_no},{line_no}", "--porcelain", "--", path])
        if blame:
            first = blame.splitlines()[0].split(" ", 1)[0]
            if first:
                return first
    return _git(repo_root, ["git", "log", "-n", "1", "--format=%H", "--", path])


def _git(repo_root: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root.resolve(),
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def _ref_path(ref: str) -> str:
    return ref.split(":", 1)[0].replace("\\", "/")


def _ref_line(ref: str) -> int | None:
    parts = ref.split(":")
    if len(parts) < 2:
        return None
    try:
        return int(parts[1])
    except ValueError:
        return None


def _governance(paths: WorkspacePaths, kind: str) -> list[dict[str, Any]]:
    from .ledger import read_jsonl

    return [row for row in read_jsonl(paths.ledgers["governance"]) if row.get("kind") == kind]
