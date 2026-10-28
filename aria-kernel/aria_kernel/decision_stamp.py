"""ARIA-LOW-741 (F3.1) — the decision stamp of a delivered change, with ONE owner.

Two facts about a delivered change are recorded beside its outcome: which
``(provider, model)`` executed it, and how big it is (``git diff --numstat``).
Three modules that cannot import each other need the same closed shape — the
delivery writes it, the plan ledger carries and validates it, the episode
reader groups by it — so the shape lives here and nowhere else.

The shape (``schema_version`` 1)::

    {"schema_version": 1,
     "route": {"provider": str, "model": str} | None,
     "numstat": [{"path": str, "added": int | None, "deleted": int | None}, ...]}

``route`` is ``None`` when no route can be proven, never a guess. ``numstat`` is
non-empty (a delivered change touched a path), sorted by path, with no path
twice; ``added``/``deleted`` are both ``None`` (a binary file) or both
non-negative ints. Totals are NEVER stored beside the entries, so they cannot
drift: :func:`stamp_churn` is the one place they are computed.

Where the facts come from is not decided here: the route is
``independence_check.executed_route_of`` and the counts are
``change_paths.parse_change_z``. This module imports neither at module level
(``ChangeChurn`` only for typing), so the plan ledger can import it with no
import cycle.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from .tool_registry import GovernanceError

if TYPE_CHECKING:
    from .change_paths import ChangeChurn

DECISION_STAMP_FIELD = "decision_stamp"
DECISION_STAMP_SCHEMA_VERSION = 1

# The route key of a delivered change whose stamp is absent or whose route is
# null: the unstamped share is a number, never hidden.
UNSTAMPED_ROUTE = "unstamped"

_STAMP_KEYS = frozenset({"schema_version", "route", "numstat"})
_ROUTE_KEYS = frozenset({"provider", "model"})
_ENTRY_KEYS = frozenset({"path", "added", "deleted"})


def _invalid(field: str) -> GovernanceError:
    return GovernanceError(f"decision_stamp_invalid: {field}")


def _is_count(value: object) -> bool:
    # ``bool`` is an ``int`` subclass; a flag is not a line count.
    return type(value) is int and value >= 0


def _validate_route(route: object) -> None:
    if route is None:
        return
    if not isinstance(route, Mapping) or set(route) != _ROUTE_KEYS:
        raise _invalid("route")
    for name in ("provider", "model"):
        value = route[name]
        if not isinstance(value, str) or not value.strip():
            raise _invalid(f"route.{name}")


def _validate_entry(index: int, entry: object) -> str:
    where = f"numstat[{index}]"
    if not isinstance(entry, Mapping) or set(entry) != _ENTRY_KEYS:
        raise _invalid(where)
    path, added, deleted = entry["path"], entry["added"], entry["deleted"]
    if not isinstance(path, str) or not path:
        raise _invalid(f"{where}.path")
    if added is None and deleted is None:
        return path
    for name, count in (("added", added), ("deleted", deleted)):
        if not _is_count(count):
            raise _invalid(f"{where}.{name}")
    return path


def validate_decision_stamp(stamp: object) -> None:
    """Raise ``GovernanceError("decision_stamp_invalid: <field>")`` unless ``stamp`` is the closed shape."""
    if not isinstance(stamp, Mapping) or set(stamp) != _STAMP_KEYS:
        raise _invalid("keys")
    version = stamp["schema_version"]
    if type(version) is not int or version != DECISION_STAMP_SCHEMA_VERSION:
        raise _invalid("schema_version")
    _validate_route(stamp["route"])
    numstat = stamp["numstat"]
    if not isinstance(numstat, list) or not numstat:
        raise _invalid("numstat")
    paths = [_validate_entry(index, entry) for index, entry in enumerate(numstat)]
    for index in range(1, len(paths)):
        if paths[index] <= paths[index - 1]:
            raise _invalid(f"numstat[{index}].path is a duplicate or out of order")


def build_decision_stamp(route: tuple[str, str] | None, churn: ChangeChurn) -> dict[str, Any]:
    """The stamp of a change that ``route`` executed and whose counts are ``churn``.

    The only constructor: it validates what it builds, so a stamp the ledger
    would refuse at every fold is never minted.
    """
    stamp: dict[str, Any] = {
        "schema_version": DECISION_STAMP_SCHEMA_VERSION,
        "route": None if route is None else {"provider": route[0], "model": route[1]},
        "numstat": [
            {"path": path, "added": added, "deleted": deleted}
            for path, added, deleted in sorted(churn.entries, key=lambda entry: entry[0])
        ],
    }
    validate_decision_stamp(stamp)
    return stamp


def stamp_churn(stamp: Mapping[str, Any]) -> dict[str, int]:
    """The size of a stamped change: files, added and deleted lines, and how many files are binary.

    A binary file is a file and a binary; it adds no lines to the measured totals.
    """
    entries = stamp["numstat"]
    return {
        "files": len(entries),
        "added": sum(entry["added"] or 0 for entry in entries),
        "deleted": sum(entry["deleted"] or 0 for entry in entries),
        "binary": sum(entry["added"] is None for entry in entries),
    }


def stamp_route_key(stamp: Mapping[str, Any] | None) -> str:
    """``"provider/model"`` of a stamped change, or :data:`UNSTAMPED_ROUTE`."""
    route = None if stamp is None else stamp["route"]
    if route is None:
        return UNSTAMPED_ROUTE
    return f"{route['provider']}/{route['model']}"


__all__ = [
    "DECISION_STAMP_FIELD",
    "DECISION_STAMP_SCHEMA_VERSION",
    "UNSTAMPED_ROUTE",
    "build_decision_stamp",
    "stamp_churn",
    "stamp_route_key",
    "validate_decision_stamp",
]
