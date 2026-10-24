"""Public ARIA kernel API, resolved on first use (PEP 562).

WHY LAZY (PLAN-v2 B1, the derived authority set). This package used to
import every module in ``_EXPORT_MODULES`` the moment any part of the
kernel was imported, so importing ``aria_kernel.evidence_trust`` also ran
``cycle``, ``pressure`` and about 175 other files. What a module executes was
then not what its imports say, and the authority set — which is the
import closure of the code that judges ARIA (``self_improvement.
derived_authority_set``) — could not be computed from the source: a change
to any of those files could rewrite the Board's scorer at import time.

Now importing a module runs that module's own imports and nothing else.
A name re-exported here (``from aria_kernel import register_tool``) is
resolved by ``__getattr__`` the first time it is asked for: the first module
of ``_EXPORT_MODULES`` that binds it, the order the eager loop used.
``scripts/ci/aria-import-graph.py`` reads the same table to resolve such an
import. Kernel code never imports a name through this hook — the authority
set's import walker refuses one, because the modules it loads are not
visible in the source.
"""

from __future__ import annotations

import importlib as _importlib
from importlib.util import find_spec as _find_spec
from typing import Any

__version__ = "0.2.0"

_EXPORT_MODULES = (
    "adapter_calibration",
    "agent_genesis",
    "agent_priors",
    "agent_satisfaction",
    "apply_engine",
    "architecture",
    "auto_merge",
    "autonomy_unlock",
    "budget",
    "calibration",
    "capability_gap",
    "capability_resolver",
    "ci",
    "constants",
    "cycle",
    "cycle_diff",
    "discovery",
    "experiment",
    "feedback_store",
    "fitness",
    "fixture_runner",
    "goldset",
    "impact",
    "impact_graph",
    "integrity",
    "incident_ledger",
    "learning",
    "llm_bridge",
    "memory",
    "migration",
    "observability",
    "performance",
    "plan_convergence",
    "policy_approval",
    "pr_manager",
    "pr_tracking",
    "pressure",
    "promotion",
    "proposal",
    "quarantine",
    "readiness",
    "readiness_proofs",
    "reflection",
    "report_ingestion",
    "risk_policy",
    "rollback_bundle",
    "runtime_artifacts",
    "reverify",
    "research",
    "runner_attestation",
    "self_modification",
    "semantic_dedup",
    "task",
    "telemetry",
    "tool_health",
    "tool_registry",
    "tool_runner",
    "trailer_scan",
    "triage",
    "trust",
    "validation",
    "verification_gate",
    "worker_dispatch",
)


def _exported(name: str, value: object) -> bool:
    """What a module re-exports here: its public callables and constants."""
    return not name.startswith("_") and (callable(value) or name.isupper())


def _public_api() -> list[str]:
    """Every re-exported name, first binder first (``from aria_kernel import *``)."""
    names: dict[str, None] = {"__version__": None}
    for module_name in _EXPORT_MODULES:
        module = _importlib.import_module(f"{__name__}.{module_name}")
        names.update((name, None) for name, value in vars(module).items() if _exported(name, value))
    return list(names)


def __getattr__(name: str) -> Any:
    """A submodule, or a re-exported name, bound here the first time it is read.

    A submodule name imports that submodule and nothing else, so
    ``from . import command_policy`` and ``aria_kernel.cycle`` load one module
    each; only a name no submodule carries is searched for in
    ``_EXPORT_MODULES``.
    """
    if name == "__all__":
        value: Any = _public_api()
    elif name.startswith("_"):
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    elif _find_spec(f"{__name__}.{name}") is not None:
        value = _importlib.import_module(f"{__name__}.{name}")
    else:
        for module_name in _EXPORT_MODULES:
            namespace = vars(_importlib.import_module(f"{__name__}.{module_name}"))
            if name in namespace and _exported(name, namespace[name]):
                value = namespace[name]
                break
        else:
            raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    globals()[name] = value
    return value
