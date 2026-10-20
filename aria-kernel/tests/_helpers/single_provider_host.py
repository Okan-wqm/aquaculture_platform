"""WP-P — the single-provider hosts a night runs on, probed by the fleet.

Operator decision (2026-10-18, HANDOVER §7): with ANY single provider alive —
Claude, Z.ai or Codex — every cycle must complete. The night tests that prove
it run on a host that presents exactly one provider, and "exactly one" is not
a fixture's say-so: :meth:`SingleProviderHost.available` asks the production
availability oracle (``model_fleet.available_providers``) and the builders
refuse to hand out a host whose oracle answer is not ``[provider]``. A fixture
that stops isolating — a credential boundary leaking in, a CLI surviving on
PATH — fails the night tests and the matrix generator that share this module,
instead of quietly widening a night to a provider the scenario killed.

What a host IS (the declared substitution budget, design WP-P round 2 §3):

* the ENVIRONMENT boundary only: a private ``HOME``, a ``PATH`` of one bin
  directory plus the system path, the provider's credential boundary — and
  NOTHING ELSE from the calling environment. The environment is built, not
  filtered: no credential, no GitHub identity, no deadline, no mock-mode
  flag and no ``GIT_*`` of a calling hook (the 2026-10-18 worktree incident
  discipline) can survive a construction that starts from zero. The names a
  consumer must still unset when it PATCHES ``os.environ`` with a host env
  are declared in ``DROPPED_ENV_NAMES``;
* a recording CLI for the vendors that have one (Claude, Codex): it logs
  every invocation to a JSONL file and answers the public status probes
  (``--version`` / ``login status``), so a night that reaches the vendor
  leaves evidence and a night that must not spawn names the call that did;
* no vendor process at all for Z.ai (the kernel's own HTTP transport): the
  host names the credential file; the local ``http.server`` that stands in
  for api.z.ai belongs to the night test, as in
  ``test_ci_executor_native_zai``.

The hosts are shared by the single-provider night tests and the role x
provider matrix generator: one definition of "this host presents only P".
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from aria_kernel.model_fleet import available_providers

# Everything a host drops from the calling environment, by name. A night must
# not inherit a credential, a GitHub identity, a deadline or a mock-mode flag
# from the test process; GIT_* is dropped wholesale for the same reason the
# 2026-10-18 incident made it a rule everywhere (a linked worktree exports an
# absolute GIT_DIR to hooks, and fixture git ran on the real repo).
DROPPED_ENV_NAMES: tuple[str, ...] = (
    "GH_TOKEN", "GITHUB_TOKEN", "ARIA_GH_TOKEN", "ARIA_NOTIFY_GITHUB_REPO",
    "ARIA_ZAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY",
    "ANTHROPIC_AUTH_TOKEN", "CODEX_HOME", "ARIA_JOB_DEADLINE_EPOCH",
    "CLAUDE_CLI_MOCK", "CLAUDE_CONFIG_DIR", "ARIA_CLAUDE_OAUTH_TOKEN_FILE",
)

# The system path a host falls back to: the interpreter's own essentials
# (python3 for the executor child, git for task binding, bwrap for the rooms).
# os.defpath ("/bin:/usr/bin") is what the native lane tests use.
_SYSTEM_PATH = os.defpath


class HostIsolationError(AssertionError):
    """A host builder produced an environment the fleet's oracle disagrees with."""


class SingleProviderHost:
    """One temporary host presenting exactly one provider; a context manager."""

    def __init__(self, provider: str, root: Path, bin_dir: Path, env: dict[str, str],
                 invocation_log: Path) -> None:
        self.provider = provider
        self.root = root
        self.binary_dir = bin_dir
        self._env = env
        self.invocation_log = invocation_log

    # --- the boundary -------------------------------------------------------------------------

    def environ(self) -> dict[str, str]:
        """The host's environment (live reference; a test may add its own keys)."""
        return self._env

    def which(self, binary: str) -> str | None:
        return shutil.which(binary, path=self._env.get("PATH", _SYSTEM_PATH))

    def calls(self) -> list[dict[str, Any]]:
        """Every CLI invocation the recording CLIs logged, in order."""
        if not self.invocation_log.exists():
            return []
        return [json.loads(line) for line in self.invocation_log.read_text(encoding="utf-8").splitlines()
                if line.strip()]

    # --- the ratchet --------------------------------------------------------------------------

    def available(self) -> list[Any]:
        """The production oracle's answer for this host — asserted by the builder."""
        return available_providers(self._env)

    def patch(self):
        """Replace ``os.environ`` with this host's environment, in place, for a night.

        The in-process night (``cli_main autonomy run``) runs under the host's
        boundary exactly as an executor child would. Whatever the calling
        process carried is GONE for the night's duration — the same
        construction as the child env, so an in-process test cannot be wider
        than the subprocess lane it stands in for.
        """
        import unittest.mock

        return unittest.mock.patch.dict(os.environ, self._env, clear=True)

    # --- lifecycle ----------------------------------------------------------------------------

    def __enter__(self) -> "SingleProviderHost":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def _recorder_prelude(log: Path) -> str:
    return (
        "import json, sys\n"
        f"log = {str(log)!r}\n"
        "with open(log, 'a', encoding='utf-8') as stream:\n"
        "    stream.write(json.dumps({'argv': sys.argv[1:], 'cwd': __import__('os').getcwd()}) + '\\n')\n"
    )


# The default Claude CLI: answers the version probe and one stream-json run
# with a minimal envelope the caller is expected to replace (night tests embed
# their scenario's answer). Recording happens for EVERY invocation.
RECORDING_CLAUDE = (
    "#!" + sys.executable + "\n"
    + _recorder_prelude(Path("__CLAUDE_LOG__"))
    + "import json, sys\n"
    "argv = sys.argv[1:]\n"
    "if argv == ['--version']:\n"
    "    print('2.1.269 (Claude Code)'); raise SystemExit(0)\n"
    "sys.stdin.read()\n"
    "message = json.dumps({'satisfaction_matrix': [], 'evidence_refs': [], 'details': {}})\n"
    "print(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': "
    "[{'type': 'text', 'text': message}]}}))\n"
    "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': message,\n"
    "                  'usage': {'input_tokens': 100, 'output_tokens': 20}, 'session_id': 'fixture-session'}))\n"
)

# The default Codex CLI: answers the public login-status probe with the
# managed ChatGPT line, serves `exec --json` turns (thread.started, one
# item.completed carrying the final message, turn.completed with usage — the
# vocabulary `_invoke_native_codex` reads), honours --output-last-message,
# and exits 97 on any other argv so argv drift fails loudly against
# build_codex_argv.
RECORDING_CODEX = (
    "#!" + sys.executable + "\n"
    + _recorder_prelude(Path("__CODEX_LOG__"))
    + "import json, os, sys\n"
    "argv = sys.argv[1:]\n"
    "# The room inserts the run's configuration flags ahead of the subcommand\n"
    "# (command[1:1] = configuration_argv()), so the probe is matched by suffix.\n"
    "if argv[-2:] == ['login', 'status']:\n"
    "    print('Logged in using ChatGPT', file=sys.stderr); raise SystemExit(0)\n"
    "if not argv or argv[0] != 'exec':\n"
    "    raise SystemExit(97)\n"
    "prompt = sys.stdin.read()\n"
    "message = json.dumps({'satisfaction_matrix': [], 'evidence_refs': [], 'details': {}})\n"
    "flag = lambda name: argv[argv.index(name) + 1] if name in argv else None\n"
    "out = flag('--output-last-message')\n"
    "if out:\n"
    "    open(out, 'w', encoding='utf-8').write(message)\n"
    "print(json.dumps({'type': 'thread.started', 'thread_id': 'fixture-codex-thread'}))\n"
    "print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': message}}))\n"
    "print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'output_tokens': 20}}))\n"
)


def _write_cli(binary_dir: Path, name: str, script: str, log: Path) -> None:
    binary_dir.mkdir(parents=True, exist_ok=True)
    path = binary_dir / name
    path.write_text(script.replace("__" + name.upper() + "_LOG__", str(log)), encoding="utf-8")
    path.chmod(0o755)


def _base_env(root: Path, bin_dir: Path) -> dict[str, str]:
    """A minimal caller environment: nothing inherited but the locale and the system path."""
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{_SYSTEM_PATH}",
        "HOME": str(root / "home"),
        "TMPDIR": str(root / "tmp"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    (root / "home").mkdir(parents=True, exist_ok=True)
    (root / "tmp").mkdir(parents=True, exist_ok=True)
    return env


# The credential-boundary variable names per provider: a host presents its
# OWN provider's boundary and none of the others'. The oracle check enforces
# the provider set; this table names the variables for the seam assertions.
VENDOR_BOUNDARY_NAMES: dict[str, tuple[str, ...]] = {
    "anthropic": ("ARIA_CLAUDE_OAUTH_TOKEN_FILE", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY",
                  "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"),
    "zai": ("ARIA_ZAI_API_KEY", "ARIA_ZAI_API_KEY_FILE"),
    "openai": ("OPENAI_API_KEY", "CODEX_HOME"),
}


def _finish(provider: str, root: Path, bin_dir: Path, env: dict[str, str], log: Path) -> SingleProviderHost:
    host = SingleProviderHost(provider, root, bin_dir, env, log)
    keys = [p.key for p in host.available()]
    if keys != [provider]:
        host.close()
        raise HostIsolationError(
            f"single_provider_host[{provider}]: the fleet oracle sees {keys}, not ['{provider}']"
        )
    return host


def claude_host(*, cli_script: str | None = None, token_text: str = "claude-fixture-token\n",
                extra_env: dict[str, str] | None = None) -> SingleProviderHost:
    """A host with the managed Claude CLI and the kernel's gateway token, and nothing else."""
    root = Path(tempfile.mkdtemp(prefix=f"aria-host-claude-"))
    log = root / "claude-invocations.jsonl"
    bin_dir = root / "bin"
    _write_cli(bin_dir, "claude", cli_script or RECORDING_CLAUDE, log)
    token = root / "claude_oauth_token"
    token.write_text(token_text, encoding="utf-8")
    token.chmod(0o600)
    env = _base_env(root, bin_dir)
    env["ARIA_CLAUDE_OAUTH_TOKEN_FILE"] = str(token)
    env.update(extra_env or {})
    return _finish("anthropic", root, bin_dir, env, log)


def zai_host(*, key_text: str = "zai-fixture-key-not-a-secret\n", endpoint: str | None = None,
             extra_env: dict[str, str] | None = None) -> SingleProviderHost:
    """A host with only the Z.ai credential boundary (the kernel's own transport; no CLI)."""
    root = Path(tempfile.mkdtemp(prefix="aria-host-zai-"))
    log = root / "zai-invocations.jsonl"
    key = root / "zai.key"
    key.write_text(key_text, encoding="utf-8")
    key.chmod(0o600)
    env = _base_env(root, root / "bin")
    env["ARIA_ZAI_API_KEY_FILE"] = str(key)
    if endpoint is not None:
        env["ARIA_ZAI_ENDPOINT"] = endpoint
    env.update(extra_env or {})
    return _finish("zai", root, root / "bin", env, log)


def codex_host(*, cli_script: str | None = None, auth_json: str = '{"fixture":"managed-session"}\n',
               extra_env: dict[str, str] | None = None) -> SingleProviderHost:
    """A host with the Codex CLI and a managed ChatGPT session file, and nothing else."""
    root = Path(tempfile.mkdtemp(prefix="aria-host-codex-"))
    log = root / "codex-invocations.jsonl"
    bin_dir = root / "bin"
    _write_cli(bin_dir, "codex", cli_script or RECORDING_CODEX, log)
    codex_home = root / "codex-home"
    codex_home.mkdir()
    (codex_home / "auth.json").write_text(auth_json, encoding="utf-8")
    env = _base_env(root, bin_dir)
    env["CODEX_HOME"] = str(codex_home)
    env.update(extra_env or {})
    return _finish("openai", root, bin_dir, env, log)


__all__ = [
    "DROPPED_ENV_NAMES", "VENDOR_BOUNDARY_NAMES", "HostIsolationError", "RECORDING_CLAUDE", "RECORDING_CODEX", "SingleProviderHost",
    "claude_host", "codex_host", "zai_host",
]
