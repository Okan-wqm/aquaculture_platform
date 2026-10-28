"""ARIA-CRITICAL-214 — the ONE reader of the paths a change removes or adds.

A rename is two facts: a path disappears and a path appears. Every reader
the merge chain had (``gh pr view --json files``, ``git diff --name-only``)
reported only the second, so a code-owned file renamed into ``docs/`` was
classified by its new name alone — lane L1 — and ARIA could delete the
owned file unreviewed.

``git diff --name-status -z --no-renames`` reports both, whatever the
repository's ``diff.renames`` configuration says: the source as ``D`` and the
target as ``A``. This module is where that argv, and the parse of its output,
live; every consumer that decides something from a change's path set (the
risk decision, the pre-merge perimeter, the delivery's scope verdict, the
self-revert's file set) reads through it, so they cannot disagree about what
a change touched.

The platform's own list (``gh pr view --json files``) is not a source: it
names the new side of a rename only and stops at ``GH_PR_FILES_LIST_CAP``
entries. ``platform_file_list_disagreement`` checks it against the git set
instead, and a disagreement is refused by name rather than resolved.

ARIA-LOW-741 — the same module owns the other per-path fact of a change, its
line counts (``git diff --numstat``). One git call, ``--raw --numstat -z
--no-renames``, prints both the status of every path and its counts, and
``parse_change_z`` reads that stream once; no other module spells a diff-size
flag (``tests/invariants/test_numstat_single_reader.py``).
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from .git_object_id import ANY_OBJECT_FORMAT, is_object_id
from .git_containment import KERNEL_GIT_NO_HOOKS_ARGS
from .state_store_lifecycle_arcs import GIT_TIMEOUT_SECONDS
from .tool_registry import GovernanceError

# `gh pr view --json files` pages at most this many entries; the PR's
# `changedFiles` count is not capped.
GH_PR_FILES_LIST_CAP = 100

CHANGE_PATHS_SOURCE = "git diff --name-status -z --no-renames"

# With --no-renames git emits no R/C entry, so every status letter names
# exactly one path. These are the statuses a change entry can carry.
CHANGE_STATUSES = frozenset("ADMTUX")


@dataclass(frozen=True)
class ChangeChurn:
    """The line counts of a change: ``(path, added, deleted)``, ``None``/``None`` for a binary file."""

    entries: tuple[tuple[str, int | None, int | None], ...]

    @property
    def paths(self) -> tuple[str, ...]:
        return tuple(sorted(path for path, _added, _deleted in self.entries))


@dataclass(frozen=True)
class ChangePaths:
    """The path set of ``base_rev``..``head_rev`` with rename sources kept."""

    base_rev: str
    head_rev: str
    entries: tuple[tuple[str, str], ...]

    @property
    def paths(self) -> tuple[str, ...]:
        return tuple(sorted({path for _status, path in self.entries}))

    @property
    def deleted(self) -> frozenset[str]:
        return frozenset(path for status, path in self.entries if status == "D")

    @property
    def added(self) -> frozenset[str]:
        return frozenset(path for status, path in self.entries if status == "A")


def name_status_args(base_rev: str, head_rev: str, *, churn: bool = False) -> list[str]:
    """The git argv (after ``git``) that reads a change's path set.

    There are two spellings because the counts are not free: on a 4k-path
    change ``--raw --numstat`` costs ~20x ``--name-status`` (3.6 s against
    0.17 s). The risk classifier and the self-revert read the cheap one; only
    the delivery, once per delivery and behind a push, asks for ``churn=True``,
    which prints every path's status AND its counts in one stream
    (``--name-status --numstat`` does not: name-status wins and no counts
    print). ``parse_change_z`` reads that stream.
    """
    for rev in (base_rev, head_rev):
        if not isinstance(rev, str) or not rev or rev.startswith("-"):
            raise GovernanceError(f"change_paths_revision_invalid: {rev!r}")
    shape = ["--raw", "--numstat"] if churn else ["--name-status"]
    return ["diff", *shape, "-z", "--no-renames", "--no-ext-diff", base_rev, head_rev, "--"]


def parse_name_status_z(output: str) -> tuple[tuple[str, str], ...]:
    """``(status, path)`` entries from ``name_status_args`` output.

    Paths are returned verbatim — ``-z`` output is never quoted — and the
    classifier normalizes (or refuses) them. A record this reader cannot
    place is a refusal, never a skipped entry.
    """
    fields = output.split("\0")
    if fields and fields[-1] == "":
        fields.pop()
    if len(fields) % 2:
        raise GovernanceError("change_paths_output_malformed: odd field count")
    entries: list[tuple[str, str]] = []
    for index in range(0, len(fields), 2):
        status, path = fields[index], fields[index + 1]
        if status not in CHANGE_STATUSES or not path:
            raise GovernanceError(f"change_paths_output_malformed: status={status!r}")
        entries.append((status, path))
    return tuple(entries)


def parse_change_z(output: str) -> tuple[tuple[tuple[str, str], ...], ChangeChurn]:
    """``(status, path)`` entries and the ``ChangeChurn`` of one ``name_status_args(churn=True)`` stream.

    A raw record is two NUL-terminated fields (``:<mode> <mode> <sha> <sha> <S>``,
    then the path); a numstat record is one (``<added> TAB <deleted> TAB <path>``,
    ``-`` and ``-`` for a binary file). Records are classified by their first
    character at a record boundary, never by position, so section order does not
    matter; a numstat record splits on its first two tabs only, so a tab (or a
    leading ``:``) inside a path survives. The ``(status, path)`` entries are the
    ones ``parse_name_status_z`` returns for the same change. Whatever cannot be
    placed is refused, and so is a stream whose two sections do not describe one
    change (a path in one and not the other, or a path twice).
    """
    fields = output.split("\0")
    if fields and fields[-1] == "":
        fields.pop()
    entries: list[tuple[str, str]] = []
    counts: list[tuple[str, int | None, int | None]] = []
    index = 0
    while index < len(fields):
        field = fields[index]
        if field.startswith(":"):
            if index + 1 >= len(fields):
                raise GovernanceError("change_paths_output_malformed: odd field count")
            status, path = field.rsplit(" ", 1)[-1], fields[index + 1]
            if status not in CHANGE_STATUSES or not path:
                raise GovernanceError(f"change_paths_output_malformed: status={status!r}")
            entries.append((status, path))
            index += 2
        else:
            counts.append(_numstat_record(field))
            index += 1
    raw_paths, counted_paths = [path for _status, path in entries], [path for path, _a, _d in counts]
    for section, paths in (("raw", raw_paths), ("numstat", counted_paths)):
        if len(set(paths)) != len(paths):
            raise GovernanceError(f"change_paths_output_malformed: a path twice in the {section} section")
    if set(raw_paths) != set(counted_paths):
        raise GovernanceError("change_paths_output_malformed: the raw and numstat sections name different paths")
    return tuple(entries), ChangeChurn(entries=tuple(counts))


def _numstat_record(record: str) -> tuple[str, int | None, int | None]:
    parts = record.split("\t", 2)
    if len(parts) != 3 or not parts[2]:
        raise GovernanceError(f"change_paths_output_malformed: numstat record {record[:40]!r}")
    added, deleted, path = parts
    if added == "-" and deleted == "-":
        return path, None, None
    if not all(count.isascii() and count.isdigit() for count in (added, deleted)):
        raise GovernanceError(f"change_paths_output_malformed: numstat counts {added!r}/{deleted!r}")
    return path, int(added), int(deleted)


def read_change_paths(workspace_root: str | Path | None, base_sha: object, head_sha: object) -> ChangePaths:
    """The change ``base_sha``..``head_sha`` as the checkout at ``workspace_root`` holds it.

    Both ends must be full object ids (they arrive from the platform) and the
    diff must succeed; anything else is ``change_paths_unavailable``, because
    a change whose paths cannot be read cannot be classified.
    """
    if workspace_root is None:
        raise GovernanceError("change_paths_unavailable: no workspace checkout")
    base_rev, head_rev = _full_sha("base", base_sha), _full_sha("head", head_sha)
    try:
        completed = subprocess.run(
            ["git", *KERNEL_GIT_NO_HOOKS_ARGS, *name_status_args(base_rev, head_rev)],
            cwd=str(Path(workspace_root)), capture_output=True, text=True, check=False,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GovernanceError(f"change_paths_unavailable: {exc.__class__.__name__}") from exc
    if completed.returncode != 0:
        detail = ((completed.stderr or "").strip().splitlines() or ["?"])[0][:200]
        raise GovernanceError(f"change_paths_unavailable: git diff failed: {detail}")
    return ChangePaths(base_rev=base_rev, head_rev=head_rev, entries=parse_name_status_z(completed.stdout))


def _full_sha(name: str, value: object) -> str:
    if not isinstance(value, str) or not is_object_id(value, formats=ANY_OBJECT_FORMAT):
        raise GovernanceError(f"change_paths_unavailable: {name} sha is not a full object id: {value!r}")
    return value


def platform_file_list_disagreement(
    change: ChangePaths,
    *,
    listed_paths: list[str],
    listed_count: object,
) -> str | None:
    """Why the platform's file list cannot describe ``change``, or None.

    ``listed_paths`` is the platform's (possibly truncated) list and
    ``listed_count`` its uncapped count. The platform reports a rename as
    one entry, its new path; git reports it as a deletion plus an addition.
    That is the only way the two may differ, so:

    * every listed path is in the git set;
    * the git set is larger than the count by the number of renames, which
      cannot exceed the deletions (or the additions) git reports;
    * when the list is complete, every git path it omits is a deletion.
    """
    if type(listed_count) is not int or listed_count < 0:
        return "platform_file_count_unavailable"
    git_paths = set(change.paths)
    listed = set(listed_paths)
    stray = sorted(listed - git_paths)
    if stray:
        return f"platform_path_not_in_git_diff:{stray[0]}"
    if len(listed) > listed_count:
        return f"platform_file_list_exceeds_count:{len(listed)}>{listed_count}"
    renames = len(git_paths) - listed_count
    if renames < 0:
        return f"platform_file_count_exceeds_git:{listed_count}>{len(git_paths)}"
    if renames > min(len(change.deleted), len(change.added)):
        return f"platform_file_count_below_git:{listed_count}<{len(git_paths)}"
    if len(listed) == listed_count:
        unlisted = sorted(path for path in git_paths - listed if path not in change.deleted)
        if unlisted:
            return f"git_path_missing_from_platform_list:{unlisted[0]}"
    return None


__all__ = [
    "CHANGE_PATHS_SOURCE",
    "CHANGE_STATUSES",
    "ChangeChurn",
    "ChangePaths",
    "GH_PR_FILES_LIST_CAP",
    "name_status_args",
    "parse_change_z",
    "parse_name_status_z",
    "platform_file_list_disagreement",
    "read_change_paths",
]
