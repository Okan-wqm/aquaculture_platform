"""ARIA-HIGH-124 (round 2) — the executor's kernel CLI never resolves from the agent's cwd.

Every kernel command an executor runs after the spawn (`human-required
record`, `agent release`, `agent submit-result`, the drain's `agent
next-pending`, the worker lane's `worker list` / `worker-result submit`)
inherits the process cwd — in the drain's lane the REQUEST WORKTREE the
agent just wrote to — and `python -m` used to put that cwd first on
sys.path: an `aria_kernel/__main__.py` the agent planted at its worktree
root ran AS the executor's kernel command, outside the sandbox, with the
lease token and the delivery token in its environment (reproduced under
real bwrap; the end-to-end pin is
`tests/test_executor_implementation_identity.py::…planted_at_the_worktree_root…`).

Three pins:

* the one helper spells the interpreter, `-P` and `-m aria_kernel`;
* run from a directory that holds a planted `aria_kernel` package and a
  `json` shadow, the helper's argv reaches the REAL kernel and the planted
  modules record nothing — while the pre-change spelling (no `-P`) from
  the same directory runs the planted package, which is the pin's teeth;
* no executor spells a kernel argv anywhere but through the helper (an
  AST scan for the literal `"-m", "aria_kernel"` sequence).
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import kernel_cli  # noqa: E402

EXECUTORS = ("ci_executor.py", "ci_executor_drain.py", "worker_executor.py")


class KernelCliArgvTests(unittest.TestCase):
    def test_the_helper_spells_this_interpreter_safe_path_and_the_module(self) -> None:
        self.assertEqual(kernel_cli.KERNEL_CLI_INTERPRETER_FLAGS, ("-P",))
        self.assertEqual(kernel_cli.kernel_cli_argv("agent", "claim", "--request-id", "r"),
                         [sys.executable, "-P", "-m", "aria_kernel", "agent", "claim", "--request-id", "r"])
        import ci_executor

        self.assertIs(ci_executor._kernel_cli_argv, kernel_cli.kernel_cli_argv)
        self.assertIs(ci_executor.KERNEL_CLI_INTERPRETER_FLAGS, kernel_cli.KERNEL_CLI_INTERPRETER_FLAGS)

    def test_a_planted_package_in_the_cwd_never_answers_the_helpers_argv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-124-shadow-") as scratch:
            cwd = Path(scratch)
            marker = cwd / "marker.jsonl"
            (cwd / "aria_kernel").mkdir()
            (cwd / "aria_kernel" / "__init__.py").write_text("", encoding="utf-8")
            (cwd / "aria_kernel" / "__main__.py").write_text(
                "import json, os, sys\n"
                f"open({str(marker)!r}, 'a').write(json.dumps({{'module': 'aria_kernel', 'argv': sys.argv[1:]}}) + '\\n')\n"
                "print('planted')\n",
                encoding="utf-8",
            )
            (cwd / "json.py").write_text(
                "import os as _os, sys as _sys\n"
                f"open({str(marker)!r}, 'a').write('{{\"module\": \"json\"}}\\n')\n"
                "_here = _os.path.dirname(_os.path.abspath(__file__))\n"
                "_sys.path[:] = [p for p in _sys.path if _os.path.abspath(p or _os.getcwd()) != _here]\n"
                "del _sys.modules['json']\n"
                "from json import *\n",
                encoding="utf-8",
            )
            env = {**os.environ, "PYTHONPATH": str(_KERNEL_DIR), "PYTHONDONTWRITEBYTECODE": "1"}
            real = subprocess.run(kernel_cli.kernel_cli_argv("--help"), cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(real.returncode, 0, real.stderr[-800:])
            self.assertIn("usage:", real.stdout.lower())
            self.assertNotIn("planted", real.stdout)
            self.assertFalse(marker.exists(), "a planted module ran in the kernel subprocess: " + (marker.read_text() if marker.exists() else ""))
            # The teeth: the pre-change spelling from the same directory runs
            # the planted package (and imports the planted json).
            legacy = subprocess.run([sys.executable, "-m", "aria_kernel", "--help"], cwd=cwd, env=env,
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(legacy.stdout.strip(), "planted")
            rows = [json.loads(line) for line in marker.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row["module"] for row in rows], ["json", "aria_kernel"])

    def test_no_executor_spells_a_kernel_argv_outside_the_helper(self) -> None:
        for name in EXECUTORS:
            source = (_POC_DIR / name).read_text(encoding="utf-8")
            tree = ast.parse(source)
            spelled = []
            for node in ast.walk(tree):
                if not isinstance(node, (ast.List, ast.Tuple)):
                    continue
                values = [element.value for element in node.elts if isinstance(element, ast.Constant)]
                for index in range(len(values) - 1):
                    if values[index] == "-m" and values[index + 1] == kernel_cli.KERNEL_CLI_MODULE:
                        spelled.append(node.lineno)
            with self.subTest(executor=name):
                self.assertEqual(spelled, [], f"{name} spells `-m aria_kernel` at lines {spelled}; use kernel_cli.kernel_cli_argv")
                self.assertIn("kernel_cli_argv(", source)
        # The helper itself is the only literal spelling.
        helper = ast.parse((_POC_DIR / "kernel_cli.py").read_text(encoding="utf-8"))
        literals = [node.value for node in ast.walk(helper) if isinstance(node, ast.Constant) and node.value == "-m"]
        self.assertEqual(literals, ["-m"])


if __name__ == "__main__":
    unittest.main()
