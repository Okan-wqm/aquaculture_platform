"""Plan ARIA-V3 Phase A2 — required ``github_adapter`` injection.

Closes GAP-3 architecturally. Pre-V3 ``dispatch_one_pending_worker_assignment``
accepted ``github_adapter: Any | None = None`` so every verified
assignment that should have auto-merged terminated at
``verified_pending_merge`` because no adapter was plumbed through
from the scheduler. V3 makes the adapter REQUIRED on both surfaces
(scheduler + hook) and supplies a profile-derived factory.

Invariants locked:

  * I-V3-04 — ``dispatch_one_pending_worker_assignment`` AND
    ``run_worker_scheduler_daemon`` parameter ``github_adapter`` has
    NO default value AND its annotation contains neither ``Optional``
    nor ``| None``. Tier-1: future refactor that re-adds the
    default fails this test.
  * I-V3-05 — ``RecordingGitHubAdapter`` writes every method
    invocation to ``<base_dir>/audit/intended-gh-calls.jsonl``
    (audit-only sink); never calls real ``gh`` CLI.
  * I-V3-06 — verified assignment with PR-bridge + real adapter
    reaches ``merge_if_green`` (no silent ``verified_pending_merge``
    fall-through).
  * I-V3-06a — V2 I-23 tracked-allowlist set-equality holds; the
    new ``aria-tools/audit/`` dir is gitignored (never tracked).
"""

from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the live checkout
# outside the kernel surface, so it runs in aria-kernel.yml's always-run
# `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = 'the live .gitignore ignores aria-tools/audit/ (I-23)'

import inspect
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseA2RequiredGithubAdapter(unittest.TestCase):
    def test_i_v3_04_dispatch_hook_github_adapter_required(self) -> None:
        from aria_kernel.worker_dispatch_hook import (
            dispatch_one_pending_worker_assignment,
        )

        sig = inspect.signature(dispatch_one_pending_worker_assignment)
        self.assertIn("github_adapter", sig.parameters)
        param = sig.parameters["github_adapter"]
        self.assertIs(
            param.default,
            inspect.Parameter.empty,
            msg=(
                "github_adapter must have NO default (Plan ARIA-V3 §A2 "
                f"GAP-3 closure). Found default={param.default!r}"
            ),
        )
        self.assertEqual(param.kind, inspect.Parameter.KEYWORD_ONLY)
        annotation_str = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |", "NoneType"):
            self.assertNotIn(forbidden, annotation_str)

    def test_i_v3_04_scheduler_daemon_github_adapter_required(self) -> None:
        from aria_kernel.autonomous_worker_scheduler import (
            run_worker_scheduler_daemon,
        )

        sig = inspect.signature(run_worker_scheduler_daemon)
        self.assertIn("github_adapter", sig.parameters)
        param = sig.parameters["github_adapter"]
        self.assertIs(
            param.default,
            inspect.Parameter.empty,
            msg=(
                "scheduler github_adapter must have NO default (Plan ARIA-V3 "
                f"§A2). Found default={param.default!r}"
            ),
        )
        annotation_str = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |", "NoneType"):
            self.assertNotIn(forbidden, annotation_str)

    def test_i_v3_04_orchestrator_github_adapter_required(self) -> None:
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator

        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn("github_adapter", sig.parameters)
        param = sig.parameters["github_adapter"]
        self.assertIs(param.default, inspect.Parameter.empty)

    def test_i_v3_05_recording_adapter_writes_audit_log(self) -> None:
        from aria_kernel.github_adapters import RecordingGitHubAdapter

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-05-") as tmp:
            base_dir = Path(tmp)
            adapter = RecordingGitHubAdapter(base_dir=base_dir, profile="observe")
            # Every Protocol method records.
            adapter.get_pr(101)
            adapter.get_latest_head_sha(101)
            adapter.get_required_checks("main")
            adapter.get_checks("abc123")
            adapter.get_reviews(101)
            adapter.get_unresolved_conversation_count(101)
            adapter.get_pr_diff(101)
            adapter.merge_pr(101, method="squash", expected_head_sha="abc123")

            audit_path = base_dir / "audit" / "intended-gh-calls.jsonl"
            self.assertTrue(audit_path.exists())
            rows = [
                json.loads(line)
                for line in audit_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(rows), 8)
            methods_recorded = {row["method"] for row in rows}
            self.assertEqual(
                methods_recorded,
                {
                    "get_pr",
                    "get_latest_head_sha",
                    "get_required_checks",
                    "get_checks",
                    "get_reviews",
                    "get_unresolved_conversation_count",
                    "get_pr_diff",
                    "merge_pr",
                },
            )
            for row in rows:
                self.assertEqual(row["adapter"], "RecordingGitHubAdapter")
                self.assertEqual(row["profile"], "observe")
                self.assertIn("recorded_at", row)
                self.assertIn("args", row)

    def test_i_v3_05_recording_adapter_read_stubs_fail_closed(self) -> None:
        """ARIA-MEDIUM-467 — a recording profile fetched nothing, so every read stub
        says so (``readable: False``) and the merge gate blocks on it.

        The stubs used to return empty lists without the flag, which the
        gate's readers default to readable: "no required checks, no
        reviews, zero unresolved conversations" — every read sub-gate passed.
        """
        from aria_kernel.auto_merge import (
            _conversation_result,
            _required_checks,
            _required_checks_result,
            _review_result,
            collect_github_snapshot,
            evaluate_auto_merge,
        )
        from aria_kernel.github_adapters import RecordingGitHubAdapter
        from aria_kernel.tool_registry import ensure_tools_dir

        with tempfile.TemporaryDirectory(prefix="aria-a8-1-") as tmp:
            tools = ensure_tools_dir(Path(tmp) / "aria-tools")
            adapter = RecordingGitHubAdapter(base_dir=tools, profile="observe")
            for result in (
                adapter.get_required_checks("main"),
                adapter.get_checks("a" * 40),
                adapter.get_reviews(7),
                adapter.get_unresolved_conversation_count(7),
                adapter.get_open_issues(labels=[]),
            ):
                self.assertIs(result.get("readable"), False, result)

            sha = "a" * 40
            pr = {"number": 7, "base_branch": "main", "head_sha": sha}
            snap = collect_github_snapshot(adapter, pr)
            self.assertIs(_required_checks(snap)["readable"], False)
            self.assertIs(_required_checks_result(snap, [], sha)["readable"], False)
            self.assertIs(_review_result({}, snap)["readable"], False)
            self.assertIs(_conversation_result(snap)["readable"], False)

            decision = evaluate_auto_merge(
                pr=pr, github=snap, base_dir=tools, workspace_root=Path(tmp),
                diff_text="+++ b/docs/x.md\n+text\n",
            )
        self.assertFalse(decision["eligible"])
        for reason in (
            "branch protection required checks unreadable",
            "review state unreadable",
            "unresolved conversation state unreadable",
        ):
            self.assertIn(reason, decision["reasons"])

    def test_i_v3_05_recording_adapter_never_calls_gh_cli(self) -> None:
        """The recording adapter must NOT shell out to gh. Source
        inspection: no ``subprocess.run`` reference inside the class.
        """
        from aria_kernel import github_adapters

        source = inspect.getsource(github_adapters.RecordingGitHubAdapter)
        self.assertNotIn("subprocess.run", source)
        self.assertNotIn('["gh"', source)
        self.assertNotIn("'gh',", source)

    def test_i_v3_05_merge_pr_returns_skipped_under_recording(self) -> None:
        from aria_kernel.github_adapters import RecordingGitHubAdapter

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-05b-") as tmp:
            adapter = RecordingGitHubAdapter(
                base_dir=Path(tmp), profile="observe",
            )
            result = adapter.merge_pr(
                42, method="squash", expected_head_sha="abc",
            )
        self.assertFalse(result["merged"])
        self.assertEqual(result["decision"], "skipped_recording_adapter")
        self.assertIn("observe", result["reason"])

    def test_i_v3_06_select_returns_real_for_strict(self) -> None:
        """Strict + autonomous select GhCliGitHubAdapter. The class
        constructor requires a real git repo (it shells `gh repo
        view`), so we exercise the factory's BRANCH (selection) via
        type-table inspection rather than instantiation. The
        instantiation-side path is covered end-to-end by Phase A1's
        ``test_strict_profile_uses_real_runner`` (which monkeypatches
        ``merge_if_green``) and by Phase B1's live-claude shake-out.
        """
        from aria_kernel import github_adapters, runtime_profile
        from aria_kernel.github_adapters import GhCliGitHubAdapter

        # Branch invariant: the factory must dispatch ``strict`` to
        # the GhCliGitHubAdapter class. We inspect the classification
        # directly so the test does not depend on the live `gh` CLI.
        self.assertIn("strict", runtime_profile.GITHUB_LIVE_PROFILES)
        self.assertIn("autonomous", runtime_profile.GITHUB_LIVE_PROFILES)
        # Source-inspection: select_github_adapter returns
        # GhCliGitHubAdapter for the real-profile branch.
        source = inspect.getsource(github_adapters.select_github_adapter)
        self.assertIn("GhCliGitHubAdapter", source)

    def test_i_v3_06_select_returns_recording_for_observe_standard_frozen(self) -> None:
        from aria_kernel.github_adapters import (
            RecordingGitHubAdapter,
            select_github_adapter,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-06b-") as tmp:
            for profile in ("observe", "standard", "frozen"):
                adapter = select_github_adapter(
                    profile=profile, base_dir=tmp, cwd=tmp,
                )
                self.assertIs(type(adapter), RecordingGitHubAdapter)
                self.assertEqual(adapter.profile, profile)

    def test_i_v3_06_select_rejects_unknown_profile(self) -> None:
        from aria_kernel.github_adapters import select_github_adapter

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-06c-") as tmp:
            with self.assertRaises(ValueError):
                select_github_adapter(
                    profile="permissive", base_dir=tmp, cwd=tmp,
                )

    def test_i_v3_06_every_profile_is_classified(self) -> None:
        """ARIA-MEDIUM-467 — the GitHub classification is derived in runtime_profile.

        github_adapters and auto_merge_runners each carried literal profile
        sets; now both read one partition of ``PROFILES`` derived from
        ``ACTION_PERMISSIONS``. The pinned values are today's behaviour.
        """
        import os as _os
        from unittest import mock

        from aria_kernel.auto_merge_runners import select_auto_merge_runner
        from aria_kernel.github_adapters import select_github_adapter
        from aria_kernel.runtime_profile import (
            GITHUB_CHECKS_READ_PROFILES,
            GITHUB_LIVE_PROFILES,
            GITHUB_RECORDING_PROFILES,
            PROFILES,
        )

        self.assertEqual(GITHUB_LIVE_PROFILES & GITHUB_RECORDING_PROFILES, frozenset())
        self.assertEqual(GITHUB_LIVE_PROFILES | GITHUB_RECORDING_PROFILES, frozenset(PROFILES))
        self.assertEqual(GITHUB_LIVE_PROFILES, frozenset({"strict", "autonomous"}))
        self.assertEqual(GITHUB_CHECKS_READ_PROFILES, frozenset({"standard", "strict", "autonomous"}))
        with tempfile.TemporaryDirectory(prefix="aria-a8-6-") as tmp:
            with mock.patch.dict(_os.environ, {"ARIA_DRY_RUN": "true"}):
                for profile in PROFILES:
                    with self.subTest(profile=profile):
                        select_github_adapter(profile=profile, base_dir=tmp, cwd=tmp)
                        select_auto_merge_runner(profile=profile, executes_merges=False, base_dir=tmp)

    def test_i_v3_06a_audit_dir_gitignored(self) -> None:
        """V2 I-23 + V3 §A2 — aria-tools/audit/ MUST be gitignored.
        Without this, the RecordingGitHubAdapter's writes would
        appear as untracked files breaking the I-23 set-equality.
        """
        gitignore_path = _REPO_ROOT / ".gitignore"
        text = gitignore_path.read_text(encoding="utf-8")
        self.assertIn("aria-tools/audit/", text)
        self.assertIn("aria-tools/acks/", text)
        self.assertIn("aria-tools/secrets/", text)
        self.assertIn("aria-tools/breakers/", text)
        self.assertIn("aria-tools/budget/", text)
        self.assertIn("aria-tools/locks/", text)

    # ----------------------------------------------------------------
    # Plan ARIA-V3.1-F2 — ARIA_DRY_RUN structural gate
    # ----------------------------------------------------------------

    def test_i_v3_f2_dry_run_overrides_strict_to_recording(self) -> None:
        """Plan ARIA-V3.1-F2 fix — ARIA_DRY_RUN=true forces
        RecordingGitHubAdapter even for the ``strict`` profile.

        Without this gate the smoke runbook's ``unshare --net``
        isolation collides with ``GhCliGitHubAdapter.__init__``'s
        eager ``gh repo view`` call. Tier-1: code structurally
        prevents network access under dry-run, not operator
        hygiene.
        """
        import os as _os
        from unittest import mock
        from aria_kernel.github_adapters import (
            RecordingGitHubAdapter,
            select_github_adapter,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-f2-strict-") as tmp:
            with mock.patch.dict(_os.environ, {"ARIA_DRY_RUN": "true"}):
                adapter = select_github_adapter(
                    profile="strict", base_dir=tmp, cwd=tmp,
                )
                self.assertIsInstance(
                    adapter, RecordingGitHubAdapter,
                    "ARIA_DRY_RUN=true MUST force RecordingGitHubAdapter "
                    "for strict profile (closes V3.1-F2 smoke-runbook regression)",
                )

    def test_i_v3_f2_dry_run_overrides_autonomous_to_recording(self) -> None:
        """ARIA_DRY_RUN=true MUST also override the autonomous profile.

        Endurance smoke variants may exercise autonomous-profile
        dry-runs; the gate must hold there too.
        """
        import os as _os
        from unittest import mock
        from aria_kernel.github_adapters import (
            RecordingGitHubAdapter,
            select_github_adapter,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-f2-auto-") as tmp:
            with mock.patch.dict(_os.environ, {"ARIA_DRY_RUN": "1"}):
                adapter = select_github_adapter(
                    profile="autonomous", base_dir=tmp, cwd=tmp,
                )
                self.assertIsInstance(adapter, RecordingGitHubAdapter)

    def test_i_v3_f2_dry_run_unset_keeps_real_adapter(self) -> None:
        """Negative coverage — without ARIA_DRY_RUN, the existing
        profile → adapter mapping holds. Prevents the gate from
        regressing into a permanent override.
        """
        import os as _os
        from unittest import mock
        from aria_kernel.github_adapters import (
            GhCliGitHubAdapter,
            select_github_adapter,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-f2-prod-") as tmp:
            with mock.patch.dict(_os.environ, {}, clear=False):
                _os.environ.pop("ARIA_DRY_RUN", None)
                # Skip if gh CLI cannot reach the network here; the
                # contract under test is the BRANCH choice (real vs
                # recording), not the gh subprocess result. Patch the
                # GhCliGitHubAdapter.__init__ to no-op so we can assert
                # the routing.
                with mock.patch.object(
                    GhCliGitHubAdapter, "__init__",
                    lambda self, cwd=".": None,
                ):
                    adapter = select_github_adapter(
                        profile="strict", base_dir=tmp, cwd=tmp,
                    )
                    self.assertIsInstance(
                        adapter, GhCliGitHubAdapter,
                        "Without ARIA_DRY_RUN, strict MUST still route to real adapter",
                    )

    def test_i_v3_f2_dry_run_truthy_values(self) -> None:
        """ARIA_DRY_RUN parses ``true`` / ``1`` / ``yes`` (case- and
        whitespace-tolerant). Falsy variants do NOT trip the gate.
        """
        import os as _os
        from unittest import mock
        from aria_kernel.github_adapters import (
            GhCliGitHubAdapter,
            RecordingGitHubAdapter,
            select_github_adapter,
            _aria_dry_run_active,
        )

        for val in ("true", "TRUE", "True", "1", "yes", "  true  "):
            with mock.patch.dict(_os.environ, {"ARIA_DRY_RUN": val}):
                self.assertTrue(
                    _aria_dry_run_active(),
                    f"truthy value {val!r} MUST trip the gate",
                )

        for val in ("false", "0", "no", "", "  "):
            with mock.patch.dict(_os.environ, {"ARIA_DRY_RUN": val}):
                self.assertFalse(
                    _aria_dry_run_active(),
                    f"falsy value {val!r} MUST NOT trip the gate",
                )


if __name__ == "__main__":
    unittest.main()
