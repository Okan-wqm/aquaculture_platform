"""Plan 032 Faz 032b-2 — one command policy, every enforcer derived from it.

Invariants:
  I-V12-POLICY-01  the kernel's ALLOWED/DENIED regex sets are DERIVED from
                   command_policy and equal the patterns the kernel carried
                   before the refactor (behaviour unchanged, pinned by literal).
  I-V12-POLICY-02  every rule's examples agree across the regex matcher and its
                   Claude projection (`verify_examples()` is empty).
  I-V12-POLICY-03  the Claude projection never admits an external-effect command
                   while external writes are closed, and always carries the
                   deny projections.
  I-V12-POLICY-04  `classify_command` names a family, never a raw line.

NOT RUN at authoring time (operator instruction 2026-09-03: tests are written
now and executed per commit later).
"""
from __future__ import annotations

import re
import unittest

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import command_policy as cp
from aria_kernel import implementation_safety as isf

# The literal pattern sets `implementation_safety` carried before Plan 032
# Faz 032b-2 (copied verbatim at refactor time). Any drift is a policy change
# that must be made HERE, on purpose.
_LEGACY_ALLOW = {
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+[\w./-]+\.py(\s+\S+)*\s*$",
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+-m\s+unittest(\s+\S+)*\s*$",
    r"^node\s+(\./)?node_modules/ts-node/dist/bin\.js(\s+\S+)*\s*$",
    r"^git\s+add(\s+\S+)*\s*$",
    r"^git\s+commit(\s+-[a-zA-Z]+)*(\s+-m\s+.+)?$",
    r"^git\s+diff(\s+\S+)*\s*$",
    r"^git\s+log(\s+\S+)*\s*$",
    r"^git\s+status(\s+\S+)*\s*$",
    r"^git\s+rev-parse(\s+\S+)*\s*$",
    r"^git\s+push\s+origin\s+aria-impl-[a-f0-9]{6,32}(\s+\S+)*\s*$",
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+-m\s+aria_kernel\s+pr\s+create(\s+\S+)*\s*$",
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+-m\s+aria_kernel\s+apply\s+gate(\s+\S+)*\s*$",
    r"^gh\s+pr\s+checks(\s+\S+)*\s*$",
    r"^gh\s+pr\s+view(\s+\S+)*\s*$",
    r"^gh\s+pr\s+diff(\s+\S+)*\s*$",
    r"^npm\s+test(\s+\S+)*\s*$",
    r"^nx\s+(affected|test|lint|build)(\s+\S+)*\s*$",
    r"^pytest(\s+\S+)*\s*$",
    r"^cargo\s+(test|check|build|fmt|clippy)(\s+\S+)*\s*$",
    r"^npm\s+run\s+(type-check|format|lint)(\s+\S+)*\s*$",
    r"^prettier(\s+\S+)*\s*$",
    r"^eslint(\s+\S+)*\s*$",
}
_LEGACY_DENY = {
    r"^(curl|wget|nc|ncat|telnet|ftp)\b", r"^(ssh|scp|rsync)\b", r"^(dd|mkfifo)\b",
    r"^(eval|exec|source|\.)\s", r"^sh\s+-c\b", r"^bash\s+-c\b", r"^(chmod|chown)\s+777\b",
    r"^(sudo|su)\b", r"^(apt|apt-get|yum|dnf|pacman|brew)\b", r"^(docker|kubectl|helm)\b",
    r"^gh\s+api\s+(-X\s+)?(DELETE|PATCH|PUT)\b",
    r"^gh\s+api\b.*(?:^|\s)/?repos/[^/\s]+/[^/\s]+/pulls/[^/\s]+/merge(?:[/?#]\S*)?(?:\s|$)",
    r"^gh\s+workflow\b", r"^gh\s+secret\b", r"^gh\s+release\b", r"^gh\s+pr\s+merge\b",
    r"^(env|printenv|set)\s*$", r"\$GH_TOKEN\b", r"\$GITHUB_TOKEN\b", r"\.env(\.|\b)", r"id_rsa\b",
    r"--force\b", r"--no-verify\b", r"--no-gpg-sign\b", r"--force-with-lease\b",
    r"^git\s+push\b.*(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)",
    r"\bgit\s+push\s+(?:\+|.+:refs/heads/main\b|origin\s+\+)", r"core\.hooksPath",
}


class TheKernelListsAreDerived(unittest.TestCase):
    def test_I_V12_POLICY_01_patterns_are_the_legacy_patterns(self) -> None:
        self.assertEqual({r.pattern for r in isf.ALLOWED_BASH_COMMANDS}, _LEGACY_ALLOW)
        self.assertEqual({r.pattern for r in isf.DENIED_BASH_COMMANDS}, _LEGACY_DENY)
        self.assertIs(isf.ALLOWED_BASH_COMMANDS, isf.ALLOWED_BASH_COMMANDS)
        self.assertEqual(isf.ARIA_IMPL_BRANCH_FRAGMENT, cp.ARIA_IMPL_BRANCH_FRAGMENT)
        self.assertEqual(len(cp.ALLOW_RULES), len(_LEGACY_ALLOW))
        self.assertEqual(len(cp.DENY_RULES), len(_LEGACY_DENY))
        for rule in (*cp.ALLOW_RULES, *cp.DENY_RULES):
            self.assertIsInstance(rule.regex, re.Pattern)
            self.assertIn(rule.family, cp.COMMAND_FAMILIES)


class EnforcersAgree(unittest.TestCase):
    def test_I_V12_POLICY_02_every_example_agrees(self) -> None:
        self.assertEqual(cp.verify_examples(), [])

    def test_I_V12_POLICY_02_the_claude_grammar_is_reproduced(self) -> None:
        self.assertTrue(cp.claude_rule_matches("Bash(git push origin aria-impl-*)", "git push origin aria-impl-abc123"))
        self.assertFalse(cp.claude_rule_matches("Bash(git push origin aria-impl-*)", "git push origin main"))
        self.assertTrue(cp.claude_rule_matches("Bash(env)", "env"))
        self.assertFalse(cp.claude_rule_matches("Bash(env)", "env | grep x"))
        self.assertTrue(cp.claude_rule_matches("Bash", "anything"))
        self.assertFalse(cp.claude_rule_matches("Read(x)", "x"))

    def test_I_V12_POLICY_03_projection_respects_external_writes(self) -> None:
        allow_closed, deny_closed = cp.claude_permission_rules(external_writes=False)
        allow_open, deny_open = cp.claude_permission_rules(external_writes=True)
        self.assertNotIn("Bash(git push origin aria-impl-*)", allow_closed)
        self.assertNotIn("Bash(python3 -m aria_kernel pr create*)", allow_closed)
        self.assertIn("Bash(git push origin aria-impl-*)", allow_open)
        self.assertEqual(deny_closed, deny_open)
        for rule in cp.DENY_RULES:
            for projection in rule.claude_rules:
                self.assertIn(projection, deny_closed)
        self.assertIn("Bash(curl*)", deny_closed)
        self.assertIn("Bash(gh api*)", deny_closed)

    def test_I_V12_POLICY_04_classification_names_a_family_never_the_line(self) -> None:
        self.assertEqual(cp.classify_command(["git", "push", "origin", "aria-impl-abc123"]), ("git_push", True))
        self.assertEqual(cp.classify_command("curl https://x"), ("network", False))
        self.assertEqual(cp.classify_command("python3 -m aria_kernel pr create --x"), ("kernel_pr_create", True))
        self.assertEqual(cp.classify_command("ls -la"), ("unknown", False))
        self.assertEqual(cp.classify_command("git push origin main -f")[0], "git_push_force")


if __name__ == "__main__":
    unittest.main()
