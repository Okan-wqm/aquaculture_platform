"""Load ``tools/aria-poc/ci_executor.py`` from its file, the one right way.

The executor is a script, not a package module, so tests that inspect it
load it from its path. The importlib recipe REGISTERS the module in
``sys.modules`` before executing it: the executor carries postponed
annotations and ``@dataclass`` resolves a field's type through
``sys.modules[cls.__module__].__dict__`` — an unregistered module made every
loader fail at ``_NativeRuntimePlan`` with "'NoneType' object has no attribute
'__dict__'" (2026-09-13: three loaders, three private recipes, one right).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

EXECUTOR_PATH = Path(__file__).resolve().parents[3] / "tools" / "aria-poc" / "ci_executor.py"


def load_ci_executor(name: str = "ci_executor_under_test") -> ModuleType:
    """Execute the executor file as module ``name`` and return it.

    Registered under ``name`` for the duration of the load only: the tests
    that need the module keep the returned object; nothing else should find
    a stray executor under a test's name afterwards.
    """
    spec = importlib.util.spec_from_file_location(name, EXECUTOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(spec.name, None)
    return module


__all__ = ["EXECUTOR_PATH", "load_ci_executor"]
