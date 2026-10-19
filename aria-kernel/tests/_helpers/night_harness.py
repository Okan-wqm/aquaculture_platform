"""WP-P — the single-provider night harness: one store, the real nightly entry
point, the real planner hook and its executor child, and a declared vendor
substitution.

Promoted from the ARIA-HIGH-579 harness (``test_night_holds_while_every_
provider_is_out.py``): that harness proved the NONE-provider night through the
real ``cli_main autonomy run --profile standard``; this one proves the
ANY-single-provider night (operator decision 2026-10-18, HANDOVER §7) through
the SAME entry point, plus the lane 579 deliberately stood down — the planner
dispatch hook is NOT replaced here, so the real hook claims the round request,
serves it from a git worktree at its anchor, and the REAL ``ci_executor`` child
runs the native admission, the dispatch and the submit.

What stands in, and why (the substitution budget, WP-P design round 2 §3):

* the VENDOR only: a fake ``claude``/``codex`` CLI (in the workspace's
  gitignored ``aria-tools/fixture-bin``, the path the room can ro-bind — the
  native-lane precedent) or a local ``http.server`` for api.z.ai. The serving
  CLIs RECORD every invocation: a night that reaches the vendor leaves
  evidence, and the envelope they answer with is derived from the prompt the
  kernel rendered (the obligation ids are extracted, never assumed);
* the delivery periphery a child needs on a fixture host: the kernel source
  committed into the fixture workspace (the room ro-binds ``aria-kernel``
  under the workspace), a ``node_modules`` marker (the pre-claim host check),
  the disposable adaptive policy with ``managed_subscription`` admission (the
  native lanes' file), and the clock knobs the 579 harness also sets;
* nothing else. No admission, routing, orchestrator or store is patched.
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import ensure_tools_binding
from tests._helpers.git_fixtures import make_repo_with_initial_commit

_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"

# The agents a plan-convergence night's round requests address (plan_round_
# controller's DEFAULT_PLANNER_AGENTS for the planner roles).
NIGHT_AGENTS = ("aria-challenger-planner", "aria-primary-planner", "aria-cross-reviewer")

# The disposable operator configuration the native lanes use: adaptive
# runtime with managed-subscription admission. An executor child on a
# fixture host refuses nothing the production child would be granted.
_ADAPTIVE_POLICY = {"executor": {"adaptive_runtime": {
    "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
    "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
    "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
    "monetary_admission": "managed_subscription",
}}}

_CYCLE_FILES = {
    "src/app.ts": "export const app = true;\n",
    "package.json": '{"name":"fixture"}\n',
    "nx.json": '{"affected":{}}\n',
}


def _challenger_plan_content(title: str) -> dict[str, Any]:
    """A plan body the plan contract accepts: a tier claim and a declared command."""
    return {
        "schema_version": 1, "title": title,
        "summary": "a challenger body the plan contract accepts",
        "affected_surfaces": [{"paths": ["src/**"]}],
        "key_changes": [{"id": "kc-0", "description": "harden the fixture app",
                         "paths": ["src/app.ts"], "imports": []}],
        "validation_commands": [{"cmd": "npx nx affected --target=lint", "expected_exit": 0,
                                 "timeout_ms": 1_800_000}],
        "evidence_refs": ["src/app.ts:1"], "architectural_tier": 3, "risks": [],
    }


def _satisfaction_from_prompt(prompt: str) -> list[dict[str, Any]]:
    """Satisfaction rows for exactly the obligations the kernel's prompt carries.

    The prompt renders every must_satisfy entry as an ``<obligation_data
    id="...">`` block; the vendor substitute derives its answer from what it
    was actually asked, so a changed obligation set can never be satisfied by
    a stale fixture.
    """
    ids = re.findall(r'obligation_data id="([^"]+)"', prompt)
    if not ids:
        raise SystemExit(96)  # no obligations found: the prompt shape drifted
    return [{"id": identifier, "verdict": "satisfied", "evidence_refs": ["src/app.ts:1"]}
            for identifier in dict.fromkeys(ids)]


def serving_claude_cli(*, log: Path, plan_title: str) -> str:
    """The Claude vendor substitute: records every call, answers one stream-json run.

    Same shape as the native Claude lane's fixture (``--version``; ``-p`` with
    the prompt on stdin; assistant + result stream-json with a usage block),
    with the response derived from the rendered prompt. The recording travels
    BOTH ways the room allows: a best-effort append to the host-side log (the
    status probes run outside the room and always reach it), and the argv
    embedded in the answer's ``details`` — the native fixtures' rule that a
    child's observation rides inside its answer, because the room's private
    /tmp and read-only workspace hide every host path a log could live on.
    """
    return (
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"log = {str(log)!r}\n"
        "argv = sys.argv[1:]\n"
        "try:\n"
        "    with open(log, 'a', encoding='utf-8') as stream:\n"
        "        stream.write(json.dumps({'argv': argv}) + '\\n')\n"
        "except OSError:\n"
        "    pass\n"
        "if argv == ['--version']:\n"
        "    print('2.1.269 (Claude Code)'); raise SystemExit(0)\n"
        "prompt = sys.stdin.read()\n"
        "import re\n"
        "ids = re.findall(r'obligation_data id=\"([^\"]+)\"', prompt)\n"
        "satisfaction = [{'id': i, 'verdict': 'satisfied', 'evidence_refs': ['src/app.ts:1']}\n"
        "                for i in dict.fromkeys(ids)]\n"
        f"plan = {_challenger_plan_content(plan_title)!r}\n"
        "response = {'satisfaction_matrix': satisfaction, 'evidence_refs': ['src/app.ts:1'],\n"
        "            'plan_content': plan,\n"
        "            'details': {'note': 'fixture challenger', 'vendor_argv': argv}}\n"
        "message = json.dumps(response)\n"
        "print(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': "
        "[{'type': 'text', 'text': message}]}}))\n"
        "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': message,\n"
        "                  'usage': {'input_tokens': 900, 'output_tokens': 120}, "
        "'session_id': 'fixture-night-session'}))\n"
    )


def serving_codex_cli(*, log: Path, plan_title: str) -> str:
    """The Codex vendor substitute: records every call, answers the status probe and
    one ``exec --json`` run with the event vocabulary ``_invoke_native_codex`` reads
    (thread.started, item.completed, turn.completed with usage), honouring
    --output-last-message; exit 97 on any other argv (argv drift fails loudly).
    """
    return (
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"log = {str(log)!r}\n"
        "argv = sys.argv[1:]\n"
        "try:\n"
        "    with open(log, 'a', encoding='utf-8') as stream:\n"
        "        stream.write(json.dumps({'argv': argv}) + '\\n')\n"
        "except OSError:\n"
        "    pass\n"
        "if argv[:2] == ['login', 'status']:\n"
        "    print('Logged in using ChatGPT', file=sys.stderr); raise SystemExit(0)\n"
        "if not argv or argv[0] != 'exec':\n"
        "    raise SystemExit(97)\n"
        "prompt = sys.stdin.read()\n"
        "import re\n"
        "ids = re.findall(r'obligation_data id=\"([^\"]+)\"', prompt)\n"
        "satisfaction = [{'id': i, 'verdict': 'satisfied', 'evidence_refs': ['src/app.ts:1']}\n"
        "                for i in dict.fromkeys(ids)]\n"
        f"plan = {_challenger_plan_content(plan_title)!r}\n"
        "message = json.dumps({'satisfaction_matrix': satisfaction, 'evidence_refs': ['src/app.ts:1'],\n"
        "                      'plan_content': plan,\n"
        "                      'details': {'note': 'fixture challenger', 'vendor_argv': argv}})\n"
        "flag = lambda name: argv[argv.index(name) + 1] if name in argv else None\n"
        "out = flag('--output-last-message')\n"
        "if out:\n"
        "    open(out, 'w', encoding='utf-8').write(message)\n"
        "print(json.dumps({'type': 'thread.started', 'thread_id': 'fixture-night-thread'}))\n"
        "print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': message}}))\n"
        "print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 900, 'output_tokens': 120}}))\n"
    )


def zai_completion_for(prompt: str, *, plan_title: str) -> dict[str, Any]:
    """The api.z.ai substitute's one chat completion for the kernel-rendered prompt."""
    return {
        "id": "chatcmpl-night-zai-fixture", "model": "glm-5.3",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": json.dumps({
                         "satisfaction_matrix": _satisfaction_from_prompt(prompt),
                         "evidence_refs": ["src/app.ts:1"],
                         "plan_content": _challenger_plan_content(plan_title),
                         "details": {"note": "fixture challenger"},
                     })}}],
        "usage": {"prompt_tokens": 1200, "completion_tokens": 90},
    }


class NightStore:
    """A production-shaped store whose planner lane can really dispatch.

    The workspace is a git repository carrying what an executor child needs
    on a fixture host (the kernel source and the ``node_modules`` marker are
    COMMITTED because the child is served from a git worktree at the
    request's anchor — untracked paths would not exist there), the tools dir
    is bound to it, and the vendor's CLI (when there is one) lives in the
    gitignored ``aria-tools/fixture-bin`` the sandbox can ro-bind.
    """

    def __init__(self, tmp: Path, *, cli_script: str | None = None) -> None:
        self.tmp = tmp
        files: dict[str, str] = {
            ".gitignore": "aria-tools/\n__pycache__/\n",
            **_CYCLE_FILES,
            "aria-config/genesis_policy.json": json.dumps(_ADAPTIVE_POLICY) + "\n",
            "node_modules/.gitkeep": "",
        }
        for name in NIGHT_AGENTS:
            files[f".claude/agents/{name}.md"] = (_REPO_ROOT / ".claude/agents" / f"{name}.md").read_text(
                encoding="utf-8")
        kernel = tmp / "kernel-copy" / "aria_kernel"
        shutil.copytree(_KERNEL_DIR / "aria_kernel", kernel, ignore=shutil.ignore_patterns("__pycache__"))
        for path in sorted(kernel.rglob("*")):
            if path.is_file():
                files[f"aria-kernel/aria_kernel/{path.relative_to(kernel)}"] = path.read_text(encoding="utf-8")
        self.workspace = make_repo_with_initial_commit(tmp / "ws", files, name="workspace")
        self.tools = ensure_tools_binding(self.workspace / "aria-tools", workspace_root=self.workspace)
        self.fixture_bin = self.workspace / "aria-tools" / "fixture-bin"
        self.fixture_bin.mkdir(parents=True, exist_ok=True)
        (self.fixture_bin / "python3").symlink_to(sys.executable)
        if cli_script is not None:
            self.install_cli("claude", cli_script)
        for name in ("repo-state", "workspaces", "runner-temp"):
            (tmp / name).mkdir(exist_ok=True)

    def install_cli(self, name: str, script: str) -> Path:
        binary = self.fixture_bin / name
        binary.write_text(script, encoding="utf-8")
        binary.chmod(0o755)
        return binary

    def prepend_path(self, env: dict[str, str]) -> dict[str, str]:
        """The night's PATH: the fixture bin (what the room binds) ahead of the host's."""
        return {**env, "PATH": f"{self.fixture_bin}{os.pathsep}{env.get('PATH', os.defpath)}"}

    def night_env(self, host_env: dict[str, str]) -> dict[str, str]:
        """The full night environment: the host boundary plus the child's periphery."""
        env = self.prepend_path(host_env)
        env.update({
            "ARIA_REPO_STATE_ROOT": str(self.tmp / "repo-state"),
            "ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces"),
            "ARIA_TOOLS_DIR": str(self.tools),
            "ARIA_NOTIFY_CHANNELS": "none",
            "ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS": "0",
            "MAX_TIMEOUT_SECONDS": "120",
            "RUNNER_TEMP": str(self.tmp / "runner-temp"),
            "GITHUB_OUTPUT": str(self.tmp / "runner-temp" / "github-output.txt"),
            "GITHUB_RUN_ID": "wpp-single-provider-night",
            "PYTHONPATH": f"{_REPO_ROOT}{os.pathsep}{_KERNEL_DIR}",
        })
        return env

    # --- the ledgers a night's contract reads -------------------------------------------------

    def requests(self) -> list[dict[str, Any]]:
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        return list_agent_invocation_requests(base_dir=self.tools)

    def autonomy_rows(self) -> list[dict[str, Any]]:
        path = self.tools / "autonomy_state.jsonl"
        return load_jsonl(path) if path.exists() else []

    def governance(self) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        return load_jsonl(path) if path.exists() else []

    def cycles_rows(self) -> list[dict[str, Any]]:
        path = self.tools / "cycles.jsonl"
        return load_jsonl(path) if path.exists() else []

    def run(self) -> tuple[int, dict[str, Any], list[dict[str, Any]]]:
        """One night: ``autonomy run`` as the cycle step invokes it, unpatched.

        The planner daemon is the real one and its hook is the real one: the
        round request a night mints is claimed and served by the real
        ``ci_executor`` child in a git worktree at its anchor, exactly as on
        the runner — the vendor boundary alone is the fixture's.
        """
        before = len(self.autonomy_rows())
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli_main([
                "--tools-dir", str(self.tools), "autonomy", "run", "--workspace-root", str(self.workspace),
                "--profile", "standard", "--max-cycles", "1", "--max-iterations-per-phase", "1",
                "--cycle-deadline-seconds", "1800",
            ])
        return code, json.loads(out.getvalue()), self.autonomy_rows()[before:]


__all__ = [
    "NightStore", "NIGHT_AGENTS", "serving_claude_cli", "serving_codex_cli", "zai_completion_for",
]
