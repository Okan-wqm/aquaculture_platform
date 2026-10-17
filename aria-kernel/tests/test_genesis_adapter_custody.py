"""ARIA-HIGH-414 — a drafted adapter runs only as the bytes the kernel holds,
and its import allowlist holds whatever the spelling.

Four defects, one per class below:

* the allowlist was a static walk of ``import`` statements; Python reaches a
  module by spellings no walk enumerates, so it is enforced at runtime by the
  kernel launcher (``tools/aria-poc/genesis_adapter_launcher.py``). EVERY
  spelling here runs through the real launcher, and through the real room
  where bwrap is usable;
* Phase 2 calibrated ``python3 <draft_id>``, a path the drafter named; it now
  calibrates the bytes of the drafter's ACCEPTED result, and records their
  digest;
* nothing re-hashed drafted bytes at dispatch; the tool and fixture runners
  now run a genesis tool only as custody bytes that still hash to the custody
  and calibration digests.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.dispatcher_factory import select_sandbox_runner
from aria_kernel.genesis_adapter_custody import (
    CALIBRATION_KIND,
    CUSTODY_KIND,
    GENESIS_LAUNCHER_RELPATH,
    GENESIS_RUNNER_BASE,
    GenesisCustodyRefusal,
    launcher_command,
    run_staged_adapter,
    source_sha256,
    stage_accepted_draft,
    verify_genesis_dispatch,
)
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.runtime_artifacts import resolve_artifact_payload
from aria_kernel.skill_genesis_sandbox import UnsafeAdapterImport, verify_adapter_imports
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, register_tool
from aria_kernel.tool_runner import run_tool
from tests._helpers.sandbox_pins import require_sandbox_backend
from tests.test_enterprise_cycle import shadow_tool

KERNEL_CHECKOUT = Path(__file__).resolve().parents[2]
LAUNCHER = KERNEL_CHECKOUT / GENESIS_LAUNCHER_RELPATH
TOOL_ID = "genesis-room-adapter"

# A well-formed drafted adapter: allowlisted imports only, reads its stdin,
# prints the findings contract. `marker` proves WHICH bytes ran.
GOOD_SOURCE = """import json
import sys
from dataclasses import dataclass


@dataclass
class Hit:
    path: str


payload = json.loads(sys.stdin.read() or "{}")
print(json.dumps({"marker": "drafted-bytes", "findings": [], "observations": [], "read_paths": [],
                  "evidence_sources": [], "got": sorted(payload)}))
"""

# The import-allowlist bypasses: the six of the #1900 probe (probe1900/b) and
# the spellings found while deciding this fix. Each must be refused AT RUNTIME
# by the launcher, whether or not the static pre-check also sees it.
BYPASS_SPELLINGS = {
    "dunder_import": "__import__('subprocess')",
    "sys_modules": "import sys\nsys.modules['os'].system('true')",
    "exec_string": "exec(\"__import__('socket')\")",
    "eval_string": "eval(\"__import__('subprocess')\")",
    "compile_string": "exec(compile(\"__import__('ctypes')\", 'x', 'exec'))",
    "getattr_builtins": "import sys\ngetattr(sys.modules['builtins'], '__im' + 'port__')('subprocess')",
    "os_path_binds_os": "import os.path\nos.system('true')",
    "pathlib_reaches_os": "import pathlib\npathlib.os.system('true')",
    "generator_frame_builtins": "(x for x in [1]).gi_frame.f_builtins['__import__']('subprocess')",
    "singledispatch_string_annotation": (
        "import functools\n@functools.singledispatch\ndef f(a):\n    pass\n"
        "@f.register\ndef _(a: \"__import__('subprocess')\"):\n    pass\n"
    ),
    "importlib_import_module": "import sys\nsys.modules['importlib'].import_module('subprocess')",
    "imp_create_builtin": "import sys\nclass S:\n    name = '_posixsubprocess'\nsys.modules['_imp'].create_builtin(S())",
    "imp_create_dynamic": (
        "import sys\nclass S:\n    name = '_ctypes'\n    origin = '/nonexistent/_ctypes.so'\n"
        "sys.modules['_imp'].create_dynamic(S())"
    ),
    "posix_fork": "import sys\nsys.modules['posix'].fork()",
    "posix_spawn": "import sys\nsys.modules['os'].posix_spawn('/bin/true', ['true'], {})",
    "execve_memfd": "import sys\nos = sys.modules['os']\nos.execve(os.memfd_create('x'), ['x'], {})",
    "marshal_code": (
        "import sys\nm = sys.modules['marshal']\n"
        "exec(m.loads(m.dumps(compile(\"__import__('ctypes')\", 'x', 'exec'))))"
    ),
    "thread_start": "import sys\nsys.modules['_thread'].start_new_thread(print, (1,))",
    "repoint_the_hook": (
        "import sys\nframe = sys._getframe(0)\nwhile frame.f_back:\n    frame = frame.f_back\n"
        "frame.f_globals['_audit'].__code__ = (lambda event, args: None).__code__\n"
        "__import__('subprocess')"
    ),
    "settrace": "import sys\nsys.settrace(lambda *a: None)",
    "proc_self_mem_write": "open('/proc/self/mem', 'r+b')",
    "rebound_builtin_then_import": "import sys\nsys.modules['builtins'].ImportError = None\n__import__('subprocess')",
    # sandbox's review of fa29eea45: CPython does not verify bytecode, and an
    # out-of-bounds LOAD_CONST (RESUME; LOAD_CONST 200; RETURN_VALUE) was a
    # SIGSEGV under the launcher — the road to native code no hook sees.
    "crafted_bytecode": (
        "f = lambda: None\n"
        "bad = f.__code__.replace(co_code=bytes([151, 0, 100, 200, 83, 0]), co_consts=(None,), co_stacksize=4)\n"
        "type(f)(bad, {})()\n"
    ),
    "code_type_constructor": (
        "c = (lambda: None).__code__\n"
        "type(c)(0, 0, 0, 0, 4, 0, bytes([151, 0, 100, 200, 83, 0]), (None,), (), (), 'x', 'x', 'x', 1, b'', b'')\n"
    ),
    "marshal_loads": "import sys\nm = sys.modules['marshal']\nm.loads(m.dumps((lambda: None).__code__))",
    "frozen_object_unmarshal": (
        "import sys\n"
        "sys.modules['_imp'].get_frozen_object('x', sys.modules['marshal'].dumps((lambda: None).__code__))"
    ),
    # A stdlib FILE re-run from its source, never through the import
    # statement (and not from its cached .pyc, which marshal.loads refuses):
    # it stops at its first import of a module not yet loaded (sandbox's
    # re-review of 94501f67e: the loader form only ever reached the .pyc).
    "source_rerun_of_subprocess": (
        "import sys\npath = sys.modules['os'].path.dirname(sys.modules['os'].__file__) + '/subprocess.py'\n"
        "exec(compile(open(path, 'rb').read(), path, 'exec'), {'__name__': 'sp'})\n"
    ),
    "frozen_module_build": "import sys\nsys.modules['_imp'].init_frozen('runpy')",
}
# What a refusal looks like: the launcher's named events, or the import
# machinery with its native constructors removed.
REFUSAL_MARKERS = (
    "genesis_adapter_import_refused:",
    "genesis_adapter_capability_refused:",
    "module '_imp' has no attribute '",
    "'NoneType' object is not callable",  # a rebound ImportError still refuses
)


def _run_launcher_directly(source: str, payload: str = "{}") -> subprocess.CompletedProcess[str]:
    command = launcher_command(source, source_sha256(source))
    return subprocess.run(
        [sys.executable, str(LAUNCHER), command.sha256],
        input=command.stdin_header + payload, capture_output=True, text=True, timeout=60, check=False,
    )


def _git_workspace(base: Path) -> Path:
    """A committed checkout under /var/tmp (the room mounts its own /tmp)."""
    workspace = base / "workspace"
    (workspace / "src").mkdir(parents=True)
    (workspace / "src" / "app.ts").write_text("export const app = 1;\n", encoding="utf-8")
    (workspace / "decoy.py").write_text("print('{\"marker\": \"decoy\", \"findings\": []}')\n", encoding="utf-8")
    for argv in (["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]):
        subprocess.run(["git", *argv], cwd=workspace, check=True, capture_output=True)
    return workspace


def accept_drafter_result(tools: Path, request_id: str, details: dict, *, role: str = "primary_authoring") -> dict:
    """An accepted drafter result as the submit path leaves it: the sealed
    artifact, and the result row naming its path and sha256."""
    tools = ensure_tools_dir(tools)
    payload = json.dumps({"request_id": request_id, "details": details}).encode("utf-8")
    relpath = f"agent-invocations/outputs/content-addressed/responses/{request_id}.json"
    (tools / relpath).parent.mkdir(parents=True, exist_ok=True)
    (tools / relpath).write_bytes(payload)
    return append_declared_jsonl(tools / "agent-invocations" / "results.jsonl", {
        "request_id": request_id, "role": role, "status": "accepted", "agent_id": "aria-primary-drafter",
        "output_path": relpath, "output_hash": "sha256:" + hashlib.sha256(payload).hexdigest(),
        "transcript_hash": "sha256:" + "b" * 64,
    }, expected_surface="agent_invocation_results")


def _manifest() -> dict:
    tool = shadow_tool()
    tool.update({"tool_id": TOOL_ID, "declared_scope": ["src/app.ts"], "allowed_read_globs": ["src/app.ts"]})
    return tool


class StaticPreCheckTests(unittest.TestCase):
    """The AST walk is the EARLY refusal, by name — not the boundary."""

    def test_the_obvious_spellings_are_refused_by_name_before_any_room(self) -> None:
        for name in ("dunder_import", "sys_modules", "exec_string", "eval_string", "compile_string",
                     "getattr_builtins", "os_path_binds_os"):
            with self.subTest(spelling=name), self.assertRaises(UnsafeAdapterImport):
                verify_adapter_imports(BYPASS_SPELLINGS[name])

    def test_import_os_path_binds_os_and_only_the_aliased_form_is_allowed(self) -> None:
        # `os.path` is allowlisted, and `import os.path` binds the name `os`:
        # the allowed spelling handed the adapter os.system.
        with self.assertRaisesRegex(UnsafeAdapterImport, r"forbidden=\['os'\]"):
            verify_adapter_imports("import os.path\n")
        verify_adapter_imports("import os.path as osp\nfrom os.path import join\n")

    def test_spellings_no_ast_walk_can_see_pass_it_and_the_launcher_refuses_them(self) -> None:
        # THE DECISION, pinned: these use no import primitive by name, so a
        # name-based deny cannot be complete. The runtime refuses them.
        for name in ("pathlib_reaches_os", "generator_frame_builtins", "singledispatch_string_annotation"):
            with self.subTest(spelling=name):
                verify_adapter_imports(BYPASS_SPELLINGS[name])
                completed = _run_launcher_directly(BYPASS_SPELLINGS[name])
                self.assertNotEqual(completed.returncode, 0)
                self.assertTrue(any(marker in completed.stderr for marker in REFUSAL_MARKERS), completed.stderr)


class LauncherAllowlistTests(unittest.TestCase):
    """The launcher alone, on every host: the allowlist holds at runtime."""

    def test_every_bypass_spelling_is_refused_by_the_launcher(self) -> None:
        for name, source in BYPASS_SPELLINGS.items():
            with self.subTest(spelling=name):
                completed = _run_launcher_directly(source)
                self.assertNotEqual(completed.returncode, 0, f"{name} ran: {completed.stdout!r}")
                self.assertTrue(any(marker in completed.stderr for marker in REFUSAL_MARKERS), completed.stderr[-400:])

    def test_the_frozen_builders_are_real_without_the_launcher(self) -> None:
        # The same bytes, no launcher: `_imp` unmarshals them into a code
        # object — the refusal above is the launcher's, not a broken spelling.
        unhooked = subprocess.run(
            [sys.executable, "-c", BYPASS_SPELLINGS["frozen_object_unmarshal"].replace(
                "sys.modules['_imp'].get_frozen_object", "print(type(sys.modules['_imp'].get_frozen_object",
            ) + ").__name__)"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(unhooked.stdout.strip(), "code", unhooked.stderr)

    def test_an_allowlisted_adapter_runs_and_reads_its_input(self) -> None:
        completed = _run_launcher_directly(GOOD_SOURCE, payload='{"fixtures": []}')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["got"], ["fixtures"])

    def test_bytes_that_are_not_the_named_digest_never_start(self) -> None:
        command = launcher_command(GOOD_SOURCE, source_sha256(GOOD_SOURCE))
        completed = subprocess.run(
            [sys.executable, str(LAUNCHER), "0" * 64], input=command.stdin_header + "{}",
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual((completed.returncode, completed.stdout), (97, ""))
        self.assertIn("genesis_launcher_refused:source_digest_mismatch", completed.stderr)

    def test_the_kernel_refuses_to_build_a_command_for_bytes_that_are_not_the_digest(self) -> None:
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_bytes_unverified"):
            launcher_command(GOOD_SOURCE, "0" * 64)


class StagingTests(unittest.TestCase):
    """The bytes come only from the drafter's accepted, hash-matching result."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-genesis-stage-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_the_accepted_bytes_are_staged_with_their_provenance(self) -> None:
        row = accept_drafter_result(self.tools, "req-ok", {"adapter_source": GOOD_SOURCE, "adapter_manifest": _manifest()})
        staged = stage_accepted_draft("req-ok", base_dir=self.tools)
        self.assertEqual((staged.source, staged.sha256), (GOOD_SOURCE, source_sha256(GOOD_SOURCE)))
        self.assertEqual(staged.provenance["output_hash"], row["output_hash"])
        self.assertEqual(staged.provenance["result_ledger_hash"], row["ledger_hash"])

    def test_no_accepted_result_a_tampered_artifact_or_another_role_is_refused(self) -> None:
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_provenance_unresolved"):
            stage_accepted_draft("req-none", base_dir=self.tools)
        row = accept_drafter_result(self.tools, "req-tampered", {"adapter_source": GOOD_SOURCE, "adapter_manifest": _manifest()})
        (self.tools / row["output_path"]).write_text(json.dumps({"details": {"adapter_source": "print(1)\n"}}), encoding="utf-8")
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_provenance_unresolved"):
            stage_accepted_draft("req-tampered", base_dir=self.tools)
        accept_drafter_result(self.tools, "req-challenger", {"adapter_source": GOOD_SOURCE, "adapter_manifest": _manifest()},
                              role="challenger_authoring")
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_provenance_unresolved"):
            stage_accepted_draft("req-challenger", base_dir=self.tools)

    def test_a_non_python_or_statically_unsafe_draft_is_refused_by_name(self) -> None:
        accept_drafter_result(self.tools, "req-ts", {"adapter_source": "console.log(1)", "adapter_manifest": _manifest(),
                                                     "adapter_lang": "typescript"})
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_lang_unsupported"):
            stage_accepted_draft("req-ts", base_dir=self.tools)
        accept_drafter_result(self.tools, "req-unsafe", {"adapter_source": "import subprocess\n", "adapter_manifest": _manifest()})
        with self.assertRaisesRegex(GenesisCustodyRefusal, "unsafe_adapter_import"):
            stage_accepted_draft("req-unsafe", base_dir=self.tools)


class _RoomLayout(unittest.TestCase):
    def setUp(self) -> None:
        require_sandbox_backend()
        base = Path(tempfile.mkdtemp(prefix="aria-genesis-room-", dir="/var/tmp"))
        self.addCleanup(shutil.rmtree, base, True)
        self.workspace = _git_workspace(base)
        self.tools = base / "store" / "aria-tools"
        ensure_tools_dir(self.tools)
        self.corpus = base / "fixtures.jsonl"
        self.corpus.write_text(json.dumps({"finding_fingerprint": "fp-1", "label": "tp"}) + "\n", encoding="utf-8")


class CalibrationTests(_RoomLayout):
    """Phase 2 runs the accepted bytes, never a path the drafter named."""

    def test_the_live_sandbox_runs_the_accepted_bytes_not_the_file_the_draft_names(self) -> None:
        # Pre-fix: select_sandbox_runner ran `python3 <adapter_path or draft_id>`
        # in the workspace, so this draft calibrated decoy.py.
        accept_drafter_result(self.tools, "req-cal", {"adapter_source": GOOD_SOURCE, "adapter_manifest": _manifest()})
        draft = {"invocation_request_id": "req-cal", "draft_id": "decoy.py", "adapter_path": "decoy.py",
                 "adapter_source": "print('a draft field is not the bytes')\n", "_workspace_root": "/"}
        result = select_sandbox_runner()(
            primary_draft=draft, calibration_corpus_path=self.corpus, workspace_root=self.workspace, base_dir=self.tools,
        )
        self.assertEqual(result["exit_code"], 0, result["raw_stderr_tail"])
        self.assertEqual(json.loads(result["raw_stdout_tail"])["marker"], "drafted-bytes")
        self.assertEqual(result["adapter_sha256"], source_sha256(GOOD_SOURCE))
        [row] = [r for r in load_declared_jsonl(self.tools / "skill-genesis" / "sandbox.jsonl",
                                                 expected_surface="skill_genesis_sandbox") if r.get("kind") == CALIBRATION_KIND]
        self.assertEqual((row["adapter_sha256"], row["ledger_hash"]), (result["adapter_sha256"], result["calibration_ledger_hash"]))
        self.assertEqual(row["provenance"]["request_id"], "req-cal")

    def test_a_draft_without_an_accepted_result_never_runs(self) -> None:
        result = select_sandbox_runner()(
            primary_draft={"draft_id": "decoy.py"}, calibration_corpus_path=self.corpus,
            workspace_root=self.workspace, base_dir=self.tools,
        )
        self.assertEqual(result["exit_code"], -6)
        self.assertIn("genesis_adapter_provenance_unresolved", result["raw_stderr_tail"])
        self.assertEqual(result["fixture_count"], 1, "the corpus still counts, so the loop critiques rather than aborts")
        self.assertFalse((self.tools / "skill-genesis" / "sandbox.jsonl").exists(), "nothing ran, nothing is recorded")

    def test_every_bypass_spelling_is_refused_in_the_real_room(self) -> None:
        for name, source in BYPASS_SPELLINGS.items():
            with self.subTest(spelling=name):
                staged = mock.Mock(source=source, sha256=source_sha256(source))
                completed = run_staged_adapter(staged, workspace_root=self.workspace, input_text="{}",
                                               timeout_seconds=60, store=self.tools)
                self.assertNotEqual(completed.returncode, 0, f"{name} ran: {completed.stdout!r}")
                self.assertTrue(any(marker in completed.stderr for marker in REFUSAL_MARKERS), completed.stderr[-400:])


def _record(tools: Path, relpath: str, surface: str, row: dict) -> dict:
    return append_declared_jsonl(tools / relpath, {"schema_version": 1, **row}, expected_surface=surface)


class DispatchTests(_RoomLayout):
    """A genesis tool runs only as custody bytes that still verify."""

    def _custody(self, *, source: str = GOOD_SOURCE, sha256: str | None = None, runner: dict | None = None,
                 calibrated: str | None = None, event: str = "custody") -> None:
        digest = sha256 or source_sha256(source)
        calibration = _record(self.tools, "skill-genesis/sandbox.jsonl", "skill_genesis_sandbox", {
            "kind": CALIBRATION_KIND, "invocation_request_id": "req-d", "adapter_sha256": calibrated or digest,
        })
        _record(self.tools, "skill-genesis/materializations.jsonl", "skill_genesis_materializations", {
            "kind": CUSTODY_KIND, "event": event, "tool_id": TOOL_ID, "adapter_sha256": digest,
            "adapter_source": source, "calibration_ledger_hash": calibration["ledger_hash"],
            "runner": runner or self.runner,
        })

    def setUp(self) -> None:
        super().setUp()
        self.runner = {**GENESIS_RUNNER_BASE, "timeout_ms": 60000}
        tool = _manifest()
        tool["runner"] = dict(self.runner)
        register_tool(tool, base_dir=self.tools)

    def _run(self) -> dict:
        return run_tool(TOOL_ID, {"repo_snapshot": {"allowed_paths": ["src/app.ts"], "snapshot_mode": "committed",
                                                    "snapshot_hash": "sha256:room"}},
                        "cyc-genesis", workspace_root=self.workspace, base_dir=self.tools)

    def test_a_curated_tool_is_not_a_genesis_tool(self) -> None:
        self.assertIsNone(verify_genesis_dispatch(shadow_tool(), base_dir=self.tools))

    def test_the_launcher_runner_without_custody_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "genesis_adapter_custody_missing"):
            self._run()

    def test_verified_custody_bytes_run_through_the_launcher(self) -> None:
        self._custody()
        envelope = self._run()["envelope"]
        self.assertEqual(envelope["runner"]["genesis_adapter_sha256"], source_sha256(GOOD_SOURCE))
        # run_tool returns the stored row; the run's stdout lives in its artifact.
        stdout = resolve_artifact_payload(envelope["artifact_ref"], base_dir=self.tools)["payload"]["stdout"] or ""
        self.assertEqual(json.loads(stdout)["marker"], "drafted-bytes", envelope["runner"]["stderr_sample"])

    def test_bytes_that_no_longer_hash_to_custody_are_refused(self) -> None:
        self._custody(source=GOOD_SOURCE.replace("drafted-bytes", "swapped"), sha256=source_sha256(GOOD_SOURCE))
        with self.assertRaisesRegex(GovernanceError, "genesis_adapter_bytes_unverified"):
            self._run()

    def test_bytes_that_are_not_the_calibrated_bytes_are_refused(self) -> None:
        self._custody(calibrated="0" * 64)
        with self.assertRaisesRegex(GovernanceError, "genesis_adapter_calibration_unbound"):
            self._run()

    def test_a_runner_that_drifted_from_custody_is_refused(self) -> None:
        self._custody(runner={**self.runner, "timeout_ms": 1})
        with self.assertRaisesRegex(GovernanceError, "genesis_adapter_runner_drift"):
            self._run()

    def test_withdrawn_custody_is_refused(self) -> None:
        self._custody(event="withdrawn")
        with self.assertRaisesRegex(GovernanceError, "genesis_adapter_custody_withdrawn"):
            self._run()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
