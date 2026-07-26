"""Plan ARIA-V9.0-D — implementation_safety invariants.

Closes:
  * ai CRIT-001/002/004 + HIGH-006
  * sec CRIT-001 + HIGH-003/004/005 + MED-018
  * perf HIGH-009
  * arb HIGH-004 (forbidden_scope normalized)
"""
from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import implementation_safety as _is


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
        }
        self.assertEqual(
            set(_is.__all__), canonical,
            f"__all__ drifted; missing={canonical - set(_is.__all__)} extra={set(_is.__all__) - canonical}",
        )


if __name__ == "__main__":
    unittest.main()
