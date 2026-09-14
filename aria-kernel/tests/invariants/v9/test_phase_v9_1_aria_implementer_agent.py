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
        self.assertIn("## Network Egress Prohibition", self.contract_body)
        self.assertIn("--unshare-net", self.contract_body)
        self.assertIn("aria-impl-", self.contract_body)

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
        self.assertIn("[ARIA-AUTO]", self.body)

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
        """details.implementation field set documented — the AGENT's fields.

        ``signer_key_fp`` is not among them (ARIA-HIGH-115): the executor
        that holds the key stamps it, and the contract says so by name
        instead of asking the agent for a value it cannot know.
        """
        for field in (
            "branch", "pr_number", "diff_hash", "branch_tip_sha",
            "base_branch_sha", "validation_results",
        ):
            self.assertIn(
                f'"{field}"',
                self.contract_body,
                f"output envelope missing {field}",
            )
        self.assertNotIn('"signer_key_fp"', self.contract_body,
                         "the agent is not asked for the executor's fingerprint")
        self.assertIn("`signer_key_fp` is NOT yours to report", self.contract_body)
        self.assertIn("implementation_signer_fp_overridden", self.contract_body)


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
