"""Plan ARIA-V7 v2 shared test helpers."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _valid_plan_content_fake(**kwargs: Any) -> dict[str, Any]:
    """Plan ARIA-V7 §2i v2 V7.1 — minimal valid plan_content for tests."""
    cycle_id = kwargs.get("cycle_id", "cycle-test")
    return {
        "schema_version": 1,
        "title": f"Fake cycle {cycle_id}",
        "summary": "V7 invariant fixture",
        "affected_surfaces": ["fixture.py"],
        "key_changes": [{
            "id": "c1", "description": "fixture cluster",
            "paths": ["fixture.py"],
        }],
        "validation_commands": [{
            "cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0,
        }],
        "evidence_refs": ["fixture.py:1:fixture line"],
    }


def _none_synthesizer(**kwargs: Any) -> None:
    """Plan ARIA-V7 §2i v2 V7.1 — no-pressure synthesizer mock."""
    return None
