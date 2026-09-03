"""Plan 032 Faz 032b-2 — the ONE command policy, compiled to every enforcer.

WHY: the Bash allow/deny lists lived as two frozensets of compiled regexes in
``implementation_safety`` and were consulted only by kernel code paths
(tool_runner, verification_gate, fixture_runner) — never at the moment the
agent's own Bash tool fired. Faz 032b-2 adds two more enforcers of the same
policy: the Claude permission rules handed to the CLI (`--settings`,
`permissions.allow/deny`) and the PreToolUse hook. Three enforcers reading
three hand-kept lists is how they drift; the second review of 2026-09-02
asked for one canonical model that COMPILES to each target and proves, on
examples, that the targets agree.

WHAT: :data:`ALLOW_RULES` / :data:`DENY_RULES` are the policy. Each
:class:`CommandRule` carries the kernel regex (the exact matcher the kernel
has always used — moved here verbatim, behaviour unchanged), an optional
Claude permission-rule projection, and positive/negative EXAMPLES. The kernel
lists in ``implementation_safety`` are DERIVED from this module;
:func:`claude_permission_rules` derives the CLI layer; :func:`verify_examples`
runs every example through the regex matcher and, where a projection exists,
through the Claude-rule matcher, and reports every disagreement.

The Claude layer is coarser than the regex layer by construction (a
permission rule is a prefix, a regex is a grammar), so the contract is not
"identical": every allow projection admits at most what its regex admits on
the examples, every deny projection refuses everything its regex refuses on
the examples, and rules the Claude grammar cannot express carry no projection
and are enforced by the hook alone. That gap is DECLARED per rule
(``claude_rule=None``), not discovered later.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

# The one grammar for an ARIA implementation branch. Both the push allow rule
# and the refspec-aware force-push check build on it (re-exported by
# implementation_safety so existing importers keep working).
ARIA_IMPL_BRANCH_FRAGMENT: str = r"aria-impl-[a-f0-9]{6,32}"

# Command families the work journal records instead of the raw command.
COMMAND_FAMILIES: tuple[str, ...] = (
    "python_script", "python_unittest", "node_ts", "git_read", "git_local_write",
    "git_push", "kernel_pr_create", "kernel_apply_gate", "gh_read", "test_runner",
    "linter_formatter", "network", "remote", "filesystem_primitive", "shell_primitive",
    "privilege", "package_manager", "orchestration", "gh_mutation", "gh_workflow",
    "gh_secret", "gh_release", "gh_merge", "env_dump", "token_reference",
    "dotenv_access", "ssh_key", "force_flag", "hook_bypass", "signing_bypass",
    "git_push_force", "git_push_main", "hooks_path", "unknown",
)


@dataclass(frozen=True)
class CommandRule:
    """One policy line, compiled to every enforcer."""

    name: str
    family: str
    pattern: str
    external_effect: bool = False
    claude_rule: str | tuple[str, ...] | None = None
    allow_examples: tuple[str, ...] = ()
    deny_examples: tuple[str, ...] = ()
    note: str = ""
    _compiled: re.Pattern[str] = field(init=False, repr=False, compare=False, default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        object.__setattr__(self, "_compiled", re.compile(self.pattern))
        if self.family not in COMMAND_FAMILIES:
            raise ValueError(f"command_rule_family_unknown:{self.name}:{self.family}")

    @property
    def regex(self) -> re.Pattern[str]:
        return self._compiled

    @property
    def claude_rules(self) -> tuple[str, ...]:
        if self.claude_rule is None:
            return ()
        return (self.claude_rule,) if isinstance(self.claude_rule, str) else tuple(self.claude_rule)


_PY = r"^(?:/[\w./-]+/)?python3?(\.\d+)?"

ALLOW_RULES: tuple[CommandRule, ...] = (
    CommandRule(
        "python_script", "python_script", _PY + r"\s+[\w./-]+\.py(\s+\S+)*\s*$",
        claude_rule=("Bash(python3 *)", "Bash(python *)"),
        allow_examples=("python3 tools/aria-poc/poc.py --help", "python tools/aria-adapters/x.py"),
        deny_examples=("python3 -c 'print(1)'",),
        note="script files only; -c is not a script (see _verify_python_script_target for the trusted prefixes)",
    ),
    CommandRule(
        "python_unittest", "python_unittest", _PY + r"\s+-m\s+unittest(\s+\S+)*\s*$",
        claude_rule="Bash(python3 -m unittest*)",
        allow_examples=("python3 -m unittest tests.test_x", "python3 -m unittest"),
        deny_examples=("python3 -m http.server",),
    ),
    CommandRule(
        "node_ts_node", "node_ts", r"^node\s+(\./)?node_modules/ts-node/dist/bin\.js(\s+\S+)*\s*$",
        claude_rule="Bash(node node_modules/ts-node/dist/bin.js*)",
        allow_examples=("node node_modules/ts-node/dist/bin.js tools/gates/x.ts",),
        deny_examples=("node -e 'process.exit(0)'",),
    ),
    CommandRule("git_add", "git_local_write", r"^git\s+add(\s+\S+)*\s*$", claude_rule="Bash(git add*)",
                allow_examples=("git add -A", "git add path/file.ts"), deny_examples=("git addx",)),
    CommandRule("git_commit", "git_local_write", r"^git\s+commit(\s+-[a-zA-Z]+)*(\s+-m\s+.+)?$", claude_rule="Bash(git commit*)",
                allow_examples=("git commit -m msg", "git commit -a -m 'x y'"), deny_examples=("git commit --amend",)),
    CommandRule("git_diff", "git_read", r"^git\s+diff(\s+\S+)*\s*$", claude_rule="Bash(git diff*)",
                allow_examples=("git diff --unified=0",), deny_examples=("git difftool",)),
    CommandRule("git_log", "git_read", r"^git\s+log(\s+\S+)*\s*$", claude_rule="Bash(git log*)",
                allow_examples=("git log --oneline -5",), deny_examples=("git logx",)),
    CommandRule("git_status", "git_read", r"^git\s+status(\s+\S+)*\s*$", claude_rule="Bash(git status*)",
                allow_examples=("git status --porcelain",), deny_examples=("git stash",)),
    CommandRule("git_rev_parse", "git_read", r"^git\s+rev-parse(\s+\S+)*\s*$", claude_rule="Bash(git rev-parse*)",
                allow_examples=("git rev-parse HEAD",), deny_examples=("git reflog",)),
    CommandRule(
        "git_push_impl_branch", "git_push",
        rf"^git\s+push\s+origin\s+{ARIA_IMPL_BRANCH_FRAGMENT}(\s+\S+)*\s*$",
        external_effect=True,
        claude_rule="Bash(git push origin aria-impl-*)",
        allow_examples=("git push origin aria-impl-0123abcd",),
        deny_examples=("git push origin main", "git push", "git push origin feat/x"),
        note="the only push the policy ever allows; external_writes on the profile gates it further",
    ),
    CommandRule(
        "kernel_pr_create", "kernel_pr_create",
        _PY + r"\s+-m\s+aria_kernel\s+pr\s+create(\s+\S+)*\s*$",
        external_effect=True,
        claude_rule="Bash(python3 -m aria_kernel pr create*)",
        allow_examples=("python3 -m aria_kernel pr create --action-id A-1",),
        deny_examples=("python3 -m aria_kernel profile set --profile autonomous",),
        note="the ONE sanctioned PR-opening path (Wave 0 §0.7)",
    ),
    CommandRule(
        "kernel_apply_gate", "kernel_apply_gate",
        _PY + r"\s+-m\s+aria_kernel\s+apply\s+gate(\s+\S+)*\s*$",
        claude_rule="Bash(python3 -m aria_kernel apply gate*)",
        allow_examples=("python3 -m aria_kernel apply gate --proposal-id P-1",),
        deny_examples=("python3 -m aria_kernel apply scan-diff",),
    ),
    CommandRule("gh_pr_checks", "gh_read", r"^gh\s+pr\s+checks(\s+\S+)*\s*$", claude_rule="Bash(gh pr checks*)",
                allow_examples=("gh pr checks 12",), deny_examples=("gh pr merge 12",)),
    CommandRule("gh_pr_view", "gh_read", r"^gh\s+pr\s+view(\s+\S+)*\s*$", claude_rule="Bash(gh pr view*)",
                allow_examples=("gh pr view 12 --json state",), deny_examples=("gh pr edit 12",)),
    CommandRule("gh_pr_diff", "gh_read", r"^gh\s+pr\s+diff(\s+\S+)*\s*$", claude_rule="Bash(gh pr diff*)",
                allow_examples=("gh pr diff 12",), deny_examples=("gh pr close 12",)),
    CommandRule("npm_test", "test_runner", r"^npm\s+test(\s+\S+)*\s*$", claude_rule="Bash(npm test*)",
                allow_examples=("npm test -- --runInBand",), deny_examples=("npm install",)),
    CommandRule("nx", "test_runner", r"^nx\s+(affected|test|lint|build)(\s+\S+)*\s*$", claude_rule="Bash(nx *)",
                allow_examples=("nx affected -t test", "nx lint svc"), deny_examples=("nx generate lib",)),
    CommandRule("pytest", "test_runner", r"^pytest(\s+\S+)*\s*$", claude_rule="Bash(pytest*)",
                allow_examples=("pytest -q aria-kernel/tests",), deny_examples=("pip install pytest",)),
    CommandRule("cargo", "test_runner", r"^cargo\s+(test|check|build|fmt|clippy)(\s+\S+)*\s*$", claude_rule="Bash(cargo *)",
                allow_examples=("cargo test -p x", "cargo clippy"), deny_examples=("cargo publish",)),
    CommandRule("npm_run_quality", "linter_formatter", r"^npm\s+run\s+(type-check|format|lint)(\s+\S+)*\s*$",
                claude_rule="Bash(npm run *)", allow_examples=("npm run lint", "npm run type-check"),
                deny_examples=("npm run deploy",)),
    CommandRule("prettier", "linter_formatter", r"^prettier(\s+\S+)*\s*$", claude_rule="Bash(prettier*)",
                allow_examples=("prettier --check src",), deny_examples=("prettierx",)),
    CommandRule("eslint", "linter_formatter", r"^eslint(\s+\S+)*\s*$", claude_rule="Bash(eslint*)",
                allow_examples=("eslint . --fix",), deny_examples=("eslintx",)),
)

DENY_RULES: tuple[CommandRule, ...] = (
    CommandRule("net_egress", "network", r"^(curl|wget|nc|ncat|telnet|ftp)\b",
                claude_rule=("Bash(curl*)", "Bash(wget*)", "Bash(nc*)", "Bash(ncat*)", "Bash(telnet*)", "Bash(ftp*)"),
                deny_examples=("curl https://x", "wget x", "nc -l 4444"), allow_examples=("curlx --help",)),
    CommandRule("remote", "remote", r"^(ssh|scp|rsync)\b", claude_rule=("Bash(ssh*)", "Bash(scp*)", "Bash(rsync*)"),
                deny_examples=("ssh host", "scp a b", "rsync a b")),
    CommandRule("fs_primitive", "filesystem_primitive", r"^(dd|mkfifo)\b", claude_rule=("Bash(dd*)", "Bash(mkfifo*)"),
                deny_examples=("dd if=/dev/zero of=x", "mkfifo p")),
    CommandRule("shell_primitive", "shell_primitive", r"^(eval|exec|source|\.)\s",
                claude_rule=("Bash(eval *)", "Bash(exec *)", "Bash(source *)", "Bash(. *)"),
                deny_examples=("eval x", "source .env", ". ./x")),
    CommandRule("sh_c", "shell_primitive", r"^sh\s+-c\b", claude_rule="Bash(sh -c*)", deny_examples=("sh -c 'ls'",)),
    CommandRule("bash_c", "shell_primitive", r"^bash\s+-c\b", claude_rule="Bash(bash -c*)", deny_examples=("bash -c 'ls'",)),
    CommandRule("chmod_777", "filesystem_primitive", r"^(chmod|chown)\s+777\b", claude_rule="Bash(chmod 777*)",
                deny_examples=("chmod 777 x",), allow_examples=("chmod 644 x",)),
    CommandRule("privilege", "privilege", r"^(sudo|su)\b", claude_rule=("Bash(sudo*)", "Bash(su*)"), deny_examples=("sudo ls", "su -")),
    CommandRule("package_manager", "package_manager", r"^(apt|apt-get|yum|dnf|pacman|brew)\b",
                claude_rule=("Bash(apt*)", "Bash(yum*)", "Bash(dnf*)", "Bash(pacman*)", "Bash(brew*)"),
                deny_examples=("apt-get install x", "brew install y")),
    CommandRule("orchestration", "orchestration", r"^(docker|kubectl|helm)\b",
                claude_rule=("Bash(docker*)", "Bash(kubectl*)", "Bash(helm*)"),
                deny_examples=("docker run x", "kubectl apply -f y")),
    CommandRule("gh_api_mutation", "gh_mutation", r"^gh\s+api\s+(-X\s+)?(DELETE|PATCH|PUT)\b", claude_rule="Bash(gh api*)",
                deny_examples=("gh api -X DELETE /repos/o/r/x", "gh api PATCH /x")),
    CommandRule("gh_api_merge", "gh_merge",
                r"^gh\s+api\b.*(?:^|\s)/?repos/[^/\s]+/[^/\s]+/pulls/[^/\s]+/merge(?:[/?#]\S*)?(?:\s|$)",
                claude_rule="Bash(gh api*)", deny_examples=("gh api repos/o/r/pulls/1/merge",)),
    CommandRule("gh_workflow", "gh_workflow", r"^gh\s+workflow\b", claude_rule="Bash(gh workflow*)",
                deny_examples=("gh workflow run x.yml",)),
    CommandRule("gh_secret", "gh_secret", r"^gh\s+secret\b", claude_rule="Bash(gh secret*)",
                deny_examples=("gh secret list",)),
    CommandRule("gh_release", "gh_release", r"^gh\s+release\b", claude_rule="Bash(gh release*)",
                deny_examples=("gh release create v1",)),
    CommandRule("gh_pr_merge", "gh_merge", r"^gh\s+pr\s+merge\b", claude_rule="Bash(gh pr merge*)",
                deny_examples=("gh pr merge 1",)),
    CommandRule("env_dump", "env_dump", r"^(env|printenv|set)\s*$", claude_rule=("Bash(env)", "Bash(printenv)", "Bash(set)"),
                deny_examples=("env", "printenv"), allow_examples=("printenv HOME",),
                note="the bare dump; a single lookup is not a dump"),
    CommandRule("token_reference_gh", "token_reference", r"\$GH_TOKEN\b", deny_examples=("echo $GH_TOKEN",),
                note="anywhere in the line — the Claude grammar is prefix-only, so the hook enforces this"),
    CommandRule("token_reference_github", "token_reference", r"\$GITHUB_TOKEN\b", deny_examples=("echo $GITHUB_TOKEN",)),
    CommandRule("dotenv_access", "dotenv_access", r"\.env(\.|\b)", deny_examples=("cat .env", "cat .env.local")),
    CommandRule("ssh_key_access", "ssh_key", r"id_rsa\b", deny_examples=("cat ~/.ssh/id_rsa",)),
    CommandRule("force_flag", "force_flag", r"--force\b", deny_examples=("git push --force", "rm --force x")),
    CommandRule("no_verify", "hook_bypass", r"--no-verify\b", deny_examples=("git commit --no-verify -m x",)),
    CommandRule("no_gpg_sign", "signing_bypass", r"--no-gpg-sign\b", deny_examples=("git commit --no-gpg-sign -m x",)),
    CommandRule("force_with_lease", "force_flag", r"--force-with-lease\b", deny_examples=("git push --force-with-lease",)),
    CommandRule("git_push_short_force", "git_push_force",
                r"^git\s+push\b.*(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)",
                deny_examples=("git push origin aria-impl-abc123 -f", "git push -fu origin x"),
                allow_examples=("git push origin aria-impl-abc123", "git log report-f.md"),
                note="ORPHAN-HIGH-454 — scoped to `git push`; a bare -f elsewhere is harmless"),
    CommandRule("git_push_main_or_plus", "git_push_main",
                r"\bgit\s+push\s+(?:\+|.+:refs/heads/main\b|origin\s+\+)",
                deny_examples=("git push +HEAD:main", "git push origin HEAD:refs/heads/main")),
    CommandRule("hooks_path", "hooks_path", r"core\.hooksPath", deny_examples=("git config core.hooksPath /tmp/h",)),
)


def allowed_regexes() -> frozenset[re.Pattern[str]]:
    return frozenset(rule.regex for rule in ALLOW_RULES)


def denied_regexes() -> frozenset[re.Pattern[str]]:
    return frozenset(rule.regex for rule in DENY_RULES)


def classify_command(argv_or_line: Iterable[str] | str) -> tuple[str, bool]:
    """(command_family, external_effect) for a command — the journal's view.

    Deny rules classify first (their family names the hazard), then allow
    rules; anything else is ``unknown``. Never the raw command.
    """
    line = argv_or_line if isinstance(argv_or_line, str) else " ".join(str(a) for a in argv_or_line)
    for rule in DENY_RULES:
        if rule.regex.search(line):
            return rule.family, rule.external_effect
    for rule in ALLOW_RULES:
        if rule.regex.match(line):
            return rule.family, rule.external_effect
    return "unknown", False


def claude_permission_rules(*, external_writes: bool) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(allow, deny) permission rules for the CLI's ``--settings``.

    Allow projections are the rules' Claude forms (external-effect rules only
    when the profile permits external writes); deny projections are every
    deny rule that has one. A rule without a projection is not weakened —
    it is simply enforced by the hook alone (see the module docstring).
    """
    allow = tuple(dict.fromkeys(
        projection
        for rule in ALLOW_RULES
        if external_writes or not rule.external_effect
        for projection in rule.claude_rules
    ))
    deny = tuple(dict.fromkeys(projection for rule in DENY_RULES for projection in rule.claude_rules))
    return allow, deny


def claude_rule_matches(rule: str, command: str) -> bool:
    """The CLI's permission-rule grammar for Bash, reproduced for verification:
    ``Bash(prefix*)`` matches a command starting with ``prefix``; ``Bash(exact)``
    matches the exact command; a bare ``Bash`` matches every Bash call."""
    if rule == "Bash":
        return True
    if not (rule.startswith("Bash(") and rule.endswith(")")):
        return False
    body = rule[5:-1]
    if body.endswith("*"):
        return command.startswith(body[:-1].rstrip())
    return command.strip() == body


def verify_examples() -> list[dict[str, str]]:
    """Every rule's examples, through every enforcer. Empty list = agreement.

    * an ALLOW rule's allow_examples must match its regex AND its projection;
      its deny_examples must fail the regex (the projection may be coarser —
      that is the declared gap the hook closes, so it is not a defect);
    * a DENY rule's deny_examples must be caught by its regex AND (when a
      projection exists) by the projection; its allow_examples must escape
      the regex.
    """
    defects: list[dict[str, str]] = []
    for rule in ALLOW_RULES:
        for example in rule.allow_examples:
            if not rule.regex.match(example):
                defects.append({"rule": rule.name, "example": example, "defect": "allow_example_misses_regex"})
            if rule.claude_rules and not any(claude_rule_matches(r, example) for r in rule.claude_rules):
                defects.append({"rule": rule.name, "example": example, "defect": "allow_example_misses_claude_rule"})
        for example in rule.deny_examples:
            if rule.regex.match(example):
                defects.append({"rule": rule.name, "example": example, "defect": "deny_example_matches_regex"})
    for rule in DENY_RULES:
        for example in rule.deny_examples:
            if not rule.regex.search(example):
                defects.append({"rule": rule.name, "example": example, "defect": "deny_example_escapes_regex"})
            if rule.claude_rules and not any(claude_rule_matches(r, example) for r in rule.claude_rules):
                defects.append({"rule": rule.name, "example": example, "defect": "deny_example_escapes_claude_rule"})
        for example in rule.allow_examples:
            if rule.regex.search(example):
                defects.append({"rule": rule.name, "example": example, "defect": "allow_example_caught_by_deny_regex"})
    return defects


__all__ = [
    "ALLOW_RULES",
    "ARIA_IMPL_BRANCH_FRAGMENT",
    "COMMAND_FAMILIES",
    "CommandRule",
    "DENY_RULES",
    "allowed_regexes",
    "claude_permission_rules",
    "claude_rule_matches",
    "classify_command",
    "denied_regexes",
    "verify_examples",
]
