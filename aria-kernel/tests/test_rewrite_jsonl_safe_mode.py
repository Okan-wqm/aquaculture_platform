"""Plan 026R §A.2 — safe rewrite_jsonl lock-order + fsync invariants.

* rewrite_jsonl acquires the locks declared by _lock_requirements_for_path
* rewrite_jsonl fsyncs the tmp file via _atomic_write_text
* rewrite_jsonl on indexed paths holds index-group OUTER + per-file INNER
  in the correct order (instrumented via patched with_exclusive_lock).
* ARIA-MEDIUM-490: ``ledger.atomic_write_json`` owns the kernel JSON-file byte format
  and its durable temp-and-rename write; no kernel function keeps a private
  copy of that writer under any name (named variants write other bytes or
  another file mode).
* ARIA-MEDIUM-490: ``ledger.sha256_of_canonical_json`` is the content digest, and the
  ids routed through it are byte-identical to the formula they replaced.
"""
from __future__ import annotations

import ast
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from aria_kernel import ledger
from aria_kernel.ledger import (
    _lock_requirements_for_path,
    append_jsonl,
    rewrite_jsonl,
    verify_jsonl,
)


class RewriteJsonlSafeModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-rewrite-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------------
    # Lock acquisition per requirements
    # ------------------------------------------------------------------
    def test_rewrite_jsonl_acquires_lock_per_requirements_non_indexed(self) -> None:
        target = self.tmp / "claims.jsonl"
        target.touch()
        acquired: list[Path] = []
        real_lock = ledger.with_exclusive_lock

        @contextmanager
        def tracking(path, *args, **kwargs):
            acquired.append(Path(path).resolve())
            with real_lock(path, *args, **kwargs):
                yield

        with patch("aria_kernel.ledger.with_exclusive_lock", tracking):
            rewrite_jsonl(target, [{"event": "a"}, {"event": "b"}])

        # Non-indexed path → single per-file lock only.
        req = _lock_requirements_for_path(target)
        self.assertIsNone(req.index_group_lock_path)
        self.assertEqual(acquired, [target.resolve()])
        # Output is strict-clean.
        self.assertTrue(verify_jsonl(target)["valid"])

    # ------------------------------------------------------------------
    # tmp fsync via _atomic_write_text
    # ------------------------------------------------------------------
    def test_rewrite_jsonl_fsyncs_tmp_via_atomic_write_text(self) -> None:
        target = self.tmp / "claims.jsonl"
        import os
        fsync_paths: list[int] = []
        real_fsync = os.fsync

        def tracked(fd):
            fsync_paths.append(fd)
            return real_fsync(fd)

        with patch("aria_kernel.ledger.os.fsync", side_effect=tracked):
            rewrite_jsonl(target, [{"event": "a"}])

        # At least one fsync for the rewritten data (rewrite_jsonl invokes
        # _atomic_write_text inside _rewrite_jsonl_unlocked AND a separate
        # write of the integrity_index on indexed-group rewrites). Here
        # the path is non-indexed → exactly the tmp fsync at minimum.
        self.assertGreaterEqual(len(fsync_paths), 1)
        self.assertTrue(verify_jsonl(target)["valid"])

    # ------------------------------------------------------------------
    # Indexed lock order: outer index-group, inner per-file
    # ------------------------------------------------------------------
    def test_rewrite_jsonl_indexed_path_holds_locks_in_correct_order(self) -> None:
        tools = self.tmp / "aria-tools"
        tools.mkdir()
        (tools / "integrity_index.json").write_text(
            json.dumps({"ledger_hashes": {}, "schema_version": 2}),
            encoding="utf-8",
        )
        target = tools / "cycles.jsonl"
        append_jsonl(target, {"event": "seed"})  # chain so rewrite has content
        acquired: list[Path] = []
        real_lock = ledger.with_exclusive_lock

        @contextmanager
        def tracking(path, *args, **kwargs):
            acquired.append(Path(path).resolve())
            with real_lock(path, *args, **kwargs):
                yield

        with patch("aria_kernel.ledger.with_exclusive_lock", tracking):
            rewrite_jsonl(target, [{"event": "rewritten"}])

        # Indexed-group path: the first 2 acquisitions are the public
        # rewrite_jsonl's own (OUTER index-group → INNER per-file).
        # Subsequent acquisitions are siblings during the held-lock-aware
        # index refresh and are unordered by group invariant.
        req = _lock_requirements_for_path(target)
        self.assertIsNotNone(req.index_group_lock_path)
        index_lock = req.index_group_lock_path.resolve()
        file_lock = req.file_lock_path.resolve()
        self.assertGreaterEqual(len(acquired), 2)
        self.assertEqual(acquired[0], index_lock,
                         "OUTER index-group lock must be first")
        self.assertEqual(acquired[1], file_lock,
                         "INNER per-file lock must be second")


_KERNEL_DIR = Path(__file__).resolve().parents[1] / "aria_kernel"


class AtomicWriteJsonOwnerTests(unittest.TestCase):
    """ARIA-MEDIUM-490 — one owner for the kernel's JSON-file byte format and write path.

    Private copies lived in more than a dozen kernel modules, under many
    names; most used a fixed shared ``.<name>.tmp`` side-car and none
    fsynced, so two writers could consume each other's tmp file and a crash
    could leave a torn file.
    """

    # Functions that pair the indent-2 JSON format with their own temp file
    # and rename, kept on purpose because their bytes or mode differ from
    # ``atomic_write_json``. A new entry needs the same kind of reason.
    _DIFFERENT_BYTES_OR_MODE: dict[tuple[str, str], str] = {
        ("autonomous_host_lease.py", "_atomic_write_lease"):
            "no trailing newline; the tmp is unique per lease pid",
        ("autonomous_host_lease.py", "_atomic_write_remote_cas_lease"):
            "no trailing newline; the tmp is unique per process",
        ("gh_token_factory.py", "_write_signing_config_snapshot"):
            "the staging file is chmod 0o600 before the rename (signing config)",
    }

    @staticmethod
    def _private_writers() -> list[tuple[str, str]]:
        def indent2_json(node: ast.AST) -> bool:
            return (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"dumps", "dump"}
                and any(
                    kw.arg == "indent" and isinstance(kw.value, ast.Constant) and kw.value.value == 2
                    for kw in node.keywords
                )
            )

        def rename_into_place(node: ast.AST) -> bool:
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                return False
            receiver = node.func.value
            if node.func.attr == "replace" and isinstance(receiver, ast.Name) and receiver.id == "os":
                return True
            return (
                node.func.attr in {"replace", "rename"}
                and isinstance(receiver, ast.Name)
                and len(node.args) == 1
                and not node.keywords
            )

        found: list[tuple[str, str]] = []
        for path in sorted(_KERNEL_DIR.rglob("*.py")):
            if "__pycache__" in path.parts or path.name == "ledger.py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    inner = list(ast.walk(node))
                    if any(indent2_json(n) for n in inner) and any(rename_into_place(n) for n in inner):
                        found.append((path.relative_to(_KERNEL_DIR).as_posix(), node.name))
        return found

    def test_no_private_copy_of_the_writer_under_any_name(self) -> None:
        # The name-only gate below let renamed copies through
        # (`_atomic_fsync_write`, `_write_record_atomic`, an inline tmp in
        # `add_fixture`, ...). This one matches the shape: the format plus a
        # temp-and-rename in one function.
        self.assertEqual(
            sorted(self._private_writers()),
            sorted(self._DIFFERENT_BYTES_OR_MODE),
        )

    def test_atomic_write_json_has_one_owner(self) -> None:
        definitions: list[tuple[str, str]] = []
        for path in sorted(_KERNEL_DIR.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {
                    "atomic_write_json",
                    "_atomic_write_json",
                }:
                    definitions.append((path.name, node.name))
        self.assertEqual(definitions, [("ledger.py", "atomic_write_json")])

        # Inside the owner module, the indent=2 format string itself is spelled once.
        tree = ast.parse((_KERNEL_DIR / "ledger.py").read_text(encoding="utf-8"))
        indent2_dumps: list[str] = []

        def visit(node: ast.AST, enclosing: str) -> None:
            for child in ast.iter_child_nodes(node):
                name = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else enclosing
                if (
                    isinstance(child, ast.Call)
                    and isinstance(child.func, ast.Attribute)
                    and child.func.attr == "dumps"
                    and any(
                        kw.arg == "indent" and isinstance(kw.value, ast.Constant) and kw.value.value == 2
                        for kw in child.keywords
                    )
                ):
                    indent2_dumps.append(name)
                visit(child, name)

        visit(tree, "<module>")
        self.assertEqual(indent2_dumps, ["atomic_write_json"])

    def test_atomic_write_json_bytes_and_no_tmp_residue(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "state.json"
            ledger.atomic_write_json(target, {"b": 1, "a": 2})
            self.assertEqual(target.read_bytes(), b'{\n  "a": 2,\n  "b": 1\n}\n')
            self.assertEqual(sorted(p.name for p in Path(tmp).glob(".*.tmp")), [])


def _old_digest(value: object) -> str:
    # The inline formula sha256_of_canonical_json replaced, kept here as the stability pin.
    import hashlib

    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


class CanonicalJsonDigestTests(unittest.TestCase):
    """ARIA-MEDIUM-490 — one owner for the canonical content digest; ids stay stable."""

    def test_no_inline_copy_of_the_canonical_digest(self) -> None:
        # sha256 over json.dumps(sort_keys=True, separators=(",", ":")) spelled
        # inline is `ledger.sha256_of_canonical_json`; a copy outside ledger.py
        # is a second spelling of the same identity (finding ids, PSE ids,
        # proof and envelope hashes). Scope: the one-expression spelling. The
        # two-step one (`raw = json.dumps(...)`, then `sha256(raw.encode())`)
        # is not matched here and still exists at other kernel sites.
        def canonical_dumps(node: ast.AST) -> bool:
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "dumps"
                and len(node.args) == 1
            ):
                return False
            keywords = {kw.arg: kw.value for kw in node.keywords}
            if set(keywords) - {"sort_keys", "separators", "ensure_ascii"}:
                return False
            sort_keys = keywords.get("sort_keys")
            separators = keywords.get("separators")
            ensure_ascii = keywords.get("ensure_ascii", ast.Constant(value=True))
            return (
                isinstance(sort_keys, ast.Constant) and sort_keys.value is True
                and isinstance(separators, ast.Tuple)
                and [getattr(item, "value", None) for item in separators.elts] == [",", ":"]
                and isinstance(ensure_ascii, ast.Constant) and ensure_ascii.value is True
            )

        def inline_digest(node: ast.AST) -> bool:
            if not (isinstance(node, ast.Call) and node.args):
                return False
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
            argument = node.args[0]
            return (
                "sha256" in name
                and isinstance(argument, ast.Call)
                and isinstance(argument.func, ast.Attribute)
                and argument.func.attr == "encode"
                and canonical_dumps(argument.func.value)
            )

        copies = [
            f"{path.relative_to(_KERNEL_DIR).as_posix()}:{node.lineno}"
            for path in sorted(_KERNEL_DIR.rglob("*.py"))
            if "__pycache__" not in path.parts and path.name != "ledger.py"
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
            if inline_digest(node)
        ]
        self.assertEqual(copies, [])

    def test_digest_matches_the_replaced_formula(self) -> None:
        for value in ({"b": 1, "a": "ç"}, [{"ref": "x.py:1"}, {"ref": "y.py:2"}], []):
            with self.subTest(value=value):
                self.assertEqual(ledger.sha256_of_canonical_json(value), _old_digest(value))

    def test_feedback_and_finding_ids_are_unchanged(self) -> None:
        from aria_kernel import feedback, feedback_store

        identity = {"source": "operator", "kind": "missed_signal", "ref": "apps/x.ts:1"}
        self.assertEqual(
            feedback._stable_event_id("fb", "Missed Signal", identity),
            f"fb-{feedback.slug('Missed Signal')[:48]}-{_old_digest(identity)[:16]}",
        )
        finding = {"rule": "R1", "path": "apps/x.ts", "message": "m", "evidence": [{"ref": "apps/x.ts:1"}]}
        self.assertEqual(
            feedback_store.evidence_hash_for_finding(finding), "sha256:" + _old_digest(finding["evidence"]),
        )
        evidence_hash = feedback_store.evidence_hash_for_finding(finding)
        normalized = {
            "tool_id": "tool-a",
            "rule": "r1",
            "path": "apps/x.ts",
            "evidence_hash": evidence_hash,
            "message": feedback_store._normalize_message("m"),
        }
        self.assertEqual(
            feedback_store.finding_fingerprint("tool-a", finding), f"finding:{_old_digest(normalized)}",
        )


if __name__ == "__main__":
    unittest.main()
