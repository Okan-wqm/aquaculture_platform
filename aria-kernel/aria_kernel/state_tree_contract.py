"""What may live in a published ``aria/state`` tree — and how a publish heals
a parent that carries what may not.

WHY THIS MODULE EXISTS. The immutable verifier in ``autonomy_evidence``
refuses any tree entry outside {GENESIS, snapshot.json, the surfaces the
snapshot claims, the empty bootstrap markers}. That rule is right: an
entry nothing attests is an entry nothing can vouch for. But the kernel
publish stages a BOUNDED pathspec (``state_store._staged_pathspecs`` —
deliberately not the subtree prefixes), so it can neither add nor remove
an entry it does not name. A parent tip that already carries such an
entry therefore poisons every later publish: the child inherits the
entry, the verifier refuses the child, the commit is soft-reset, and the
branch stops moving. Measured on ``origin/aria/state`` tip 84032eda1
(2026-09-11): sixteen zero-byte ``*.lock`` side-cars, ``repo_identity.json``
and ``integrity_index.json`` — all admitted by a maintenance lane that
committed with ``git add -A`` — and no kernel publish had landed since
2026-09-04.

The healing rule is derived from the same vocabulary the verifier uses,
never restated by name:

* ``STATE_BOOTSTRAP_EMPTY_MARKERS`` and the two contract files are the
  entries every tree may carry;
* a path under a declared root that resolves to a declared surface with a
  carried/artifact storage policy is a SURFACE — a snapshot will claim it
  when it exists and its removal stages as a deletion when it does not;
* everything else is UNCLAIMABLE: no snapshot built from this store can
  ever name it, so the only publish that verifies is one whose tree omits
  it. The lock shapes are decoded, never restated: a state-group lock KEY
  (``locks/state-groups/<group>.lock``, the manifest's shape) is recognised
  first, then ``file_lock``'s side-car shape — so the side-car of a group
  key is recorded as the group lock it serialises rather than as the
  side-car of a target no tree ever carried, and no ``".lock"`` literal
  lives here.

Dropping is index-only (``git rm --cached``): the working-tree file stays,
because a live side-car may be held by a running writer and the host
identity is what binds this checkout. The parent commit keeps the blob, so
nothing is destroyed; the governance row names the parent and every path
so ``git show <parent>:<path>`` recovers any of them.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Mapping

from .file_lock import lock_sidecar_target
from .ledger_inline import spill_oversized_inline
from .state_manifest import state_group_lock_group, surface_for_relative_path
from .state_snapshot import STORAGE_POLICY

# The one place this set is declared; the immutable verifier imports it.
STATE_BOOTSTRAP_EMPTY_MARKERS = frozenset({
    "findings/.gitkeep",
    "tools/.gitkeep",
    "workspace/.gitkeep",
})

# Governance event a healing publish appends BEFORE the snapshot is built,
# so the row is inside the very commit whose tree omits the entries.
INHERITED_ENTRIES_DROPPED_EVENT = "state_publish_inherited_entries_dropped"

# A governance row is bounded (ledger row cap); a parent carrying more
# unclaimable entries than this still heals, and the row says how many
# were not listed — the parent commit sha recovers the rest. The count cap
# keeps the listed sample readable; the BYTE cap is the append primitive's
# (``LEDGER_ROW_MAX_BYTES``) and is met by construction: the listed entries
# pass through ``ledger_inline.spill_oversized_inline``, so a thousand long
# paths become a digest stub rather than a row the primitive refuses.
MAX_RECORDED_DROPPED_ENTRIES = 1000

# Paths per git invocation. The verifier admits up to 10,000 tree entries;
# handing them to one `git rm` / `git ls-files` would sit at the argv limit
# and push the bounded-output reader past its budget, so both walk the
# list in slices small enough for either bound to be a non-question.
_GIT_PATHSPEC_SLICE = 500


@dataclass(frozen=True)
class TreeEntryClassification:
    """One store-relative path judged against the published-tree contract."""

    kind: str  # "contract" | "surface" | "unclaimable"
    reason: str
    surface_name: str | None = None


@dataclass(frozen=True)
class InheritedEntry:
    path: str
    object_id: str
    reason: str


@dataclass(frozen=True)
class InheritedTree:
    """The parent commit's blobs, split by what a publish must do with them."""

    parent_commit: str
    surfaces: tuple[str, ...]
    unclaimable: tuple[InheritedEntry, ...]


def classify_state_tree_path(
    path: str,
    *,
    root_prefixes: Mapping[str, str],
) -> TreeEntryClassification:
    """Judge one store-relative blob path.

    ``root_prefixes`` maps a manifest ``root_kind`` to its store-relative
    prefix (``tools``, ``workspace/<repo_hash>``, ``findings``) — the same
    binding ``store_roots`` produces, passed in so this module never
    restates the layout.
    """
    from .state_store import GENESIS_FILENAME, SNAPSHOT_FILENAME

    if path in {GENESIS_FILENAME, SNAPSHOT_FILENAME}:
        return TreeEntryClassification("contract", "contract_file")
    if path in STATE_BOOTSTRAP_EMPTY_MARKERS:
        return TreeEntryClassification("contract", "bootstrap_marker")
    for root_kind, prefix in root_prefixes.items():
        if not path.startswith(prefix + "/"):
            continue
        relative = path[len(prefix) + 1:]
        surface = surface_for_relative_path(relative, root_kind=root_kind)
        if surface is not None:
            if STORAGE_POLICY[surface.state_class] == "excluded":
                return TreeEntryClassification(
                    "unclaimable",
                    f"excluded_surface:{surface.name}",
                    surface.name,
                )
            return TreeEntryClassification("surface", "declared_surface", surface.name)
        # The group-lock KEY first: it is itself side-car-shaped (the suffix
        # is file_lock's, applied to the bare group name), so decoding it as
        # a side-car would name a target — ``locks/state-groups/runtime`` —
        # that nothing ever creates.
        group = state_group_lock_group(relative)
        if group is not None:
            return TreeEntryClassification("unclaimable", f"state_group_lock:{group}")
        target = lock_sidecar_target(PurePosixPath(relative))
        if target is not None:
            # What the writers actually leave on disk: file_lock's side-car
            # OF the group key (``<group>.lock.lock``) — sixteen of them on
            # the 2026-09-11 tip. Named by the group it serialises.
            group = state_group_lock_group(target)
            if group is not None:
                return TreeEntryClassification(
                    "unclaimable",
                    f"state_group_lock_sidecar:{group}",
                )
            return TreeEntryClassification(
                "unclaimable",
                f"lock_sidecar:{target.as_posix()}",
            )
        return TreeEntryClassification("unclaimable", "undeclared")
    return TreeEntryClassification("unclaimable", "outside_declared_roots")


def _store_root_prefixes(store: Any, repo_hash: str) -> dict[str, str]:
    from .state_store import StateStoreError, store_roots

    prefixes: dict[str, str] = {}
    for root_kind, root in store_roots(store, repo_hash).items():
        try:
            prefixes[root_kind] = root.relative_to(store.root).as_posix()
        except ValueError:  # pragma: no cover - store_roots is store-relative
            raise StateStoreError(
                f"state_store_root_outside_store: {root.as_posix()} is not inside "
                f"{store.root.as_posix()}"
            ) from None
    return prefixes


def classify_inherited_tree(
    store: Any,
    *,
    repo_hash: str,
    base_head: str,
) -> InheritedTree:
    """List the parent commit's blobs and judge each one.

    Uses the immutable verifier's own bounded tree listing so a tree the
    verifier could not read is refused here by the same name, before the
    publish spends a snapshot build on it.
    """
    from .autonomy_evidence import _git_tree_entries
    from .state_store import StateStoreRefusal

    try:
        tree = _git_tree_entries(store.root, base_head)
    except RuntimeError as exc:
        raise StateStoreRefusal(
            f"state_publish_parent_tree_unreadable: {exc}"
        ) from exc
    prefixes = _store_root_prefixes(store, repo_hash)
    surfaces: list[str] = []
    unclaimable: list[InheritedEntry] = []
    for path, (_record, _mode, object_type, object_id) in sorted(tree.items()):
        if object_type != "blob":
            continue
        verdict = classify_state_tree_path(path, root_prefixes=prefixes)
        if verdict.kind == "surface":
            surfaces.append(path)
        elif verdict.kind == "unclaimable":
            unclaimable.append(InheritedEntry(path, object_id, verdict.reason))
    return InheritedTree(
        parent_commit=base_head,
        surfaces=tuple(surfaces),
        unclaimable=tuple(unclaimable),
    )


def _slices(paths: list[str]) -> list[list[str]]:
    return [
        paths[start:start + _GIT_PATHSPEC_SLICE]
        for start in range(0, len(paths), _GIT_PATHSPEC_SLICE)
    ]


def unclaimable_entries_still_indexed(
    store: Any,
    entries: tuple[InheritedEntry, ...],
) -> list[str]:
    """Which inherited unclaimable paths the index would still commit."""
    from .state_store import _git

    if not entries:
        return []
    indexed: set[str] = set()
    for chunk in _slices([entry.path for entry in entries]):
        listing = _git(store.root, "ls-files", "--cached", "-z", "--", *chunk)
        indexed.update(name for name in listing.split("\0") if name)
    return [entry.path for entry in entries if entry.path in indexed]


def drop_inherited_unclaimed_entries(
    store: Any,
    *,
    repo_hash: str,
    base_head: str,
) -> list[dict[str, str]]:
    """Stage the omission of every unclaimable inherited entry and record it.

    Runs BEFORE the snapshot is built: the governance row it appends is a
    write to ``tools/governance.jsonl``, which the snapshot attests, so the
    row travels inside the healing commit rather than in a working tree
    the runner throws away. Returns what it dropped (empty when the parent
    was already clean, in which case nothing is written anywhere).
    """
    from .ledger import LedgerIntegrityError
    from .state_store import StateStoreRefusal, _git, tools_root
    from .tool_registry import GovernanceError, append_tools_governance

    inherited = classify_inherited_tree(
        store,
        repo_hash=repo_hash,
        base_head=base_head,
    )
    indexed = set(unclaimable_entries_still_indexed(store, inherited.unclaimable))
    dropped = [entry for entry in inherited.unclaimable if entry.path in indexed]
    if not dropped:
        return []
    recorded = [
        {"path": entry.path, "object_id": entry.object_id, "reason": entry.reason}
        for entry in dropped[:MAX_RECORDED_DROPPED_ENTRIES]
    ]
    # The record comes FIRST. A frozen runtime profile, or an unbound tools
    # root, refuses the governance write; healing the index and then failing
    # to record it would be exactly the unrecorded mutation the frozen
    # profile forbids, so the refusal is surfaced as the publish verdict
    # before the index is touched. A governance ledger whose chain the
    # append primitive refuses to extend is the same verdict the
    # continuity gate gives when it cannot read that ledger: the publish
    # cannot vouch for anything through it, by that name.
    recovery = f"git show {base_head}:<path>"
    try:
        append_tools_governance(
            tools_root(store),
            INHERITED_ENTRIES_DROPPED_EVENT,
            {
                "parent_commit": base_head,
                "dropped_count": len(dropped),
                "entries": spill_oversized_inline(
                    "entries",
                    recorded,
                    recovery=(
                        f"git ls-tree -r {base_head}, judged by "
                        "state_tree_contract.classify_state_tree_path, "
                        "lists every dropped entry"
                    ),
                ),
                "entries_not_listed": len(dropped) - len(recorded),
                "recovery": recovery,
            },
        )
    except GovernanceError as exc:
        raise StateStoreRefusal(
            "state_publish_inherited_entries_record_refused: the parent tree "
            f"carries {len(dropped)} unclaimable entries and the governance row "
            f"naming them could not be written ({exc}); nothing was dropped"
        ) from exc
    except LedgerIntegrityError as exc:
        raise StateStoreRefusal(
            "state_publish_governance_ledger_unreadable: the governance row "
            f"naming {len(dropped)} inherited unclaimable entries could not be "
            f"appended ({str(exc)[:200]}); nothing was dropped"
        ) from exc
    for chunk in _slices([entry.path for entry in dropped]):
        _git(store.root, "rm", "--cached", "--quiet", "--", *chunk)
    return recorded


__all__ = [
    "INHERITED_ENTRIES_DROPPED_EVENT",
    "InheritedEntry",
    "InheritedTree",
    "MAX_RECORDED_DROPPED_ENTRIES",
    "STATE_BOOTSTRAP_EMPTY_MARKERS",
    "TreeEntryClassification",
    "classify_inherited_tree",
    "classify_state_tree_path",
    "drop_inherited_unclaimed_entries",
    "unclaimable_entries_still_indexed",
]
