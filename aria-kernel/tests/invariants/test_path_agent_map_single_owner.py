"""SE-2 — ONE path -> Lane-A agent map, and the reviewer set it derives.

WHY. Two kernel tables answer "which Lane-A agent reviews a change to this
path". The orchestrator routing table
(``.claude/shared/orchestrator-routing-table.md``, read by
``agent_routing.load_routing_table`` / ``recommended_agents_for_project``) is
the table the orchestrator dispatches from. ``specialist_review_runner``
carries a second one in code, ``_DOMAIN_TOUCH_MAP`` with its accessor
``domain_touch_map()``, and the merge-time expert set for ARIA's own
implementation PRs (``select_specialist_agents``, ``expert_review_gate``) is
chosen from that copy. A third path -> agent answer reads the frontmatter
``scope_globs`` of every agent (``agent_priors.related_agents_for_paths``,
called by ``capability_gap`` and ``ci``). The three disagree today: a change
under ``apps/gateway-api/`` is reviewed by ``performance-expert`` at merge time
and by nobody of that name in the orchestrator's table, and a
``libs/backend-common/src/nats/`` change goes to ``platform-kernel-expert``
in one and to ``data-expert`` in the other. Service-expertise PLAN.md §2 row
"Path -> owning Lane-A agent" (SE-2, SO-11) keeps the routing table through
``agent_routing`` and deletes the others with every caller converted.

WHAT THIS PINS (PLAN.md §8 SE-2 red tests (i) and (iii); DECISIONS.md Q4, Q12).

(i) No path -> agent table in ``aria_kernel`` and no kernel routing reads
    ``scope_globs``:
    * Detection is STRUCTURAL: a dict literal, or a sequence of 2-tuples,
      that pairs repository path strings with names of agents defined under
      ``.claude/agents/`` (in either direction) is a path -> agent table.
      The one table lives in ``.claude/shared/``, so none is allowed in the
      kernel package. The detector is proved on synthetic samples first, so
      a green run is not a vacuous one.
    * ``_DOMAIN_TOUCH_MAP``, ``domain_touch_map`` and
      ``related_agents_for_paths`` are gone, and no kernel module names
      them (no re-derived accessor). ``service_dimension`` keeps no
      path -> agent function (``owning_agent_domains_for_paths`` moves into
      ``agent_routing``; its new name there is the implementer's).
    * ``scope_globs`` is read only by the genesis DRAFT owners
      (``agent_genesis``, ``draft_intent``, ``draft_pii_filter``): it is the
      drafted agent's evidence boundary (``REQUIRED_DRAFT_FIELDS``), not a
      routing input.
    * The different concepts stay (PLAN §2 item 3): the Tier-1 profile gate
      and the cross-cutting specialists are not path-keyed.

(iii) A LITERAL expected reviewer set per top-level surface equals the set
    the one owner derives (``recommended_agents_for_project`` over the live
    routing table, primary ∪ also-notify). The surfaces are the ones the
    deleted touch map keyed the merge-time set by. The literal is the routing
    table at the branch base plus the agents owner decision Q4 adds FIRST,
    so the merge-time reviewer set does not narrow silently:
      - ``compliance-expert`` on auth (the base table already yields it for
        ``apps/auth-service`` through its privacy/gdpr sub-area rows);
      - ``performance-expert`` on ``apps/gateway-api``;
      - ``accessibility-auditor`` on ``web`` (and so on
        ``web/apps/aquamobil``, which the touch map's ``web/`` key covered);
      - ``platform-kernel-expert`` kept beside ``data-expert`` on the
        ``nats/`` surfaces (``libs/backend-common/src/nats`` and
        ``infrastructure/nats``): Q4 lists it among the LOST agents to add,
        and "must not narrow" keeps it. The program lead kept it there (not a
        move to ``data-expert``); since the owner counts a sub-area row for a
        broader surface, ``infrastructure`` derives it too.
    Every other agent the deleted touch map named and the routing table does
    not is listed by name in ``_NARROWED_WITHOUT_A_Q4_ENTRY``; the test pins
    that exactly these, and nothing else, drop. Q4 did not name them, so the
    list is a visible record for the owner, raised with the program lead as
    a finding by the SE-2 test writer; it is not a decision taken here.

RED AT THE BRANCH BASE, each by assertion (no new import): the structural
detector finds ``specialist_review_runner._DOMAIN_TOUCH_MAP``; the names are
still referenced; ``agent_priors.related_agents_for_paths`` reads
``scope_globs``; and the derived set lacks the Q4 agents on gateway, web and
the nats surfaces. The guards (detector self-test, the concepts that stay,
the draft field) are green at base by design.
"""
from __future__ import annotations

import ast
import functools
import re
import unittest
from pathlib import Path

from aria_kernel import agent_genesis, service_dimension, specialist_review_runner
from aria_kernel.agent_routing import load_routing_table, recommended_agents_for_project

_KERNEL_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = _KERNEL_ROOT.parent
_KERNEL = _KERNEL_ROOT / "aria_kernel"

# A repository path or path glob as a table key/value spells it:
# ``apps/auth-service/``, ``web/``, ``.github/workflows/``, ``apps/*/src/**``.
_PATH_LITERAL = re.compile(r"^[\w.*{}-]+(?:/[\w.*{},-]*)+$")
_FRONTMATTER_NAME = re.compile(r"(?m)^name:\s*\"?([^\s\"]+)\"?\s*$")

# The deleted names: no definition and no reference may remain in the kernel.
_DELETED_NAMES = frozenset({"_DOMAIN_TOUCH_MAP", "domain_touch_map", "related_agents_for_paths"})

# The genesis draft owners: ``scope_globs`` is a draft field there
# (``agent_genesis.REQUIRED_DRAFT_FIELDS``), the drafted agent's evidence boundary.
_DRAFT_FIELD_OWNERS = frozenset({"agent_genesis", "draft_intent", "draft_pii_filter"})


def _module_name(path: Path) -> str:
    return ".".join(path.relative_to(_KERNEL).with_suffix("").parts)


@functools.cache
def _kernel_modules() -> tuple[tuple[str, ast.Module], ...]:
    return tuple((_module_name(path), ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
            for path in sorted(_KERNEL.rglob("*.py")))


def _agent_names() -> frozenset[str]:
    """Every agent defined under ``.claude/agents/``: frontmatter ``name`` and file stem."""
    names: set[str] = set()
    for path in (_REPO_ROOT / ".claude" / "agents").rglob("*.md"):
        if path.name == "README.md":
            continue
        names.add(path.stem)
        match = _FRONTMATTER_NAME.search(path.read_text(encoding="utf-8", errors="replace"))
        if match:
            names.add(match.group(1))
    return frozenset(names)


def _strings(node: ast.AST | None) -> list[str] | None:
    """A string constant, or a tuple/list/set of only string constants, as a list."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)) and node.elts and all(
            isinstance(element, ast.Constant) and isinstance(element.value, str) for element in node.elts):
        return [element.value for element in node.elts]
    return None


def _pairs_path_with_agent(left: ast.AST | None, right: ast.AST | None, agents: frozenset[str]) -> bool:
    """Whether one entry pairs path literals with agent names, in either direction."""
    keys, values = _strings(left), _strings(right)
    if not keys or not values:
        return False

    def paths(items: list[str]) -> bool:
        return all(_PATH_LITERAL.match(item) for item in items)

    def names_agents(items: list[str]) -> bool:
        return any(item in agents for item in items)

    return (paths(keys) and names_agents(values)) or (names_agents(keys) and paths(values))


def path_agent_tables(tree: ast.AST, agents: frozenset[str]) -> list[int]:
    """Line numbers of every path -> agent table literal in ``tree``."""
    lines: list[int] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            if any(_pairs_path_with_agent(key, value, agents) for key, value in zip(node.keys, node.values)):
                lines.append(node.lineno)
        elif isinstance(node, (ast.Tuple, ast.List)) and node.elts and all(
                isinstance(element, ast.Tuple) and len(element.elts) == 2 for element in node.elts):
            if any(_pairs_path_with_agent(element.elts[0], element.elts[1], agents) for element in node.elts):
                lines.append(node.lineno)
    return lines


def _scope_globs_reads(tree: ast.AST) -> list[int]:
    """Lines that READ ``scope_globs``: ``x.get("scope_globs")``, ``getattr(x, "scope_globs")``,
    ``x["scope_globs"]`` and ``x.scope_globs`` in load context. Building a dict
    with that key, or declaring the field, is not a read."""
    lines: list[int] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) \
                and node.args[0].value == "scope_globs":
            if (isinstance(node.func, ast.Attribute) and node.func.attr in ("get", "pop", "setdefault")) or (
                    isinstance(node.func, ast.Name) and node.func.id == "getattr"):
                lines.append(node.lineno)
        elif isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load) \
                and isinstance(node.slice, ast.Constant) and node.slice.value == "scope_globs":
            lines.append(node.lineno)
        elif isinstance(node, ast.Attribute) and node.attr == "scope_globs" and isinstance(node.ctx, ast.Load):
            lines.append(node.lineno)
    return lines


def _referenced_names(tree: ast.AST) -> list[tuple[int, str]]:
    """Every identifier a module defines, imports or references (no comments, no docstrings)."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            found.append((node.lineno, node.id))
        elif isinstance(node, ast.Attribute):
            found.append((node.lineno, node.attr))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.append((node.lineno, node.name))
        elif isinstance(node, ast.alias):
            found.append((getattr(node, "lineno", 0), node.name.rpartition(".")[2]))
    return found


class TheDetectorSeesATable(unittest.TestCase):
    """The structural detector flags the shapes a path -> agent table takes (guard, green at base)."""

    _AGENTS = frozenset({"farm-expert", "infra-expert"})

    def _flagged(self, source: str) -> bool:
        return bool(path_agent_tables(ast.parse(source), self._AGENTS))

    def test_a_prefix_to_agents_dict_is_a_table(self) -> None:
        self.assertTrue(self._flagged('M = {"apps/farm-service/": ("farm-expert",)}'))

    def test_a_glob_to_one_agent_dict_is_a_table(self) -> None:
        self.assertTrue(self._flagged('M = {".github/workflows/**": "infra-expert"}'))

    def test_an_agent_to_paths_dict_is_a_table(self) -> None:
        self.assertTrue(self._flagged('M = {"farm-expert": ["apps/farm-service/**"]}'))

    def test_a_sequence_of_pairs_is_a_table(self) -> None:
        self.assertTrue(self._flagged('M = (("apps/farm-service/", ("farm-expert",)), ("web/", "infra-expert"))'))

    def test_a_table_inside_a_function_is_a_table(self) -> None:
        self.assertTrue(self._flagged('def f():\n    return {"apps/farm-service/": ["farm-expert"]}\n'))

    def test_a_path_to_something_else_is_not_a_table(self) -> None:
        self.assertFalse(self._flagged('M = {"apps/farm-service/": "ledger", "web/": ("tsx",)}'))

    def test_agents_without_paths_are_not_a_table(self) -> None:
        self.assertFalse(self._flagged('M = {"tier1": ("farm-expert", "infra-expert")}'))


class NoSecondPathToAgentMapInTheKernel(unittest.TestCase):
    """(i) The routing table, read through ``agent_routing``, is the one path -> agent map."""

    maxDiff = None

    def test_no_kernel_module_holds_a_path_to_agent_table(self) -> None:
        agents = _agent_names()
        self.assertIn("farm-expert", agents, "the agent roster under .claude/agents/ was not read")
        found = [f"aria_kernel/{name.replace('.', '/')}.py:{line}"
                 for name, tree in _kernel_modules() for line in path_agent_tables(tree, agents)]
        self.assertEqual(
            found, [],
            "a path -> agent table lives in aria_kernel; the one map is "
            ".claude/shared/orchestrator-routing-table.md read through agent_routing (PLAN §2, SE-2)")

    def test_the_touch_map_and_its_accessor_are_deleted(self) -> None:
        self.assertFalse(hasattr(specialist_review_runner, "_DOMAIN_TOUCH_MAP"),
                         "specialist_review_runner._DOMAIN_TOUCH_MAP is a second path -> agent map")
        self.assertFalse(hasattr(specialist_review_runner, "domain_touch_map"),
                         "domain_touch_map() is deleted with no re-derived accessor")

    def test_no_kernel_module_names_a_deleted_routing_name(self) -> None:
        found = sorted({f"aria_kernel/{module.replace('.', '/')}.py:{line}:{name}"
                        for module, tree in _kernel_modules()
                        for line, name in _referenced_names(tree) if name in _DELETED_NAMES})
        self.assertEqual(
            found, [],
            "every caller converts to the routing table owner (agent_routing); "
            "related_agents_for_paths is deleted as a routing input")

    def test_service_dimension_keeps_no_path_to_agent_function(self) -> None:
        self.assertFalse(
            hasattr(service_dimension, "owning_agent_domains_for_paths"),
            "owning_agent_domains_for_paths moves into agent_routing (PLAN §2, SE-2 item 1)")
        found = sorted({f"aria_kernel/{module.replace('.', '/')}.py:{line}"
                        for module, tree in _kernel_modules()
                        for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                        and (node.module or "").endswith("service_dimension")
                        for alias in node.names if alias.name == "owning_agent_domains_for_paths"
                        for line in (node.lineno,)})
        self.assertEqual(found, [], "a caller still takes its reviewing agents from service_dimension")

    def test_no_kernel_routing_reads_scope_globs(self) -> None:
        found = [f"aria_kernel/{module.replace('.', '/')}.py:{line}"
                 for module, tree in _kernel_modules() if module not in _DRAFT_FIELD_OWNERS
                 for line in _scope_globs_reads(tree)]
        self.assertEqual(
            found, [],
            "scope_globs is the genesis draft's evidence boundary, not a routing input; "
            "only the draft owners read it (PLAN §2, SE-2 item 2)")


class TheDifferentConceptsStay(unittest.TestCase):
    """Guards (green at base): SE-2 deletes the path -> agent copies, not these."""

    def test_scope_globs_stays_a_draft_field(self) -> None:
        self.assertIn("scope_globs", agent_genesis.REQUIRED_DRAFT_FIELDS)

    def test_the_tier_one_gate_and_the_cross_cutting_set_stay(self) -> None:
        self.assertIn("auth-security-expert", specialist_review_runner._TIER_1_SPECIALISTS)
        self.assertIn("performance-expert", specialist_review_runner._CROSS_CUTTING_SPECIALISTS)


# -- (iii) the literal reviewer set per top-level surface ---------------------
# The deleted touch map, copied verbatim from specialist_review_runner at the
# branch base (39c8c9679): the merge-time set SE-2 replaces. It is the
# reference "does not narrow" is measured against, once the original is gone.
_DELETED_TOUCH_MAP: dict[str, frozenset[str]] = {
    "apps/auth-service": frozenset({"auth-security-expert", "compliance-expert"}),
    "apps/farm-service": frozenset({"farm-expert"}),
    "apps/sensor-service": frozenset({"sensor-expert"}),
    "apps/alert-engine": frozenset({"alert-engine-expert"}),
    "apps/billing-service": frozenset({"billing-expert"}),
    "apps/messaging-service": frozenset({"messaging-expert"}),
    "apps/hr-service": frozenset({"hr-expert"}),
    "apps/hydroponics-service": frozenset({"farm-expert"}),
    "apps/ai-service": frozenset({"ai-safety-auditor"}),
    "apps/admin-api-service": frozenset({"admin-expert"}),
    "apps/gateway-api": frozenset({"auth-security-expert", "performance-expert"}),
    "apps/event-store-service": frozenset({"data-expert"}),
    "apps/observability-service": frozenset({"observability-expert"}),
    "libs/backend-common/src/guards": frozenset({"auth-security-expert"}),
    "libs/backend-common/src/security": frozenset({"compliance-expert"}),
    "libs/backend-common/src/audit": frozenset({"audit-trail-completeness-auditor"}),
    "libs/backend-common/src/nats": frozenset({"platform-kernel-expert"}),
    "libs/event-contracts": frozenset({"data-expert", "contract-parity-enforcer"}),
    "platform/libs": frozenset({"platform-kernel-expert"}),
    "web": frozenset({"frontend-expert", "accessibility-auditor"}),
    # ``web/apps/aquamobil/`` also matched the ``web/`` key (prefix match).
    "web/apps/aquamobil": frozenset({"frontend-mobile-development:mobile-developer",
                                     "frontend-expert", "accessibility-auditor"}),
    "sens-api-gateway": frozenset({"edge-expert", "edge-industrial-auditor"}),
    "infrastructure": frozenset({"infra-expert"}),
    # ``infrastructure/nats/`` also matched the ``infrastructure/`` key.
    "infrastructure/nats": frozenset({"platform-kernel-expert", "infra-expert"}),
    "tools/aria-poc": frozenset({"mcp-expert"}),
    "tools/aria-adapters": frozenset({"ai-safety-auditor"}),
    ".github/workflows": frozenset({"infra-expert", "supply-chain-auditor"}),
    "aria-kernel": frozenset({"platform-kernel-expert"}),
}

# Rows the ``apps/*`` routing globs (entities, tenant, gdpr) contribute to every
# app surface under the owner's prefix semantics.
_EVERY_APP = frozenset({
    "audit-trail-completeness-auditor", "auth-security-expert", "compliance-expert", "data-expert",
    "database-reviewer", "gdpr-erasure-executor", "legal-hold-auditor", "multi-tenant-saas-expert",
})

# THE LITERAL (routing table at the branch base + the Q4 additions, marked).
_EXPECTED_REVIEWERS: dict[str, frozenset[str]] = {
    "apps/auth-service": _EVERY_APP | {"security-reviewer"},  # Q4: compliance-expert (already derived)
    "apps/farm-service": _EVERY_APP | {"farm-expert"},
    "apps/sensor-service": _EVERY_APP | {"sensor-expert"},
    "apps/alert-engine": _EVERY_APP | {"alert-engine-expert", "farm-expert", "security-reviewer", "sensor-expert"},
    "apps/billing-service": _EVERY_APP | {"billing-expert", "security-reviewer"},
    "apps/messaging-service": _EVERY_APP | {"messaging-expert"},
    "apps/hr-service": _EVERY_APP | {"hr-expert"},
    "apps/hydroponics-service": _EVERY_APP | {"farm-expert"},
    "apps/ai-service": _EVERY_APP | {"ai-safety-auditor", "messaging-expert"},
    "apps/admin-api-service": _EVERY_APP | {"admin-expert"},
    "apps/gateway-api": _EVERY_APP | {"security-reviewer", "performance-expert"},  # Q4: performance-expert
    "apps/event-store-service": _EVERY_APP | {"observability-expert"},
    "apps/observability-service": _EVERY_APP | {"observability-expert"},
    "libs/backend-common/src/guards": frozenset({
        "auth-security-expert", "data-expert", "multi-tenant-saas-expert", "security-reviewer"}),
    "libs/backend-common/src/security": frozenset({"auth-security-expert", "compliance-expert", "security-reviewer"}),
    "libs/backend-common/src/audit": frozenset({"auth-security-expert"}),
    "libs/backend-common/src/nats": frozenset({"data-expert", "platform-kernel-expert"}),  # Q4: nats/
    "libs/event-contracts": frozenset({"data-expert"}),
    "platform/libs": frozenset({"data-expert", "messaging-expert", "platform-kernel-expert", "security-reviewer"}),
    "web": frozenset({  # Q4: accessibility-auditor
        "admin-expert", "compliance-expert", "farm-expert", "frontend-expert", "hr-expert", "sensor-expert",
        "accessibility-auditor"}),
    "web/apps/aquamobil": frozenset({"frontend-expert", "accessibility-auditor"}),  # Q4: web
    "sens-api-gateway": frozenset({"edge-expert", "security-reviewer"}),
    # The owner counts a sub-area row for a broader surface (prefix rule, as for
    # web, apps/auth-service, platform/libs, infrastructure/monitoring), so the
    # kept infrastructure/nats row reaches infrastructure too (program lead, Q4).
    "infrastructure": frozenset({"infra-expert", "observability-expert", "security-reviewer",
                                 "platform-kernel-expert"}),
    "infrastructure/nats": frozenset({"infra-expert", "security-reviewer", "platform-kernel-expert"}),  # Q4: nats/
    "tools/aria-poc": frozenset(),
    "tools/aria-adapters": frozenset(),
    ".github/workflows": frozenset({"infra-expert", "security-reviewer", "test-runner"}),
    "aria-kernel": frozenset(),
}

# Agents the deleted touch map named that neither the routing table nor a Q4
# entry keeps. Owner decision Q4 named four lost agents; these it did not.
# They are a visible record for the owner (raised as a finding by the SE-2 test
# writer), not a decision taken in this file. ``aria-kernel`` matters most:
# the merge-time Lane-A review of ARIA's own PRs (Q12) gets no domain expert
# for a kernel-only change once the touch map is gone.
_NARROWED_WITHOUT_A_Q4_ENTRY: frozenset[tuple[str, str]] = frozenset({
    ("libs/backend-common/src/audit", "audit-trail-completeness-auditor"),
    ("libs/event-contracts", "contract-parity-enforcer"),
    ("web/apps/aquamobil", "frontend-mobile-development:mobile-developer"),
    ("sens-api-gateway", "edge-industrial-auditor"),
    ("tools/aria-poc", "mcp-expert"),
    ("tools/aria-adapters", "ai-safety-auditor"),
    (".github/workflows", "supply-chain-auditor"),
    ("aria-kernel", "platform-kernel-expert"),
})


def _derived_reviewers(surface: str, routing: list[dict[str, object]]) -> frozenset[str]:
    """The reviewer set the one owner derives for a surface: primary ∪ also-notify."""
    recommended = recommended_agents_for_project(surface, routing)
    return frozenset(recommended["primary"]) | frozenset(recommended["also_notify"])


class TheReviewerSetPerSurfaceIsTheLiteral(unittest.TestCase):
    """(iii) The derived set equals the Q4 literal, and nothing narrows unnamed."""

    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.routing = load_routing_table(_REPO_ROOT)

    def test_the_routing_table_was_read(self) -> None:
        self.assertTrue(self.routing, "the live routing table yielded no rows")

    def test_the_literal_covers_every_surface_the_touch_map_keyed(self) -> None:
        self.assertEqual(set(_EXPECTED_REVIEWERS), set(_DELETED_TOUCH_MAP))

    def test_each_surface_derives_exactly_the_literal_set(self) -> None:
        mismatches = {}
        for surface, expected in sorted(_EXPECTED_REVIEWERS.items()):
            derived = _derived_reviewers(surface, self.routing)
            if derived != expected:
                mismatches[surface] = {"missing": sorted(expected - derived), "unexpected": sorted(derived - expected)}
        self.assertEqual(
            mismatches, {},
            "the routing table must derive the Q4 reviewer set per surface (DECISIONS.md Q4: the lost "
            "agents join the routing table FIRST, in the SE-2 PR)")

    def test_the_q4_agents_are_derived(self) -> None:
        q4 = {
            ("apps/auth-service", "compliance-expert"),
            ("apps/gateway-api", "performance-expert"),
            ("web", "accessibility-auditor"),
            ("web/apps/aquamobil", "accessibility-auditor"),
            ("libs/backend-common/src/nats", "platform-kernel-expert"),
            ("infrastructure/nats", "platform-kernel-expert"),
        }
        missing = sorted((surface, agent) for surface, agent in q4
                         if agent not in _derived_reviewers(surface, self.routing))
        self.assertEqual(missing, [], "an agent owner decision Q4 adds is not derived from the routing table")

    def test_only_the_named_agents_drop_from_the_deleted_touch_map(self) -> None:
        dropped = frozenset((surface, agent) for surface, agents in _DELETED_TOUCH_MAP.items()
                            for agent in agents if agent not in _derived_reviewers(surface, self.routing))
        self.assertEqual(
            sorted(dropped), sorted(_NARROWED_WITHOUT_A_Q4_ENTRY),
            "the merge-time reviewer set must not narrow silently: an agent the touch map named drops "
            "only when it is named here")


if __name__ == "__main__":
    unittest.main()
