"""The ONE reading of the executor's release sites, for every test that pins them.

Two invariants pin the same property — every reason the executor releases a
claim with is classified by `release_reason` (harness or request fault) —
and each used to carry its own AST walk. When ARIA-HIGH-107 made the
admission refusal's release site read its reason off a refusal record
(`reason=admission_exit.release_reason`, the record built from the module
level `ADMISSION_REFUSALS` / `TASK_BINDING_REFUSAL` tables), one walker was
taught the tables and the other refused the attribute: the property had two
definitions and they disagreed. This module is the single definition; both
tests read it.

What a `reason=` expression may be, and where its literal lives:

* a string literal — the literal itself;
* an f-string — its static head is a PREFIX the kernel owns
  (`f"submit_timeout_{n}s"` -> `submit_timeout_`);
* a conditional — every arm is a site;
* a bare name — a module constant whose literal is pinned where it is
  assigned or derived (its own classification test);
* `<name>.release_reason` — a refusal record; its literal is one of the
  `release_reason=` keywords of the refusal tables, which this scan also
  reads, so the table and the site are classified together. The tables are
  the module-level names in `REFUSAL_TABLE_NAMES` and nothing else: a
  record built anywhere else — an exception's property, a local — has a
  literal this reading never sees, and the site it feeds is classified by
  nothing (ARIA-HIGH-115 round 2: `exc.release_reason` satisfied the shape
  while its literal lived in a kernel property, and a wholly unclassified
  executor release reason failed no static pin). So a `release_reason`
  attribute site is admitted ONLY on a refusal table's own name, or on one
  of the `REFUSAL_RECORD_READERS` — the locals that carry a record built
  from a table (`_refuse_native_admission` from `ADMISSION_REFUSALS` /
  `TASK_BINDING_REFUSAL`). Any other name is a new shape and needs a rule
  here, which is where its literal gets classified.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

EXECUTOR_PATH = Path(__file__).resolve().parents[3] / "tools" / "aria-poc" / "ci_executor.py"
REFUSAL_TABLE_NAMES: frozenset[str] = frozenset({
    "ADMISSION_REFUSALS", "TASK_BINDING_REFUSAL", "IMPLEMENTATION_IDENTITY_REFUSAL",
    # ARIA-HIGH-124 — the executor's delivery refusals; round 3 added the
    # delivery's window/sandbox admission.
    "DELIVERY_CREDENTIAL_REFUSAL", "IMPLEMENTATION_BRANCH_COLLISION_REFUSAL",
    "IMPLEMENTATION_REQUEST_INVALID_REFUSAL", "DELIVERY_WINDOW_REFUSAL",
})
REFUSAL_RECORD_ATTRIBUTE = "release_reason"
# The locals a release site may read `.release_reason` off besides the tables
# themselves: each carries a `_NativeAdmissionRefusal` that
# `_refuse_native_admission` built from a kind in the tables, so the literal
# behind it is one this scan read there. A site on any other name is refused
# by `scan_executor_release_sites` — the reading names its admitted shapes.
REFUSAL_RECORD_READERS: frozenset[str] = frozenset({"admission_exit"})


class UnreadableReleaseSite(AssertionError):
    """A `reason=` expression this reading does not admit — a new shape needs a rule here, not a wider regex."""


@dataclass
class ReleaseSiteScan:
    literal: set[str] = field(default_factory=set)
    """Literal reasons: from release sites and from the refusal tables."""
    fstring_prefixes: set[str] = field(default_factory=set)
    """Static heads of parameterised reasons."""
    refusal_tables_seen: set[str] = field(default_factory=set)
    release_sites: int = 0
    attribute_sites: int = 0
    """Release sites that read a refusal record's `release_reason`."""
    attribute_site_names: set[str] = field(default_factory=set)
    """The names those sites read the record off: a refusal table's own, or a rostered reader's."""


def _literals(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.IfExp):
        return _literals(node.body) | _literals(node.orelse)
    return set()


def _refusal_record_reasons(kind: ast.AST) -> set[str]:
    """`_AdmissionRefusalKind(release_reason="...", ...)` -> its release reason literals."""
    if not isinstance(kind, ast.Call):
        return set()
    return set().union(*(_literals(keyword.value) for keyword in kind.keywords
                         if keyword.arg == REFUSAL_RECORD_ATTRIBUTE))


def scan_executor_release_sites(source: str | None = None) -> ReleaseSiteScan:
    """Every reason the executor can release a claim with, read from its AST."""
    text = source if source is not None else EXECUTOR_PATH.read_text(encoding="utf-8")
    tree = ast.parse(text)
    scan = ReleaseSiteScan()

    def collect(expr: ast.expr) -> None:
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            scan.literal.add(expr.value)
        elif isinstance(expr, ast.JoinedStr):
            head = expr.values[0]
            if not (isinstance(head, ast.Constant) and isinstance(head.value, str)):
                raise UnreadableReleaseSite(f"an f-string reason must start with its static prefix: {ast.dump(expr)}")
            scan.fstring_prefixes.add(head.value)
        elif isinstance(expr, ast.IfExp):
            collect(expr.body)
            collect(expr.orelse)
        elif isinstance(expr, ast.Name):
            return
        elif (isinstance(expr, ast.Attribute) and expr.attr == REFUSAL_RECORD_ATTRIBUTE
              and isinstance(expr.value, ast.Name)):
            if expr.value.id not in REFUSAL_TABLE_NAMES | REFUSAL_RECORD_READERS:
                raise UnreadableReleaseSite(
                    f"a release site reads `.{REFUSAL_RECORD_ATTRIBUTE}` off {expr.value.id!r}, which is neither a "
                    "refusal table nor a rostered reader of one: the literal behind it is classified by nothing"
                )
            scan.attribute_sites += 1
            scan.attribute_site_names.add(expr.value.id)
        else:
            raise UnreadableReleaseSite(f"release reason shape not admitted: {ast.dump(expr)}")

    for node in ast.walk(tree):
        target = (node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1
                  else node.target if isinstance(node, ast.AnnAssign) else None)
        if isinstance(target, ast.Name) and target.id in REFUSAL_TABLE_NAMES and node.value is not None:
            scan.refusal_tables_seen.add(target.id)
            kinds = node.value.values if isinstance(node.value, ast.Dict) else [node.value]
            for kind in kinds:
                found = _refusal_record_reasons(kind)
                if not found:
                    raise UnreadableReleaseSite(f"{target.id}: every refusal kind must name a literal release_reason")
                scan.literal |= found
        if not isinstance(node, ast.Call):
            continue
        callee = node.func
        name = callee.attr if isinstance(callee, ast.Attribute) else getattr(callee, "id", None)
        if name != "_release_claim":
            continue
        scan.release_sites += 1
        for keyword in node.keywords:
            if keyword.arg == "reason":
                collect(keyword.value)
    if scan.attribute_sites and scan.refusal_tables_seen != set(REFUSAL_TABLE_NAMES):
        raise UnreadableReleaseSite(
            "a release site reads a refusal record's release_reason but the refusal tables "
            f"{sorted(REFUSAL_TABLE_NAMES - scan.refusal_tables_seen)} are not module-level literals this reading can see"
        )
    return scan
