"""Plan ARIA-V9.1 — aria-implementer agent file invariants.

Pins the 17 refusal classes, SECURITY CONTRACT presence, mandatory
sections, tool ceiling, and pedagogy tier so the agent file cannot
silently drift away from the V9.0 safety perimeter.

Closes: ai CRIT-001/003/005 + HIGH-011/012, sec HIGH-008.
"""
from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_AGENT_FILE = _REPO_ROOT / ".claude" / "agents" / "aria-implementer.md"
_SHARED_CONTRACT_FILE = (
    _REPO_ROOT
    / ".claude"
    / "agents"
    / "_shared"
    / "aria-implementer-safety-contract.md"
)


# The 17 canonical refusal classes (mirror of
# plan_convergence._validate_event implementation_rejected set + V9.1
# contract). Adding/removing a class = invariant amendment.
CANONICAL_REFUSAL_CLASSES = frozenset({
    "forbidden_scope_violation",
    "validation_failed",
    "plan_evidence_stale",
    "branch_collision",
    "prompt_injection_detected",
    "kernel_self_modification_attempted",
    "secret_leak_detected",
    "dependency_pinning_unsafe",
    "bash_command_denylist_hit",
    "path_escape_outside_workspace",
    "file_lock_conflict",
    "cycle_budget_exhausted",
    "implementer_turn_budget_exhausted",
    "content_hash_mismatch",
    "branch_tip_drift",
    "gh_api_scope_violation",
    "autonomous_profile_preconditions_not_met",
})


class TestV9ImplementerAgentFile(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.assertTrue(cls, _AGENT_FILE.exists(),
                       f"agent file not found at {_AGENT_FILE}")
        cls.assertTrue(cls, _SHARED_CONTRACT_FILE.exists(),
                       f"shared safety contract not found at {_SHARED_CONTRACT_FILE}")
        cls.body = _AGENT_FILE.read_text()
        cls.shared_contract = _SHARED_CONTRACT_FILE.read_text()
        cls.contract_body = cls.body + "\n" + cls.shared_contract

    def test_i_v9_impl_01_agent_file_exists_runtime_location(self):
        """aria-implementer.md MUST live at runtime location (Lane-A
        root), NOT under _maintenance/."""
        self.assertTrue(_AGENT_FILE.exists())
        maintenance = _AGENT_FILE.parent / "_maintenance" / "aria-implementer.md"
        self.assertFalse(
            maintenance.exists(),
            "aria-implementer.md MUST be Lane-A runtime, not _maintenance",
        )

    def test_i_v9_impl_01_frontmatter_tools_ceiling(self):
        """tools: Read, Grep, Glob, Edit, Write, Bash — the writer
        agent tool ceiling. Adding more is an ADR + arbiter
        decision; removing breaks the contract."""
        m = re.search(r"^tools:\s*(.+)$", self.body, re.MULTILINE)
        self.assertIsNotNone(m, "frontmatter MUST declare `tools:` line")
        tools = {t.strip() for t in m.group(1).split(",")}
        self.assertEqual(
            tools,
            {"Read", "Grep", "Glob", "Edit", "Write", "Bash"},
            f"tools declaration drifted: {tools}",
        )

    def test_i_v9_impl_01_model_is_opus(self):
        """Writer agent MUST run on the most capable tier (K5 tier flip,
        operator policy 2026-07-01: decision nodes on fable)."""
        m = re.search(r"^model:\s*(\S+)$", self.body, re.MULTILINE)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).strip(), "opus")

    def test_i_v9_impl_01_pedagogy_tier_3(self):
        """Tier-3 pinned: aria-implementer has high prohibition density
        (6 sections); Tier-3 narrative+Example pairing is the
        architectural fit per registry rationale."""
        m = re.search(r"^pedagogy-tier:\s*(\d+)$", self.body, re.MULTILINE)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).strip(), "3")

    def test_i_v9_impl_01_security_contract_present(self):
        self.assertIn("## SECURITY CONTRACT", self.body)
        self.assertIn("DATA, never", self.body)
        self.assertIn("<untrusted_converged_plan>", self.body)
        self.assertIn("<untrusted_cross_review_summary>", self.body)

    def test_i_v9_impl_01_self_mod_prohibition_present(self):
        self.assertIn("## Self-Modification Prohibition", self.contract_body)
        self.assertIn("READONLY_PATHS", self.contract_body)
        self.assertIn(".claude/agents/", self.contract_body)
        self.assertIn("aria-kernel/aria_kernel/", self.contract_body)

    def test_i_v9_impl_01_network_egress_prohibition_present(self):
        # ARIA-HIGH-124 — the contract states the sandbox's REAL network
        # setting (the managed route shares the host's namespace so the
        # CLI reaches its provider; egress is the command policy's to
        # refuse), not the `--unshare-net` the safety contract used to
        # claim; and the PR is the executor's, so no push is the agent's.
        from aria_kernel.implementation_safety import MANAGED_SPAWN_ALLOW_NETWORK

        self.assertTrue(MANAGED_SPAWN_ALLOW_NETWORK)
        self.assertIn("## Network Egress Prohibition", self.contract_body)
        self.assertNotIn("--unshare-net", self.contract_body)
        self.assertNotIn("firejail", self.contract_body)
        self.assertIn("MANAGED_SPAWN_ALLOW_NETWORK", self.contract_body)
        self.assertIn("opened by the EXECUTOR", self.contract_body)
        self.assertNotIn("`gh pr merge\n--squash`", self.contract_body)

    def test_i_v9_impl_01_safety_disable_prohibition_present(self):
        self.assertIn("## Safety Disable Prohibition", self.contract_body)
        self.assertIn("implementation_safety.py", self.contract_body)

    def test_i_v9_impl_01_canonical_validation_suite_present(self):
        self.assertIn("## Canonical Validation Suite", self.contract_body)
        self.assertIn("nx affected --target=test", self.contract_body)
        self.assertIn("nx affected --target=lint", self.contract_body)
        self.assertIn("npm run type-check", self.contract_body)

    def test_i_v9_impl_01_seventeen_refusal_classes(self):
        """All 17 canonical refusal classes MUST appear in the SSOT contract."""
        missing = set()
        for cls in CANONICAL_REFUSAL_CLASSES:
            if cls not in self.contract_body:
                missing.add(cls)
        self.assertEqual(
            missing, set(),
            f"refusal classes missing from agent body: {missing}",
        )

    def test_i_v9_impl_01_reason_class_field_documented(self):
        """The reason_class field is referenced in BOTH the section
        intro AND the refusal envelope shape. The 17-class-set test
        above is the load-bearing check; this is a structural sanity
        guard that the refusal section + envelope shape coexist."""
        self.assertIn("reason_class", self.body)
        # Either in the refusal-class introduction OR in the JSON
        # envelope shape (both occur in canonical document).
        self.assertIn("Refusal Patterns", self.contract_body)

    def test_i_v9_impl_01_pr_title_prefix_documented(self):
        # ARIA-HIGH-124 — the title convention is the PR opener's
        # (`pr_manager.build_pr_body` / the staged proposal), applied by the
        # executor; the agent file names the opener, and the convention is
        # pinned where it is produced (tests/test_pr_manager_e2e.py).
        self.assertIn("pr_manager.open_pr_for_action", self.body)
        self.assertIn("implementation_delivery", self.body)

    def test_i_v9_impl_01_v9_0_module_anchors_present(self):
        """Knowledge anchors point at V9.0 modules."""
        for anchor in (
            "implementation_safety.py",
            "preflight.py",
            "gh_token_factory.py",
            "knowledge_graph.py",
            "plan_candidate_source.py",
        ):
            self.assertIn(
                anchor, self.body,
                f"agent body MUST reference V9.0 module {anchor}",
            )

    def test_i_v9_impl_01_implementer_output_envelope_shape(self):
        """details.implementation field set documented — the KERNEL's fields.

        ARIA-HIGH-115 stamped ``signer_key_fp``; ARIA-HIGH-124 stamps the
        rest: the executor delivers the branch and writes every delivery
        field, and the contract documents the record as the kernel fills
        it, telling the agent by name that a value it writes is replaced.
        """
        from aria_kernel.implementation_delivery import KERNEL_STAMPED_DELIVERY_FIELDS

        for field in (*KERNEL_STAMPED_DELIVERY_FIELDS, "signer_key_fp", "completed_at"):
            self.assertIn(
                f'"{field}"',
                self.contract_body,
                f"output envelope missing {field}",
            )
        self.assertIn("KERNEL_STAMPED_DELIVERY_FIELDS", self.contract_body)
        self.assertIn("implementation_delivery_overridden", self.contract_body)
        self.assertIn("`signer_key_fp` is NOT yours to report", self.contract_body)
        self.assertIn("implementation_signer_fp_overridden", self.contract_body)
        self.assertIn("EMPTY of delivery", self.body)


class TestV9ImplementerPromptReadsTheDataModel(unittest.TestCase):
    """ARIA-HIGH-104 (3) — every ``key_changes[].<field>`` the implementer
    prompt cites is a field the plan data model defines.

    The prompt used to read ``key_changes[].file`` while the skeleton defined
    strings and the synthesizer emitted ``paths``: an agent following its
    prompt found no file to verify and no path to write. The field names are
    read from ``plan_convergence.KEY_CHANGE_FIELDS`` — the one shape the plan
    contract enforces, staging reads and the envelope's obligations carry —
    so a renamed field is a red test here, not a silent no-op in the agent.
    """

    _CITATION = re.compile(r"key_changes\[\]\.([A-Za-z_]+)")
    # A `key_changes:` YAML example inside a code fence: the entry lines that
    # follow it (`  - field: …` / `    field: …`) until the fence closes or the
    # indentation returns to the key's own level.
    _YAML_BLOCK = re.compile(r"^key_changes:\n((?:[ \t]+.*\n)+)", re.MULTILINE)
    _YAML_FIELD = re.compile(r"^[ \t]+-?[ \t]*([A-Za-z_]+):", re.MULTILINE)
    # Both files the implementer is told to Read as its SSoT: the residue the
    # ARIA-HIGH-104 verifier found (`- file:`) sat in the shared contract,
    # which the first version of this pin never opened.
    _PROMPT_FILES = (_AGENT_FILE, _SHARED_CONTRACT_FILE)

    def _cited_fields(self, body: str) -> set[str]:
        cited = set(self._CITATION.findall(body))
        for block in self._YAML_BLOCK.findall(body):
            cited.update(self._YAML_FIELD.findall(block))
        return cited

    def test_every_cited_key_change_field_exists(self) -> None:
        from aria_kernel.plan_convergence import KEY_CHANGE_FIELDS

        cited_anywhere: set[str] = set()
        for path in self._PROMPT_FILES:
            body = path.read_text(encoding="utf-8")
            cited = self._cited_fields(body)
            with self.subTest(file=path.name):
                self.assertTrue(cited, f"{path.name} cites no key_changes[] field at all")
                self.assertEqual(
                    cited - set(KEY_CHANGE_FIELDS), set(),
                    f"{path.name} cites key_changes[] fields the data model lacks: "
                    f"{sorted(cited - set(KEY_CHANGE_FIELDS))}; KEY_CHANGE_FIELDS={KEY_CHANGE_FIELDS}",
                )
            cited_anywhere |= cited
        self.assertIn("paths", cited_anywhere)

    def test_the_yaml_scan_reads_an_example_the_way_the_residue_was_written(self) -> None:
        # The scan has to see the exact shape that evaded the first pin, or a
        # green run here proves nothing about the shared contract.
        residue = "```\nkey_changes:\n  - file: .claude/agents/aria-implementer.md\n    description: relax\n```\n"
        self.assertEqual(self._cited_fields(residue), {"file", "description"})
        current = "```yaml\nkey_changes:\n  - id: kc-1\n    description: d\n    paths: [a.ts]\n```\n"
        self.assertEqual(self._cited_fields(current), {"id", "description", "paths"})

    def test_the_plan_contract_refuses_the_field_the_prompt_used_to_cite(self) -> None:
        import tempfile

        from aria_kernel.plan_contract import REASON_KEY_CHANGE_SHAPE, plan_contract_violations

        with tempfile.TemporaryDirectory() as tmp:
            violations = plan_contract_violations(
                {"architectural_tier": 1, "validation_commands": [],
                 "key_changes": [{"file": "apps/x.ts", "description": "d"}, "a string step",
                                 {"id": "k", "description": "d", "paths": ["apps/x.ts"]}]},
                base_dir=Path(tmp) / "aria-tools",
            )
        self.assertEqual(len(violations), 1)
        self.assertTrue(violations[0].startswith(f"{REASON_KEY_CHANGE_SHAPE}:key_changes[0]"))
        self.assertIn("unknown field(s) ['file']", violations[0])


class TestV9ImplementerPromptCitesRealKernelCommands(unittest.TestCase):
    """ARIA-HIGH-104 verifier — the prompt told the agent to record runs via
    `validation-run submit`, a subcommand the kernel CLI has never had; the
    one recording path is `apply gate`. Every command the implementer prompt
    and the shared contract cite — spelled `python3 -m aria_kernel <group>
    <sub>` OR bare, the way the residue read ("each recorded via
    validation-run submit") — is resolved through `cli.build_parser()`'s own
    subparser tree, so a renamed or invented subcommand is a red test here
    rather than a step the agent cannot take. The round-2 re-verifier found
    the first version of this pin scanning the qualified form only: it was
    green over the very line it was written for."""

    # `python3 -m aria_kernel` followed by one or two bare words (a group and
    # its subcommand); a line break inside a backtick span is one space.
    _CITATION = re.compile(r"python3 -m aria_kernel\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?")
    # A bare citation: a group-shaped token (a real CLI group, or a
    # hyphenated lowercase name — the CLI's own group spelling, and how the
    # residue's `validation-run` read) followed by one of the verbs an agent
    # is told to run to WRITE into the kernel. Plain prose ("the triple
    # gate", "the merge gate") has neither a group nor a hyphen before the
    # verb and is not a citation.
    _RECORDING_VERBS = ("submit", "create", "gate", "record", "claim")
    _BARE_CITATION = re.compile(
        r"(?<![\w./-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s+(" + "|".join(_RECORDING_VERBS) + r")(?![\w-])"
    )

    @staticmethod
    def _subcommands(parser) -> dict[str, object]:
        import argparse

        for action in parser._actions:
            if isinstance(action, argparse._SubParsersAction):
                return dict(action.choices)
        return {}

    @classmethod
    def _groups(cls) -> dict[str, object]:
        from aria_kernel.cli import build_parser

        return cls._subcommands(build_parser())

    @classmethod
    def _cited(cls, body: str, groups: dict[str, object]) -> set[tuple[str, str | None]]:
        """Every command the text cites, qualified or bare."""
        flat = " ".join(body.split())
        cited: set[tuple[str, str | None]] = set(cls._CITATION.findall(flat))
        for name, verb in cls._BARE_CITATION.findall(flat):
            if name in groups or "-" in name:
                cited.add((name, verb))
        return cited

    @classmethod
    def _unresolved(cls, body: str, groups: dict[str, object]) -> list[str]:
        """The cited commands the parser tree does not have."""
        missing = []
        for group, sub in sorted(cls._cited(body, groups), key=lambda pair: (pair[0], pair[1] or "")):
            if group not in groups:
                missing.append(f"{group} {sub}".strip() + " (no such CLI group)")
            elif sub and sub not in cls._subcommands(groups[group]):
                missing.append(f"{group} {sub} (no such subcommand of {group})")
        return missing

    def test_every_cited_subcommand_exists(self) -> None:
        groups = self._groups()
        cited_anywhere: set[tuple[str, str | None]] = set()
        for path in (_AGENT_FILE, _SHARED_CONTRACT_FILE):
            body = path.read_text(encoding="utf-8")
            with self.subTest(file=path.name):
                self.assertEqual(self._unresolved(body, groups), [])
            cited_anywhere |= self._cited(body, groups)
        self.assertTrue(cited_anywhere, "the implementer prompt cites no kernel CLI command at all")
        self.assertIn(("apply", "gate"), cited_anywhere)

    def test_the_recording_verbs_are_subcommands_the_cli_has(self) -> None:
        # The verb list cannot drift from the CLI: each is a real subcommand
        # of some group, so a renamed verb is a red test, not a dead scan.
        groups = self._groups()
        verbs = {sub for group in groups.values() for sub in self._subcommands(group)}
        self.assertEqual(set(self._RECORDING_VERBS) - verbs, set())

    def test_the_scan_sees_the_citation_that_was_wrong(self) -> None:
        groups = self._groups()
        qualified = "Record each run via `python3 -m aria_kernel\n   validation-run submit`."
        self.assertEqual(self._unresolved(qualified, groups), ["validation-run submit (no such CLI group)"])
        # The pristine line, spelled the way the agent file read it: bare,
        # broken across a line, no backticks — the residue the qualified scan
        # never saw.
        pristine = (
            "`npm run type-check` and affected tests, each recorded via\n"
            "   validation-run submit — the triple gate blocks\n"
            "   (`triple_gate_hygiene_run_missing:<dimension>`) without all three."
        )
        self.assertEqual(self._cited(pristine, groups), {("validation-run", "submit")})
        self.assertEqual(self._unresolved(pristine, groups), ["validation-run submit (no such CLI group)"])
        # The corrected line resolves; prose around a verb is not a citation.
        current = (
            "The one recorded run — the evidence the merge gate's hygiene battery joins on — is the "
            "apply gate's (step 8b); `python3 -m aria_kernel apply gate --proposal-id <id>`; "
            "the triple gate blocks; raw `gh pr create` is NOT an alternative."
        )
        self.assertEqual(self._cited(current, groups), {("apply", "gate"), ("pr", "create")})
        self.assertEqual(self._unresolved(current, groups), [])
        # An invented subcommand of a real group is caught too.
        self.assertEqual(self._unresolved("run `apply record` first", groups), ["apply record (no such subcommand of apply)"])


class TestV9ImplementerPromptCommandsAreDecidedByThePolicy(unittest.TestCase):
    """ARIA-HIGH-124 (round 2) — every command the implementer is TOLD TO RUN
    is admitted by the command policy the PreToolUse hook enforces.

    The lane's step 3 (`git branch --show-current`, the replacement for the
    `git switch -c` the previous verifier refused for exactly this reason)
    and the pre-existing step 8 (`git show --format= --patch HEAD`) were both
    BashAllowlistMiss: the first command of every production implementation
    was refused by the hook, and the prompt told the agent any mismatch is
    `reason_class=evidence` and STOP. Nothing caught it because the
    end-to-end pins' scripted agent runs git directly, never through the
    hook. This pin walks every backticked command of the agent prompt, the
    shared safety contract and the kernel-rendered implementation prompt
    through `verify_bash_command_allowed`. The commands the prompt names as
    NOT the agent's are declared in one table, verified both ways: each is
    named by some surface (a stale entry is red) and each is refused in the
    shape the table says (a deny by name, or an allowlist miss where the
    prose says "not admitted"); everything else is admitted.
    """

    _COMMAND_WORDS = ("git", "gh", "python3", "python", "npx", "npm", "nx", "pytest", "node", "cargo", "eslint", "prettier")
    _FENCE = re.compile(r"```.*?```", re.S)
    _SPAN = re.compile(r"`([^`]+)`")
    _NESTED = re.compile(r"\((" + "|".join(_COMMAND_WORDS) + r")\s([^()]*)\)")
    _PLACEHOLDER = re.compile(r"<[^<>]+>")
    # The commands the prompts name as the EXECUTOR's or as refused — never
    # the agent's to run — and the refusal the policy must answer with:
    # `family:rule` of the deny rule that names it, or None for an
    # allowlist miss (the prose says "not admitted" / "allowlist miss").
    _NOT_THE_AGENTS: dict[str, str | None] = {
        "git push": "kernel_authority:git_push_any",
        "python3 -m aria_kernel": "kernel_authority:kernel_cli",
        "python3 -m aria_kernel apply gate": "kernel_authority:kernel_cli",
        "gh pr merge": "gh_merge:gh_pr_merge",
        "gh pr create": None,
        "git switch": None,
        # The hazard `gh_api_scope_violation` names, not a command to run.
        "gh api": None,
        # ARIA-HIGH-124 (round 4) — the commit shape the prompt names as
        # refused: a signing key of the agent's own.
        "git commit -m x --gpg-sign=<key>": "commit_identity:git_commit_foreign_option",
        # ARIA-HIGH-147 — the hand recomputation the prompt and the contract
        # forbid by name: the authenticity obligation goes to `plan_verify`.
        "python3 -c": None,
    }

    @classmethod
    def _commands_named(cls, text: str) -> list[str]:
        """Every backticked command line (a command word plus at least one
        argument) in ``text``, fenced code blocks excluded, a command nested
        in a call such as `verify_no_secret_in_diff(git diff --staged)`
        included, a trailing ellipsis (a prefix spelled as such) dropped."""
        found: list[str] = []
        for span in cls._SPAN.findall(cls._FENCE.sub(" ", text)):
            flat = " ".join(span.split())
            for candidate in (flat, *(f"{word} {rest}" for word, rest in cls._NESTED.findall(flat))):
                tokens = candidate.split()
                while tokens and tokens[-1] in ("…", "..."):
                    tokens.pop()
                if len(tokens) >= 2 and tokens[0] in cls._COMMAND_WORDS:
                    found.append(" ".join(tokens))
        return list(dict.fromkeys(found))

    @classmethod
    def _verdict(cls, command: str) -> tuple[str, str]:
        """(kind, detail): ``allowed``, ``denied`` + `family:rule`, or ``miss``.
        A `<placeholder>` is a value the agent fills in."""
        from aria_kernel.implementation_safety import BashAllowlistMiss, BashDenylistHit, verify_bash_command_allowed

        argv = cls._PLACEHOLDER.sub("x", command).split()
        try:
            verify_bash_command_allowed(argv)
        except BashDenylistHit as refused:
            named = re.search(r"DENY rule hit: ([a-z_]+:[a-z_]+)", str(refused))
            return "denied", named.group(1) if named else str(refused)
        except BashAllowlistMiss:
            return "miss", ""
        return "allowed", ""

    @staticmethod
    def _rendered_prompt() -> str:
        from aria_kernel.cross_review_bridge import _implementation_suggested_prompt

        return _implementation_suggested_prompt(
            converged_plan_revision_id="rev-1", converged_plan_text="{}", cross_review_revision_id="cr-1",
            cross_review_summary_text="{}",
            implementation_ids={"proposal_id": "p-1", "change_id": "c-1", "branch": "aria-impl-0123abcd", "base_sha": "0" * 40},
        )

    def _surfaces(self) -> dict[str, str]:
        return {
            _AGENT_FILE.name: _AGENT_FILE.read_text(encoding="utf-8"),
            _SHARED_CONTRACT_FILE.name: _SHARED_CONTRACT_FILE.read_text(encoding="utf-8"),
            "cross_review_bridge._implementation_suggested_prompt": self._rendered_prompt(),
        }

    def test_every_command_the_agent_is_told_to_run_is_admitted(self) -> None:
        named_anywhere: set[str] = set()
        for surface, text in self._surfaces().items():
            for command in self._commands_named(text):
                named_anywhere.add(command)
                kind, detail = self._verdict(command)
                with self.subTest(surface=surface, command=command):
                    if command in self._NOT_THE_AGENTS:
                        expected = self._NOT_THE_AGENTS[command]
                        if expected is None:
                            self.assertEqual(kind, "miss", f"the prose says {command!r} is not admitted; the policy says {kind} {detail}")
                        else:
                            self.assertEqual((kind, detail), ("denied", expected))
                    else:
                        self.assertEqual((kind, detail), ("allowed", ""),
                                         f"the prompt tells the agent to run {command!r}; the hook would answer {kind} {detail}")
        # The table cannot go stale: every entry is named by some surface,
        # and the agent's own steps name at least these.
        self.assertEqual(set(self._NOT_THE_AGENTS) - named_anywhere, set())
        self.assertTrue({"git branch --show-current", "git rev-parse HEAD", "git commit -m <subject> -m <body> -m <trailer>",
                         "git diff --staged"} <= named_anywhere, named_anywhere)
        # (round 4) the contract's own commit spelling is admitted with its
        # placeholders filled (the one-`-m` spelling that carries the trailer
        # as the last body line is pinned through the hook's own lexer in
        # `test_phase_v12_b_command_policy`).
        self.assertEqual(self._verdict("git commit -m <subject> -m <body> -m <trailer>"), ("allowed", ""))

    def test_the_prompt_names_no_kernel_function_as_a_command_of_the_agents(self) -> None:
        # ARIA-HIGH-124 (round 6) — the round-5 prompt told the agent to run
        # `implementation_safety.verify_no_secret_in_diff(...)`: a Python
        # function of the kernel the sandbox cannot execute, the same shape
        # as the `emit_change_committed(...)` the round-2 contract named.
        # The agent READS its diff; the executor's delivery runs the scan
        # over the branch's whole patch and refuses a hit by name.
        text = _AGENT_FILE.read_text(encoding="utf-8")
        self.assertNotIn("verify_no_secret_in_diff(", text)
        self.assertNotIn("emit_change_committed(", text)
        self.assertIn("implementation_delivery_refused:result_admissible", text)
        named = self._commands_named(text)
        self.assertIn("git diff --staged", named)
        self.assertIn("git diff <implementation_ids.base_sha> HEAD", named)
        self.assertEqual(self._verdict("git diff <implementation_ids.base_sha> HEAD"), ("allowed", ""))

    def test_the_scan_sees_the_commands_that_were_refused(self) -> None:
        # The two lines as the round-1 prompt spelled them: a nested call
        # and a plain span, across a line break.
        step_three = "3. **Confirm you stand on the kernel-made branch before edits**:\n   `git branch --show-current` prints `<implementation_ids.branch>` and\n   `git rev-parse HEAD` prints `<implementation_ids.base_sha>`"
        step_eight = "8. **Secret-scan committed patch** using\n   `implementation_safety.verify_no_secret_in_diff(git show --format= --patch HEAD)`"
        self.assertEqual(self._commands_named(step_three), ["git branch --show-current", "git rev-parse HEAD"])
        self.assertEqual(self._commands_named(step_eight), ["git show --format= --patch HEAD"])
        # Step 8's old spelling is still an allowlist miss: the pin was red
        # on it, and the prompt now scans the whole branch's `git diff`.
        self.assertEqual(self._verdict("git show --format= --patch HEAD"), ("miss", ""))
        # A fenced code block is not a command the agent is told to run, a
        # bare program name is not a command line, an ellipsis is a prefix.
        self.assertEqual(self._commands_named("```python\nverify_bash_command_allowed([\"curl\"])\n```"), [])
        self.assertEqual(self._commands_named("`gh` is admitted for READS only"), [])
        self.assertEqual(self._commands_named("every `python3 -m aria_kernel …` is refused"), ["python3 -m aria_kernel"])
        # The bounded `git branch` read admits exactly the step's spelling.
        self.assertEqual(self._verdict("git branch --show-current"), ("allowed", ""))
        self.assertEqual(self._verdict("git branch -D main"), ("miss", ""))
        self.assertEqual(self._verdict("git branch aria-impl-0123abcd"), ("miss", ""))


class TestV9ImplementerRunnerSelectionIsDerived(unittest.TestCase):
    """I-V9-IMPL-03 (ORPHAN-HIGH-728) — the agent above only ever runs if a
    runner selects it, and that selection must READ the profile table rather
    than restate it.

    The behaviour is pinned in `tests/test_runtime_profile.py` by revoking
    `pr_create` in the table and watching the factory demote. This is the
    structural half: a factory that compares profile NAMES is a second copy
    of the authority mapping regardless of whether today's copy happens to
    agree, and the copy is what drifted — `strict` refused implementation
    while the table granted it `pr_create`/`pr_open`, so the whole V9 agent
    contract this file guards was unreachable from every profile the nightly
    lane ever ran under.
    """

    def _factory_ast(self):
        import ast

        from aria_kernel.cycle_phases import implementer

        tree = ast.parse(Path(implementer.__file__).read_text(encoding="utf-8"))
        return next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "select_v9_implementation_runner"
        )

    def test_factory_reads_the_permission_table(self):
        """The factory must SUBSCRIPT `ACTION_PERMISSIONS`, structurally.

        The import line this used to assert as text was red on a reformat
        and green on an import that nothing then used. What makes the
        selection derived is the READ, so the read is what is matched — by
        name in the factory's own tree, not by the shape of the line that
        brought the name into scope.
        """
        import ast

        subscripted = {
            node.value.id
            for node in ast.walk(self._factory_ast())
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
        }
        self.assertIn(
            "ACTION_PERMISSIONS", subscripted,
            "runner selection does not read the profile table",
        )

    def test_factory_does_not_test_profile_names(self):
        """No comparison of `profile` against NAME LITERALS in the factory.

        Equality is one shape of the defect; membership in a literal tuple
        (`profile in ("strict", "autonomous")`) is the same defect with a
        second name in it, and the first version of this pin walked straight
        past it — a reviewer re-introduced exactly that drift and this test
        stayed green. Both forms are rejected now, and the permitted form
        (`profile in ACTION_PERMISSIONS[...]`) survives untouched because its
        right-hand side is a subscript of the SSoT, not a literal anyone can
        edit here.
        """
        import ast

        literal_containers = (ast.Tuple, ast.List, ast.Set)
        offenders: list[str] = []
        for node in ast.walk(self._factory_ast()):
            if not (
                isinstance(node, ast.Compare)
                and isinstance(node.left, ast.Name)
                and node.left.id == "profile"
            ):
                continue
            for operator, comparator in zip(node.ops, node.comparators):
                if isinstance(operator, (ast.Eq, ast.NotEq)) and isinstance(
                    comparator, ast.Constant,
                ):
                    offenders.append(f"== {comparator.value!r}")
                elif isinstance(operator, (ast.In, ast.NotIn)) and isinstance(
                    comparator, literal_containers,
                ):
                    offenders.append(
                        "in "
                        + repr([
                            element.value for element in comparator.elts
                            if isinstance(element, ast.Constant)
                        ])
                    )
        self.assertEqual(
            offenders, [],
            "runner selection compares the profile NAME "
            f"({offenders}); derive it from ACTION_PERMISSIONS instead "
            "(ORPHAN-HIGH-728)",
        )

    def test_the_refusing_variant_is_gone(self):
        """İ2 — a runner that refuses implementation under a profile granted
        `pr_create` had no producer that could ever satisfy it. Removed with
        reasoning in `cycle_phases/implementer.py`; a re-export means it came
        back."""
        from aria_kernel import cycle_phases

        self.assertFalse(hasattr(cycle_phases, "StrictV9ImplementationRunner"))


class TestV9ImplementerHashRegistry(unittest.TestCase):
    """I-V9-IMPL-02 — sha256 of aria-implementer.md pinned by
    IMMUTABLE_AGENT_FILE_HASH_REGISTRY in implementation_safety.

    V9.1 lands the agent file. V9.0-D shipped the empty registry; this
    invariant verifies the registry has been (or will be) populated
    with this agent's hash on a subsequent commit. For V9.1 the
    registry remains empty (no kernel-side runtime gate yet); the
    pinning lands in V9.6 when auto_merge_runner gates on
    file-hash drift.
    """

    def test_implementer_hash_computable(self):
        """The agent body MUST be readable + sha256-computable —
        ensures the registry CAN be populated on a subsequent commit."""
        body = _AGENT_FILE.read_bytes()
        sha = hashlib.sha256(body).hexdigest()
        self.assertEqual(len(sha), 64, "sha256 hexdigest format")
        self.assertTrue(re.match(r"^[0-9a-f]{64}$", sha))

    def test_immutable_registry_shape(self):
        """V9.0-D registry shape verified — it's a dict[str, str].
        Population happens later (V9.6 wire-up); shape is the
        load-bearing V9.1 invariant."""
        from aria_kernel import implementation_safety as _is
        self.assertIsInstance(_is.IMMUTABLE_AGENT_FILE_HASH_REGISTRY, dict)


if __name__ == "__main__":
    unittest.main()
