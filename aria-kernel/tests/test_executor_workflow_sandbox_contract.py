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


def executable_yaml(text: str) -> str:
    """The workflow with comment-only lines removed.

    ORPHAN-MEDIUM-458 — the patterns above were matched against the raw file,
    so a YAML COMMENT satisfied them. An auditor deleted the entire "Verify
    the sandbox actually confines" step from `aria-agent-executor.yml` and
    this contract still passed, because a comment forty lines earlier
    happened to contain the words `sandbox_backend()`. A gate satisfied by
    prose about the gate is the failure mode this whole file exists to
    prevent, one level up.

    Line-level rather than a YAML parse on purpose: an inline `# ...` after a
    real command is part of a line that IS executable, and dropping the whole
    line would lose the command. Comment-only lines are the case that
    produced the bug and the only one this needs to remove.
    """
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )


def _workflows_invoking(executor: str) -> list[Path]:
    return [
        path for path in sorted(_WORKFLOWS.glob("*.yml"))
        if executor in path.read_text(encoding="utf-8")
    ]


# `uses: ./.github/actions/<name>` — a composite action living in this repo.
_LOCAL_ACTION_USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(\./[^\s#]+)", re.MULTILINE)


def containment_text(workflow: Path) -> str:
    """What the RUNNER executes for this workflow, composite actions included.

    RC-9 moved the install + verify pair out of two workflows and into
    `.github/actions/ensure-sandbox-backend`, because two hand-copied
    copies of a safety step is how the two lanes drift. This contract
    then failed both workflows — correctly, on its own terms: neither
    file declared containment any more.

    Forcing the steps back inline to satisfy the gate would be the tail
    wagging the dog: the gate exists to ensure the JOB has containment,
    and a composite action the job `uses:` is part of that job. So the
    contract now follows local `uses: ./...` references and reads the
    action's steps as what they are — steps this workflow runs.

    Deliberately NOT recursive and deliberately local-only: a third-party
    `uses:` is pinned by SHA and reviewed as a dependency, and following
    it would mean asserting containment on code this repo does not own.
    """
    text = workflow.read_text(encoding="utf-8")
    parts = [executable_yaml(text)]
    for match in _LOCAL_ACTION_USES.finditer(text):
        action_dir = _REPO_ROOT / match.group(1)[2:]
        for filename in ("action.yml", "action.yaml"):
            action = action_dir / filename
            if action.is_file():
                parts.append(executable_yaml(action.read_text(encoding="utf-8")))
                break
    return "\n".join(parts)


def enclosing_step(text: str, position: int) -> str:
    """The YAML step containing ``position``, found by indentation.

    Pre-RC-9 this was `text.rfind("\\n      - name:")` — the exact indent a
    step has inside a workflow job. A composite action indents its steps
    two levels less, so against an action the search found nothing, the
    "step" became the whole file, and the `continue-on-error: true` on an
    unrelated step read as if it were on the verification step. The
    boundary is a step marker at ANY indent, and the step ends at the
    next marker at the SAME indent.
    """
    lines = text.splitlines(keepends=True)
    offsets: list[int] = []
    running = 0
    for line in lines:
        offsets.append(running)
        running += len(line)
    index = max(i for i, offset in enumerate(offsets) if offset <= position)

    marker = re.compile(r"^(\s*)-\s+(name|uses|run|id):")
    start = 0
    indent = ""
    for i in range(index, -1, -1):
        found = marker.match(lines[i])
        if found:
            start, indent = i, found.group(1)
            break
    end = len(lines)
    for i in range(start + 1, len(lines)):
        found = marker.match(lines[i])
        if found and found.group(1) == indent:
            end = i
            break
    return "".join(lines[start:end])


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

    def test_i_sbx_02_is_not_satisfiable_by_a_comment(self) -> None:
        """ORPHAN-MEDIUM-458 — guards this gate against its own failure mode.

        An auditor deleted the whole "Verify the sandbox actually confines"
        step from `aria-agent-executor.yml` and this contract still passed:
        the raw-text match was satisfied by a comment forty lines earlier
        that happened to mention `sandbox_backend()`. A synthetic workflow
        whose ONLY mention of each pattern is inside a comment must fail
        both assertions.
        """
        commented_only = (
            "name: fake\n"
            "jobs:\n"
            "  run:\n"
            "    steps:\n"
            "      # apt-get install -y bubblewrap\n"
            "      # asserts sandbox_backend() is not None\n"
            "      - run: python3 tools/aria-poc/ci_executor.py\n"
        )
        code = executable_yaml(commented_only)
        self.assertIsNone(
            _INSTALL_PATTERN.search(code),
            "a commented-out apt-get install still satisfies I-SBX-01",
        )
        self.assertIsNone(
            _ASSERT_PATTERN.search(code),
            "a comment mentioning sandbox_backend() still satisfies I-SBX-02",
        )
        # And the inverse: a real command on the same line as a trailing
        # comment must still count, or stripping would break the gate it
        # is meant to strengthen.
        real = executable_yaml(
            "      - run: apt-get install -y bubblewrap  # needed for confinement\n"
        )
        self.assertIsNotNone(_INSTALL_PATTERN.search(real))

    def test_i_sbx_01_and_02_dispatching_workflows_declare_containment(self) -> None:
        checked = 0
        for executor in WRITE_CAPABLE_EXECUTORS:
            for workflow in _workflows_invoking(executor):
                checked += 1
                # ORPHAN-MEDIUM-458 — comments stripped before matching, so
                # the assertions below read what the runner executes rather
                # than what the file says about itself. RC-9 — and composite
                # actions the workflow `uses:` are part of what it executes.
                text = containment_text(workflow)
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
        """A verification step that cannot fail verifies nothing.

        Scoped to the step that CALLS `sandbox_backend()`, not to the job.
        RC-9's composite action marks its apt-get install
        `continue-on-error: true` on purpose — a host with no apt egress
        must reach the verify step and get its named cause, rather than
        dying inside apt and reporting "exit 100". Tolerating a failed
        install is not the same as tolerating a failed verification, and
        this assertion is about the second one.
        """
        checked = 0
        for executor in WRITE_CAPABLE_EXECUTORS:
            for workflow in _workflows_invoking(executor):
                text = containment_text(workflow)
                for match in _ASSERT_PATTERN.finditer(text):
                    checked += 1
                    step = enclosing_step(text, match.start())
                    with self.subTest(workflow=workflow.name):
                        self.assertNotIn(
                            "continue-on-error: true", step,
                            msg=(
                                f"{workflow.name}: the sandbox verification step is "
                                "advisory, so a missing backend would be reported and "
                                "then ignored"
                            ),
                        )
        self.assertGreater(
            checked, 0,
            "no sandbox_backend() call was found in any dispatching workflow or the "
            "composite actions it uses — this assertion passed vacuously, which is "
            "how it survived RC-9 moving the verify step into a composite action",
        )


if __name__ == "__main__":
    unittest.main()
