"""P0 regression — the worker lane's tools-root resolution must honor env.

2026-09-16 finding: worker_executor hardcoded `repo / "aria-tools"`. On the
runner the durable store is `.aria-state-store/tools` and ONLY the
ARIA_TOOLS_DIR env var points there, so worker usage/cost rows and dispatch
results were written to the ephemeral checkout tree — the silent sibling of
the cost_attribution_missing sentinel, and the dual-tools-root hazard the
state-store action.yml warns about.
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

POC_DIR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
sys.path.insert(0, str(POC_DIR))

worker_executor = importlib.import_module("worker_executor")


class WorkerToolsDirResolution(unittest.TestCase):
    def test_env_wins_over_checkout_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_root = Path(tmp) / "durable-store" / "tools"
            env_root.mkdir(parents=True)
            repo = Path(tmp) / "repo"
            repo.mkdir()
            old = os.environ.get("ARIA_TOOLS_DIR")
            try:
                os.environ["ARIA_TOOLS_DIR"] = str(env_root)
                self.assertEqual(worker_executor._resolve_tools_dir(repo), env_root)
            finally:
                if old is None:
                    os.environ.pop("ARIA_TOOLS_DIR", None)
                else:
                    os.environ["ARIA_TOOLS_DIR"] = old

    def test_checkout_fallback_when_env_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            old = os.environ.pop("ARIA_TOOLS_DIR", None)
            try:
                self.assertEqual(
                    worker_executor._resolve_tools_dir(repo), repo / "aria-tools"
                )
            finally:
                if old is not None:
                    os.environ["ARIA_TOOLS_DIR"] = old


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
