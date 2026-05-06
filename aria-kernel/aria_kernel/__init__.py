"""Public ARIA kernel API."""

from __future__ import annotations

from importlib import import_module

__version__ = "0.2.0"

_EXPORT_MODULES = (
    "adapter_calibration",
    "agent_genesis",
    "agent_priors",
    "agent_satisfaction",
    "apply_engine",
    "architecture",
    "auto_merge",
    "budget",
    "calibration",
    "capability_gap",
    "ci",
    "codegen",
    "constants",
    "cycle",
    "cycle_diff",
    "discovery",
    "executor",
    "feedback_store",
    "fitness",
    "fixture_runner",
    "goldset",
    "heartbeat",
    "impact",
    "impact_graph",
    "integrity",
    "learning",
    "llm_bridge",
    "memory",
    "migration",
    "observability",
    "performance",
    "plan_convergence",
    "pr_manager",
    "pr_tracking",
    "pressure",
    "promotion",
    "proposal",
    "quarantine",
    "readiness",
    "reflection",
    "reverify",
    "research",
    "self_modification",
    "task",
    "telemetry",
    "tool_health",
    "tool_registry",
    "tool_runner",
    "trailer_scan",
    "trust",
    "validation",
)

__all__: list[str] = ["__version__"]

for _module_name in _EXPORT_MODULES:
    _module = import_module(f"{__name__}.{_module_name}")
    for _name, _value in vars(_module).items():
        if _name.startswith("_"):
            continue
        if callable(_value) or _name.isupper():
            globals().setdefault(_name, _value)
            __all__.append(_name)

del import_module, _EXPORT_MODULES, _module_name, _module, _name, _value
