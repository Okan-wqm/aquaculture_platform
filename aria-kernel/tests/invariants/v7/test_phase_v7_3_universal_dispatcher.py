"""Plan ARIA-V7 §2g v2 V7.3 — universal dispatcher invariants.

Five invariants pin the dispatcher factory contract:

  * I-V7.3-01 — SUPPORTED_ROLES enumerates exactly 9 dispatchable
                roles (closed enum; typo'd roles fail at factory
                selection time, NOT runtime polling)
  * I-V7.3-02 — kernel SUPPORTED_ROLES MATCHES ci_executor
                SUPPORTED_ROLES (kernel + consumer parity invariant)
  * I-V7.3-03 — select_drafter rejects unknown role with ValueError
                (no silent acceptance)
  * I-V7.3-04 — select_judge rejects unknown role with ValueError
  * I-V7.3-05 — default_dispatcher_config honours env-var overrides
                (operator-tunable cost discipline)
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV7_3UniversalDispatcher(unittest.TestCase):
    # I-V7.3-01 — SUPPORTED_ROLES closed enum (exactly 10; the
    # plan-coverage gate PR-2 added completeness_critique).
    def test_i_v7_3_01_supported_roles_closed_enum(self) -> None:
        """Plan ARIA-V7 §2g v2 — closed role enum."""
        from aria_kernel.dispatcher_factory import SUPPORTED_ROLES
        expected = {
            "specialist_domain_review",
            "primary_authoring", "challenger_authoring",
            "evidence_judgment", "adversarial_judgment",
            "primary_plan", "challenger_plan", "cross_review",
            "completeness_critique",
            "implementation",
        }
        self.assertEqual(
            set(SUPPORTED_ROLES), expected,
            msg=(
                "Plan ARIA-V7 §2g v2 — SUPPORTED_ROLES MUST match the "
                "10-role closed enum exactly. Adding a role requires "
                "updating BOTH kernel + ci_executor in the same commit."
            ),
        )

    # I-V7.3-02 — kernel + consumer parity.
    def test_i_v7_3_02_kernel_consumer_role_parity(self) -> None:
        """Plan ARIA-V7 §2g v2 — kernel SUPPORTED_ROLES == ci_executor SUPPORTED_ROLES."""
        from aria_kernel.dispatcher_factory import (
            SUPPORTED_ROLES as KERNEL_ROLES,
        )
        ci_path = _REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"
        spec = importlib.util.spec_from_file_location(
            "_ci_exec_under_test", ci_path,
        )
        ci_mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(ci_mod)
        except Exception as exc:
            self.fail(
                f"Plan ARIA-V7 §2g v2 — tools/aria-poc/ci_executor.py "
                f"failed to import for parity check: {exc}"
            )
        ci_roles = getattr(ci_mod, "SUPPORTED_ROLES", None)
        self.assertIsNotNone(
            ci_roles,
            msg=(
                "Plan ARIA-V7 §2g v2 — ci_executor.py MUST define "
                "SUPPORTED_ROLES (V7.3 consumer-side parity invariant)."
            ),
        )
        self.assertEqual(
            set(KERNEL_ROLES), set(ci_roles),
            msg=(
                "Plan ARIA-V7 §2g v2 — kernel SUPPORTED_ROLES MUST "
                "exactly match consumer SUPPORTED_ROLES. Drift between "
                f"kernel ({sorted(KERNEL_ROLES)}) and consumer "
                f"({sorted(ci_roles)}) breaks the role-routing contract."
            ),
        )

    # I-V7.3-03 — select_drafter rejects unknown.
    def test_i_v7_3_03_select_drafter_rejects_unknown(self) -> None:
        """Plan ARIA-V7 §2g v2 — unknown role → ValueError at factory time."""
        from aria_kernel.dispatcher_factory import select_drafter
        with self.assertRaises(ValueError) as ctx:
            select_drafter(role="not_a_real_role")
        self.assertIn("unknown_role", str(ctx.exception))

    # I-V7.3-04 — select_judge rejects unknown.
    def test_i_v7_3_04_select_judge_rejects_unknown(self) -> None:
        """Plan ARIA-V7 §2g v2 — unknown role → ValueError at factory time."""
        from aria_kernel.dispatcher_factory import select_judge
        with self.assertRaises(ValueError):
            select_judge(role="not_a_real_role")

    # I-V7.3-05 — env-var overrides honoured.
    def test_i_v7_3_05_env_var_overrides(self) -> None:
        """Plan ARIA-V7 §2g v2 — operator-tunable via env-var."""
        import os
        from aria_kernel.dispatcher_factory import default_dispatcher_config
        prev = os.environ.get("ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS")
        try:
            os.environ["ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS"] = "123.5"
            cfg = default_dispatcher_config()
            self.assertEqual(
                cfg["poll_timeout_seconds"], 123.5,
                msg=(
                    "Plan ARIA-V7 §2g v2 — env-var override MUST be "
                    "honoured (operator-tunable cost discipline). "
                    f"Got: {cfg['poll_timeout_seconds']}"
                ),
            )
        finally:
            if prev is None:
                os.environ.pop("ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS", None)
            else:
                os.environ["ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS"] = prev


if __name__ == "__main__":
    unittest.main()
