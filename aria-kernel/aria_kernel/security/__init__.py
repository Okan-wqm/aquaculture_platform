"""Plan 033 — Autonomous Security Engineering (kernel-internal).

Every 033 capability lives here, in ARIA's own core: the prerequisite gate, the
repository security profile, the kernel-owned security packs, the attack graph,
the assurance ledger, and (later phases) the campaign/lab/reproduction machinery.
Nothing here depends on the removable Lane-B security agents.
"""
from __future__ import annotations

__all__ = ["prerequisites"]
