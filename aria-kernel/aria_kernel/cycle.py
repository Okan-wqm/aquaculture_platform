from __future__ import annotations

import json
from datetime import datetime, timezone

from .feedback import derive_pressure
from .ledger import verify_index_hashes, write_index
from .workspace import WorkspacePaths


def run_cycle(paths: WorkspacePaths) -> dict[str, object]:
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    emitted = derive_pressure(paths, index)
    write_index(paths.feedback_index, index, paths.ledgers)

    cycle_id = datetime.now(timezone.utc).strftime("cyc-%Y%m%dT%H%M%SZ")
    state = {
        "cycle_id": cycle_id,
        "repo_root": str(paths.repo_root),
        "workspace_root": str(paths.workspace_root),
        "feedback_pressure_emitted": len(emitted),
        "schema_version": 1,
    }
    (paths.cycle_dir / f"{cycle_id}.json").write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return state
