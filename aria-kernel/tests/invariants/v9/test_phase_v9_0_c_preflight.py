"""Plan ARIA-V9.0-C — preflight contract invariants.

Closes security-reviewer CRIT-002 (branch-bypass via gh api), CRIT-004
(commit signature kernel verification), HIGH-002 (CI race + branch
up-to-date), MED-016 (autonomous-profile precondition gate).

Tier-1 (make impossible) — autonomous profile rejects when
preconditions not met; verify_preflight is the single checkpoint.
"""
from __future__ import annotations

import inspect
import os
import unittest
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import preflight


class TestV9PreflightContract(unittest.TestCase):

    def test_i_v9_preflight_required_fields_triad(self):
        """Plan ARIA-V9.0-C + V10.3-B prereq — the 3 required
        branch-protection fields MUST be the canonical set.

        V10.3-B prereq amendment (operator-acknowledged via
        aria-tools/preflight/main-branch-protection-v4.json,
        2026-05-19): the original V9.0-C 4-field tuple included
        `restrictions.users` non-empty. GitHub's classic Branch
        Protection UI does not consistently surface the
        "Restrict who can push" checkbox (Free-plan public repo
        feature flag), and main is the ARIA experimental
        branch (not production). The remaining 3 fields
        (signatures + strict + enforce_admins) PLUS the
        required_pull_request_reviews check via verify_preflight
        deliver the equivalent Tier-1 trust floor.

        Adding a 4th = ADR + arbiter approval + invariant update.
        """
        self.assertEqual(
            len(preflight.REQUIRED_BRANCH_PROTECTION_FIELDS), 3,
            "REQUIRED_BRANCH_PROTECTION_FIELDS MUST have exactly 3 entries "
            "(V10.3-B prereq amendment)",
        )
        keys = {dotted for dotted, _ in preflight.REQUIRED_BRANCH_PROTECTION_FIELDS}
        self.assertEqual(
            keys,
            {
                "required_signatures.enabled",
                "required_status_checks.strict",
                "enforce_admins.enabled",
            },
            "REQUIRED_BRANCH_PROTECTION_FIELDS canonical-keys drifted",
        )

    def test_i_v9_preflight_verdict_dataclass_frozen(self):
        """PreflightVerdict MUST be frozen (immutable audit-trail
        guarantee)."""
        verdict = preflight.PreflightVerdict(
            valid=True, profile="strict", reasons=(), branch="main",
            repo=None, gh_token_present=True, gh_app_installation=False,
            signing_key_present=True, immutable_paths_count=9,
            bash_allowlist_count=15,
        )
        with self.assertRaises((AttributeError, Exception)):
            verdict.valid = False  # type: ignore[misc]

    def test_i_v9_preflight_strict_profile_lenient(self):
        """Profile=strict permits valid=False (operator-driven
        dry-run mode). The orchestrator only hard-fails autonomous
        profile when preconditions miss."""
        with mock.patch.dict(os.environ, {"GH_TOKEN": ""}, clear=False):
            os.environ.pop("GH_TOKEN", None)
            os.environ.pop("GITHUB_TOKEN", None)
            v = preflight.verify_preflight(
                profile="strict",
                workspace_root="/tmp",
                skip_remote=True,
            )
            self.assertTrue(
                v.valid,
                f"strict profile MUST be lenient on preconditions; reasons={v.reasons}",
            )

    def test_i_v9_preflight_autonomous_requires_gh_token(self):
        """Autonomous profile MUST fail when GH_TOKEN absent."""
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GH_TOKEN", None)
            os.environ.pop("GITHUB_TOKEN", None)
            v = preflight.verify_preflight(
                profile="autonomous",
                workspace_root="/tmp",
                skip_remote=True,
            )
            self.assertFalse(
                v.valid,
                "autonomous profile MUST fail without GH_TOKEN",
            )
            self.assertIn(
                "autonomous_profile_preconditions_not_met",
                v.failure_classes,
                f"failure_classes missing canonical class; got {v.failure_classes}",
            )

    def test_i_v9_preflight_autonomous_warns_on_app_missing(self):
        """ARIA_GH_APP_INSTALLATION_ID absent → reason logged but NOT
        a hard-fail under V9.0-C code-only scope (operator runbook
        upgrades to hard-fail post-setup)."""
        with mock.patch.dict(os.environ, {"GH_TOKEN": "ghp_test"}, clear=False):
            os.environ.pop("ARIA_GH_APP_INSTALLATION_ID", None)
            v = preflight.verify_preflight(
                profile="autonomous",
                workspace_root="/tmp",
                skip_remote=True,
            )
            self.assertIn(
                "gh_app_installation_missing_fallback_active",
                v.reasons,
                "preflight MUST flag GH App fallback even when permitting it",
            )
            self.assertFalse(
                v.gh_app_installation,
                "gh_app_installation field MUST be False without env var",
            )

    def test_i_v9_preflight_check_protection_field_true(self):
        """_check_protection_field returns (True, ok_reason) when
        the dotted path resolves to True for a boolean field."""
        payload = {"required_signatures": {"enabled": True}}
        ok, reason = preflight._check_protection_field(
            payload, "required_signatures.enabled", "true",
        )
        self.assertTrue(ok, f"field check failed: {reason}")

    def test_i_v9_preflight_check_protection_field_false(self):
        """_check_protection_field returns (False, ...) when the
        dotted path resolves to False."""
        payload = {"required_signatures": {"enabled": False}}
        ok, reason = preflight._check_protection_field(
            payload, "required_signatures.enabled", "true",
        )
        self.assertFalse(ok)
        self.assertIn("expected=true", reason)

    def test_i_v9_preflight_check_protection_field_non_empty_list(self):
        """restrictions.users sentinel — accepts list-of-users OR
        dict-with-users-list (GitHub returns both shapes depending on
        endpoint variant)."""
        # List shape
        payload_a = {"restrictions": {"users": [{"login": "aria-bot"}]}}
        ok_a, _ = preflight._check_protection_field(
            payload_a, "restrictions.users", "non-empty",
        )
        self.assertTrue(ok_a)
        # Empty list — should fail
        payload_b = {"restrictions": {"users": []}}
        ok_b, _ = preflight._check_protection_field(
            payload_b, "restrictions.users", "non-empty",
        )
        self.assertFalse(ok_b)

    def test_i_v9_preflight_verify_branch_protection_missing_gh_cli(self):
        """Returns (False, ('gh_cli_not_on_path',)) when gh CLI absent."""
        with mock.patch("aria_kernel.preflight._gh_available", return_value=False):
            ok, reasons = preflight.verify_branch_protection(branch="main")
            self.assertFalse(ok)
            self.assertEqual(reasons, ("gh_cli_not_on_path",))

    def test_i_v9_preflight_verify_branch_protection_missing_token(self):
        """Returns (False, ('gh_token_absent',)) when GH_TOKEN absent."""
        with mock.patch("aria_kernel.preflight._gh_available", return_value=True), \
             mock.patch("aria_kernel.preflight._read_gh_token", return_value=None):
            ok, reasons = preflight.verify_branch_protection(branch="main")
            self.assertFalse(ok)
            self.assertEqual(reasons, ("gh_token_absent",))

    def test_i_v9_preflight_public_api_pinned(self):
        """__all__ exports MUST contain the 6 canonical symbols.
        Adding/removing exports = explicit invariant amendment."""
        self.assertEqual(
            set(preflight.__all__),
            {
                "PreflightVerdict",
                "WorkflowPreflightVerdict",
                "REQUIRED_BRANCH_PROTECTION_FIELDS",
                "verify_branch_protection",
                "verify_preflight",
                "verify_workflow_contract",
                "verify_workflow_preflight",
            },
            "preflight.__all__ drifted",
        )


if __name__ == "__main__":
    unittest.main()
