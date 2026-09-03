from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .feedback import add_feedback, normalize_feedback_event
from .batch_containment import guard_item, with_item_failures
from .ledger import read_jsonl
from .pressure import append_pressure_state_event, effective_workspace_pressures
from .workspace import WorkspacePaths
from .phase2_utils import record_workspace_governance_once

TRAILER_RE = re.compile(r"^(Closes-Pressure|Addresses-Pressure):\s*(.+?)\s*$")
PRESSURE_ID_RE = re.compile(r"^PE-[A-Za-z0-9][A-Za-z0-9_.:-]*$")


def git_trailer_scan(paths: WorkspacePaths, *, cycle_id: str, tools_root: str | Path | None = None) -> dict[str, Any]:
    if tools_root is None:
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "no_tools_root", "scanned_commit_count": 0}
    root = Path(tools_root)
    previous_sha = _previous_completed_head(root, cycle_id)
    if not previous_sha:
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "no_previous_head", "scanned_commit_count": 0}

    commits = _git_lines(paths.repo_root, ["git", "log", "--format=%H", f"{previous_sha}..HEAD"])
    pressures = {str(row.get("event_id") or row.get("pressure_id")): row for row in effective_workspace_pressures(paths)}
    closed = 0
    addressed = 0
    item_failures: list[dict[str, Any]] = []
    ignored = 0
    for sha in commits:
        # Per commit: `git show` can fail on one commit, and a trailer's
        # governance write can fail on one line. Either used to end the scan,
        # so every LATER commit's `Closes-Pressure` trailer went unread and
        # those pressures stayed open with nothing recording why.
        ok, message = guard_item(
            item_failures,
            item_kind="commit",
            item_id=sha,
            work=lambda sha=sha: _git_output(paths.repo_root, ["git", "show", "-s", "--format=%B", sha]),
        )
        if not ok or message is None:
            continue
        ok, changed_files = guard_item(
            item_failures,
            item_kind="commit",
            item_id=sha,
            work=lambda sha=sha: _changed_files(paths.repo_root, sha),
        )
        if not ok or changed_files is None:
            continue
        for line in message.splitlines():
            match = TRAILER_RE.match(line.strip())
            if not match:
                continue
            kind, raw_value = match.groups()
            pressure_id = raw_value.strip()
            if "," in pressure_id or not PRESSURE_ID_RE.match(pressure_id):
                guard_item(
                    item_failures,
                    item_kind="trailer",
                    item_id=f"{sha}:{raw_value}",
                    work=lambda sha=sha, kind=kind, raw_value=raw_value: _record_ignored(
                        paths, cycle_id, sha, kind, raw_value, "malformed_trailer",
                    ),
                )
                ignored += 1
                continue
            pressure = pressures.get(pressure_id)
            if pressure is None:
                guard_item(
                    item_failures,
                    item_kind="trailer",
                    item_id=f"{sha}:{pressure_id}",
                    work=lambda sha=sha, kind=kind, pressure_id=pressure_id: _record_ignored(
                        paths, cycle_id, sha, kind, pressure_id, "unknown_pressure",
                    ),
                )
                ignored += 1
                continue
            if kind == "Closes-Pressure":
                ok, did_close = guard_item(
                    item_failures,
                    item_kind="trailer",
                    item_id=f"{sha}:{pressure_id}",
                    work=lambda pressure=pressure, sha=sha: _close_pressure_from_trailer(
                        paths, cycle_id, sha, pressure,
                    ),
                )
                if ok and did_close:
                    closed += 1
                continue
            ok, _recorded = guard_item(
                item_failures,
                item_kind="trailer",
                item_id=f"{sha}:{pressure_id}",
                work=lambda pressure_id=pressure_id, sha=sha, kind=kind, changed_files=changed_files: (
                    record_workspace_governance_once(
                        paths,
                        "pressure_addresses_recorded",
                        {
                            "pressure_event_id": pressure_id,
                            "commit_sha": sha,
                            "trailer_kind": kind,
                            "changed_files": changed_files,
                            "cycle_id": cycle_id,
                        },
                    )
                ),
            )
            if ok:
                addressed += 1
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "previous_git_head_sha_at_cycle": previous_sha,
        "scanned_commit_count": len(commits),
        "closed_count": closed,
        "addressed_count": addressed,
        "ignored_count": ignored,
    }, item_failures)


def _close_pressure_from_trailer(paths: WorkspacePaths, cycle_id: str, sha: str, pressure: dict[str, Any]) -> bool:
    pressure_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "")
    existing = [
        row
        for row in read_jsonl(paths.ledgers["governance"])
        if row.get("kind") == "pressure_closed_via_trailer"
        and row.get("details", {}).get("pressure_event_id") == pressure_id
        and row.get("details", {}).get("commit_sha") == sha
    ]
    event = normalize_feedback_event(
        {
            "kind": "closed_signal",
            "source": "self",
            "refs": [pressure_id],
            "summary": f"Pressure closed by commit trailer {sha}",
            "capability_gap_key": pressure.get("capability_gap_key"),
            "failure_mode": _failure_mode_from_gap(str(pressure.get("capability_gap_key") or "")),
            "evidence_refs": [f"git:commit:{sha}"],
        },
        cycle_id=cycle_id,
        paths=paths,
    )
    if not any(row.get("event_id") == event["event_id"] for row in read_jsonl(paths.ledgers["external_feedback"])):
        add_feedback(paths, event)
    append_pressure_state_event(
        paths,
        pressure=pressure,
        to_state="closed",
        reason="commit_trailer_closed",
        cycle_id=cycle_id,
        evidence_refs=[f"git:commit:{sha}"],
        feedback_event_ids=[event["event_id"]],
        details={"commit_sha": sha, "trailer_kind": "Closes-Pressure"},
    )
    record_workspace_governance_once(
        paths,
        "pressure_closed_via_trailer",
        {
            "pressure_event_id": pressure_id,
            "commit_sha": sha,
            "feedback_event_id": event["event_id"],
            "cycle_id": cycle_id,
        },
    )
    return not existing


def _record_ignored(paths: WorkspacePaths, cycle_id: str, sha: str, trailer_kind: str, value: str, reason: str) -> None:
    record_workspace_governance_once(
        paths,
        "pressure_trailer_ignored",
        {
            "cycle_id": cycle_id,
            "commit_sha": sha,
            "trailer_kind": trailer_kind,
            "value": value,
            "reason": reason,
        },
    )


def _previous_completed_head(root: Path, cycle_id: str) -> str | None:
    cycles_path = root / "cycles.jsonl"
    if not cycles_path.exists():
        return None
    rows = read_jsonl(cycles_path, expected_surface="cycles")
    for row in reversed(rows):
        if row.get("cycle_id") == cycle_id:
            continue
        if row.get("event") != "completed":
            continue
        sha = row.get("git_head_sha_at_cycle")
        if isinstance(sha, str) and sha.strip():
            return sha.strip()
    return None


def _changed_files(repo_root: Path, sha: str) -> list[str]:
    output = _git_output(repo_root, ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha])
    return sorted({item.replace("\\", "/") for item in output.split("\x00") if item.strip()})


def _git_lines(repo_root: Path, command: list[str]) -> list[str]:
    output = _git_output(repo_root, command)
    return [line.strip() for line in output.splitlines() if line.strip()]


def _git_output(repo_root: Path, command: list[str]) -> str:
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root.resolve(),
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"git command timed out: {' '.join(command)}") from exc
    except OSError as exc:
        raise OSError(f"git command failed to start: {' '.join(command)}: {exc}") from exc
    if completed.returncode != 0:
        raise RuntimeError(f"git command failed ({completed.returncode}): {' '.join(command)}: {completed.stderr.strip()}")
    return completed.stdout


def _failure_mode_from_gap(gap: str) -> str:
    parts = gap.split(":")
    if len(parts) == 3 and parts[1]:
        return parts[1]
    return "evidence_gap"
