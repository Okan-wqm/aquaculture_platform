"""ORPHAN-CRITICAL-439 — a write-capable executor job must carry containment.

`claude_runtime._apply_write_containment` refuses a write-capable spawn when
`implementation_safety.sandbox_backend()` is None. That is the correct
fail-closed behaviour and it is also a trap: no workflow installed a backend, so
the containment layer was indistinguishable from a hard disable. The implementer
would not have run unconfined — it would not have run at all, and the failure
would have read as an agent problem rather than a missing package.

Fixing the one workflow is tier 2: it works until someone adds the second
executor. These invariants are the tier-3 half — a workflow that dispatches a
write-capable executor and does not declare both the backend install and the
capability assertion fails here, at build time, rather than at 03:00 in a
scheduled run whose only symptom is an empty cycle.

  * I-SBX-01 — every workflow invoking a write-capable executor installs a backend
  * I-SBX-02 — ...and asserts sandbox_backend() is not None
  * I-SBX-03 — the assertion is a hard failure, not advisory
  * I-SBX-04 — the executor entrypoints this contract covers are enumerated, and
               the enumeration matches what the repo actually contains
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

# Entrypoints that can reach a write-capable Claude spawn. Kept as a literal so
# adding one is a deliberate edit here, with the contract in view.
WRITE_CAPABLE_EXECUTORS: tuple[str, ...] = (
    "tools/aria-poc/ci_executor.py",
    "tools/aria-poc/worker_executor.py",
)

_INSTALL_PATTERN = re.compile(r"apt-get\s+install[^\n]*\b(bubblewrap|firejail)\b")
_ASSERT_PATTERN = re.compile(r"sandbox_backend\s*\(")


def _workflows_invoking(executor: str) -> list[Path]:
    return [
        path for path in sorted(_WORKFLOWS.glob("*.yml"))
        if executor in path.read_text(encoding="utf-8")
    ]


class ExecutorWorkflowSandboxContract(unittest.TestCase):
    def test_i_sbx_04_executor_enumeration_matches_the_repo(self) -> None:
        """The covered set must not silently fall behind the repo."""
        for executor in WRITE_CAPABLE_EXECUTORS:
            with self.subTest(executor=executor):
                self.assertTrue(
                    (_REPO_ROOT / executor).is_file(),
                    f"{executor} is enumerated as write-capable but does not exist; "
                    "either restore it or remove it from WRITE_CAPABLE_EXECUTORS",
                )
        # Any executor that spawns Claude and is not enumerated is a gap in this
        # contract, so the discovery is asserted rather than assumed.
        poc = _REPO_ROOT / "tools" / "aria-poc"
        spawners = {
            f"tools/aria-poc/{path.name}"
            for path in sorted(poc.glob("*executor*.py"))
            if "run_claude_exec" in path.read_text(encoding="utf-8")
        }
        self.assertLessEqual(
            spawners, set(WRITE_CAPABLE_EXECUTORS),
            "an executor calls run_claude_exec but is not covered by this contract: "
            f"{sorted(spawners - set(WRITE_CAPABLE_EXECUTORS))}",
        )

    def test_i_sbx_01_and_02_dispatching_workflows_declare_containment(self) -> None:
        checked = 0
        for executor in WRITE_CAPABLE_EXECUTORS:
            for workflow in _workflows_invoking(executor):
                checked += 1
                text = workflow.read_text(encoding="utf-8")
                # Deliberately not assertRegex: it embeds the entire workflow in
                # the failure message, which buries the one sentence a reader
                # needs. A gate whose failure output is unreadable gets skipped.
                with self.subTest(workflow=workflow.name, executor=executor):
                    if not _INSTALL_PATTERN.search(text):
                        self.fail(
                            f"{workflow.name} dispatches {executor} but installs no "
                            "sandbox backend (expected an apt-get install of "
                            "bubblewrap or firejail). sandbox_backend() would be None "
                            "and every write-capable spawn would be refused, so the "
                            "job produces nothing and the cause is invisible."
                        )
                    if not _ASSERT_PATTERN.search(text):
                        self.fail(
                            f"{workflow.name} installs a backend but never calls "
                            "sandbox_backend() to assert it works. Installing is not "
                            "confining: bubblewrap installs cleanly on a host where "
                            "unprivileged user namespaces are disabled."
                        )
        self.assertGreater(
            checked, 0,
            "no workflow dispatches a write-capable executor — if that is now "
            "true, this contract is dead code and should be removed deliberately",
        )

    def test_i_sbx_03_the_assertion_is_not_advisory(self) -> None:
        """A verification step that cannot fail verifies nothing."""
        for executor in WRITE_CAPABLE_EXECUTORS:
            for workflow in _workflows_invoking(executor):
                text = workflow.read_text(encoding="utf-8")
                for match in _ASSERT_PATTERN.finditer(text):
                    # Look back to the enclosing step and forward to the next one.
                    start = text.rfind("\n      - name:", 0, match.start())
                    end = text.find("\n      - name:", match.end())
                    step = text[start if start >= 0 else 0: end if end >= 0 else len(text)]
                    with self.subTest(workflow=workflow.name):
                        self.assertNotIn(
                            "continue-on-error: true", step,
                            msg=(
                                f"{workflow.name}: the sandbox verification step is "
                                "advisory, so a missing backend would be reported and "
                                "then ignored"
                            ),
                        )


if __name__ == "__main__":
    unittest.main()
