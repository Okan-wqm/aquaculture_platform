"""Plan ARIA-V2 §3.5 + I-18 — SERVICE_MAP.json v1 ↔ v2 upcaster.

v1 shape:
    {
      "schema_version": 1,
      "apps": [...rows...],
      "web": [...flat list of web/* top-level rows...],
      "platform_libs": [...],
      "libs": [...]
    }

v2 shape:
    {
      "schema_version": 2,
      "apps": [...rows...],
      "web": {
        "modules": [...MFE rows...],
        "apps": [...web/apps rows...],
        "shared_ui": [...row...],
        "shell": [...row...]
      },
      "platform_libs": [...],
      "libs": [...]
    }

The non-``web`` top-level keys are unchanged between versions; only
``web`` reshapes from flat list to typed buckets. ``downcast`` recovers
a v1-shape ``web`` list by union-flattening all bucket lists in a
deterministic order (modules → apps → shared_ui → shell) so v1
consumers see every project exactly once.

Round-trip is value-preserving for the v1 representable subset — i.e.
``downcast(upcast(v1))`` returns the original ``web`` list IFF the v1
list contained only rows whose ``path`` falls under one of the four
v2 buckets. Rows under unrecognized paths are preserved in a
``_unrouted`` bucket so no information is lost.
"""

from __future__ import annotations

from typing import Any


_WEB_BUCKET_PREFIXES: dict[str, str] = {
    "modules": "web/modules/",
    "apps": "web/apps/",
    "shared_ui": "web/shared-ui",
    "shell": "web/shell",
}


def _classify_web_row(row: dict[str, Any]) -> str:
    """Decide which v2 web-bucket a v1 row belongs to based on path."""
    path = str(row.get("path") or "")
    if path.startswith(_WEB_BUCKET_PREFIXES["modules"]) or path == "web/modules":
        return "modules"
    if path.startswith(_WEB_BUCKET_PREFIXES["apps"]) or path == "web/apps":
        return "apps"
    if path == _WEB_BUCKET_PREFIXES["shared_ui"] or path.startswith(_WEB_BUCKET_PREFIXES["shared_ui"] + "/"):
        return "shared_ui"
    if path == _WEB_BUCKET_PREFIXES["shell"] or path.startswith(_WEB_BUCKET_PREFIXES["shell"] + "/"):
        return "shell"
    return "_unrouted"


def upcast(v1: dict[str, Any]) -> dict[str, Any]:
    """v1 → v2 forward direction.

    The v1 ``web`` flat list contained top-level web/* children
    (4 entries: apps, modules, shared-ui, shell). Upcast collapses
    these top-level placeholder rows since v2 enumerates contents,
    not the parent dirs. Where the v1 row pointed to a real leaf
    project (rare; only ``shared-ui`` and ``shell`` qualify), it
    lands in its typed bucket.
    """
    if int(v1.get("schema_version") or 0) >= 2:
        return v1
    v2 = dict(v1)
    v2["schema_version"] = 2
    legacy_web = v1.get("web") or []
    if isinstance(legacy_web, list):
        buckets: dict[str, list[dict[str, Any]]] = {
            "modules": [],
            "apps": [],
            "shared_ui": [],
            "shell": [],
            "_unrouted": [],
        }
        for row in legacy_web:
            if not isinstance(row, dict):
                continue
            # v1 top-level web rows (web/modules, web/apps, etc.)
            # are placeholder parent-dir markers; they don't translate
            # to v2 leaf rows. Only treat them as v2 rows if they
            # name a real leaf project (shared-ui / shell).
            path = str(row.get("path") or "")
            if path in ("web/modules", "web/apps"):
                continue
            bucket = _classify_web_row(row)
            buckets[bucket].append(row)
        v2["web"] = {
            key: buckets[key]
            for key in ("modules", "apps", "shared_ui", "shell")
        }
        if buckets["_unrouted"]:
            v2["web"]["_unrouted"] = buckets["_unrouted"]
    elif isinstance(legacy_web, dict):
        # Already v2-shaped (defensive — caller might have passed
        # a partially-migrated payload).
        v2["web"] = legacy_web
    return v2


def downcast(v2: dict[str, Any]) -> dict[str, Any]:
    """v2 → v1 reverse direction (used by rollback path).

    Flattens the typed-bucket ``web`` back into a single list in
    deterministic order (modules → apps → shared_ui → shell). Any
    ``_unrouted`` rows preserved during upcast land at the tail.
    """
    if int(v2.get("schema_version") or 0) < 2:
        return v2
    v1 = dict(v2)
    v1["schema_version"] = 1
    typed_web = v2.get("web")
    if isinstance(typed_web, dict):
        flat: list[dict[str, Any]] = []
        for key in ("modules", "apps", "shared_ui", "shell", "_unrouted"):
            bucket = typed_web.get(key) or []
            if isinstance(bucket, list):
                flat.extend(bucket)
        v1["web"] = flat
    return v1
