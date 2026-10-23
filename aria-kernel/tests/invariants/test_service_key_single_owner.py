"""SE-1 — a repository path is attributed to a service by ONE function, over
ONE fingerprint-checked map.

WHY. Two kernel functions answered "which service owns this path" in two
vocabularies. ``impact_graph.project_for_path`` names nx projects over the
``project_roots`` map that ``cached_service_analysis_order`` publishes;
``service_dimension.service_for_path`` (E15-a) names ``apps/<dir>``,
``shared:<lib>`` and ``web:<app>``. Measured against this repository, 54 of
71 nx project names are values the second vocabulary can never produce
(``impact_graph.py`` ``project_for_path`` docstring), and ``libs/X`` and
``platform/libs/X`` collapse into one ``shared:X``. A finding minted in one
vocabulary and routed or filtered in the other is filed under a service that
does not exist in the impacted set. The service-expertise plan (PLAN.md §2
row "Path → service/project key", owner decision Q9) keeps
``project_for_path`` and deletes the second implementation with every caller
migrated, no wrapper, no string fallback.

SE-1 round 2 (review-r1-blockers.md). The round-1 invariant matched function
NAMES only (``^_?(service|project)s?_(for|of)_paths?$``), so a live second
owner with another name passed it: ``security/assess.py`` ``_asset_of`` maps
``apps/<dir>`` to ``service:<dir>``. Round 1 also added a second map ACCESSOR,
``published_project_roots``, which reads the published cache file without
the fingerprint check ``cached_service_analysis_order`` applies, and the
reviewers proved the two accessors file one finding under two names.

WHAT THIS PINS.
  * Detection is STRUCTURAL as well as by name: a top-level kernel function
    (or method) outside ``impact_graph`` is a path→project attribution when it
      - splits a path on ``/``, tests a leading segment against a project
        family (``apps``, ``libs``, ``platform``, ``web``, or a prefix such as
        ``apps/``) and reads a later segment (``parts[1]``, ``parts[:2]``) —
        the shape of ``service_for_path``, ``_asset_of`` and every
        convention-based copy. "Splits" covers every binding form (plain,
        annotated, walrus, tuple and starred unpacking), a subscript straight
        on the split, ``split('/')`` and ``split(sep='/')``,
        ``Path(...).parts``, and the rest of a path after its family
        (``removeprefix('apps/')`` or ``partition('/')``) split again (SE-1-R2
        appellate R2: the round-2 detector saw only ``name = split``). The
        family is spelled inline or bound to a module-level name;
      - holds a regex anchored on a project family with a capture group,
        inline or as a module-level pattern it uses (plain or annotated
        binding). A string literal counts when it compiles as a regex
        (``re.error`` is the only exception caught) with at least one group
        and EITHER clause holds:
          (a) BEHAVIOUR (SE-1-R2 appellate R5): it captures the project
              directory ``<d>`` out of a sample path of some project family
              (``apps/<d>/x``, ``libs/<d>/x``, ``platform/libs/<d>/x``,
              ``web/modules/<d>/x``, ...) and does NOT capture it out of the
              same path under a non-family head (the anchor). This covers
              alternations, optional prefixes and named groups:
              ``^apps/(?P<svc>[^/]+)/``, ``^(apps|libs)/([^/]+)/``,
              ``^(?:apps|libs)/([^/]+)/``, ``^(?:platform/)?libs/([^/]+)/``;
          (b) SPELLING (SE-1-R3 appellate R6): after an optional ``^``, it
              begins with a project family or family parent (``apps``,
              ``libs``, ``platform``, ``platform/libs``, ``web``,
              ``web/modules``), then ``/``, then a capturing group (a ``(``
              not followed by ``?``, or ``(?P<``): a group at the
              project-directory position. This covers a capture that also
              constrains the rest of the path, which (a)'s one sample tail
              never matches: ``^apps/([^/]+)/src/``,
              ``^apps/([\\w-]+)/.*\\.ts$``, ``^apps/([^/]+)$``,
              ``^libs/([^/]+)/src/index\\.ts$``, ``^apps/([a-z-]+-service)/``.
        Both clauses take the families from the owner's
        ``impact_graph._CONVENTIONAL_FAMILIES`` (no second list).
        ``^apps/([^/]+)/`` meets both. ``^(\\w+)\\.ts$`` and
        ``^([^/]+)/([^/]+)/`` (no family), ``^apps/.*\\.spec\\.ts$`` (no
        capture) and ``^apps/.*/(\\w+)\\.spec\\.ts$`` (a capture past the
        project directory) meet neither; or
      - reads a ``project.json`` ``name`` — naming a project is the map
        builder's job (``impact_graph._declared_project_name``), and a second
        reader builds a second map.
    No such function exists outside the owner, except the holdouts another
    tracked package removes, each named below with that package. An entry
    stays only while the function still exists AND is still detected, so the
    allowance cannot grow silent entries or keep stale ones.
  * ``service_dimension`` no longer exports ``service_for_path``,
    ``services_for_paths`` or ``service_dimension``; ``services_for_finding_row``
    stays as the ROW reader. No kernel module imports the deleted names.
  * ONE map accessor: the published cache file
    (``tools/impact/service-order-cache.json``) is read only by
    ``impact_graph.cached_service_analysis_order``, which checks the graph
    fingerprint against the workspace before trusting it. No other function
    reads the file, so no caller can be handed a stale map.

NOT DETECTED. By design of an AST detector (SE-1-R2 appellate R5
non-blocking list): slice strips, f-string regexes, aliased pathlib classes,
``os.sep``, loops over segments, module-level lambdas and a bare ``split()``.
Neither regex clause detects a content-constrained capture behind a
non-capturing family alternation, such as
``^(?:apps|libs)/([a-z-]+-service)/`` (SE-1-R3 appellate R6): (a)'s sample
directory does not match ``-service``, and the spelling does not begin with
a family.

Holdouts tombstoned elsewhere (PLAN.md §2, row "Path → service/project key",
item 3; SO-17): ``recursive_impact`` (whole module, incl. ``_project_for_path``)
and ``impact.plan_impact`` (with its helper ``_affected_projects_hint``) go in
F0.9b; ``security.assess._asset_of`` is the per-path twin of
``security/profile.py`` ``_detect_services``, which the same row tombstones in
F0.9b, and goes with it (review-r1 BLOCKER-2 REQUIRED FIX).
"""
from __future__ import annotations

import ast
import functools
import re
import unittest
import warnings
from pathlib import Path

from aria_kernel.impact_graph import _CONVENTIONAL_FAMILIES

_KERNEL = Path(__file__).resolve().parents[2] / "aria_kernel"

# The module that owns the key: ``project_for_path``, its shape adapter
# ``_project_for_path`` and the map builder (``_discover_projects``,
# ``_declared_project_name``) all live here.
_OWNER_MODULE = "impact_graph"

# Implementations another tracked package removes, with that package and the
# registry finding that tracks the removal.
_TOMBSTONED_ELSEWHERE = {
    ("recursive_impact", "_project_for_path"): "F0.9b, ARIA-MEDIUM-791",
    ("impact", "_affected_projects_hint"): "F0.9b, ARIA-MEDIUM-791",
    ("security.assess", "_asset_of"): "F0.9b, ARIA-MEDIUM-791",
}

# A path -> service/project attribution, by the names this kernel has used
# for one: service_for_path, services_for_paths, project_for_path,
# _project_for_path, services_of_path, ...
_ATTRIBUTION_NAME = re.compile(r"^_?(service|project)s?_(for|of)_paths?$")

# The project families come from the owner's map builder (one source): the
# parents its discovery walks (``apps``, ``libs``, ``platform/libs``,
# ``web/modules``) and their leading segments (``apps``, ``libs``,
# ``platform``, ``web``).
_PROJECT_ROOT_PARENTS = tuple(parent for parent, _ in _CONVENTIONAL_FAMILIES)
_PROJECT_FAMILIES = frozenset(parent.split("/")[0] for parent in _PROJECT_ROOT_PARENTS)

_FAMILY_HEADS = tuple(sorted({*_PROJECT_ROOT_PARENTS, *_PROJECT_FAMILIES}))

# Regex clause (a), behaviour: a distinctive project directory under every
# family parent and every leading family segment, and the same directory
# under a head that is no family (the anchor check).
_PROBE_DIR = "zqprobedir"
_FAMILY_SAMPLE_PATHS = tuple(f"{head}/{_PROBE_DIR}/x" for head in _FAMILY_HEADS)
_NON_FAMILY_SAMPLE_PATH = f"zqnotafamily/{_PROBE_DIR}/x"

# Regex clause (b), spelling: the family heads as a regex spells them before
# the project directory.
_FAMILY_SPELLING_PREFIXES = tuple(f"{head}/" for head in _FAMILY_HEADS)

_DELETED_FROM_SERVICE_DIMENSION = ("service_for_path", "services_for_paths", "service_dimension")

# The one function allowed to read the published map file.
_MAP_READER = ("impact_graph", "cached_service_analysis_order")
_MAP_FILE_NAMES = frozenset({"_read_service_order_cache", "_SERVICE_ORDER_CACHE"})
_MAP_FILE_LITERAL = "service-order-cache"


def _module_name(path: Path) -> str:
    return ".".join(path.relative_to(_KERNEL).with_suffix("").parts)


def _kernel_sources() -> list[Path]:
    return sorted(p for p in _KERNEL.rglob("*.py") if "__pycache__" not in p.parts)


def _functions(tree: ast.Module) -> list[tuple[str, ast.AST]]:
    """Top-level functions and class methods, by qualified name. A nested
    function is part of the function that encloses it."""
    found: list[tuple[str, ast.AST]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append((node.name, node))
        elif isinstance(node, ast.ClassDef):
            found.extend(
                (f"{node.name}.{member.name}", member)
                for member in node.body
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef))
            )
    return found


def _string_literals(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return [
            element.value
            for element in node.elts
            if isinstance(element, ast.Constant) and isinstance(element.value, str)
        ]
    return []


def _names_a_project_family(literal: str) -> bool:
    head, sep, _ = literal.partition("/")
    return literal in _PROJECT_FAMILIES or (bool(sep) and head in _PROJECT_FAMILIES)


def _module_bindings(tree: ast.AST) -> list[tuple[str, ast.AST]]:
    """Module-level ``name = value`` and ``name: T = value`` bindings."""
    pairs: list[tuple[str, ast.AST]] = []
    for node in getattr(tree, "body", []):
        if isinstance(node, ast.Assign):
            pairs.extend((t.id, node.value) for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and node.value is not None and isinstance(node.target, ast.Name):
            pairs.append((node.target.id, node.value))
    return pairs


def _family_constants(tree: ast.AST) -> frozenset[str]:
    """Module-level names bound to a value that spells a project family
    (``_FAMILIES = frozenset({'apps', 'libs'})``, ``_PREFIX = 'apps/'``)."""
    return frozenset(
        name
        for name, value in _module_bindings(tree)
        if any(
            isinstance(n, ast.Constant) and isinstance(n.value, str) and _names_a_project_family(n.value)
            for n in ast.walk(value)
        )
    )


def _names_a_family(node: ast.AST, family_constants: frozenset[str]) -> bool:
    """A family spelled inline, or a module-level name bound to one."""
    return any(_names_a_project_family(v) for v in _string_literals(node)) or (
        isinstance(node, ast.Name) and node.id in family_constants
    )


def _slash_call(node: ast.AST, method: str) -> bool:
    """``<x>.<method>('/')`` or ``<x>.<method>(sep='/')`` (any receiver, any
    maxsplit)."""
    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == method):
        return False
    separators = [*node.args[:1], *(kw.value for kw in node.keywords if kw.arg == "sep")]
    return any(isinstance(sep, ast.Constant) and sep.value == "/" for sep in separators)


def _receiver(node: ast.AST) -> ast.AST | None:
    """``x`` of a method call ``x.m(...)``."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        return node.func.value
    return None


def _is_path_parts(node: ast.AST) -> bool:
    """``Path(...).parts`` / ``PurePosixPath(...).parts`` (any pathlib class)."""
    if not (isinstance(node, ast.Attribute) and node.attr == "parts" and isinstance(node.value, ast.Call)):
        return False
    func = node.value.func
    name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
    return name.endswith("Path")


def _is_segments(node: ast.AST) -> bool:
    """A path's segments, as such: ``p.split('/')`` or ``Path(p).parts``."""
    return _slash_call(node, "split") or _is_path_parts(node)


def _holds_segments(node: ast.AST) -> bool:
    """A bound value built from a path's segments (directly, or through a
    comprehension or a call over them)."""
    return any(_is_segments(n) for n in ast.walk(node))


def _is_family_strip(node: ast.AST, family_constants: frozenset[str]) -> bool:
    """``<x>.removeprefix('<family>/')``: the rest of the path after its
    project family, whose first segment is the project directory."""
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "removeprefix"
        and bool(node.args)
        and _names_a_family(node.args[0], family_constants)
    )


def _is_partition_rest(node: ast.AST) -> bool:
    """``<x>.partition('/')[2]``: the path after its first segment."""
    return (
        isinstance(node, ast.Subscript)
        and _slash_call(node.value, "partition")
        and isinstance(node.slice, ast.Constant)
        and node.slice.value == 2
    )


def _bindings(fn: ast.AST) -> list[tuple[ast.AST, ast.AST]]:
    """Every (target, value) binding in ``fn``: plain, annotated and walrus
    assignments (tuple and starred targets are kept whole)."""
    pairs: list[tuple[ast.AST, ast.AST]] = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign):
            pairs.extend((target, node.value) for target in node.targets)
        elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
            pairs.append((node.target, node.value))
    return pairs


class _PathReads:
    """What one function binds from a path: its segments (``parts``), a later
    segment by unpacking (``head, name, *_ = p.split('/')``), or the rest of
    the path after a leading segment (``p.removeprefix('apps/')``,
    ``head, _, rest = p.partition('/')``)."""

    def __init__(self, fn: ast.AST, family_constants: frozenset[str]) -> None:
        self.family_constants = family_constants
        self.segments: set[str] = set()
        self.later: set[str] = set()
        self.rests: set[str] = set()
        for target, value in _bindings(fn):
            if isinstance(target, ast.Name):
                if _holds_segments(value):
                    self.segments.add(target.id)
                elif self._is_rest(value):
                    self.rests.add(target.id)
            elif isinstance(target, (ast.Tuple, ast.List)):
                self._unpack(target, value)

    def _unpack(self, target: ast.Tuple | ast.List, value: ast.AST) -> None:
        is_partition = _slash_call(value, "partition")
        if not (is_partition or _is_segments(value)):
            return
        for position, element in enumerate(target.elts):
            inner = element.value if isinstance(element, ast.Starred) else element
            if not isinstance(inner, ast.Name) or position == 0:
                continue
            if not is_partition:
                self.later.add(inner.id)
            elif position == 2:
                self.rests.add(inner.id)

    def _is_rest(self, node: ast.AST) -> bool:
        return (
            (isinstance(node, ast.Name) and node.id in self.rests)
            or _is_family_strip(node, self.family_constants)
            or _is_partition_rest(node)
        )

    def _is_bound_segments(self, node: ast.AST) -> bool:
        return (isinstance(node, ast.Name) and node.id in self.segments) or _is_segments(node)

    def reads_a_later_segment(self, fn: ast.AST) -> bool:
        for node in ast.walk(fn):
            # parts[1], parts[:2], p.split('/')[1], Path(p).parts[1]
            if isinstance(node, ast.Subscript) and self._is_bound_segments(node.value):
                index = node.slice
                if isinstance(index, ast.Slice):
                    return True
                if isinstance(index, ast.Constant) and isinstance(index.value, int) and index.value >= 1:
                    return True
            # head, name, *_ = p.split('/'); ... name
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in self.later:
                return True
            # rest.split('/') / rest.partition('/'): the first segment of the
            # rest is the project directory.
            if _slash_call(node, "split") or _slash_call(node, "partition"):
                receiver = _receiver(node)
                if receiver is not None and self._is_rest(receiver):
                    return True
        return False


def _family_capture_patterns(tree: ast.AST) -> frozenset[str]:
    """Module-level names (plain or annotated binding) bound to a
    family-anchored regex with a capture."""
    return frozenset(
        name
        for name, value in _module_bindings(tree)
        if any(_is_family_capture(n) for n in ast.walk(value))
    )


@functools.lru_cache(maxsize=None)
def _captures_a_project_dir(literal: str) -> bool:
    """``literal`` compiles as a regex with at least one group, and its
    capture is the project directory of a family path by clause (a) or (b)
    (module docstring)."""
    # Most literals probed here are prose, not regexes; ``re`` warns about
    # the future meaning of some of them (``[[`` "possible nested set"),
    # which says nothing about whether they capture a project directory.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        try:
            pattern = re.compile(literal)
        except re.error:
            return False
    if pattern.groups == 0:
        return False
    return _captures_it_from_a_family_sample(pattern) or _spells_a_capture_after_a_family(literal)


def _captures_it_from_a_family_sample(pattern: re.Pattern[str]) -> bool:
    """Clause (a), behaviour: ``pattern`` captures the project directory of a
    sample path in a project family and does not capture it under a
    non-family head."""

    def captures(path: str) -> bool:
        match = pattern.search(path)
        return match is not None and _PROBE_DIR in match.groups()

    return any(captures(path) for path in _FAMILY_SAMPLE_PATHS) and not captures(_NON_FAMILY_SAMPLE_PATH)


def _spells_a_capture_after_a_family(literal: str) -> bool:
    """Clause (b), spelling: after an optional ``^``, ``literal`` begins with
    a family head and ``/``, then a capturing group (``(`` not followed by
    ``?``, or ``(?P<``), so its group sits at the project-directory position
    whatever it requires of the rest of the path."""
    spelling = literal.removeprefix("^")
    return any(
        rest.startswith("(") and (not rest.startswith("(?") or rest.startswith("(?P<"))
        for rest in (
            spelling[len(prefix):] for prefix in _FAMILY_SPELLING_PREFIXES if spelling.startswith(prefix)
        )
    )


def _is_family_capture(node: ast.AST) -> bool:
    """A string literal that is a regex anchored on a project family with a
    capturing group (``^apps/([^/]+)/``): the capture is the project dir."""
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and _captures_a_project_dir(node.value)


def _uses_a_family_capture(fn: ast.AST, module_patterns: frozenset[str]) -> bool:
    return any(
        _is_family_capture(node)
        or (isinstance(node, ast.Name) and node.id in module_patterns)
        for node in ast.walk(fn)
    )


def _tests_a_project_family(fn: ast.AST, family_constants: frozenset[str]) -> bool:
    for node in ast.walk(fn):
        if isinstance(node, ast.Compare):
            for operand in (node.left, *node.comparators):
                if _names_a_family(operand, family_constants):
                    return True
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in ("startswith", "removeprefix")
        ):
            for arg in node.args:
                if _names_a_family(arg, family_constants):
                    return True
    return False


def _reads_a_project_json_name(fn: ast.AST) -> bool:
    mentions_manifest = any(
        isinstance(node, ast.Constant) and node.value == "project.json" for node in ast.walk(fn)
    )
    reads_name = any(
        (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and bool(node.args)
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "name"
        )
        or (
            isinstance(node, ast.Subscript)
            and isinstance(node.slice, ast.Constant)
            and node.slice.value == "name"
        )
        for node in ast.walk(fn)
    )
    return mentions_manifest and reads_name


def _attribution_reasons(
    name: str, fn: ast.AST, module_patterns: frozenset[str], family_constants: frozenset[str]
) -> list[str]:
    """Why ``fn`` is a path→project attribution (empty: it is not one)."""
    reasons: list[str] = []
    if _ATTRIBUTION_NAME.match(name.rsplit(".", 1)[-1]):
        reasons.append("name")
    if _tests_a_project_family(fn, family_constants) and _PathReads(fn, family_constants).reads_a_later_segment(fn):
        reasons.append("path-segment attribution")
    if _uses_a_family_capture(fn, module_patterns):
        reasons.append("family regex capture")
    if _reads_a_project_json_name(fn):
        reasons.append("project.json name")
    return reasons


def _attributions_in(source: str, module: str) -> dict[tuple[str, str], list[str]]:
    tree = ast.parse(source)
    module_patterns = _family_capture_patterns(tree)
    family_constants = _family_constants(tree)
    found: dict[tuple[str, str], list[str]] = {}
    for name, fn in _functions(tree):
        reasons = _attribution_reasons(name, fn, module_patterns, family_constants)
        if reasons:
            found[(module, name)] = reasons
    return found


def _kernel_attributions() -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = {}
    for path in _kernel_sources():
        found.update(_attributions_in(path.read_text(encoding="utf-8"), _module_name(path)))
    return found


class TheDetectorSeesEveryKnownShape(unittest.TestCase):
    """The structural detector is not vacuous: it flags the shapes the review
    found (and the round-1 regex missed), and leaves a plain path test alone."""

    def test_the_deleted_string_vocabulary_is_detected(self) -> None:
        source = (
            "def service_key(path):\n"
            "    parts = [p for p in path.split('/') if p]\n"
            "    if len(parts) >= 2 and parts[0] == 'apps':\n"
            "        return parts[1]\n"
            "    if len(parts) >= 3 and parts[0] == 'platform' and parts[1] == 'libs':\n"
            "        return f'shared:{parts[2]}'\n"
            "    return None\n"
        )
        self.assertIn(("m", "service_key"), _attributions_in(source, "m"))

    def test_an_asset_of_shaped_function_is_detected(self) -> None:
        source = (
            "def _asset_of(code_ref):\n"
            "    parts = str(code_ref).split('/')\n"
            "    if len(parts) >= 2 and parts[0] == 'apps' and parts[1]:\n"
            "        return f'service:{parts[1]}'\n"
            "    return None\n"
        )
        self.assertIn(("m", "_asset_of"), _attributions_in(source, "m"))

    def test_a_prefix_grouping_is_detected(self) -> None:
        source = (
            "class Splitter:\n"
            "    def group(self, path):\n"
            "        if path.startswith('libs/'):\n"
            "            parts = path.split('/')\n"
            "            return '/'.join(parts[:2])\n"
            "        return path\n"
        )
        self.assertIn(("m", "Splitter.group"), _attributions_in(source, "m"))

    def test_a_second_project_json_name_reader_is_detected(self) -> None:
        source = (
            "import json\n"
            "def nearest(root, rel):\n"
            "    manifest = root / rel / 'project.json'\n"
            "    return json.loads(manifest.read_text()).get('name')\n"
        )
        self.assertIn(("m", "nearest"), _attributions_in(source, "m"))

    # SE-1-R2 appellate R2: the shapes the reviewers' probes (ssot P2, arch
    # p7) showed the name-bound detector missed. Each is a renamed copy of the
    # deleted ``service_for_path``.

    def _assert_detected(self, source: str) -> None:
        self.assertIn(("m", "svc"), _attributions_in(source, "m"))

    def test_an_annotated_split_is_detected(self) -> None:
        self._assert_detected(
            "def svc(path: str) -> str | None:\n"
            "    parts: list[str] = path.split('/')\n"
            "    if len(parts) >= 2 and parts[0] == 'apps':\n"
            "        return parts[1]\n"
            "    return None\n"
        )

    def test_a_walrus_bound_split_is_detected(self) -> None:
        self._assert_detected(
            "def svc(path):\n"
            "    if (parts := path.split('/'))[0] == 'apps':\n"
            "        return parts[1]\n"
            "    return None\n"
        )

    def test_a_tuple_unpacked_split_is_detected(self) -> None:
        self._assert_detected(
            "def svc(p):\n"
            "    head, name, *_ = p.split('/')\n"
            "    return name if head == 'apps' else None\n"
        )

    def test_a_starred_unpacked_split_is_detected(self) -> None:
        self._assert_detected(
            "def svc(p):\n"
            "    head, *rest = p.split('/')\n"
            "    return rest[0] if head == 'libs' else None\n"
        )

    def test_an_inline_subscript_of_a_split_is_detected(self) -> None:
        self._assert_detected(
            "def svc(path):\n"
            "    if path.startswith('apps/'):\n"
            "        return path.split('/')[1]\n"
            "    return None\n"
        )

    def test_a_removeprefix_then_split_is_detected(self) -> None:
        self._assert_detected(
            "def svc(path):\n"
            "    if not path.startswith('apps/'):\n"
            "        return None\n"
            "    return path.removeprefix('apps/').split('/', 1)[0]\n"
        )

    def test_a_partition_is_detected(self) -> None:
        self._assert_detected(
            "def svc(path):\n"
            "    head, _, rest = path.partition('/')\n"
            "    if head in {'apps', 'libs'}:\n"
            "        return rest.partition('/')[0]\n"
            "    return None\n"
        )

    def test_pathlib_parts_are_detected(self) -> None:
        self._assert_detected(
            "from pathlib import PurePosixPath\n"
            "def svc(path):\n"
            "    parts = PurePosixPath(path).parts\n"
            "    if parts[0] == 'apps':\n"
            "        return parts[1]\n"
            "    return None\n"
        )

    def test_an_inline_pathlib_parts_subscript_is_detected(self) -> None:
        self._assert_detected(
            "from pathlib import Path\n"
            "def svc(path):\n"
            "    return Path(path).parts[1] if path.startswith('apps/') else None\n"
        )

    def test_a_family_anchored_regex_capture_is_detected(self) -> None:
        self._assert_detected(
            "import re\n"
            "def svc(p):\n"
            "    m = re.match(r'^apps/([^/]+)/', p)\n"
            "    return m.group(1) if m else None\n"
        )

    def test_a_module_level_family_regex_capture_is_detected(self) -> None:
        self._assert_detected(
            "import re\n"
            "_APP = re.compile(r'^apps/([^/]+)/')\n"
            "def svc(path):\n"
            "    m = _APP.match(path)\n"
            "    return m.group(1) if m else None\n"
        )

    # SE-1-R2 appellate R5: the detector recognised its documented regex rule
    # by one spelling (``^<family>/`` then an unnamed group) and one module
    # binding form (``ast.Assign``), and its split rule by a positional '/'
    # only (ssot P5, evidence p2). Each shape below is a family-anchored regex
    # with a capture group, or a '/'-split, that the round-2 detector missed.

    _FAMILY_REGEX_SHAPES = (
        r"^apps/(?P<svc>[^/]+)/",
        r"^(apps|libs)/([^/]+)/",
        r"^(?:apps|libs)/([^/]+)/",
        r"^(?:platform/)?libs/([^/]+)/",
    )

    def test_family_regex_shapes_are_detected_inline(self) -> None:
        for pattern in self._FAMILY_REGEX_SHAPES:
            with self.subTest(pattern=pattern):
                self._assert_detected(
                    "import re\n"
                    "def svc(p):\n"
                    f"    m = re.match(r'{pattern}', p)\n"
                    "    return m.group(m.lastindex) if m else None\n"
                )

    def test_family_regex_shapes_are_detected_as_module_level_patterns(self) -> None:
        for pattern in self._FAMILY_REGEX_SHAPES:
            with self.subTest(pattern=pattern):
                self._assert_detected(
                    "import re\n"
                    f"_P = re.compile(r'{pattern}')\n"
                    "def svc(p):\n"
                    "    m = _P.match(p)\n"
                    "    return m.group(m.lastindex) if m else None\n"
                )

    def test_an_annotated_module_level_family_regex_is_detected(self) -> None:
        self._assert_detected(
            "import re\n"
            "from typing import Final\n"
            "_P: Final = re.compile(r'^apps/([^/]+)/')\n"
            "def svc(p):\n"
            "    m = _P.match(p)\n"
            "    return m.group(1) if m else None\n"
        )

    # SE-1-R3 appellate R6: R5's behaviour clause samples one path tail
    # (``<family>/<d>/x``), so a family-anchored capture that also constrains
    # the rest of the path stopped counting. The round-2 detector flagged each
    # of these (7765782d5), and the docstring's rule names them.

    _FAMILY_REGEX_SHAPES_THAT_CONSTRAIN_THE_REST = (
        r"^apps/([^/]+)/src/",
        r"^apps/([\w-]+)/.*\.ts$",
        r"^apps/([^/]+)/src/.*\.(ts|tsx)$",
        r"^apps/([^/]+)$",
        r"^libs/([^/]+)/src/index\.ts$",
        r"^apps/([a-z-]+-service)/",
        r"^apps/([^/]+)/(?:src|test)/",
    )

    def test_a_family_regex_that_constrains_the_rest_of_the_path_is_detected(self) -> None:
        for pattern in self._FAMILY_REGEX_SHAPES_THAT_CONSTRAIN_THE_REST:
            with self.subTest(pattern=pattern, binding="inline"):
                self._assert_detected(
                    "import re\n"
                    "def svc(p):\n"
                    f"    m = re.match(r'{pattern}', p)\n"
                    "    return m.group(1) if m else None\n"
                )
            with self.subTest(pattern=pattern, binding="module-level"):
                self._assert_detected(
                    "import re\n"
                    f"_P = re.compile(r'{pattern}')\n"
                    "def svc(p):\n"
                    "    m = _P.match(p)\n"
                    "    return m.group(1) if m else None\n"
                )

    def test_a_split_with_a_sep_keyword_is_detected(self) -> None:
        self._assert_detected(
            "def svc(p):\n"
            "    parts = p.split(sep='/')\n"
            "    if parts[0] == 'apps':\n"
            "        return parts[1]\n"
            "    return None\n"
        )

    def test_a_family_tested_through_a_module_constant_is_detected(self) -> None:
        # Recommended by appellate R5 (not required): the docstring's "tests a
        # leading segment against a project family" holds whether the family
        # is spelled inline or bound to a module-level name.
        self._assert_detected(
            "_FAMILIES = frozenset({'apps', 'libs'})\n"
            "def svc(p):\n"
            "    parts = p.split('/')\n"
            "    if parts[0] in _FAMILIES:\n"
            "        return parts[1]\n"
            "    return None\n"
        )

    def test_a_regex_without_a_family_anchor_or_without_a_capture_is_not_flagged(self) -> None:
        for name, pattern in (
            ("capture_without_family", r"^(\w+)\.ts$"),
            ("family_without_capture", r"^apps/.*\.spec\.ts$"),
            ("capture_of_any_leading_segment", r"^([^/]+)/([^/]+)/"),
            # A family regex whose capture is not at the project-directory
            # position (SE-1-R3 appellate R6).
            ("family_with_a_capture_past_the_project_dir", r"^apps/.*/(\w+)\.spec\.ts$"),
        ):
            with self.subTest(shape=name):
                source = (
                    "import re\n"
                    f"_P = re.compile(r'{pattern}')\n"
                    "def svc(p):\n"
                    f"    return bool(re.search(r'{pattern}', p)) or bool(_P.match(p))\n"
                )
                self.assertEqual(_attributions_in(source, "m"), {})

    def test_a_path_class_test_that_names_no_project_is_not_flagged(self) -> None:
        source = (
            "def is_runtime(path):\n"
            "    return path.startswith(('apps/', 'libs/')) and '/src/' in path\n"
        )
        self.assertEqual(_attributions_in(source, "m"), {})


class OnePathToServiceImplementation(unittest.TestCase):
    def test_only_impact_graph_attributes_a_path_to_a_service(self) -> None:
        found = _kernel_attributions()
        second_owners = sorted(
            f"{module}.{name} ({', '.join(reasons)})"
            for (module, name), reasons in found.items()
            if module != _OWNER_MODULE and (module, name) not in _TOMBSTONED_ELSEWHERE
        )
        self.assertEqual(
            second_owners,
            [],
            "a second path->service/project implementation exists in aria_kernel; the one "
            "owner is impact_graph.project_for_path over the fingerprint-checked project_roots "
            "map (fold it into the owner, or name the tracked package that removes it in "
            "_TOMBSTONED_ELSEWHERE)",
        )

    def test_the_owner_is_still_there(self) -> None:
        from aria_kernel import impact_graph

        self.assertTrue(callable(getattr(impact_graph, "project_for_path", None)))

    def test_entries_tombstoned_elsewhere_are_live_and_detected(self) -> None:
        found = _kernel_attributions()
        for (module, name), package in _TOMBSTONED_ELSEWHERE.items():
            self.assertIn(
                (module, name),
                found,
                f"{module}.{name} is gone or no longer attributes a path ({package} landed, "
                "or it was folded): drop its entry here",
            )


class OneFingerprintCheckedMapAccessor(unittest.TestCase):
    """review-r1 B1 / BLOCKER-1: ``published_project_roots`` read the published
    map without the fingerprint check, so a mint in the cycle's 'tools' phase
    (before 'service_examination' refreshes the map) and any mint after a
    ``project.json`` rename stamped a stale name, while ``emit_finding``,
    through the checked accessor, stamped the current one."""

    def test_only_the_fingerprint_checked_writer_reads_the_published_map(self) -> None:
        readers: list[str] = []
        for path in _kernel_sources():
            module = _module_name(path)
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            for name, fn in _functions(tree):
                if (module, name) == _MAP_READER:
                    continue
                touches = sorted(
                    {
                        node.id
                        for node in ast.walk(fn)
                        if isinstance(node, ast.Name) and node.id in _MAP_FILE_NAMES
                    }
                    | {
                        node.attr
                        for node in ast.walk(fn)
                        if isinstance(node, ast.Attribute) and node.attr in _MAP_FILE_NAMES
                    }
                    | {
                        _MAP_FILE_LITERAL
                        for node in ast.walk(fn)
                        if isinstance(node, ast.Constant)
                        and isinstance(node.value, str)
                        and _MAP_FILE_LITERAL in node.value
                        and not _is_docstring_of(node, fn)
                    }
                )
                if touches:
                    readers.append(f"{module}.{name} ({', '.join(touches)})")
        self.assertEqual(
            readers,
            [],
            "the published project map is read without the graph-fingerprint check; the one "
            "accessor is impact_graph.cached_service_analysis_order",
        )


def _is_docstring_of(node: ast.AST, fn: ast.AST) -> bool:
    body = getattr(fn, "body", [])
    return bool(body) and isinstance(body[0], ast.Expr) and body[0].value is node


class ServiceDimensionKeepsOnlyTheRowReader(unittest.TestCase):
    def test_the_string_vocabulary_functions_are_deleted(self) -> None:
        from aria_kernel import service_dimension

        still_exported = [
            name for name in _DELETED_FROM_SERVICE_DIMENSION if hasattr(service_dimension, name)
        ]
        self.assertEqual(still_exported, [])

    def test_the_row_reader_stays(self) -> None:
        from aria_kernel import service_dimension

        self.assertTrue(callable(getattr(service_dimension, "services_for_finding_row", None)))

    def test_no_kernel_module_imports_a_deleted_name(self) -> None:
        importers: list[str] = []
        for path in _kernel_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom):
                    continue
                if (node.module or "").rsplit(".", 1)[-1] != "service_dimension":
                    continue
                for alias in node.names:
                    if alias.name in _DELETED_FROM_SERVICE_DIMENSION:
                        importers.append(
                            f"{path.relative_to(_KERNEL.parent).as_posix()}:{node.lineno}:{alias.name}"
                        )
        self.assertEqual(
            importers,
            [],
            "every caller migrates to impact_graph.project_for_path with the cached map",
        )


if __name__ == "__main__":
    unittest.main()
