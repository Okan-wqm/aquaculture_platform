"""ORPHAN-HIGH-728 — the nightly lane's authority, and the wall above it.

Two halves that only mean something together.

The first half is that the producer lane can reach the pipeline
`runtime_profile` documents WHEN AN OPERATOR HAS SAID IT MAY. It ran
`--profile standard` while the profile table withholds `pr_create` from
standard, so ARIA could converge a plan every night and had no authority to
open the pull request that plan describes — and nothing reported a refusal,
because from the workflow's point of view nothing had been attempted. The
profile is now a verdict read from the existing L1 autonomy ladder and then
BOUNDED by `scheduler_profile_ceiling`, an operator value in the same
`runtime_profile` control plane. Evidence can say the repository has earned
more authority; only an operator can grant it, and these tests are where the
difference is provable rather than asserted.

The second half is that raising the ceiling did not raise the roof.
`pr_merge` remains autonomous-only, `RealAutoMergeRunner` still forces
`dry_run` for every profile that is not `autonomous`, `merge_pr_if_ready`
still demands the unlock ladder, and charter M-6.1 still says no
self-merge. A change that grants ARIA the authority to PROPOSE has to be
provably not a change that grants it the authority to LAND, and this file
is where that is provable rather than asserted.

The workflow half EXECUTES the gate's own script against a seeded ledger
rather than pattern-matching the YAML around it. A regex can only pin that
some words are present; running the script pins what the runner will
actually decide, which is the thing that matters at 01:13 UTC.
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

from tests.test_executor_workflow_sandbox_contract import executable_yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "aria-auto-cycle.yml"
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_MISSION_SPEC = _REPO_ROOT / "docs" / "aria" / "MISSION_SPEC.md"

# The step that answers "what authority does tonight run under". Held as a
# constant because every assertion below is about THIS step; a rename that
# leaves the constant behind fails loudly instead of vacuously passing.
_GATE_STEP_ID = "profile_gate"


def _cycle_steps() -> list[dict]:
    document = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))
    return document["jobs"]["cycle"]["steps"]


def _step_by_id(step_id: str) -> dict:
    for step in _cycle_steps():
        if step.get("id") == step_id:
            return step
    raise AssertionError(f"{_WORKFLOW.name}: no step with id {step_id!r}")


def _cycle_run_step() -> dict:
    for step in _cycle_steps():
        run = step.get("run")
        if isinstance(run, str) and "aria_kernel autonomy run" in run:
            return step
    raise AssertionError(f"{_WORKFLOW.name}: no `autonomy run` step")


def _tree_fingerprint(root: Path) -> dict[str, tuple[int, str]]:
    """Content + mtime of every file under `root`.

    Used to prove a step wrote NOTHING. Content alone would miss an
    idempotent rewrite (the tools-index refresh writes the same bytes back),
    and an idempotent write into a frozen kernel is still a write.
    """
    import hashlib

    return {
        str(path.relative_to(root)): (
            path.stat().st_mtime_ns,
            hashlib.sha256(path.read_bytes()).hexdigest(),
        )
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _gate_script() -> str:
    """The python the gate step feeds to a heredoc, dedented and runnable."""
    run = _step_by_id(_GATE_STEP_ID)["run"]
    body = run.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    return textwrap.dedent(body)


class TheNightlyProfileIsAVerdictNotALiteral(unittest.TestCase):
    def test_the_gate_step_exists_and_is_runnable_python(self) -> None:
        ast.parse(_gate_script())

    def test_the_gate_delegates_the_decision_to_the_kernel(self) -> None:
        """The YAML prints a decision; it does not make one.

        A copy of the resolution rule in a heredoc would be the second
        answer to "may ARIA act" that this change exists to delete, and the
        one place no test can patch. `resolve_scheduled_profile` owns the
        three inputs and their order.
        """
        script = _gate_script()
        self.assertIn(
            "from aria_kernel.autonomy_unlock import resolve_scheduled_profile",
            script,
        )
        self.assertIn("resolve_scheduled_profile(", script)
        self.assertNotIn("assert_autonomy_unlocked", script)

    def test_the_gate_never_spends_the_merge_gates_verdict_row(self) -> None:
        """`evaluate_autonomy_unlock`, the reading half, not
        `assert_autonomy_unlocked`, the writing one: deciding a profile must
        not put an unlock-verdict entry in the enterprise ledger for a run
        that never approaches a merge. Asserted by RUNNING the resolver and
        looking for the row, because the import it does not make is exactly
        what a source grep cannot see through a delegation."""
        from aria_kernel.autonomy_unlock import resolve_scheduled_profile

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            resolve_scheduled_profile(base_dir=tools)
            self.assertFalse(
                (tools / "enterprise" / "autonomy-unlock-events.jsonl").exists(),
                "the profile gate spent a merge-authority verdict row",
            )

    def test_the_cycle_runs_the_gates_answer_not_a_hardcoded_profile(self) -> None:
        step = _cycle_run_step()
        self.assertIn('--profile "$ARIA_CYCLE_PROFILE"', step["run"])
        self.assertEqual(
            step["env"]["ARIA_CYCLE_PROFILE"],
            "${{ steps.%s.outputs.profile }}" % _GATE_STEP_ID,
        )

    def test_the_approval_ref_is_explicit_and_not_the_synthetic_default(self) -> None:
        """`cli.py` synthesises `cli-flag:<daemon>:<epoch>` when the flag is
        absent, and `set_profile` records whatever it is handed for EVERY
        transition. The executor lane then enforces the profile that ref
        persisted, so an auditor reconstructing the night's authority gets
        either a run they can open or an epoch they cannot."""
        step = _cycle_run_step()
        self.assertIn('--operator-approval-ref "$ARIA_PROFILE_APPROVAL_REF"', step["run"])
        ref = step["env"]["ARIA_PROFILE_APPROVAL_REF"]
        self.assertTrue(ref.strip(), "approval ref must not be empty")
        self.assertFalse(
            ref.strip().startswith("cli-flag:"),
            "an explicit ref that merely re-states the synthetic default is "
            "the default wearing a flag",
        )
        self.assertIn("github.run_id", ref, "the ref must name a run an auditor can open")

    def test_the_cycle_bounds_the_implementer_poll(self) -> None:
        """ORPHAN-HIGH-734 — strict made a 30-minute dead sleep REACHABLE on
        the nightly critical path.

        `implementer_poll_seconds` defaults to 1800 against a
        `--cycle-deadline-seconds 1800` night, and the executor lane that
        would answer the poll is serialized behind the SAME concurrency group
        as this job — so the answer cannot arrive in-run and every CONVERGED
        strict night would spend its whole budget reaching
        `IMPLEMENTATION_TIMEOUT`. The bound is not the fix (the poll is the
        wrong shape for a two-lane topology; ORPHAN-HIGH-734 owns that, owner
        + deadline recorded); it is what stops activation from costing a night
        before the successor lands. Pinned as a CEILING rather than a value,
        so tuning it down stays free and restoring the default fails here.
        """
        # REWRITTEN PIN (ORPHAN-HIGH-754). The successor this bound was
        # waiting for has landed: CL-1 removed the synchronous poll, the CLI
        # dropped `--implementer-poll-seconds` with it, and the sibling pin in
        # tests/invariants/v3_1/test_phase_v31_e_profile_preflight.py was
        # updated to assert the PARAMETER is gone. This one was not, and it
        # enforced the opposite — so the workflow kept passing a flag argparse
        # no longer accepts and every nightly cycle died at its first step
        # ("unrecognized arguments: --implementer-poll-seconds 120", run
        # 32324892989). A pin that outlives the thing it pinned does not go
        # quiet; it holds the broken state in place.
        run = _cycle_run_step()["run"]
        self.assertNotIn(
            "--implementer-poll-seconds", run,
            "the CLI no longer accepts this flag; passing it kills the cycle "
            "before any phase runs",
        )

    def test_this_lane_cannot_reach_the_autonomous_profile(self) -> None:
        """The merge-capable profile is unreachable from the producer lane
        BY CONSTRUCTION, not by review habit.

        Matched against the executable YAML (comments stripped) and against
        the gate script's own string literals, because `autonomous` appears
        legitimately in this file's prose and in `autonomous_host_lease` —
        the question is whether any PROFILE VALUE can be `autonomous`, not
        whether the word occurs.
        """
        body = executable_yaml(_WORKFLOW.read_text(encoding="utf-8"))
        for forbidden in ("--profile autonomous", "profile=autonomous", "profile: autonomous"):
            self.assertNotIn(forbidden, body, f"{_WORKFLOW.name}: {forbidden!r} present")
        literals = {
            node.value
            for node in ast.walk(ast.parse(_gate_script()))
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertNotIn(
            "autonomous", literals,
            "the gate must be structurally incapable of emitting the "
            "merge-capable profile",
        )


class TheDeclaredProfileIsTheProfileTheRunTook(unittest.TestCase):
    """ORPHAN-HIGH-728 — the preflight declaration, and the gate it owns.

    `verify_workflow_preflight` has exactly one profile-sensitive rule:
    `frozen` + declared write roots is refused. A lane whose declaration is a
    LITERAL can never reach that rule for a frozen kernel — the check was
    dead code here — and this change made it matter, because the resolver now
    deliberately PRESERVES a frozen hold instead of thawing it.
    """

    _PRE_RESTORE_STEP = "Persist enterprise workflow preflight"
    _RESOLVED_STEP = "Persist enterprise workflow preflight for the resolved profile"

    @staticmethod
    def _step_by_name(name: str) -> dict:
        for step in _cycle_steps():
            if step.get("name") == name:
                return step
        raise AssertionError(f"{_WORKFLOW.name}: no step named {name!r}")

    def test_the_pre_restore_declaration_names_the_lanes_structural_ceiling(self) -> None:
        """It runs before the store is bound, so it cannot know the night's
        profile; what it CAN say honestly is the most this lane could ever
        resolve. Read from the kernel, so a constant that moves moves the
        declaration with it."""
        run = self._step_by_name(self._PRE_RESTORE_STEP)["run"]
        self.assertIn(
            "from aria_kernel.runtime_profile import SCHEDULER_MAX_PROPOSABLE_PROFILE",
            run,
        )
        self.assertIn("profile=SCHEDULER_MAX_PROPOSABLE_PROFILE,", run)

    def test_the_second_declaration_carries_the_resolved_profile(self) -> None:
        step = self._step_by_name(self._RESOLVED_STEP)
        self.assertEqual(
            step["env"]["RESOLVED_PROFILE"],
            "${{ steps.%s.outputs.profile }}" % _GATE_STEP_ID,
        )
        self.assertIn('profile=os.environ["RESOLVED_PROFILE"]', step["run"])

    def test_a_frozen_kernel_refuses_this_lanes_mutating_workflow(self) -> None:
        """The rule the second declaration exists to reach, exercised with
        the same contract arguments the step passes."""
        from aria_kernel.preflight import verify_workflow_preflight

        allowed = [".aria-state-store"]
        verdicts = {
                profile: verify_workflow_preflight(
                    workflow_id="aria-auto-cycle",
                    job_id="cycle",
                    profile=profile,
                    # The real checkout: the contract verifier reads the
                    # workflow YAML relative to the workspace, so a scratch
                    # directory would fail every profile for the wrong reason.
                    workspace_root=_REPO_ROOT,
                    allowed_write_roots=allowed,
                    path_allowlist=allowed,
                    network_policy=["github_artifact", "github_git"],
                    network_enforcement_evidence="contract test",
                    token_provenance="github_actions_artifact_token",
                    require_github_app=False,
                    dlp_mode="fail_closed",
                    dlp_scan_clean=True,
                    audit_reason="contract test",
                )
                for profile in ("frozen", "observe", "standard", "strict")
        }
        # The DIFFERENTIAL, not the absolute verdict: this preflight also
        # asserts environment facts (a clean worktree, among others) that a
        # developer checkout legitimately fails, and they fail identically for
        # every profile. What must be true of the profile alone is that
        # exactly one of the four is refused, and refused by name.
        self.assertFalse(verdicts["frozen"].valid)
        self.assertIn(
            "frozen_profile_blocks_mutating_workflow", verdicts["frozen"].reasons,
        )
        self.assertIn("frozen_profile_write_block", verdicts["frozen"].failure_classes)
        for profile in ("observe", "standard", "strict"):
            with self.subTest(profile=profile):
                self.assertNotIn(
                    "frozen_profile_blocks_mutating_workflow",
                    verdicts[profile].reasons,
                )
                self.assertNotIn(
                    "frozen_profile_write_block", verdicts[profile].failure_classes,
                )


class TheGateDecidesWhatItClaimsToDecide(unittest.TestCase):
    """Runs the workflow's own script. A pin on a workflow that never runs
    the workflow is a pin on the author's intentions."""

    def _run_gate(self, tools_dir: Path) -> dict[str, str]:
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "gh-output"
            summary = Path(scratch) / "gh-summary"
            output.touch()
            summary.touch()
            env = dict(os.environ)
            env.update({
                "PYTHONPATH": str(_KERNEL_ROOT),
                "ARIA_TOOLS_DIR": str(tools_dir),
                "GITHUB_OUTPUT": str(output),
                "GITHUB_STEP_SUMMARY": str(summary),
            })
            proc = subprocess.run(
                [sys.executable, "-c", _gate_script()],
                capture_output=True, text=True, env=env, cwd=str(_REPO_ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            parsed = dict(
                line.split("=", 1)
                for line in output.read_text(encoding="utf-8").splitlines()
                if "=" in line
            )
            parsed["_stdout"] = proc.stdout
            parsed["_summary"] = summary.read_text(encoding="utf-8")
            return parsed

    @staticmethod
    def _seed_valid_ladder(tools: Path, tag: str) -> None:
        from aria_kernel.autonomy_unlock import (
            load_autonomy_unlock_policy,
            record_acceptance_event,
        )

        required = load_autonomy_unlock_policy()[
            "lane_requirements"]["L1"]["observe_successes"]
        for index in range(required):
            record_acceptance_event(
                event_type="observe_success",
                base_dir=tools,
                reason=f"{tag}-{index}",
            )

    def test_an_empty_ladder_refuses_strict_and_says_why(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_gate(Path(tmp) / "aria-tools")
        self.assertEqual(result["profile"], "standard")
        self.assertEqual(result["l1_valid"], "false")
        self.assertIn("::warning::l1_autonomy_unlock_invalid", result["_stdout"])
        self.assertIn("autonomy_unlock_threshold_missing", result["_stdout"])

    def test_a_satisfied_ladder_alone_does_not_grant_strict(self) -> None:
        """THE AUTHORITY BOUNDARY. A ladder full of acceptance evidence is
        the machine saying the repository has earned more; it is not an
        operator saying ARIA may have it. ADR-033 records strict as an
        operator decision and ADR-041 step 2 spends a week of nightly
        STANDARD-profile cycles reaching one — a lane that promoted itself
        on evidence would end that window with the very event the window
        exists to produce, and would be holding a gesture nobody made.

        A store no operator has touched has a `standard` ceiling, so this is
        also the DEFAULT: shipping this change flips nothing on its own.
        """
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            self._seed_valid_ladder(tools, "earned-not-granted")
            result = self._run_gate(tools)
        self.assertEqual(result["l1_valid"], "true", "the ladder IS satisfied")
        self.assertEqual(result["ceiling"], "standard")
        self.assertEqual(
            result["profile"], "standard",
            "a scheduled lane promoted itself past the operator ceiling",
        )
        self.assertIn("::warning::scheduler_ceiling_bound", result["_stdout"])

    def test_the_operator_ceiling_is_what_grants_strict(self) -> None:
        """The same ladder, one recorded operator gesture earlier, and the
        night runs the implementing pipeline. The grant travels through the
        EXISTING control plane — `set_profile`, one state file, one history
        ledger — so raising it is auditable the way every other profile
        transition already is."""
        from aria_kernel.runtime_profile import set_profile

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            self._seed_valid_ladder(tools, "granted")
            set_profile(
                "standard",
                operator_approval_ref="op:adr-041-step-3",
                base_dir=tools,
                scheduler_ceiling="strict",
            )
            result = self._run_gate(tools)
        self.assertEqual(result["ceiling"], "strict")
        self.assertEqual(result["profile"], "strict")
        self.assertEqual(result["l1_valid"], "true")
        self.assertNotIn("::warning::", result["_stdout"])

    def test_the_ceiling_grants_a_maximum_and_not_a_floor(self) -> None:
        """An operator who raised the ceiling still does not get strict out
        of a short ladder. The ceiling bounds the verdict; it never replaces
        it, so both gates must agree before the night can open a PR."""
        from aria_kernel.runtime_profile import set_profile

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            set_profile(
                "standard",
                operator_approval_ref="op:adr-041-step-3",
                base_dir=tools,
                scheduler_ceiling="strict",
            )
            result = self._run_gate(tools)
        self.assertEqual(result["ceiling"], "strict")
        self.assertEqual(result["l1_valid"], "false")
        self.assertEqual(result["profile"], "standard")
        self.assertIn("::warning::l1_autonomy_unlock_invalid", result["_stdout"])

    def test_a_machine_cannot_write_itself_a_ceiling(self) -> None:
        """The ceiling is only worth what the control plane refuses.

        `set_profile` rejects a non-operator setter that tries to raise the
        ceiling OR to persist a profile past it — so `autonomy run --profile
        strict`, the command the workflow itself runs, cannot mint the
        authority it is asking for. Without this the ceiling would be a
        convention the scheduler chooses to honour.
        """
        from aria_kernel.runtime_profile import (
            get_scheduler_profile_ceiling,
            set_profile,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            set_profile(
                "standard", operator_approval_ref="op:init", base_dir=tools,
            )
            with self.assertRaises(GovernanceError) as raised_profile:
                set_profile(
                    "strict",
                    operator_approval_ref="aria-auto-cycle:run=1",
                    base_dir=tools,
                    set_by="autonomy-cli",
                )
            self.assertIn(
                "profile_exceeds_scheduler_ceiling", str(raised_profile.exception),
            )
            with self.assertRaises(GovernanceError) as raised_ceiling:
                set_profile(
                    "standard",
                    operator_approval_ref="aria-auto-cycle:run=1",
                    base_dir=tools,
                    set_by="autonomy-cli",
                    scheduler_ceiling="strict",
                )
            self.assertIn(
                "scheduler_ceiling_raise_requires_operator",
                str(raised_ceiling.exception),
            )
            self.assertEqual(get_scheduler_profile_ceiling(base_dir=tools), "standard")

    def test_an_operator_grant_survives_the_lanes_own_transition(self) -> None:
        """The nightly lane records its own run through `set_profile`. A
        ceiling that reset to the default on each transition would be a
        grant an operator had to re-assert every night — so the machine's
        ordinary bookkeeping carries it forward untouched."""
        from aria_kernel.runtime_profile import (
            get_scheduler_profile_ceiling,
            set_profile,
        )

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            set_profile(
                "standard",
                operator_approval_ref="op:grant",
                base_dir=tools,
                scheduler_ceiling="strict",
            )
            set_profile(
                "strict",
                operator_approval_ref="aria-auto-cycle:run=7",
                base_dir=tools,
                set_by="autonomy-cli",
            )
            self.assertEqual(get_scheduler_profile_ceiling(base_dir=tools), "strict")

    def test_a_corrupt_ladder_demotes_and_does_not_kill_the_night(self) -> None:
        """The step header promises an invalid ladder demotes rather than
        failing the job; a `LedgerIntegrityError` under `set -euo pipefail`
        would have made that promise false in the one case it was written
        for. Losing the night's discovery to protect an authority the
        demotion already withholds is the wrong trade twice over."""
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            self._seed_valid_ladder(tools, "corrupt")
            ledger = tools / "enterprise" / "acceptance-events.jsonl"
            ledger.write_text(
                ledger.read_text(encoding="utf-8") + "{ not json at all\n",
                encoding="utf-8",
            )
            result = self._run_gate(tools)
        self.assertEqual(result["profile"], "standard")
        self.assertIn("l1_ladder_unreadable", result["_summary"])
        self.assertIn("::warning::", result["_stdout"])

    def test_a_ledger_derived_reason_cannot_forge_a_workflow_command(self) -> None:
        """The unreadable-ladder reason carries a message built from the
        ledger's own bytes and ends up in a `::warning::` annotation. A raw
        newline there would close the command and let whatever follows be
        read as another one — so the reason is escaped where it is BUILT,
        not wherever it happens to be printed."""
        from aria_kernel.autonomy_unlock import (
            record_acceptance_event,
            resolve_scheduled_profile,
        )

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            record_acceptance_event(
                event_type="observe_success", base_dir=tools, reason="seed",
            )
            ledger = tools / "enterprise" / "acceptance-events.jsonl"
            ledger.write_text(
                ledger.read_text(encoding="utf-8")
                + '{"unterminated\n::error::forged\n',
                encoding="utf-8",
            )
            decision = resolve_scheduled_profile(base_dir=tools)
        self.assertEqual(decision.profile, "standard")
        for reason in decision.reasons:
            with self.subTest(reason=reason[:40]):
                self.assertNotIn("\n", reason)
                self.assertNotIn("\r", reason)

    def test_a_frozen_kernel_is_not_thawed_by_the_scheduler(self) -> None:
        """The gate RAISES authority and never lowers an operator's hold.

        Pre-existing hole this closes: the lane passed `--profile standard`
        unconditionally and `cli.py` calls `set_profile` on any difference
        from the persisted value, so an operator who froze ARIA during an
        incident had that freeze silently lifted by the next scheduled night.
        A ladder that can raise to strict would have widened it.
        """
        from aria_kernel.autonomy_unlock import (
            load_autonomy_unlock_policy,
            record_acceptance_event,
        )
        from aria_kernel.runtime_profile import set_profile

        for held in ("frozen", "observe"):
            with self.subTest(persisted=held), tempfile.TemporaryDirectory() as tmp:
                tools = Path(tmp) / "aria-tools"
                # A ladder that WOULD be satisfied, so the hold is the only
                # thing standing between the operator and an override.
                self._seed_valid_ladder(tools, "hold-seed")
                set_profile(
                    held,
                    operator_approval_ref="op:incident",
                    base_dir=tools,
                    scheduler_ceiling="strict",
                )
                before = _tree_fingerprint(tools)
                result = self._run_gate(tools)
                self.assertEqual(result["profile"], held)
                # Three-valued on purpose: the ladder was never ASKED, and
                # "false" would misreport a hold as evidence found wanting.
                self.assertEqual(result["l1_valid"], "not-consulted")
                self.assertIn("operator_held_profile_preserved", result["_stdout"])
                # ...and the hold is honoured BEFORE the store is touched.
                # `evaluate_autonomy_unlock` reaches `ensure_tools_dir`,
                # which mkdirs, rewrites the tools index and can bootstrap
                # identity files: a gate that writes to a stopped kernel on
                # its way to asking whether the stop counts has already
                # broken the no-write invariant it is about to honour.
                self.assertEqual(
                    _tree_fingerprint(tools), before,
                    "the profile gate wrote into a frozen/observe kernel",
                )

    def test_the_merge_capable_profile_is_unreachable_at_any_ceiling(self) -> None:
        """The hold is one-directional on purpose: it preserves an operator's
        LOWER authority and never inherits a higher one.

        Worst case constructed deliberately — `autonomous` PERSISTED, an
        `autonomous` CEILING recorded by an operator, and a satisfied ladder.
        The resolver still comes out `strict`, because the ladder proposes at
        most `SCHEDULER_MAX_PROPOSABLE_PROFILE` and the ceiling can only
        narrow a proposal, never widen one. An unattended lane cannot run a
        merge-capable profile even when every input says yes, and the
        executor lane, which enforces whatever this run persists, inherits
        that bound too. The only reading compatible with charter M-6.1.
        """
        from aria_kernel.runtime_profile import (
            SCHEDULER_MAX_PROPOSABLE_PROFILE,
            set_profile,
        )

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            self._seed_valid_ladder(tools, "demote-seed")
            set_profile(
                "autonomous",
                operator_approval_ref="op:auto",
                base_dir=tools,
                scheduler_ceiling="autonomous",
            )
            result = self._run_gate(tools)
        self.assertEqual(result["profile"], SCHEDULER_MAX_PROPOSABLE_PROFILE)
        self.assertEqual(result["profile"], "strict")

    def test_the_reasons_never_become_a_step_output(self) -> None:
        """A reason code carrying a newline would close the `KEY=VALUE`
        record and let the remainder be read as further outputs. The
        reasons reach a human as text (summary + annotation) instead."""
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_gate(Path(tmp) / "aria-tools")
        self.assertEqual(
            {key for key in result if not key.startswith("_")},
            {"profile", "l1_valid", "ceiling"},
        )
        self.assertIn("autonomy_unlock_threshold_missing", result["_summary"])


class MergeStaysImpossibleWhenTheNightRunsStrict(unittest.TestCase):
    """Raising the proposal ceiling must not move the landing floor."""

    def test_pr_merge_is_autonomous_only(self) -> None:
        from aria_kernel.runtime_profile import ACTION_PERMISSIONS
        self.assertEqual(ACTION_PERMISSIONS["pr_merge"], frozenset({"autonomous"}))

    def test_merge_authority_refuses_under_strict_before_touching_github(self) -> None:
        from aria_kernel.merge_authority import merge_pr_if_ready
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import GovernanceError

        class _AdapterThatMustNotBeAsked:
            def get_pr(self, pr_number: int):  # pragma: no cover - must not run
                raise AssertionError(
                    "merge authority reached GitHub under a profile without "
                    "pr_merge; the gate is downstream of the network call"
                )

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            set_profile("strict", operator_approval_ref="op:728", base_dir=tools)
            with self.assertRaises(GovernanceError) as caught:
                merge_pr_if_ready(
                    adapter=_AdapterThatMustNotBeAsked(),
                    pr_number=1,
                    base_dir=tools,
                    readiness_claim_id="claim-1",
                )
        self.assertIn("profile_violation", str(caught.exception))
        self.assertIn("pr_merge", str(caught.exception))

    def test_the_unlock_ladder_refuses_a_ledger_that_has_not_earned_it(self) -> None:
        """The gate the merge path spends, exercised rather than grepped.

        `assert_autonomy_unlocked` is the WRITING half — it records a verdict
        row and raises — which is why the profile gate above uses the reading
        half instead.
        """
        from aria_kernel.autonomy_unlock import assert_autonomy_unlocked
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            with self.assertRaises(GovernanceError) as caught:
                assert_autonomy_unlocked(lane="L1", base_dir=tools)
            self.assertIn("autonomy_unlock_required_for_merge", str(caught.exception))
            self.assertTrue(
                (tools / "enterprise" / "autonomy-unlock-events.jsonl").exists(),
                "the merge-side ladder must leave its verdict on the record",
            )

    def test_the_merge_path_is_wired_to_that_gate(self) -> None:
        """AST, not substring: the call must EXIST inside `merge_pr_if_ready`.

        A source grep for a formatted argument list is red on a rename that
        changes nothing and green on a call that has been moved out of the
        function it is supposed to guard. Matching the callee name inside the
        function's own tree answers the question actually being asked.
        """
        tree = ast.parse(
            (_KERNEL_ROOT / "aria_kernel" / "merge_authority.py").read_text(
                encoding="utf-8",
            )
        )
        function = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "merge_pr_if_ready"
        )
        called = {
            node.func.id
            for node in ast.walk(function)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertIn("assert_autonomy_unlocked", called)
        self.assertIn("enforce_profile_for_action", called)

    def test_the_auto_merge_runner_forces_dry_run_for_strict(self) -> None:
        from unittest.mock import patch

        from aria_kernel.auto_merge_runners import (
            RealAutoMergeRunner,
            select_auto_merge_runner,
        )

        runner = select_auto_merge_runner(
            profile="strict",
            adapter_factory=lambda: object(),
            pr_enumerator=lambda adapter: [4242],
            readiness_claim_resolver=lambda adapter, pr, base: "claim-1",
        )
        self.assertIsInstance(runner, RealAutoMergeRunner)
        observed: list[bool] = []

        def _fake_merge_if_green(*, adapter, pr_number, base_dir, dry_run):
            observed.append(dry_run)
            return {"decision": "blocked", "eligible": False, "pr_number": pr_number, "reasons": []}

        def _must_not_merge(**kwargs):  # pragma: no cover - must not run
            raise AssertionError("strict reached the real merge authority")

        with tempfile.TemporaryDirectory() as tmp, \
                patch("aria_kernel.auto_merge.merge_if_green", _fake_merge_if_green), \
                patch("aria_kernel.merge_authority.merge_pr_if_ready", _must_not_merge):
            result = runner(base_dir=Path(tmp) / "aria-tools", workspace_root=tmp)
        self.assertEqual(observed, [True])
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["merges_completed"], 0)

    def test_only_autonomous_clears_dry_run(self) -> None:
        """The strict sibling above shows `dry_run=True`; this shows that the
        flag is not simply always True. Run rather than grepped: the source
        pin it replaces was red on a harmless rename and blind to a policy
        moved elsewhere, and neither failure mode is about the behaviour that
        decides whether a run evaluates or lands."""
        from unittest.mock import patch

        from aria_kernel.auto_merge_runners import select_auto_merge_runner

        runner = select_auto_merge_runner(
            profile="autonomous",
            adapter_factory=lambda: object(),
            pr_enumerator=lambda adapter: [4242],
            readiness_claim_resolver=lambda adapter, pr, base: "claim-1",
        )
        reached_merge_authority: list[int] = []

        def _record_merge_authority(*, adapter, pr_number, base_dir, readiness_claim_id):
            reached_merge_authority.append(pr_number)
            # `blocked` and not a merge: the gates BELOW this point (profile,
            # risk, unlock ladder, readiness) have their own tests, and this
            # one is about which door the profile opens.
            return {"decision": "blocked", "eligible": False, "pr_number": pr_number, "reasons": []}

        def _must_not_evaluate(**kwargs):  # pragma: no cover - must not run
            raise AssertionError("autonomous took the dry-run evaluation path")

        with tempfile.TemporaryDirectory() as tmp, \
                patch(
                    "aria_kernel.watchdog_freeze.open_watchdog_incidents",
                    return_value={"readable": True, "incidents": [], "reason": "clear"},
                ), \
                patch("aria_kernel.auto_merge.merge_if_green", _must_not_evaluate), \
                patch("aria_kernel.merge_authority.merge_pr_if_ready", _record_merge_authority):
            result = runner(base_dir=Path(tmp) / "aria-tools", workspace_root=tmp)
        self.assertEqual(reached_merge_authority, [4242])
        self.assertFalse(result["dry_run"])
        self.assertEqual(result["merges_completed"], 0)

    def test_charter_m_6_1_is_intact(self) -> None:
        charter = _MISSION_SPEC.read_text(encoding="utf-8")
        self.assertIn(
            "**M-6.1** No self-merge, ever; human approval is not removable.",
            charter,
        )


if __name__ == "__main__":
    unittest.main()
