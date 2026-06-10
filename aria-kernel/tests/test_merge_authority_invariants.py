from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

from aria_kernel.fixture_runner import run_fixture_case
from aria_kernel.auto_merge import GhCliGitHubAdapter
from aria_kernel.implementation_safety import BashAllowlistMiss, verify_bash_command_allowed
from aria_kernel.tool_registry import GovernanceError


KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"


def _literal_string(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else "{}" for part in node.values)
    return None


def _contains_merge_endpoint(value: str) -> bool:
    return "/pulls/" in value and "/merge" in value


def _merge_violations(
    tree: ast.AST,
    *,
    allow_merge_pr_call: bool = False,
    allow_merge_endpoint: bool = False,
) -> list[int]:
    violations: list[int] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr == "merge_pr" and not allow_merge_pr_call:
                violations.append(node.lineno)
            if isinstance(func, ast.Call):
                inner = func.func
                if isinstance(inner, ast.Name) and inner.id == "getattr":
                    if len(func.args) >= 2 and _literal_string(func.args[1]) == "merge_pr" and not allow_merge_pr_call:
                        violations.append(node.lineno)
                if isinstance(inner, ast.Attribute) and inner.attr == "__getattribute__":
                    if func.args and _literal_string(func.args[0]) == "merge_pr" and not allow_merge_pr_call:
                        violations.append(node.lineno)
            for arg in [*node.args, *(kw.value for kw in node.keywords)]:
                text = _literal_string(arg)
                if text and _contains_merge_endpoint(text) and not allow_merge_endpoint:
                    violations.append(getattr(arg, "lineno", node.lineno))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            values: list[ast.AST] = []
            if isinstance(node, ast.Assign):
                values.append(node.value)
            else:
                values.append(node.value) if node.value is not None else None
            for value in values:
                text = _literal_string(value)
                if text and _contains_merge_endpoint(text) and not allow_merge_endpoint:
                    violations.append(getattr(value, "lineno", node.lineno))
        elif isinstance(node, ast.List):
            for item in node.elts:
                text = _literal_string(item)
                if text and _contains_merge_endpoint(text) and not allow_merge_endpoint:
                    violations.append(getattr(item, "lineno", node.lineno))
    return sorted(set(violations))


class MergeAuthorityInvariants(unittest.TestCase):
    def test_real_merge_call_only_in_merge_authority(self) -> None:
        violations: list[str] = []
        for path in sorted(KERNEL.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for lineno in _merge_violations(
                tree,
                allow_merge_pr_call=path.name == "merge_authority.py",
                allow_merge_endpoint=path.name == "implementation_safety.py",
            ):
                violations.append(f"{path.relative_to(KERNEL)}:{lineno}")
        self.assertEqual(violations, [], "\n".join(violations))

    def test_merge_scanner_poison_fixtures(self) -> None:
        poisons = [
            "adapter.merge_pr(1)",
            "getattr(adapter, 'merge_pr')(1)",
            "adapter.__getattribute__('merge_pr')(1)",
            "endpoint = '/repos/o/r/pulls/1/merge'",
            "endpoint: str = '/repos/o/r/pulls/1/merge/'",
            "args=['gh', 'api', '/repos/o/r/pulls/1/merge?x=1']",
            "subprocess.run('gh api /repos/o/r/pulls/1/merge', shell=True)",
            "run = subprocess.run\nrun(['gh', 'api', '/repos/o/r/pulls/1/merge'])",
            "subprocess.run(f'/repos/o/r/pulls/{number}/merge')",
            "cmds.append('/repos/o/r/pulls/1/merge')",
            "cmds.extend(['/repos/o/r/pulls/1/merge'])",
        ]
        for source in poisons:
            with self.subTest(source=source):
                tree = ast.parse(source)
                self.assertTrue(_merge_violations(tree), source)

    def test_private_merge_authority_token_only_imported_by_authority(self) -> None:
        violations: list[str] = []
        for path in sorted(KERNEL.rglob("*.py")):
            text = path.read_text(encoding="utf-8")
            if "_REAL_MERGE_AUTHORITY" in text:
                violations.append(str(path.relative_to(KERNEL)))
        self.assertEqual(violations, [], "\n".join(violations))

    def test_python_c_escape_hatch_is_not_allowed(self) -> None:
        with self.assertRaises(BashAllowlistMiss):
            verify_bash_command_allowed(["python3", "-c", "print('escape')"])

    def test_python_absolute_script_path_is_not_allowed(self) -> None:
        with self.assertRaises(BashAllowlistMiss):
            verify_bash_command_allowed(["python3", "/tmp/tool.py"])

    def test_python_untrusted_relative_script_path_is_not_allowed(self) -> None:
        with self.assertRaises(BashAllowlistMiss):
            verify_bash_command_allowed(["python3", "tmp/tool.py"])

    def test_python_trusted_adapter_cwd_script_is_allowed(self) -> None:
        verify_bash_command_allowed(
            ["python3", "agent_harness_security_adapter.py"],
            cwd="tools/aria-adapters",
        )

    def test_live_github_adapter_rejects_direct_merge_without_authority(self) -> None:
        adapter = object.__new__(GhCliGitHubAdapter)
        adapter.cwd = Path(".")
        adapter._merge_authority_token = None
        with self.assertRaisesRegex(GovernanceError, "merge_pr_requires_merge_authority"):
            adapter.merge_pr(1, method="squash", expected_head_sha="a" * 40)

    def test_fixture_runner_rechecks_stale_registry_argv_at_runtime(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-runner-policy-") as raw:
            root = Path(raw)
            case_path = root / "case.json"
            case_path.write_text("{}", encoding="utf-8")
            tool = {
                "tool_id": "unsafe-tool",
                "runner": {
                    "type": "subprocess",
                    "argv": ["python3", "-c", "print('escape')"],
                    "cwd": ".",
                    "timeout_ms": 1000,
                    "stdin_json": False,
                },
            }
            with self.assertRaisesRegex(GovernanceError, "runner_argv_policy_rejected"):
                run_fixture_case(tool, {}, case_path, root, root)


if __name__ == "__main__":
    unittest.main()
