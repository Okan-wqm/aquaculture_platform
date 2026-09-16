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
from aria_kernel import validation_suite as vs

# The literal pattern sets `implementation_safety` carried before Plan 032
# Faz 032b-2 (copied verbatim at refactor time). Any drift is a policy change
# that must be made HERE, on purpose.
_LEGACY_ALLOW = {
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+[\w./-]+\.py(\s+\S+)*\s*$",
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+-m\s+unittest(\s+\S+)*\s*$",
    r"^node\s+(\./)?node_modules/ts-node/dist/bin\.js(\s+\S+)*\s*$",
    r"^git\s+add(\s+\S+)*\s*$",
    # ARIA-HIGH-124 (round 4) — the line sees the option PREFIX only: `-a`,
    # then `-m`/`-am` and a message that may carry newlines (`(?s)`); every
    # option after `-m` is the token rule's (`git_commit_foreign_option`,
    # the one DENY rule with no pattern). The legacy
    # `(\s+-[a-zA-Z]+)*(\s+-m\s+.+)?$` admitted `-S<key>` in the cluster
    # and every trailing flag inside `.+`.
    r"(?s)^git\s+commit(?:\s+-a)?(?:\s+-a?m\s*\S.*)?$",
    r"^git\s+diff(\s+\S+)*\s*$",
    r"^git\s+log(\s+\S+)*\s*$",
    r"^git\s+status(\s+\S+)*\s*$",
    r"^git\s+rev-parse(\s+\S+)*\s*$",
    # ARIA-HIGH-124 (round 2) — the one `git branch` read the implementer's
    # first step names (`git branch --show-current`), admitted on purpose;
    # every other `git branch` form stays a miss.
    r"^git\s+branch\s+--show-current\s*$",
    # ARIA-HIGH-124 — the `git push origin aria-impl-*`, `aria_kernel pr
    # create` and `aria_kernel apply gate` allow rows are GONE: the push,
    # the gate and the PR are the executor's after the spawn; inside the
    # sandbox they are refused by name (the two `kernel_authority` deny
    # rows at the end of _LEGACY_DENY).
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
    # ARIA-HIGH-124 — kernel authority is the executor's: every kernel CLI
    # command and every push are refused inside, by name.
    r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+-m\s+aria_kernel\b",
    r"^git\s+push\b",
}


# ARIA-HIGH-104 (2) — the one policy change made here on purpose since the
# refactor: an allow rule per canonical validation command, DERIVED from
# `validation_suite.CANONICAL_VALIDATION_COMMANDS_EXECUTABLE` (the hand-kept
# patterns above refused `npm run format:check` and every `npx nx …` entry the
# implementer's envelope tells it to run). Read from the suite, not retyped,
# so a command joining the suite is admitted without this literal growing.
_DERIVED_ALLOW = {
    vs.bash_allow_pattern_for(spelling) for spelling in vs.CANONICAL_VALIDATION_COMMANDS_EXECUTABLE
}


# ARIA-HIGH-124 (round 4) — the DENY rules that are token grammars rather
# than line patterns: one, the `git commit` option grammar.
_TOKEN_DENY_RULES = {"git_commit_foreign_option"}


class TheKernelListsAreDerived(unittest.TestCase):
    def test_I_V12_POLICY_01_patterns_are_the_legacy_patterns(self) -> None:
        self.assertEqual({r.pattern for r in cp.STATED_ALLOW_RULES}, _LEGACY_ALLOW)
        self.assertEqual({r.pattern for r in isf.ALLOWED_BASH_COMMANDS}, _LEGACY_ALLOW | _DERIVED_ALLOW)
        self.assertEqual({r.pattern for r in isf.DENIED_BASH_COMMANDS}, _LEGACY_DENY)
        self.assertIs(isf.ALLOWED_BASH_COMMANDS, isf.ALLOWED_BASH_COMMANDS)
        self.assertEqual(isf.ARIA_IMPL_BRANCH_FRAGMENT, cp.ARIA_IMPL_BRANCH_FRAGMENT)
        self.assertEqual(len(cp.STATED_ALLOW_RULES), len(_LEGACY_ALLOW))
        self.assertEqual(len(cp.ALLOW_RULES), len(_LEGACY_ALLOW) + len(_DERIVED_ALLOW))
        self.assertEqual(len(cp.DENY_RULES), len(_LEGACY_DENY) + len(_TOKEN_DENY_RULES))
        self.assertEqual({rule.name for rule in cp.DENY_RULES if rule.pattern is None}, _TOKEN_DENY_RULES)
        for rule in (*cp.ALLOW_RULES, *cp.DENY_RULES):
            if rule.name in _TOKEN_DENY_RULES:
                self.assertIsNone(rule.regex)
                self.assertIsNotNone(rule.argv_refusal)
                self.assertEqual(rule.claude_rules, (), "a token grammar has no prefix projection")
            else:
                self.assertIsInstance(rule.regex, re.Pattern)
            self.assertIn(rule.family, cp.COMMAND_FAMILIES)
        # A rule carries exactly one grammar.
        with self.assertRaisesRegex(ValueError, "command_rule_grammar_ambiguous"):
            cp.CommandRule("both", "unknown", r"^x$", argv_refusal=lambda argv: None)
        with self.assertRaisesRegex(ValueError, "command_rule_grammar_ambiguous"):
            cp.CommandRule("neither", "unknown", None)


class TheGitCommitGrammarIsClosed(unittest.TestCase):
    """ARIA-HIGH-124 (round 4) — `git commit` admits `-a` and `-m <message>`
    and nothing else. The legacy line rule admitted `git commit -m x
    --gpg-sign=/tmp/k` (the `.+` after `-m` swallowed every trailing flag)
    and `git commit -Skey -m x` (the `(\\s+-[a-zA-Z]+)*` cluster), so the
    real CLI agent could sign with a key it wrote under its HOME and the
    executor lent its push to that commit. The message itself is whatever
    follows `-m` — newlines, bullets and flag-shaped words included: the
    line cannot tell a flag from a word of the message, the argv can."""

    def _verdict(self, command: str) -> tuple[str, str]:
        try:
            isf.verify_bash_command_allowed(cp.argv_of(command))
        except isf.BashDenylistHit as refused:
            return "denied", str(refused)
        except isf.BashAllowlistMiss:
            return "miss", ""
        return "allowed", ""

    def test_every_foreign_option_is_refused_by_name_through_the_enforcer(self) -> None:
        for command, detail in (
            ("git commit -m x --gpg-sign=/tmp/k", "option='--gpg-sign=/tmp/k'"),
            ("git commit -m 'fix: x' --gpg-sign=/tmp/its-own-key", "option='--gpg-sign=/tmp/its-own-key'"),
            ("git commit -S -m x", "option='-S'"),
            ("git commit -Skey -m x", "option='-Skey'"),
            ("git commit -m x -S/tmp/k", "option='-S/tmp/k'"),
            ("git commit -aSm x", "option='-aSm'"),
            ("git commit --author='A <a@x>' -m x", "option='--author=A <a@x>'"),
            ("git commit -m x --amend", "option='--amend'"),
            ("git commit -m x --date=2020-01-01", "option='--date=2020-01-01'"),
            ("git commit -m x -C HEAD", "option='-C'"),
            ("git commit -n -m x", "option='-n'"),
            ("git commit -q -m x", "option='-q'"),
            ("git commit -m x -- path/file.ts", "option='--'"),
            ("git commit -m x path/file.ts", "operand='path/file.ts'"),
        ):
            with self.subTest(command=command):
                kind, reason = self._verdict(command)
                self.assertEqual(kind, "denied", command)
                self.assertIn("DENY rule hit: commit_identity:git_commit_foreign_option " + detail, reason)
                self.assertEqual(cp.classify_command(command), ("commit_identity", False))
                self.assertEqual(cp.git_commit_option_refusal(cp.argv_of(command)), detail)

    def test_the_contracts_own_spellings_are_admitted(self) -> None:
        trailer = "Closes: docs/reviews/claude/2026-09-12-aria-live-chain-blockers.md#ARIA-HIGH-124"
        for command in (
            "git commit -m 'fix(aria): x'",
            "git commit -a -m 'x y'",
            "git commit -am 'x y'",
            "git commit -mtext",
            "git commit",
            f"git commit -m 'fix(aria): x' -m 'WHY: the plan says so.' -m '{trailer}'",
            # One `-m` holding subject, body (bullets, a flag-shaped word) and
            # the trailer as its last line: an allowlist miss until round 4
            # (`.` did not cross the newline).
            f"git commit -m 'fix(aria): x\n\n- refuses --gpg-sign by name\n- pins it\n\n{trailer}'",
            # After `-m` the next token IS the message, flag-shaped or not.
            "git commit -m x -m --gpg-sign=/tmp/k",
        ):
            with self.subTest(command=command):
                self.assertEqual(self._verdict(command), ("allowed", ""), command)
                self.assertIsNone(cp.git_commit_option_refusal(cp.argv_of(command)))
        self.assertEqual(cp.GIT_COMMIT_ADMITTED_SHORT_OPTIONS, frozenset({"a", "m"}))
        # Not a `git commit` at all: the grammar says nothing.
        self.assertIsNone(cp.git_commit_option_refusal(["git", "commit-tree", "HEAD^{tree}"]))
        self.assertIsNone(cp.git_commit_option_refusal(["git", "status"]))
        # The hook lexes the way a shell does; an unlexable line stays one token.
        self.assertEqual(cp.argv_of("git commit -m 'a b'"), ["git", "commit", "-m", "a b"])
        self.assertEqual(cp.argv_of("git commit -m 'unterminated"), ["git commit -m 'unterminated"])


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
        # ARIA-HIGH-124 — no allow rule carries an external effect any more:
        # the grant on the profile governs the EXECUTOR's delivery credential,
        # and the two projections are the same document. The push and the
        # kernel CLI are denied for every profile.
        self.assertEqual(allow_closed, allow_open)
        self.assertEqual([rule.name for rule in cp.ALLOW_RULES if rule.external_effect], [])
        for closed in ("Bash(git push origin aria-impl-*)", "Bash(python3 -m aria_kernel pr create*)",
                       "Bash(python3 -m aria_kernel apply gate*)"):
            self.assertNotIn(closed, allow_open)
        self.assertIn("Bash(git push*)", deny_open)
        self.assertIn("Bash(python3 -m aria_kernel*)", deny_open)
        self.assertEqual(deny_closed, deny_open)
        for rule in cp.DENY_RULES:
            for projection in rule.claude_rules:
                self.assertIn(projection, deny_closed)
        self.assertIn("Bash(curl*)", deny_closed)
        self.assertIn("Bash(gh api*)", deny_closed)

    def test_I_V12_POLICY_04_classification_names_a_family_never_the_line(self) -> None:
        # ARIA-HIGH-124 — a push and a kernel CLI call classify under the
        # hazard that refuses them, with no external effect the sandbox can
        # have (the executor's own push and PR are not journaled here).
        self.assertEqual(cp.classify_command(["git", "push", "origin", "aria-impl-abc123"]), ("kernel_authority", False))
        self.assertEqual(cp.classify_command("curl https://x"), ("network", False))
        self.assertEqual(cp.classify_command("python3 -m aria_kernel pr create --x"), ("kernel_authority", False))
        self.assertEqual(cp.classify_command("python3 -m aria_kernel apply gate --x"), ("kernel_authority", False))
        self.assertEqual(cp.classify_command("ls -la"), ("unknown", False))
        self.assertEqual(cp.classify_command("git push origin main -f")[0], "git_push_force")


if __name__ == "__main__":
    unittest.main()
