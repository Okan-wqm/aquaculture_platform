"""Code facts for fixture trees that carry no event or gateway contract (SE-4).

The impact closure (``impact_graph.impact_closure``) walks import, gateway_subgraph and event edges
and takes the event edges from SE-3's code facts. A fixture about the import walk, pressure
scoping or routing has no application that produces or consumes an event, so its true facts are
computed and empty: this is that value, in ``plan_coverage.compute_service_facts``'s shape.
"""
from __future__ import annotations

from typing import Any

NO_CONTRACT_FACTS: dict[str, Any] = {
    "verdict": "computed",
    "facts_sha": "0" * 40,
    "event_facts": {"schema": "aria/event_facts/v1", "services": [], "event_definitions": []},
    "module_facts": {"services": []},
    "witness": {},
}


def facts_without_contract_edges() -> Any:
    """Patch the kernel's workspace facts (``plan_coverage.compute_service_facts_at_head``, which
    every workspace-level closure caller imports at call time) to ``NO_CONTRACT_FACTS``.

    For fixtures whose workspace has no TypeScript toolchain and whose subject is not the contract
    edges: plan admission, the learning hook. On such a tree the real answer is a named hold
    (``contract_edges_unavailable:toolchain_missing``), which the closure suites pin."""
    from unittest.mock import patch

    return patch("aria_kernel.plan_coverage.compute_service_facts_at_head", return_value=NO_CONTRACT_FACTS)
