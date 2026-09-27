"""Operator-override fixtures for the genesis policy (ARIA-MEDIUM-082).

A fixture that qualifies real source — the twin self-feature projection and
the per-mint re-observation over ~30 kernel files, each a bounded Git read —
must not depend on host speed: the 2 s runtime default failed beside a heavy
suite run (load about 5) and passed alone. The runtime reads its allowance
from ``genesis_policy.source_qualification_policy``, so a fixture widens it
through the same seam an operator would — the override file under the
workspace — never by patching a clock.
"""

from __future__ import annotations

import json
from pathlib import Path

from aria_kernel.genesis_policy import OVERRIDE_RELPATH

# Ample for a loaded host, yet still bounded (and under the policy ceiling):
# a genuinely hung read fails the test instead of hanging the suite.
AMPLE_QUALIFICATION_DEADLINE_SECONDS = 120.0


def write_source_qualification_override(
    workspace_root: Path, *, deadline_seconds: float = AMPLE_QUALIFICATION_DEADLINE_SECONDS,
) -> Path:
    """Write ``<workspace>/aria-config/genesis_policy.json`` with one block.

    Written BEFORE the fixture's commit so a committed-mode snapshot sees a
    clean tree; the merge is shallow per block, so only this block is set.
    """
    path = workspace_root / OVERRIDE_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"source_qualification": {"deadline_seconds": deadline_seconds}}
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
