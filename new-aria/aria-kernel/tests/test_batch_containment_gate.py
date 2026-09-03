"""A cycle learning hook may not commit inside an unguarded loop.

THE DEFECT THIS GATE EXISTS FOR. A hook iterates items and commits as it goes:
a ledger row, a governance event, an archived file. Item k raises. Items 1..k-1
are already on disk; items k+1..n never run; and the hook's entire report is
replaced upstream by one generic `learning_hook_failed`. The writes happened and
nothing says so — a partial state indistinguishable from a total failure.

ORPHAN-HIGH-575 was one instance, found by a human reading a traceback. When the
question was finally asked mechanically, TWELVE of the sixteen hooks had the
shape, across seven modules. That ratio is the argument for a gate: this is not
a bug that was made once.

HOW THE HOOK ROSTER IS DERIVED, and why it is not a list. `PRODUCTION_SOURCE_ROOTS`
in `control_reachability` had to be guarded against becoming stale because a
hardcoded roster is the same shape as ORPHAN-HIGH-569 — a list that was true when
written and quietly stopped describing the repository. So this gate hardcodes no
hooks. It reads `learning._run_learning_hooks`'s own dispatch tuple from the AST,
takes each hook's name and the function its lambda calls, and resolves that
function to a module through `learning.py`'s imports. Add a hook tomorrow and it
is scanned tomorrow, with nothing to remember.

HOW "COMMITTING" IS DERIVED, for the same reason. A curated list of writer names
would miss the first writer someone names `persist_thing` — and the first
attempt here, a `record_` name prefix, swept in `ledger._record_hash`, which
computes a hash and writes nothing. So the seed asks what the code DOES: a
function is a write primitive if its own body opens a file for writing or calls
one of the filesystem mutators, and it is *committing* if it can reach one
through the call graph. Nothing about this is a list to keep up to date.

WHERE FAIL-FAST IS DELIBERATE, a waiver is declared with owner, reason, deadline
and finding ID, in `batch-containment.waivers.json`. The mechanism is the one
`invariant-reachability.spec.ts` proved and paid for: that spec validated the
SHAPE of `expires_on` and never compared it to the clock, so 25 waivers sailed a
month past a shared deadline in silence. Here the deadline is compared to the
clock, and a waiver for a loop that has since been guarded fails too — a waiver
that outlives its reason is a lie with a date on it.
"""

from __future__ import annotations

import ast
import json
import unittest
from datetime import date
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL = REPO_ROOT / "aria-kernel" / "aria_kernel"
WAIVERS_PATH = REPO_ROOT / "aria-kernel" / "batch-containment.waivers.json"

# What counts as touching the disk, expressed as syntax rather than as names.
# The first version of this seed matched a name prefix — `record_` — and so
# swept in `ledger._record_hash`, which computes a row hash and writes nothing.
# That made `ledger.load_jsonl` "committing" and would have flagged every read
# inside every loop: a gate crying wolf on its very first run. Naming a writer
# is not writing, so the seed asks what the code DOES.
# Unambiguous: nothing in this kernel spells any of these on a non-path object.
FS_WRITE_ATTRS = frozenset({
    "write_text", "write_bytes", "writelines", "mkdir", "touch", "unlink",
    "rename", "rmdir", "rmtree", "copytree", "makedirs",
})
# Ambiguous: `replace` is `os.replace` on a path and `str.replace`/`datetime.replace`
# everywhere else; `remove` is `os.remove` and `list.remove`. Counting the bare
# attribute made `_age_days` — which parses a date — a write primitive. These
# therefore require their module, and nothing real is lost: every atomic write
# in this kernel calls `mkdir` and `write_text` before it calls `tmp.replace`.
FS_WRITE_QUALIFIED = frozenset({
    ("os", "replace"), ("os", "rename"), ("os", "remove"), ("os", "makedirs"),
    ("shutil", "move"), ("shutil", "copy"), ("shutil", "copy2"),
    ("shutil", "rmtree"), ("shutil", "copytree"),
})
FS_WRITE_MODES = ("w", "a", "x", "+")


def _module_functions(path: Path) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return {}
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _called_names(node: ast.AST) -> set[str]:
    """Bare-function callees only.

    Attribute calls are excluded on purpose: in this kernel every ledger and
    governance writer is a module-level function, while `x.append(...)` is a
    Python list append. Counting attribute calls would flag every accumulator in
    the repository, and a gate that cries wolf gets waived into uselessness.
    """
    return {
        child.func.id
        for child in ast.walk(node)
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name)
    }


def _module_imports(path: Path) -> dict[str, str]:
    """Imported name -> the module it came from, for one kernel module."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return {}
    imports: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                imports[alias.asname or alias.name] = node.module.lstrip(".")
    return imports


def _touches_the_disk(fn: ast.AST) -> bool:
    """Does this function body contain a filesystem write?"""
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in FS_WRITE_ATTRS:
                return True
            receiver = getattr(node.func.value, "id", "")
            if (receiver, node.func.attr) in FS_WRITE_QUALIFIED:
                return True
        if isinstance(node.func, ast.Name) and node.func.id == "open":
            mode = ""
            if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                mode = str(node.args[1].value)
            for kw in node.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    mode = str(kw.value.value)
            if any(flag in mode for flag in FS_WRITE_MODES):
                return True
    return False


def _write_primitives() -> set[tuple[str, str]]:
    """Every kernel function whose own body writes to the filesystem."""
    seeds: set[tuple[str, str]] = set()
    for path in sorted(KERNEL.rglob("*.py")):
        module = path.relative_to(KERNEL).as_posix()[: -len(".py")].replace("/", ".")
        for fn_name, fn in _module_functions(path).items():
            if _touches_the_disk(fn):
                seeds.add((module, fn_name))
    return seeds


def _committing_functions() -> set[tuple[str, str]]:
    """Every kernel function that can transitively reach a write primitive.

    Keyed by (module, name), not name. The kernel has 2,400 module-level
    functions and same-named private helpers are everywhere — `_write_cache`,
    `_record_hash`, `_now`. Merging them by name alone let a pure read inherit
    a sibling's write edge: `ledger.load_jsonl` came out "committing", which
    would have flagged every read inside every loop. That is the wolf-crying
    failure this gate cannot afford, so resolution follows each module's own
    imports.
    """
    call_graph: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for path in sorted(KERNEL.rglob("*.py")):
        module = path.relative_to(KERNEL).as_posix()[: -len(".py")].replace("/", ".")
        local = _module_functions(path)
        imports = _module_imports(path)
        for fn_name, fn in local.items():
            edges: set[tuple[str, str]] = set()
            for callee in _called_names(fn):
                if callee in imports:
                    edges.add((imports[callee], callee))
                elif callee in local:
                    edges.add((module, callee))
            call_graph[(module, fn_name)] = edges

    committing = _write_primitives()
    changed = True
    while changed:
        changed = False
        for key, callees in call_graph.items():
            if key not in committing and callees & committing:
                committing.add(key)
                changed = True
    return committing


def _hook_roster() -> dict[str, tuple[Path, str]]:
    """hook name -> (module path, function name), read from the dispatch tuple."""
    learning_path = KERNEL / "learning.py"
    tree = ast.parse(learning_path.read_text(encoding="utf-8"))
    runner = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_run_learning_hooks"
    )
    imports: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                imports[alias.asname or alias.name] = node.module

    roster: dict[str, tuple[Path, str]] = {}
    for node in ast.walk(runner):
        if not (isinstance(node, ast.Tuple) and len(node.elts) == 2):
            continue
        name_node, lambda_node = node.elts
        if not (isinstance(name_node, ast.Constant) and isinstance(name_node.value, str)):
            continue
        if not isinstance(lambda_node, ast.Lambda):
            continue
        called = [
            child.func.id
            for child in ast.walk(lambda_node)
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name)
            and child.func.id != "_skipped"
        ]
        if not called:
            continue
        fn_name = called[0]
        module = imports.get(fn_name)
        path = learning_path if module is None else KERNEL / f"{module.lstrip('.')}.py"
        roster[name_node.value] = (path, fn_name)
    return roster


def _loop_body_nodes(loop: ast.For | ast.AsyncFor) -> list[ast.AST]:
    """Every node in the loop's BODY, excluding the iterable expression.

    `for row in load_rows(path):` evaluates `load_rows` once, before any item
    exists. A failure there has no item to be contained to and legitimately
    fails the hook, so counting it would be the gate's first false positive —
    and the first false positive is how a gate starts getting waived.
    """
    nodes: list[ast.AST] = []
    for stmt in list(loop.body) + list(loop.orelse):
        nodes.extend(ast.walk(stmt))
    return nodes


def _guarded_nodes(loop: ast.For | ast.AsyncFor) -> set[int]:
    guarded: set[int] = set()
    for node in _loop_body_nodes(loop):
        is_guard_call = (
            isinstance(node, ast.Call)
            and (getattr(node.func, "id", "") == "guard_item" or getattr(node.func, "attr", "") == "guard_item")
        )
        if is_guard_call or isinstance(node, ast.Try):
            guarded.update(id(child) for child in ast.walk(node))
    return guarded


def unguarded_commits_in_function(
    fn: ast.AST,
    *,
    module: str,
    local: dict[str, Any],
    imports: dict[str, str],
    committing: set[tuple[str, str]],
    file_label: str,
) -> list[dict[str, Any]]:
    """Committing calls in this function's loop bodies that nothing contains.

    Factored out of the hook scan so the scanner can be pointed at a synthetic
    known-bad function. Without that positive control, blinding the scanner is
    invisible: a gate that finds nothing and a gate that cannot see report the
    same empty result, which is how a green gate stops meaning anything.
    """
    hits: list[dict[str, Any]] = []
    for loop in [n for n in ast.walk(fn) if isinstance(n, (ast.For, ast.AsyncFor))]:
        guarded = _guarded_nodes(loop)
        for node in _loop_body_nodes(loop):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            callee = node.func.id
            if callee not in local and callee not in imports:
                continue
            key = (imports[callee], callee) if callee in imports else (module, callee)
            if key not in committing or id(node) in guarded:
                continue
            hits.append({"call": callee, "file": file_label, "lineno": node.lineno})
    return hits


def unguarded_commits_in_hooks() -> dict[str, list[dict[str, Any]]]:
    """hook name -> committing calls sitting in a loop with no containment."""
    committing = _committing_functions()
    findings: dict[str, list[dict[str, Any]]] = {}
    for hook, (path, fn_name) in _hook_roster().items():
        local = _module_functions(path)
        fn = local.get(fn_name)
        if fn is None:
            continue
        hits = unguarded_commits_in_function(
            fn,
            module=path.relative_to(KERNEL).as_posix()[: -len(".py")].replace("/", "."),
            local=local,
            imports=_module_imports(path),
            committing=committing,
            file_label=path.relative_to(REPO_ROOT).as_posix(),
        )
        if hits:
            findings[hook] = hits
    return findings


def _load_waivers() -> dict[str, dict[str, Any]]:
    if not WAIVERS_PATH.exists():
        return {}
    payload = json.loads(WAIVERS_PATH.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


REQUIRED_WAIVER_FIELDS = ("owner", "reason", "expires_on", "finding_id")


def waiver_defects(
    waivers: dict[str, dict[str, Any]],
    *,
    findings: dict[str, list[dict[str, Any]]],
    roster: dict[str, Any],
    today: date,
) -> list[str]:
    """Every reason a declared waiver is not a valid one.

    Written as a pure function of its inputs so the rules can be exercised
    directly. The repository currently declares no waivers — which would leave
    this machinery untested, and an untested control that nothing calls is the
    exact defect this whole programme keeps closing.
    """
    defects: list[str] = []
    for hook, waiver in sorted(waivers.items()):
        for field in REQUIRED_WAIVER_FIELDS:
            if field not in waiver:
                defects.append(f"{hook}: missing {field}")
        if not str(waiver.get("reason", "")).strip():
            defects.append(f"{hook}: empty reason")
        raw_expiry = str(waiver.get("expires_on", ""))
        try:
            expires = date.fromisoformat(raw_expiry)
        except ValueError:
            defects.append(f"{hook}: unparsable expires_on {raw_expiry!r}")
        else:
            # The lesson `invariant-reachability.spec.ts` paid for: validating
            # the SHAPE of a date lets every waiver expire together in silence.
            if expires < today:
                defects.append(f"{hook}: expired on {expires} ({waiver.get('finding_id')})")
        if hook not in roster:
            defects.append(f"{hook}: no longer a learning hook")
        elif hook not in findings:
            defects.append(f"{hook}: guarded now — delete the waiver rather than leaving a false record")
    return defects


class BatchContainmentGateTests(unittest.TestCase):
    def test_the_derivation_inputs_are_real(self):
        """A gate whose inputs silently vanish is a gate that passes for free."""
        committing = {name for _module, name in _committing_functions()}
        for expected in ("append_jsonl", "append_declared_jsonl", "record_workspace_governance"):
            self.assertIn(expected, committing, "the write closure stopped reaching a known writer")
        # …and just as load-bearing, that it does NOT reach a pure read. This
        # direction is the one that caught the `record_`-prefix seed.
        for pure_read in ("read_jsonl", "_finding_key", "classify_pressure", "_age_days"):
            self.assertNotIn(pure_read, committing, f"{pure_read} is a read; the closure is over-broad")
        roster = _hook_roster()
        self.assertGreaterEqual(len(roster), 12, "the hook roster collapsed — derivation is broken, not the code")

    def test_every_learning_hook_contains_failure_per_item(self):
        findings = unguarded_commits_in_hooks()
        waivers = _load_waivers()
        unwaived = {hook: hits for hook, hits in findings.items() if hook not in waivers}
        self.assertEqual(
            unwaived,
            {},
            "A hook commits inside a loop with no per-item containment: one bad item "
            "would leave the earlier writes on disk, skip every later item, and report "
            "a wholesale failure. Wrap the committing call in guard_item(), or declare "
            f"a waiver in {WAIVERS_PATH.name}.",
        )

    def test_the_declared_waivers_are_all_valid(self):
        self.assertEqual(
            waiver_defects(
                _load_waivers(),
                findings=unguarded_commits_in_hooks(),
                roster=_hook_roster(),
                today=date.today(),
            ),
            [],
        )


class ScannerPositiveControlTests(unittest.TestCase):
    """The gate must be provably able to SEE.

    G4 in this change's own mutation log: emptying the loop-body scan left the
    suite green, because with zero real findings a blinded scanner and a clean
    repository are indistinguishable. These cases give the scanner a known-bad
    input it must always flag, and known-good inputs it must never flag.
    """

    COMMITTING = {("ledger", "append_jsonl")}
    IMPORTS = {"append_jsonl": "ledger"}

    def _scan(self, source: str) -> list[dict[str, Any]]:
        tree = ast.parse(source)
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef))
        local = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        return unguarded_commits_in_function(
            fn, module="fake", local=local, imports=self.IMPORTS,
            committing=self.COMMITTING, file_label="fake.py",
        )

    def test_an_unguarded_commit_in_a_loop_is_found(self):
        hits = self._scan(
            "def hook(paths, rows):\n"
            "    for row in rows:\n"
            "        append_jsonl(paths, row)\n"
        )
        self.assertEqual([hit["call"] for hit in hits], ["append_jsonl"])

    def test_a_guarded_commit_is_not_found(self):
        hits = self._scan(
            "def hook(paths, rows):\n"
            "    failures = []\n"
            "    for row in rows:\n"
            "        guard_item(failures, item_kind='r', item_id='1',\n"
            "                   work=lambda row=row: append_jsonl(paths, row))\n"
        )
        self.assertEqual(hits, [])

    def test_a_commit_inside_an_explicit_try_is_not_found(self):
        hits = self._scan(
            "def hook(paths, rows):\n"
            "    for row in rows:\n"
            "        try:\n"
            "            append_jsonl(paths, row)\n"
            "        except Exception:\n"
            "            continue\n"
        )
        self.assertEqual(hits, [])

    def test_a_commit_in_the_loops_iterable_is_not_found(self):
        # Evaluated once, before any item exists: there is no per-item failure
        # to contain, and flagging it would be the gate's first false positive.
        hits = self._scan(
            "def hook(paths, rows):\n"
            "    for row in append_jsonl(paths, rows):\n"
            "        pass\n"
        )
        self.assertEqual(hits, [])

    def test_a_commit_outside_any_loop_is_not_found(self):
        hits = self._scan(
            "def hook(paths, rows):\n"
            "    append_jsonl(paths, rows)\n"
        )
        self.assertEqual(hits, [])


class WaiverRuleTests(unittest.TestCase):
    """The waiver rules themselves, exercised against synthetic declarations.

    Without these the waiver machinery would ship untested, because the
    repository declares no waivers today.
    """

    TODAY = date(2026, 8, 6)
    ROSTER = {"decay_recompute": None}
    FINDINGS = {"decay_recompute": [{"call": "append_jsonl", "file": "x.py", "lineno": 1}]}

    def _defects(self, waivers: dict[str, dict[str, Any]]) -> list[str]:
        return waiver_defects(waivers, findings=self.FINDINGS, roster=self.ROSTER, today=self.TODAY)

    def _valid(self, **overrides: Any) -> dict[str, dict[str, Any]]:
        waiver = {
            "owner": "okan",
            "reason": "fail-fast is deliberate here",
            "expires_on": "2026-09-06",
            "finding_id": "ORPHAN-HIGH-578",
        }
        waiver.update(overrides)
        return {"decay_recompute": waiver}

    def test_a_complete_current_waiver_is_accepted(self):
        self.assertEqual(self._defects(self._valid()), [])

    def test_a_waiver_past_its_deadline_is_refused(self):
        defects = self._defects(self._valid(expires_on="2026-08-05"))
        self.assertEqual(len(defects), 1)
        self.assertIn("expired on 2026-08-05", defects[0])

    def test_a_waiver_expiring_today_is_still_live(self):
        # The boundary the shape-only check could never have expressed.
        self.assertEqual(self._defects(self._valid(expires_on="2026-08-06")), [])

    def test_a_waiver_missing_a_required_field_is_refused(self):
        for field in REQUIRED_WAIVER_FIELDS:
            waiver = self._valid()
            del waiver["decay_recompute"][field]
            with self.subTest(field=field):
                self.assertTrue(self._defects(waiver), f"a waiver with no {field} was accepted")

    def test_a_waiver_with_an_empty_reason_is_refused(self):
        self.assertTrue(self._defects(self._valid(reason="   ")))

    def test_a_waiver_for_a_hook_since_guarded_is_refused(self):
        defects = waiver_defects(self._valid(), findings={}, roster=self.ROSTER, today=self.TODAY)
        self.assertEqual(len(defects), 1)
        self.assertIn("guarded now", defects[0])

    def test_a_waiver_naming_a_hook_that_no_longer_exists_is_refused(self):
        defects = waiver_defects(self._valid(), findings=self.FINDINGS, roster={}, today=self.TODAY)
        self.assertIn("no longer a learning hook", " ".join(defects))


if __name__ == "__main__":
    unittest.main()
