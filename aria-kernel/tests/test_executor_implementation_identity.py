"""ARIA-HIGH-115 — the implementer's signing identity is minted where the commit is made.

The V9 runner used to mint the cycle key inside its own run and revoke it in
``finally`` before the implementer had been claimed; the executor lane, which
claims the request later in a per-request worktree, minted nothing, and the
outcome recorder demanded a ``signer_key_fp`` the agent could not know. Every
executor-lane implementation result was therefore refused: with an empty
fingerprint by ``record_implementation_outcome``, with a fabricated one by
the bridge's ``git verify-commit``.

These pins run the ACTUAL executor child (``tools/aria-poc/ci_executor.py``)
in a per-request worktree the drain's own provisioning adds, with the ACTUAL
kernel claiming, submitting and bridging, under the REAL bwrap containment
(ARIA-HIGH-123: the sandbox derives the worktree's git binds from the
checkout, masks the private key, and binds the kernel-held signing agent's
socket — the pre-change containment bound only the workspace, so the agent's
first git command died ``not a git repository`` and these pins had to run a
pass-through ``bwrap``); the one declared substitute is the ``claude``
binary (a script that switches to the staged branch, edits the plan's file
and runs a plain ``git commit`` in its cwd, then answers the envelope). No
dry-run flag is set, so the bridge's verification is the real
``git verify-commit``. A host without a usable bwrap skips: the executor
refuses to claim there (``sandbox_unavailable``), which is its own pin
(``tests/test_containment_probe.py``).

One property per test:

* a plain ``git commit`` in the request worktree is signed by the key the
  executor minted there; the executor stamps that fingerprint on the result,
  the bridge verifies the commit against the PUBLIC key registered in
  ``kg_signers`` and the IMPL row lands (IMPLEMENTATION_RECORDED); the cost
  row carries the same fingerprint; the key is revoked and neither the sibling
  worktree nor the shared checkout carries any signing config;
* the registry holds the executor's public key BEFORE the agent starts, and
  the worktree's git config names the key while the agent runs;
* a commit made unsigned, or with another key, is refused
  ``commit_signature_unverified`` by name and the IMPL row never lands;
* a fabricated ``signer_key_fp`` from the agent is overwritten with the
  executor's and recorded (``implementation_signer_fp_overridden``), never
  trusted;
* an implementation request served from the shared checkout (no per-request
  worktree: ``--local`` would be the config every worktree shares) is
  released by name before any agent turn, harness-class in the claims ledger
  AND in the dispatch summary: the request is back on the queue with its
  requeue budget untouched, and nothing was minted — the scope is decided
  from the checkout's shape before any key or config write;
* a refusal decided before the spawn (the dispatch budget here) mints no
  identity and registers nothing: the identity is the LAST pre-spawn step,
  so a refused attempt leaves no ``kg_signers`` row for a key that never
  signed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (_POC_DIR, _KERNEL_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import ci_executor  # noqa: E402
import ci_executor_drain as drain  # noqa: E402

from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit  # noqa: E402
from tests._helpers.production_shaped import production_implementation_request  # noqa: E402

SOURCE = "apps/farm-service/src/sample-interval.ts"
PLAN_ID = "plan-aria-high-115"
CYCLE_ID = "cyc-aria-high-115"
PR_URL = "https://github.com/fixture/aria-high-115/pull/115"
_STATUS = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}


def _scripted_implementer(
    *, branch: str, base_sha: str, must_satisfy_ids: list[str], message: str,
    commit_shape: str = "plain", claimed_fingerprint: str | None = None,
) -> str:
    """The implementer as a script: the request's branch, the plan's file,
    one commit in its cwd, then the envelope. ``commit_shape`` is ``plain``
    (whatever the worktree's git config says), ``unsigned`` (``--no-gpg-sign``)
    or ``other_key`` (a key the executor never minted); ``claimed_fingerprint``
    is a value the agent asserts for ``signer_key_fp``, or None to omit it."""
    return (
        f"#!{sys.executable}\n"
        "import hashlib, json, os, subprocess, sys\n"
        "argv = sys.argv[1:]\n"
        "if argv == ['--version']:\n"
        "    print('2.1.269 (Claude Code)'); raise SystemExit(0)\n"
        "if argv[:3] == ['auth', 'status', '--json']:\n"
        f"    print(json.dumps({_STATUS!r})); raise SystemExit(0)\n"
        "prompt = sys.stdin.read()\n"
        "def git(*args):\n"
        "    done = subprocess.run(['git', *args], capture_output=True, text=True)\n"
        "    if done.returncode != 0:\n"
        "        sys.stderr.write('git ' + ' '.join(args[:2]) + ' rc=' + str(done.returncode) + ': ' + done.stderr.strip()[-600:] + '\\n')\n"
        "        raise SystemExit(1)\n"
        "    return done.stdout.strip()\n"
        "def config(key):\n"
        "    done = subprocess.run(['git', 'config', '--get', key], capture_output=True, text=True)\n"
        "    return done.stdout.strip() if done.returncode == 0 else None\n"
        "registry = os.path.join(os.environ['ARIA_TOOLS_DIR'], 'knowledge-graph', 'signers.jsonl')\n"
        "registered = [json.loads(line) for line in open(registry, encoding='utf-8')] if os.path.isfile(registry) else []\n"
        f"git('switch', '-q', '-c', {branch!r}, {base_sha!r})\n"
        f"open({SOURCE!r}, 'w', encoding='utf-8').write('export const sampleIntervalMs = 30000;\\n')\n"
        f"git('add', {SOURCE!r})\n"
        f"commit = ['commit', '-q', '-m', {message!r}]\n"
        + {
            "plain": "",
            "unsigned": "commit.append('--no-gpg-sign')\n",
            "other_key": (
                "other = os.path.join(os.environ['HOME'], 'other-key')\n"
                "subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', other], check=True)\n"
                "commit = ['-c', 'user.signingkey=' + other, *commit]\n"
            ),
        }[commit_shape]
        + "git(*commit)\n"
        "head = git('rev-parse', 'HEAD')\n"
        # ARIA-HIGH-123 — what the sandbox lets this process reach, probed
        # from the inside: each entry is a boolean the test asserts on.
        "def readable(path):\n"
        "    try:\n"
        "        open(path, 'rb').read(); return True\n"
        "    except OSError:\n"
        "        return False\n"
        "def writable(path):\n"
        "    try:\n"
        "        open(path, 'a').close(); return True\n"
        "    except OSError:\n"
        "        return False\n"
        "def rc(*args):\n"
        "    return subprocess.run(['git', *args], capture_output=True, text=True).returncode\n"
        "checkout = os.path.dirname(os.path.dirname(os.getcwd()))\n"
        "hooks = git('rev-parse', '--path-format=absolute', '--git-path', 'hooks')\n"
        "worktree_config = git('rev-parse', '--path-format=absolute', '--git-path', 'config.worktree')\n"
        "common = git('rev-parse', '--path-format=absolute', '--git-common-dir')\n"
        "private = git('rev-parse', '--path-format=absolute', '--git-dir')\n"
        "signingkey = config('user.signingkey') or ''\n"
        "store = os.environ.get('ARIA_TOOLS_DIR') or ''\n"
        # The store must not be reachable; a hook row must reach the kernel
        # through the broker's socket, which the client finds by name.
        "hook_payload = json.dumps({'session_id': 'sess-e2e', 'tool_use_id': 'toolu_e2e', 'hook_event_name': 'PostToolUse',\n"
        "    'tool_name': 'Bash', 'tool_input': {'command': 'git status'}, 'tool_response': {'exit_code': 0}})\n"
        "client = os.path.join(os.getcwd(), 'aria-kernel', 'aria_kernel', 'hook_client.py')\n"
        "hook = subprocess.run([sys.executable, client, 'post-tool'], input=hook_payload, capture_output=True, text=True)\n"
        "packs = [p for p in os.listdir(os.path.join(common, 'objects', 'pack')) if p.endswith('.pack')]\n"
        "def unlinkable(path):\n"
        "    try:\n"
        "        os.unlink(path); return True\n"
        "    except OSError:\n"
        "        return False\n"
        "sandbox = {\n"
        # The fixture CLI lives under the store (`fixture-bin/claude`, bound
        # read-only by the spawner as the real CLI is), so the store's ROOT
        # exists inside as that bind's parent; its ledgers must not.
        "    'store_ledgers_visible': any(os.path.exists(os.path.join(store, p)) for p in\n"
        "        ('agent-invocations', 'governance.jsonl', 'knowledge-graph', 'control', 'human-required')),\n"
        "    'store_forgeable': writable(os.path.join(store, 'agent-invocations', 'requests.jsonl')),\n"
        "    'hook_broker_env': os.environ.get('ARIA_HOOK_BROKER_SOCKET'),\n"
        "    'hook_client_rc': hook.returncode,\n"
        "    'git_object_directory': os.environ.get('GIT_OBJECT_DIRECTORY'),\n"
        "    'shared_objects_writable': writable(os.path.join(common, 'objects', 'aria-probe')),\n"
        "    'shared_pack_unlinkable': bool(packs) and unlinkable(os.path.join(common, 'objects', 'pack', packs[0])),\n"
        "    'alternates_writable': writable(os.path.join(common, 'objects', 'info', 'alternates')),\n"
        "    'maintenance_lock_plantable': writable(os.path.join(common, 'objects', 'maintenance.lock')),\n"
        "    'main_lock_planted_inside': writable(os.path.join(common, 'refs', 'heads', 'main.lock')),\n"
        "    'worktree_lock_written_inside': writable(os.path.join(private, 'locked')),\n"
        "    'private_key_readable': readable(signingkey),\n"
        "    'public_key_readable': readable(signingkey + '.pub'),\n"
        "    'hooks_writable': writable(os.path.join(hooks, 'aria-probe')),\n"
        "    'worktree_config_writable': writable(worktree_config),\n"
        "    'allowed_signers_writable': writable(config('gpg.ssh.allowedSignersFile') or ''),\n"
        "    'common_config_writable': writable(os.path.join(common, 'config')),\n"
        "    'signingkey_reconfigurable': rc('config', '--worktree', 'user.signingkey', '/tmp/other') == 0,\n"
        "    'local_config_writable_by_git': rc('config', '--local', 'aria.probe', '1') == 0,\n"
        "    'main_ref_rewritable': rc('update-ref', 'refs/heads/main', head) == 0,\n"
        "    'sibling_worktree_visible': os.path.exists(os.path.join(checkout, 'aria-worktrees', 'req-sibling')),\n"
        "    'sibling_git_dir_visible': os.path.exists(os.path.join(common, 'worktrees', 'req-sibling')),\n"
        "    'main_working_tree_visible': os.path.exists(os.path.join(checkout, 'apps')),\n"
        "    'dependency_tree_visible': os.path.isdir(os.path.join(checkout, 'node_modules')),\n"
        "    'ssh_auth_sock': os.environ.get('SSH_AUTH_SOCK'),\n"
        "    'tmpdir': os.environ.get('TMPDIR'),\n"
        "}\n"
        f"diff = git('diff', {base_sha!r}, head)\n"
        f"implementation = {{'branch': {branch!r}, 'pr_url': {PR_URL!r},\n"
        "    'diff_hash': 'sha256:' + hashlib.sha256(diff.encode('utf-8')).hexdigest(),\n"
        f"    'branch_tip_sha': head, 'base_branch_sha': {base_sha!r}, 'validation_results': []}}\n"
        + (f"implementation['signer_key_fp'] = {claimed_fingerprint!r}\n" if claimed_fingerprint else "")
        + f"matrix = [{{'id': item, 'verdict': 'satisfied', 'evidence_refs': [{SOURCE!r} + ':1']}} for item in {must_satisfy_ids!r}]\n"
        f"response = {{'satisfaction_matrix': matrix, 'evidence_refs': [{SOURCE!r} + ':1'],\n"
        "    'details': {'implementation': implementation, 'agent_observation': {\n"
        "        'cwd': os.getcwd(), 'registered_before_agent': registered,\n"
        "        'commit_gpgsign': config('commit.gpgsign'), 'user_signingkey': config('user.signingkey'),\n"
        "        'gpg_format': config('gpg.format'), 'allowed_signers': config('gpg.ssh.allowedSignersFile'),\n"
        "        'sandbox': sandbox}}}\n"
        "message = json.dumps(response)\n"
        "print(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': message}]}}))\n"
        "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': message,\n"
        "                  'usage': {'input_tokens': 900, 'output_tokens': 120}, 'session_id': 'fixture-session'}))\n"
    )


class ExecutorImplementationIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel import agent_invocations as ai
        from aria_kernel.implementation_safety import sandbox_backend
        from aria_kernel.tool_registry import ensure_tools_binding

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host; the executor refuses to claim here")
        scratch = tempfile.TemporaryDirectory(prefix="aria-115-identity-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.home = self.root / "home"
        self.binary_dir = self.root / "bin"
        self.runner_temp = self.root / "runner-temp"
        for path in (self.home, self.binary_dir, self.runner_temp, self.root / "repo-state"):
            path.mkdir()
        (self.binary_dir / "python3").symlink_to(sys.executable)
        config_dir = self.home / ".claude"
        config_dir.mkdir(parents=True)
        (config_dir / ".credentials.json").write_text('{"fixture":"managed-session"}\n', encoding="utf-8")
        self.ai = ai
        agent = _REPO_ROOT / ".claude/agents/aria-implementer.md"
        self.repo = make_repo_with_initial_commit(self.root, {
            ".gitignore": "aria-tools/\naria-debts/keys/\naria-worktrees/\nnode_modules/\n__pycache__/\n",
            SOURCE: "export const sampleIntervalMs = 60000;\n",
            ".claude/agents/aria-implementer.md": agent.read_text(encoding="utf-8"),
            # The in-sandbox hook client rides the checkout's own kernel tree
            # (ARIA-HIGH-123): the scripted implementer ships a hook through it.
            "aria-kernel/aria_kernel/hook_client.py": (_KERNEL_DIR / "aria_kernel" / "hook_client.py").read_text(encoding="utf-8"),
        }, name="checkout")
        # The shared store carries a pack, as the runner checkout's does.
        _git(["repack", "-a", "-d", "-q"], cwd=self.repo)
        # A validation command resolves node modules by walking up from the
        # worktree; the checkout carries them (the environment gate's probe).
        (self.repo / "node_modules").mkdir()
        # Operator policy: the legacy lane reserves opus's notional spawn
        # price against the per-run cap before it spawns; the shipped $0.50
        # refuses every implementer run, so the fixture's workspace raises
        # it (the override chain the kernel reads, not a test hook).
        policy = self.repo / "aria-config" / "genesis_policy.json"
        policy.parent.mkdir()
        policy.write_text(json.dumps({"cost_caps_usd": {"daily": 50.0, "monthly": 500.0, "per_run": 10.0}}) + "\n",
                          encoding="utf-8")
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        # The fixture CLI lives on a path the checkout carries, the way the
        # real CLI lives on a bound path (the native lanes' shape).
        self.fixture_bin = self.tools / "fixture-bin"
        self.fixture_bin.mkdir()
        self.environment = {
            "PATH": os.pathsep.join([str(self.fixture_bin), str(self.binary_dir), os.defpath]),
            "HOME": str(self.home), "CLAUDE_CONFIG_DIR": str(config_dir),
            "ARIA_REPO_STATE_ROOT": str(self.root / "repo-state"),
            "ARIA_WORKSPACE_BASE": str(self.root / "workspaces"),
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(_KERNEL_DIR),
            "GITHUB_RUN_ID": "aria-high-115", ci_executor.MOCK_MODE_ENV_VAR: "0",
            "ARIA_TOOLS_DIR": str(self.tools), "MAX_TIMEOUT_SECONDS": "60",
            "RUNNER_TEMP": str(self.runner_temp),
            # The suite runs as root here; the fixture binary is not the CLI,
            # so the sandbox acknowledgement changes nothing about what runs.
            "ARIA_CLAUDE_SANDBOX": "1",
            # The implementer profile declares external_writes: its delivery
            # credential is minted in the PAT-fallback mode from this value,
            # which is not a credential and is sent nowhere.
            "GH_TOKEN": "fixture-only-invalid-token",
            # The suite's hermetic git layers (tests/_helpers/hermetic_git),
            # so the child's git reads no machine-global signing config.
            **{name: os.environ[name] for name in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM") if name in os.environ},
        }
        self.base_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        with patch.dict(os.environ, {"ARIA_TOOLS_DIR": str(self.tools)}):
            self.request = production_implementation_request(
                tools_dir=self.tools, workspace_root=self.repo, plan_id=PLAN_ID,
                allowed_path=SOURCE, cycle_id=CYCLE_ID, base_sha=self.base_sha,
            )
        self.request_id = self.request["request_id"]
        self.ids = self.request["implementation_ids"]
        # The commit contract the kernel derived: a trailer only when the
        # plan's origin prints one (this fixture plan has no finding origin).
        trailer = self.request["commit_contract"]["trailer"]
        self.message = "fix(farm-service): halve the sample interval\n\nWHY: the plan says so.\n" + (
            f"\n{trailer}\n" if trailer else ""
        )
        # A sibling worktree of the same repository: what a per-worktree
        # identity must never reach.
        self.sibling = self.repo / drain.REQUEST_WORKTREES_DIR / "req-sibling"
        self.sibling.parent.mkdir(exist_ok=True)
        _git(["worktree", "add", "--detach", "-q", str(self.sibling), self.base_sha], cwd=self.repo)

    def _install_bwrap_without_the_quarantine_refs_bind(self) -> None:
        """ARIA-HIGH-123 — a runner whose containment cannot host a commit:
        the real bwrap, minus the one bind that stands the quarantine in for
        the shared `refs/heads` (the pre-change shape, where nothing under
        the common git dir was writable: `git switch -c` dies EROFS). Every
        other argv reaches bwrap unchanged."""
        import shutil

        real = shutil.which("bwrap")
        assert real is not None
        executable = self.fixture_bin / "bwrap"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import os, sys\n"
            "argv = sys.argv[1:]\n"
            "for index in range(len(argv) - 2):\n"
            "    if argv[index] == '--bind' and argv[index + 2].endswith('/.git/refs/heads'):\n"
            "        argv = argv[:index] + argv[index + 3:]\n"
            "        break\n"
            f"os.execv({real!r}, [{real!r}, *argv])\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)

    def _install_implementer(self, **shape: object) -> None:
        executable = self.fixture_bin / "claude"
        executable.write_text(_scripted_implementer(
            branch=self.ids["branch"], base_sha=self.base_sha,
            must_satisfy_ids=[item["id"] for item in self.request["must_satisfy"]],
            message=self.message, **shape,
        ), encoding="utf-8")
        executable.chmod(0o755)

    def _run_child(
        self, *, worktree: Path | None, extra_env: dict[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], Path | None]:
        """The drain's launch, verbatim: the per-request worktree it added is
        the child's cwd and its ``ARIA_WORKSPACE_ROOT``; without one the
        shared checkout is both (the lane's restore step exports the
        checkout as ``ARIA_WORKSPACE_ROOT`` and the drain inherits it)."""
        github_output = self.runner_temp / f"aria-drain-output-{self.request_id}.txt"
        cwd = self.repo if worktree is None else worktree
        environment = {**self.environment, "GITHUB_OUTPUT": str(github_output), "ARIA_WORKSPACE_ROOT": str(cwd),
                       **(extra_env or {})}
        completed = subprocess.run(
            ["python3", str(_POC_DIR / "ci_executor.py"), self.request_id, "aria-implementer"],
            cwd=str(cwd), env=environment, capture_output=True, text=True, timeout=240,
        )
        return completed, github_output

    def _run_in_request_worktree(
        self, *, extra_env: dict[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], Path]:
        provisioned = drain._add_request_worktree(self.repo, self.request_id, None)
        self.assertIsNone(provisioned.unanswered_reason)
        assert provisioned.path is not None
        worktree = provisioned.path
        try:
            self.worktree_config_before = self._signing_config(worktree)
            completed, _output = self._run_child(worktree=worktree, extra_env=extra_env)
            self.worktree_git_dir = Path(_git(["rev-parse", "--absolute-git-dir"], cwd=worktree).stdout.strip())
            self.worktree_config_after = self._signing_config(worktree)
            # The keys dir is created by the mint and outlives the revoke:
            # its existence says whether a mint ever ran in this worktree.
            self.worktree_keys_dir_existed = (worktree / "aria-debts" / "keys").is_dir()
            self.worktree_keys_after = sorted(
                path.name for path in (worktree / "aria-debts" / "keys").iterdir()
            ) if self.worktree_keys_dir_existed else []
        finally:
            self.assertIsNone(drain._remove_request_worktree(self.repo, worktree))
        return completed, worktree

    @staticmethod
    def _signing_config(checkout: Path) -> dict[str, str | None]:
        config: dict[str, str | None] = {}
        for key in ("commit.gpgsign", "gpg.format", "user.signingkey", "gpg.ssh.allowedSignersFile"):
            done = _git(["config", "--get", key], cwd=checkout, check=False)
            config[key] = done.stdout.strip() if done.returncode == 0 else None
        return config

    def _governance(self, kind: str) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return [row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                if row.get("kind") == kind]

    def _plan_state(self) -> str:
        from aria_kernel.plan_convergence import fold_plan_state

        return str(fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["state"])

    def _submitted_envelope(self) -> dict:
        return json.loads(Path(self.request["expected_output_path"]).read_text(encoding="utf-8"))

    def _registered(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        path = self.tools / "knowledge-graph" / "signers.jsonl"
        return load_declared_jsonl(path, expected_surface="kg_signers") if path.is_file() else []

    def _verify_against_registry(self, sha: str, fingerprint: str) -> bool:
        """``git verify-commit`` from the SHARED checkout, against nothing but
        the registered public key — the worktree and its config are gone."""
        row = next((row for row in self._registered() if row["signer_key_fp"] == fingerprint), None)
        self.assertIsNotNone(row, "the executor's public key must be on the kg_signers ledger")
        allowed = self.root / "allowed-from-registry"
        allowed.write_text(f"aria-cycle-{row['cycle_id']} {row['key_type']} {row['public_key']}\n", encoding="utf-8")
        done = _git(["-c", f"gpg.ssh.allowedSignersFile={allowed}", "verify-commit", "--raw", sha],
                    cwd=self.repo, check=False)
        found = re.search(r"SHA256:[A-Za-z0-9+/]+=*", done.stdout + done.stderr)
        return done.returncode == 0 and found is not None and found.group(0) == fingerprint

    def _diagnostic(self, completed: subprocess.CompletedProcess[str]) -> str:
        from aria_kernel.ledger import load_declared_jsonl

        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        return completed.stderr[-4000:] + "\n" + json.dumps(
            [{"kind": row["kind"], "details": row.get("details")} for row in rows[-12:]], sort_keys=True,
        )[:6000]

    def test_a_plain_commit_in_the_request_worktree_lands_the_impl_row(self) -> None:
        from aria_kernel.budget import read_cost_attribution

        self._install_implementer()
        completed, worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "ACCEPTED")
        envelope = self._submitted_envelope()
        implementation = envelope["details"]["implementation"]
        fingerprint = implementation["signer_key_fp"]
        self.assertTrue(fingerprint.startswith("SHA256:"), implementation)
        observed = envelope["details"]["agent_observation"]
        # The agent ran in the request worktree, with the executor's key
        # wired into THAT worktree's config, and the public key was on the
        # registry before its first command.
        self.assertEqual(Path(observed["cwd"]).resolve(), worktree.resolve())
        self.assertEqual(observed["commit_gpgsign"], "true")
        self.assertEqual(observed["gpg_format"], "ssh")
        self.assertEqual(Path(observed["user_signingkey"]), worktree / "aria-debts" / "keys" / CYCLE_ID)
        self.assertEqual(Path(observed["allowed_signers"]).parent, self.worktree_git_dir)
        # The registry is on the store, which the sandbox does not see
        # (ARIA-HIGH-123): the agent observes no rows. The public key was
        # registered BEFORE the agent's first command all the same — the
        # executor's stage line says so, and the row is on the ledger.
        self.assertEqual(observed["registered_before_agent"], [])
        self.assertEqual([row["signer_key_fp"] for row in self._registered()], [fingerprint])
        self.assertEqual([row["cycle_id"] for row in self._registered()], [CYCLE_ID])
        self.assertLess(completed.stderr.index("implementation_identity_held"), completed.stderr.index("claude_returned_exit"))
        # ARIA-HIGH-123 — inside the REAL sandbox: the private key is not
        # there to read (git signed through the kernel-held agent's socket),
        # the public half is; hooks, both configs, the signers file and the
        # loose `main` ref refuse writes; the sibling worktree, its git dir
        # and the main checkout's working tree are not even visible — only
        # its `node_modules`, the tree a nested worktree's validation suite
        # resolves; the temp dir is the sandbox's own.
        from aria_kernel.git_containment import SANDBOX_SIGNING_AGENT_SOCKET
        from aria_kernel.hook_broker import SANDBOX_HOOK_BROKER_SOCKET
        from aria_kernel.hooks import journal_rows_for
        from aria_kernel.implementation_safety import SANDBOX_TMPDIR

        self.assertEqual(observed["sandbox"], {
            "store_ledgers_visible": False, "store_forgeable": False,
            "hook_broker_env": SANDBOX_HOOK_BROKER_SOCKET, "hook_client_rc": 0,
            "git_object_directory": str(self.worktree_git_dir / "objects"),
            "shared_objects_writable": False, "shared_pack_unlinkable": False, "alternates_writable": False,
            "maintenance_lock_plantable": False,
            # Both land in the worktree's quarantine/replica, never on the host.
            "main_lock_planted_inside": True, "worktree_lock_written_inside": True,
            "private_key_readable": False, "public_key_readable": True,
            "hooks_writable": False, "worktree_config_writable": False, "allowed_signers_writable": False,
            "common_config_writable": False, "signingkey_reconfigurable": False,
            "local_config_writable_by_git": False, "main_ref_rewritable": False,
            "sibling_worktree_visible": False, "sibling_git_dir_visible": False,
            "main_working_tree_visible": False, "dependency_tree_visible": True,
            "ssh_auth_sock": SANDBOX_SIGNING_AGENT_SOCKET, "tmpdir": SANDBOX_TMPDIR,
        })
        # The hook row the agent's client shipped reached the REAL store
        # through the executor's broker, under the executor's request id;
        # the request ledger it could not reach is as the kernel wrote it.
        journal = [row for row in journal_rows_for(self.request_id, base_dir=self.tools) if row["tool_use_id"] == "toolu_e2e"]
        self.assertEqual([row["command_family"] for row in journal], ["git_read"])
        self.assertNotIn("forged", (self.tools / "agent-invocations" / "requests.jsonl").read_text(encoding="utf-8"))
        # The planted locks stayed in the sandbox: the shared `main` is not
        # wedged and the worktree was removable (the fixture removed it).
        self.assertFalse((self.repo / ".git" / "refs" / "heads" / "main.lock").exists())
        self.assertFalse((self.repo / ".git" / "objects" / "maintenance.lock").exists())
        self.assertEqual(_git(["fsck", "--no-dangling"], cwd=self.repo, check=False).returncode, 0)
        # The commit reached the shared checkout through the kernel's
        # publication of the worktree's quarantine — recorded by name — and
        # verifies there against the registered key, where the branch ref
        # survives the worktree's removal.
        head = implementation["branch_tip_sha"]
        published = self._governance(ci_executor.IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT)
        self.assertEqual(len(published), 1, published)
        self.assertEqual(published[0]["details"]["refs_published"], [self.ids["branch"]])
        self.assertEqual(published[0]["details"]["refusal"], None)
        self.assertEqual(published[0]["details"]["objects_refused"], [])
        self.assertGreaterEqual(published[0]["details"]["loose_objects_migrated"], 3)
        self.assertEqual({row["ref"] for row in published[0]["details"]["refs_discarded"]}, {"main.lock"})
        self.assertEqual(_git(["rev-parse", self.ids["branch"]], cwd=self.repo).stdout.strip(), head)
        self.assertTrue(self._verify_against_registry(head, fingerprint))
        # The IMPL row landed: the bridge accepted the outcome.
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        self.assertEqual(self._governance("agent_bridge_warning"), [])
        self.assertEqual(self._governance("implementation_signer_fp_overridden"), [])
        # The cost row carries the executor-held fingerprint, not the sentinel.
        cost = [row for row in read_cost_attribution(base_dir=self.tools) if row["agent_role"] == "implementation"]
        self.assertEqual([row["signer_key_fp"] for row in cost], [fingerprint])
        # Revoked: no key files, the worktree's config restored to what it
        # had before the child, and nothing reached the sibling or the shared
        # checkout (their config is the fixture's baseline: no key, no
        # signers file, no ssh format).
        self.assertEqual(self.worktree_keys_after, [])
        self.assertEqual(self.worktree_config_after, self.worktree_config_before)
        self.assertIsNone(self.worktree_config_after["user.signingkey"])
        for checkout in (self.sibling, self.repo):
            self.assertEqual(self._signing_config(checkout), self.worktree_config_before, checkout)
        self.assertFalse((self.repo / "aria-debts" / "keys").exists())

    def test_an_unsigned_commit_is_refused_by_name(self) -> None:
        self._install_implementer(commit_shape="unsigned")
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        warnings = self._governance("agent_bridge_warning")
        self.assertEqual(len(warnings), 1, warnings)
        self.assertEqual(warnings[0]["details"]["kind"], "plan_convergence_bridge")
        self.assertIn("commit_signature_unverified", warnings[0]["details"]["error"])
        # Refused BEFORE any plan-state mutation: the verification is the
        # first thing the dispatch does, so a refused result leaves the plan
        # where the envelope mint left it.
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")

    def test_a_commit_signed_with_another_key_is_refused_by_name(self) -> None:
        self._install_implementer(commit_shape="other_key")
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        warnings = self._governance("agent_bridge_warning")
        self.assertEqual(len(warnings), 1, warnings)
        self.assertIn("commit_signature_unverified", warnings[0]["details"]["error"])
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")
        # The registered key is the executor's; the other key never verifies.
        fingerprint = self._submitted_envelope()["details"]["implementation"]["signer_key_fp"]
        self.assertFalse(self._verify_against_registry(
            self._submitted_envelope()["details"]["implementation"]["branch_tip_sha"], fingerprint,
        ))

    def test_a_fabricated_fingerprint_from_the_agent_is_overridden_and_recorded(self) -> None:
        fabricated = "SHA256:" + "A" * 43
        self._install_implementer(claimed_fingerprint=fabricated)
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        implementation = self._submitted_envelope()["details"]["implementation"]
        self.assertNotEqual(implementation["signer_key_fp"], fabricated)
        self.assertEqual([row["signer_key_fp"] for row in self._registered()], [implementation["signer_key_fp"]])
        overridden = self._governance("implementation_signer_fp_overridden")
        self.assertEqual(len(overridden), 1, overridden)
        self.assertEqual(overridden[0]["details"]["agent_supplied"], fabricated)
        self.assertEqual(overridden[0]["details"]["signer_key_fp"], implementation["signer_key_fp"])
        self.assertEqual(overridden[0]["details"]["request_id"], self.request_id)
        # The commit was signed by the executor's key regardless of what the
        # agent claimed, so the outcome lands under the true fingerprint.
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")

    def test_the_shared_checkout_is_refused_before_any_agent_turn(self) -> None:
        self._install_implementer()
        completed, github_output = self._run_child(worktree=None)
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        # Released under a harness-class reason: back on the queue with the
        # requeue budget untouched, no result, no agent turn spent.
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "REQUEUED")
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no agent turn was spent")
        released = self._governance("agent_requeued")
        self.assertEqual([(row["details"]["reason"], row["details"]["requeue_count"]) for row in released],
                         [("implementation_signing_unavailable", 0)])
        self.assertEqual(self._governance("claude_subprocess_env_audit"), [], "no spawn was attempted")
        refusals = self._governance("implementation_signing_unavailable")
        self.assertEqual(len(refusals), 1, refusals)
        self.assertEqual(refusals[0]["details"]["reason"], "shared_checkout_scope:--local")
        self.assertEqual(refusals[0]["details"]["cycle_id"], CYCLE_ID)
        summary = json.loads(next(
            line.split("=", 1)[1] for line in github_output.read_text(encoding="utf-8").splitlines()
            if line.startswith("dispatch_summary_path=")
        ) and (self.runner_temp / f"dispatch-result-{self.request_id}.json").read_text(encoding="utf-8"))
        self.assertEqual((summary["outcome"], summary["failure_detail_code"]),
                         ("refused", "implementation_signing_unavailable"))
        # The summary says what the ledger says: the host's fault, retried
        # by the daemon after a back-off — not a policy the dispatch violated.
        self.assertEqual((summary["failure_class"], summary["retryable"]), ("harness_unavailable", True))
        self.assertIsNone(self._signing_config(self.repo)["user.signingkey"])
        self.assertEqual(self._registered(), [])
        # Decided from the checkout's shape BEFORE any mint: no keys dir was
        # ever created in the shared checkout, so no key, no config write and
        # no snapshot could have been either.
        self.assertFalse((self.repo / "aria-debts" / "keys").exists())
        self.assertFalse((self.repo / ".git" / "aria-signing-config-snapshots").exists())

    def test_a_runner_whose_sandbox_cannot_commit_is_refused_before_any_claim(self) -> None:
        # ARIA-HIGH-123 — the containment probe runs the contract's git
        # commands inside the real argv; a bwrap that cannot host them is
        # "no backend" to the pre-claim environment gate: the request is
        # never claimed (PENDING, requeue budget untouched), no identity is
        # minted, no agent turn is spent, and the governance row names the
        # git failure the probe saw.
        self._install_implementer()
        self._install_bwrap_without_the_quarantine_refs_bind()
        completed, worktree = self._run_in_request_worktree()
        # The gate's own exit (1, the FAZ 5b shape: the job reports an
        # environment fault), never a claim.
        self.assertEqual(completed.returncode, 1, self._diagnostic(completed))
        self.assertIn("::error::pre_claim_environment_gate: sandbox_unavailable", completed.stderr)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "PENDING")
        self.assertEqual(self._governance("agent_claim_created"), [], "nothing was claimed")
        self.assertEqual(self._governance("agent_requeued"), [])
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no agent turn was spent")
        self.assertNotIn("implementation_identity_held", completed.stderr)
        self.assertEqual(self._registered(), [])
        self.assertFalse(self.worktree_keys_dir_existed, "no key was minted")
        refusals = self._governance("sandbox_unavailable")
        self.assertEqual(len(refusals), 1, refusals)
        self.assertEqual(refusals[0]["details"]["source"], "ci_executor_pre_claim_gate")
        self.assertIn("git containment probe refused: git_in_sandbox_failed", refusals[0]["details"]["detail"])
        self.assertIn("Read-only file system", refusals[0]["details"]["detail"])

    def test_a_pre_spawn_refusal_mints_no_identity(self) -> None:
        # The identity is held as the LAST pre-spawn step: a refusal decided
        # before it — the dispatch budget here, a turn cap the request's one
        # evidence ref already exceeds — costs no ssh-keygen and leaves no
        # `kg_signers` row for a key that never signed.
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree(extra_env={"MAX_TURNS_PER_RUN": "0"})
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "REQUEUED")
        released = self._governance("agent_requeued")
        self.assertEqual([(row["details"]["reason"], row["details"]["requeue_count"]) for row in released],
                         [("dispatch_budget_refused", 0)])
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no agent turn was spent")
        self.assertNotIn("implementation_identity_held", completed.stderr)
        self.assertEqual(self._registered(), [], "a refused attempt registers no key")
        self.assertEqual(self._governance("implementation_signing_unavailable"), [])
        self.assertFalse(self.worktree_keys_dir_existed, "no key was ever minted for the refused attempt")
        self.assertEqual(self.worktree_config_after, self.worktree_config_before)


if __name__ == "__main__":
    unittest.main()
