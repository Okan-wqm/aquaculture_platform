"""The one table both finding-id grammar owners are held to, read when a test asks for it (REG-ID).

``tools/gates/fixtures/finding-id-grammar-table.json`` is the table the TypeScript owner
(``tools/gates/finding-id-grammar.ts``) and the Python owner
(``aria_kernel/finding_id_grammar.py``) are both judged by. It lives under ``tools/gates``, outside
the kernel surface (``.github/manifests/aria-kernel-surface.json``), so the modules that read it
declare ``READS_LIVE_CHECKOUT`` and run in the always-run ``workspace`` job, never in a skippable shard.

WHY THE READ IS NOT AT IMPORT. Unittest discovery and pytest collection import every test module,
the live ones included, in every shard process; a module that read the table while it was imported
made each shard read a tracked file outside the surface, and the read trace
(``scripts/ci/aria_read_trace.py verify``) failed all of them. The declaration moves a module's TESTS to
the always-run job; it does not stop its import from happening in the shards. So the table is read
here, on the first call from a running test, and by no module that is merely imported.
"""
from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

_TABLE_PATH = Path(__file__).resolve().parents[3] / "tools" / "gates" / "fixtures" / "finding-id-grammar-table.json"


@functools.cache
def finding_id_table() -> dict[str, Any]:
    """The table: ``accept``, ``reject``, ``limit``, ``format``, ``formatRefused``, ``order``."""
    table = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))
    if not isinstance(table, dict):
        raise TypeError(f"{_TABLE_PATH} is not a JSON object")
    return table


def accepted_ids() -> list[str]:
    """Every id the table says both owners read."""
    return [entry["id"] for entry in finding_id_table()["accept"]]


def rejected_values() -> list[str]:
    """Every value the table says both owners refuse."""
    return list(finding_id_table()["reject"])
