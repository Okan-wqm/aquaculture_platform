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

ARIA-HIGH-124 — kernel authority is exercised OUTSIDE the agent's sandbox.
The same executor child, after the spawn and the quarantine's publication,
runs the apply gate at the published branch's HEAD in the request worktree
(the canonical suite answered by fixture ``npx``/``npm`` executables that
record where they ran — a stubbed suite recorded as evidence), pushes the
branch to a fixture bare ``origin`` with the delivery credential it holds
(the token never enters the sandbox: the agent observes no ``GH_TOKEN``),
opens the PR through ``pr_manager.open_pr_for_action`` (a fixture ``gh``
answers ``pr create`` with a URL and records its argv), and stamps
``pr_url`` / ``pr_number`` / ``branch_tip_sha`` / ``diff_hash`` / the gate
ref / the recorded runs on the submitted record — the scripted agent
supplies none of them, and a fabricated ``pr_url`` / ``branch_tip_sha`` is
overwritten and recorded. Inside the sandbox the agent starts ON the
kernel-made branch (no ``git switch`` of its own), the hook broker refuses
``python3 -m aria_kernel apply gate`` and ``git push`` by name
(``kernel_authority``), and the `aria` MCP view answers through the relay
with the REAL store's rows while a write tool is refused. Before this
change the executor never ran the gate, never pushed, never opened a PR,
and the in-sandbox `apply gate` found no store.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
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

from aria_kernel.recovery import unresolved_intents as recovery_unresolved_intents  # noqa: E402
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit  # noqa: E402
from tests._helpers.production_shaped import production_staged_implementation_request  # noqa: E402

SOURCE = "apps/farm-service/src/sample-interval.ts"
PLAN_ID = "plan-aria-high-115"
CYCLE_ID = "cyc-aria-high-115"
# ARIA-HIGH-124 (round 3) — the fixture's branch is MINTED (by the real mint,
# `implementation_safety.mint_unpredictable_feature_branch_name`, drawn
# until it does) to carry TEN CONSECUTIVE DIGITS: the operator CLI's
# free-text `--reason` validator reads such a run as a phone number, and
# the round-2 executor passed every escalation's reason — the collision's
# branch name, the invalid row's ids, a delivery refusal's detail — through
# it as a `human-required record` child, so one escalation in ten (8% of
# mints carry such a run) was refused at argparse and silently lost
# (`requeued` instead of `human_required`). With this mint every escalation
# pin below reproduces that loss DETERMINISTICALLY on the round-2 tree
# (the flake the round-2 verifier hit one run in four), and passes only when
# the ids never meet a free-text validator.
_TEN_DIGIT_RUN = re.compile(r"\d{10}")


def _mint_branch_with_a_ten_digit_run(plan_id: str) -> str:
    from aria_kernel.implementation_safety import mint_unpredictable_feature_branch_name

    while True:
        branch = mint_unpredictable_feature_branch_name(plan_id)
        if _TEN_DIGIT_RUN.search(branch):
            return branch
# What the fixture `gh` answers `pr create` with: the REMOTE's fact, parsed
# by the kernel's PR opener and stamped by the executor. The agent never
# sees it.
FIXTURE_PR_URL = "https://github.com/fixture/aria-high-124/pull/124"
_STATUS = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}


def _scripted_implementer(
    *, branch: str, base_sha: str, must_satisfy_ids: list[str], message: str,
    commit_shape: str = "plain", claimed_fingerprint: str | None = None,
    claimed_delivery: dict[str, object] | None = None, commit: bool = True,
    exit_after_start: int | None = None, kernel_shadow_marker: str | None = None,
    validation_probe: str | None = None, evidence_line: int = 1,
) -> str:
    """The implementer as a script: the plan's file, one commit in its cwd
    (on the branch the kernel stood it on), then the envelope.
    ``commit_shape`` is ``plain`` (whatever the worktree's git config says),
    ``unsigned`` (``--no-gpg-sign``) or ``other_key`` (a key the executor
    never minted); ``claimed_fingerprint`` is a value the agent asserts for
    ``signer_key_fp``, or None to omit it; ``claimed_delivery`` are values
    the agent asserts for the kernel-stamped delivery fields (``pr_url``,
    ``branch_tip_sha``…), or None to supply none — the contract asks for
    none; ``commit=False`` answers the envelope without committing;
    ``exit_after_start`` exits with that code right after the first git
    reads (the shape of a timeout, a provider outage, an operator cancel:
    a spawn that ends before any commit); ``kernel_shadow_marker`` plants
    an ``aria_kernel`` package and a ``json`` module at the worktree ROOT —
    what a real agent does with one Write call, the hook admitting any
    workspace path outside READONLY_PATHS — and commits them with the
    plan's file: if any process ever imports them, they append a row
    (argv, cwd, the NAMES of the credential variables present) to that
    marker path on the host, outside the sandbox; ``validation_probe`` is
    the body of a Python script the agent commits as
    ``aria-validation-probe.py`` together with a ``package.json`` whose
    ``type-check`` script runs it — what the executor's gate then executes
    as `npm run type-check` (ARIA-HIGH-124 round 3: the suite is the
    agent's code); ``evidence_line`` is the line every evidence ref of the
    envelope cites in the plan's file (round 5: a line the file does not
    have is the envelope the kernel rejects)."""
    return (
        f"#!{sys.executable}\n"
        "import hashlib, json, os, socket, subprocess, sys\n"
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
        # ARIA-HIGH-124 — the kernel stood the sandbox on the branch: no
        # `git switch` here; what the agent SEES is recorded.
        "branch_at_start = git('branch', '--show-current')\n"
        "head_at_start = git('rev-parse', 'HEAD')\n"
        + (f"raise SystemExit({exit_after_start})\n" if exit_after_start is not None else "")
        + f"open({SOURCE!r}, 'w', encoding='utf-8').write('export const sampleIntervalMs = 30000;\\n')\n"
        + f"git('add', {SOURCE!r})\n"
        + (_kernel_shadow_plant(kernel_shadow_marker) if kernel_shadow_marker else "")
        + (_validation_probe_plant(validation_probe) if validation_probe else "")
        + f"commit = ['commit', '-q', '-m', {message!r}]\n"
        + {
            "plain": "",
            "unsigned": "commit.append('--no-gpg-sign')\n",
            "other_key": (
                "other = os.path.join(os.environ['HOME'], 'other-key')\n"
                "subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', other], check=True)\n"
                "commit = ['-c', 'user.signingkey=' + other, *commit]\n"
            ),
        }[commit_shape]
        + ("git(*commit)\n" if commit else "")
        + "head = git('rev-parse', 'HEAD')\n"
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
        # ARIA-HIGH-124 — what the hook broker DECIDES for the kernel
        # commands the old contract had the agent run, asked the way the
        # CLI asks (a PreToolUse payload through the in-sandbox client).
        "def verdict(command):\n"
        "    payload = json.dumps({'session_id': 'sess-e2e', 'tool_use_id': 'toolu_' + hashlib.sha1(command.encode()).hexdigest()[:8],\n"
        "        'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_input': {'command': command}})\n"
        "    done = subprocess.run([sys.executable, client, 'pre-tool'], input=payload, capture_output=True, text=True)\n"
        "    try:\n"
        "        reason = json.loads(done.stdout)['hookSpecificOutput']['permissionDecisionReason']\n"
        "    except (ValueError, KeyError):\n"
        "        reason = done.stdout.strip()[:200]\n"
        "    return {'exit_code': done.returncode, 'reason': reason[:200]}\n"
        "policy = {\n"
        f"    'apply_gate': verdict('python3 -m aria_kernel apply gate --proposal-id p --change-id c'),\n"
        f"    'pr_create': verdict('python3 -m aria_kernel pr create --proposal-id p --change-id c --no-dry-run'),\n"
        f"    'push': verdict('git push origin {branch}'),\n"
        f"    'status': verdict('git status --porcelain'),\n"
        # ARIA-HIGH-124 (round 4) — the commit shapes that would make the
        # tip something other than the worktree's wired identity, asked the
        # way the CLI asks: a key of the agent's own under its writable
        # HOME, the short form, and a re-attribution. The round-3 policy
        # admitted all three (`(\\s+-m\\s+.+)$` swallowed trailing flags).
        f"    'commit_own_key': verdict('git commit -m \\'fix: x\\' --gpg-sign=' + os.path.join(os.environ['HOME'], 'its-own-key')),\n"
        f"    'commit_short_key': verdict('git commit -Skey -m \\'fix: x\\''),\n"
        f"    'commit_author': verdict('git commit -m \\'fix: x\\' --author=\\'A <a@x>\\''),\n"
        f"    'commit_plain': verdict('git commit -m \\'fix: x\\''),\n"
        "}\n"
        # ARIA-HIGH-124 — the `aria` MCP server as the CLI would start it:
        # the entry of this spawn's --mcp-config document, its env merged
        # over this process's (the CLI's own merge order, measured on
        # 2.1.269), asked for the store's governance rows and a write tool.
        "def mcp_probe():\n"
        "    if '--mcp-config' not in argv:\n"
        "        return {'error': 'no_mcp_config_flag'}\n"
        "    document = json.load(open(argv[argv.index('--mcp-config') + 1], encoding='utf-8'))\n"
        "    entry = document.get('mcpServers', {}).get('aria')\n"
        "    if entry is None:\n"
        "        return {'error': 'no_aria_server', 'servers': sorted(document.get('mcpServers', {}))}\n"
        "    messages = [\n"
        "        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}},\n"
        "        {'jsonrpc': '2.0', 'method': 'notifications/initialized'},\n"
        "        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},\n"
        "        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'governance_tail', 'arguments': {'kind': 'agent_claim_created', 'limit': 5}}},\n"
        "        {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'human_required_resolve', 'arguments': {'request_id': 'x', 'resolution_note': 'n', 'operator_approval_ref': 'abcdef'}}},\n"
        "    ]\n"
        "    done = subprocess.run([entry['command'], *entry.get('args', [])], input=''.join(json.dumps(m) + '\\n' for m in messages),\n"
        "        capture_output=True, text=True, env={**os.environ, **entry.get('env', {})}, timeout=60)\n"
        "    replies = {}\n"
        "    for line in done.stdout.splitlines():\n"
        "        try:\n"
        "            reply = json.loads(line)\n"
        "        except ValueError:\n"
        "            continue\n"
        "        if isinstance(reply, dict) and 'id' in reply:\n"
        "            replies[reply['id']] = reply\n"
        "    def text(n):\n"
        "        reply = replies.get(n) or {}\n"
        "        if 'error' in reply:\n"
        "            return {'error': reply['error'].get('message')}\n"
        "        result = reply.get('result') or {}\n"
        "        content = result.get('content') or [{}]\n"
        "        return {'is_error': result.get('isError'), 'text': content[0].get('text')}\n"
        "    governance = text(3)\n"
        "    try:\n"
        "        rows = json.loads(governance['text']) if governance.get('text') else []\n"
        "    except ValueError:\n"
        "        rows = []\n"
        "    return {\n"
        "        'command_basename': os.path.basename(entry['command']), 'args_basenames': [os.path.basename(a) for a in entry.get('args', [])],\n"
        "        'env_names': sorted(entry.get('env', {})), 'rc': done.returncode, 'stderr_tail': done.stderr[-300:],\n"
        "        'server_name': ((replies.get(1) or {}).get('result') or {}).get('serverInfo', {}).get('name'),\n"
        "        'tools': sorted(t['name'] for t in ((replies.get(2) or {}).get('result') or {}).get('tools', [])),\n"
        "        'governance_error': governance.get('error'), 'governance_is_error': governance.get('is_error'),\n"
        "        'claim_rows_seen': [r.get('details', {}).get('request_id') for r in rows if isinstance(r, dict)],\n"
        "        'write_tool': text(4),\n"
        "    }\n"
        "try:\n"
        "    mcp = mcp_probe()\n"
        "except Exception as exc:\n"
        "    mcp = {'error': type(exc).__name__ + ':' + str(exc)[:200]}\n"
        "sandbox = {\n"
        # ARIA-HIGH-124 — the branch the kernel made, and the credential
        # that is NOT here.
        "    'branch_at_start': branch_at_start, 'head_at_start': head_at_start,\n"
        "    'delivery_token_in_env': 'GH_TOKEN' in os.environ, 'git_credential_helper_in_env': 'GIT_CONFIG_COUNT' in os.environ,\n"
        "    'mcp_broker_env': os.environ.get('ARIA_MCP_BROKER_SOCKET'),\n"
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
        # ARIA-HIGH-124 — the record carries what the AGENT knows and
        # nothing the kernel stamps: no pr_url, no tip, no diff hash. A
        # `claimed_delivery` is the adversarial shape.
        "implementation = {}\n"
        + (f"implementation.update({claimed_delivery!r})\n" if claimed_delivery else "")
        + (f"implementation['signer_key_fp'] = {claimed_fingerprint!r}\n" if claimed_fingerprint else "")
        + f"matrix = [{{'id': item, 'verdict': 'satisfied', 'evidence_refs': [{SOURCE!r} + ':{evidence_line}']}} for item in {must_satisfy_ids!r}]\n"
        f"response = {{'satisfaction_matrix': matrix, 'evidence_refs': [{SOURCE!r} + ':{evidence_line}'],\n"
        "    'details': {'implementation': implementation, 'agent_observation': {\n"
        "        'cwd': os.getcwd(), 'registered_before_agent': registered,\n"
        "        'commit_gpgsign': config('commit.gpgsign'), 'user_signingkey': config('user.signingkey'),\n"
        "        'gpg_format': config('gpg.format'), 'allowed_signers': config('gpg.ssh.allowedSignersFile'),\n"
        "        'sandbox': sandbox, 'policy': policy, 'mcp': mcp, 'head': head}}}\n"
        "message = json.dumps(response)\n"
        "print(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': message}]}}))\n"
        "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': message,\n"
        "                  'usage': {'input_tokens': 900, 'output_tokens': 120}, 'session_id': 'fixture-session'}))\n"
    )


# ARIA-HIGH-124 (round 2) — what a planted module records if it ever runs:
# never a value, only the NAMES of the credential variables in its
# environment (the lease token, the delivery token, the store binding).
_SHADOW_CREDENTIAL_NAMES = (ci_executor.LEASE_TOKEN_ENV_VAR, "GH_TOKEN", "ARIA_TOOLS_DIR")


def _kernel_shadow_plant(marker: str) -> str:
    """The scripted agent's planting of `aria_kernel/{__init__,__main__}.py`
    and `json.py` at the worktree root, staged alongside the plan's file.
    The planted `__main__` is what `python3 -m aria_kernel …` runs when the
    interpreter's cwd is this worktree and the cwd is on sys.path; the
    planted `json` is what any such process gets for `import json`. Both
    append a marker row and then answer — `__main__` with an empty JSON
    object and exit 0, `json` by handing over to the real module — so a
    run that did resolve them keeps going and the marker is the evidence."""
    record = (
        "import json as _json, os as _os, sys as _sys\n"
        f"with open({marker!r}, 'a', encoding='utf-8') as _log:\n"
        "    _log.write(_json.dumps({'module': __name__, 'argv': _sys.argv[1:], 'cwd': _os.getcwd(),\n"
        f"        'credential_names': sorted(n for n in _os.environ if n in {_SHADOW_CREDENTIAL_NAMES!r})}}) + '\\n')\n"
    )
    main_module = record + "print('{}')\n"
    json_module = (
        "import os as _os, sys as _sys\n"
        f"with open({marker!r}, 'a', encoding='utf-8') as _log:\n"
        "    _log.write('{\"module\": \"json\", \"cwd\": \"' + _os.getcwd() + '\"}\\n')\n"
        "_here = _os.path.dirname(_os.path.abspath(__file__))\n"
        "_sys.path[:] = [p for p in _sys.path if _os.path.abspath(p or _os.getcwd()) != _here]\n"
        "del _sys.modules['json']\n"
        "from json import *\n"
    )
    return (
        "os.makedirs('aria_kernel', exist_ok=True)\n"
        "open(os.path.join('aria_kernel', '__init__.py'), 'w', encoding='utf-8').write('')\n"
        f"open(os.path.join('aria_kernel', '__main__.py'), 'w', encoding='utf-8').write({main_module!r})\n"
        f"open('json.py', 'w', encoding='utf-8').write({json_module!r})\n"
        "git('add', 'aria_kernel/__init__.py', 'aria_kernel/__main__.py', 'json.py')\n"
    )


VALIDATION_PROBE_PATHS = ("package.json", "aria-validation-probe.py")


def _validation_probe_plant(body: str) -> str:
    """The scripted agent's commit of a `package.json` whose `type-check`
    script is its own program: what npm-run-script executes from the tree."""
    package = json.dumps({"name": "fixture", "private": True,
                          "scripts": {"type-check": f"{sys.executable} aria-validation-probe.py"}}) + "\n"
    return (
        f"open('package.json', 'w', encoding='utf-8').write({package!r})\n"
        f"open('aria-validation-probe.py', 'w', encoding='utf-8').write({body!r})\n"
        "git('add', 'package.json', 'aria-validation-probe.py')\n"
    )


VALIDATION_PROBE_MARKER = "aria-validation-probe-marker"


def _validation_probe_body(*, targets: dict[str, Path]) -> str:
    """ARIA-HIGH-124 (round 3) — what the AGENT's validation suite can reach
    when the executor's gate runs it. For every target (the store, the code
    root's kernel tree, the shared repository's `refs/heads`, the runner's
    real home) the script TRIES to plant a marker file there — the pin then
    asks the HOST whether any marker landed, which is the only reading that
    tells a sandbox-private tmpfs from the real directory (`os.access` on a
    path bwrap materialised in its private root answers True for nothing).
    The environment facts and the sandbox markers are printed as the
    command's stdout: the gate records it on the validation-runs ledger,
    which is where the pin reads it back."""
    return (
        "import json, os, sys\n"
        f"targets = {json.dumps({name: str(path) for name, path in targets.items()})}\n"
        "planted = {}\n"
        "for name, path in targets.items():\n"
        "    try:\n"
        "        os.makedirs(path, exist_ok=True)\n"
        f"        open(os.path.join(path, {VALIDATION_PROBE_MARKER!r}), 'w', encoding='utf-8').write('planted by the suite\\n')\n"
        "        planted[name] = 'written'\n"
        "    except OSError as exc:\n"
        "        planted[name] = type(exc).__name__\n"
        # (round 5) what the suite sees of the workspace's keys dir: names and
        # byte counts only — never a byte of content — read from the tree
        # the gate runs in. Until round 5 the private key and the delivery
        # token were both readable here, and the gate recorded the reading.
        "keys_dir = os.path.join(os.getcwd(), 'aria-debts', 'keys')\n"
        "keys_dir_entries = sorted(os.listdir(keys_dir)) if os.path.isdir(keys_dir) else None\n"
        # A masked keys dir is its OWN mount (a tmpfs: another st_dev than
        # the worktree's); an unmasked one is the worktree's directory.
        "keys_dir_masked = os.path.isdir(keys_dir) and os.stat(keys_dir).st_dev != os.stat(os.getcwd()).st_dev\n"
        "keys_dir_readable = {}\n"
        "for name in keys_dir_entries or []:\n"
        "    try:\n"
        "        keys_dir_readable[name] = len(open(os.path.join(keys_dir, name), 'rb').read())\n"
        "    except OSError as exc:\n"
        "        keys_dir_readable[name] = type(exc).__name__\n"
        "print(json.dumps({\n"
        "    'planted': planted,\n"
        "    'keys_dir_entries': keys_dir_entries, 'keys_dir_readable': keys_dir_readable, 'keys_dir_masked': keys_dir_masked,\n"
        "    'home_env': os.environ.get('HOME'), 'tmpdir_env': os.environ.get('TMPDIR'),\n"
        "    'hook_broker_socket': os.path.exists('/tmp/aria-hook-broker.sock'),\n"
        "    'mcp_broker_socket': os.path.exists('/tmp/aria-mcp-broker.sock'),\n"
        "    'signing_agent_socket': os.path.exists('/tmp/aria-signing-agent.sock'),\n"
        "    'hook_broker_env': os.environ.get('ARIA_HOOK_BROKER_SOCKET'), 'mcp_broker_env': os.environ.get('ARIA_MCP_BROKER_SOCKET'),\n"
        "    'gh_token_in_env': 'GH_TOKEN' in os.environ, 'lease_token_in_env': 'ARIA_LEASE_TOKEN' in os.environ,\n"
        "    'store_binding_in_env': 'ARIA_TOOLS_DIR' in os.environ,\n"
        "    'cwd_writable': os.access(os.getcwd(), os.W_OK), 'executable': sys.executable,\n"
        "}))\n"
    )


def completed_stderr_index(test: "ExecutorImplementationIdentityTests", stage: str) -> int:
    """Where ``stage`` first appears in the child's stderr (the executor's
    stage log) — the order the child did things in."""
    return test.completed.stderr.index(stage)


class ExecutorImplementationIdentityTests(unittest.TestCase):
    def _start_egress_proxy(self) -> str:
        """A real ``aria_kernel.egress_proxy`` on loopback, allowing one
        provider host, torn down with the test. Returns its HTTPS_PROXY."""
        import socket
        import subprocess as _sp

        sock = socket.socket()  # allowlist-external-network: binds 127.0.0.1:0 only to learn a free local port for the in-test egress proxy; nothing is sent anywhere
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        proc = _sp.Popen(
            [sys.executable, "-I", str(_REPO_ROOT / "aria-kernel" / "aria_kernel" / "egress_proxy.py"),
             "--listen", f"127.0.0.1:{port}", "--allow", "api.anthropic.com:443"],
            stderr=_sp.DEVNULL,
        )
        self.addCleanup(lambda: (proc.terminate(), proc.wait(timeout=5)))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        else:
            self.skipTest("the egress proxy did not come up")
        return f"http://127.0.0.1:{port}"

    def setUp(self) -> None:
        from aria_kernel import agent_invocations as ai
        from aria_kernel.implementation_safety import sandbox_backend
        from aria_kernel.tool_registry import ensure_tools_binding

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host; the executor refuses to claim here")
        # ARIA-HIGH-143 — the pre-claim gate now requires an egress boundary
        # (the spawn shares the host's network). Stand up the real allowlist
        # proxy the production unit runs, on loopback, and hand the child its
        # HTTPS_PROXY: the fixture CLI makes no real egress call, so the proxy
        # only ever answers the gate's off-allowlist probe with a refusal.
        https_proxy = self._start_egress_proxy()
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
        # Operator policy: the legacy lane reserves opus's notional spawn
        # price against the per-run cap before it spawns; the shipped $0.50
        # refuses every implementer run, so the fixture's workspace raises
        # it (the override chain the kernel reads, not a test hook).
        # Committed with the tree — the staging's BASELINE validation refuses
        # a dirty checkout, and so does the executor's gate.
        self.repo = make_repo_with_initial_commit(self.root, {
            ".gitignore": "aria-tools/\naria-debts/keys/\naria-worktrees/\nnode_modules/\n__pycache__/\n",
            SOURCE: "export const sampleIntervalMs = 60000;\n",
            ".claude/agents/aria-implementer.md": agent.read_text(encoding="utf-8"),
            # The reviewer the production-shaped plan names, byte-identical
            # to what `production_converged_plan` writes, so the checkout
            # stays clean for the baseline.
            ".claude/agents/farm-expert.md": "\n".join([
                "---", "name: farm-expert", "description: Fixture reviewer.", "---", "", "Owns `apps/farm-service/**`.",
            ]),
            "aria-config/genesis_policy.json": json.dumps(
                {"cost_caps_usd": {"daily": 50.0, "monthly": 500.0, "per_run": 10.0}}) + "\n",
            # The in-sandbox hook client and the MCP relay ride the checkout's
            # own kernel tree (ARIA-HIGH-123 / 124): the scripted implementer
            # ships a hook and an MCP call through them.
            "aria-kernel/aria_kernel/hook_client.py": (_KERNEL_DIR / "aria_kernel" / "hook_client.py").read_text(encoding="utf-8"),
            "aria-kernel/aria_kernel/mcp_relay.py": (_KERNEL_DIR / "aria_kernel" / "mcp_relay.py").read_text(encoding="utf-8"),
        }, name="checkout")
        # The shared store carries a pack, as the runner checkout's does.
        _git(["repack", "-a", "-d", "-q"], cwd=self.repo)
        # A validation command resolves node modules by walking up from the
        # worktree; the checkout carries them (the environment gate's probe).
        (self.repo / "node_modules").mkdir()
        # ARIA-HIGH-124 — the fixture remote the executor pushes to: a bare
        # repository standing in for GitHub's git side; the fixture `gh`
        # below stands in for its API.
        self.remote = self.root / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        _git(["remote", "add", "origin", str(self.remote)], cwd=self.repo)
        # (round 6) the remote's receive hook records WHEN the push arrived
        # and WHICH credential names rode it (a local receive-pack inherits
        # the pusher's environment): the pin puts that instant beside the
        # lease's mint and the gate's recorded runs.
        self.push_log = self.root / "push-calls.jsonl"
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys, time\n"
            f"with open({str(self.push_log)!r}, 'a', encoding='utf-8') as log:\n"
            "    log.write(json.dumps({'time': time.time(), 'refs': sys.stdin.read().split(),\n"
            "        'credential_names': sorted(n for n in os.environ if n in ('GH_TOKEN', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'))}) + '\\n')\n",
            encoding="utf-8",
        )
        hook.chmod(0o755)
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        # The fixture CLI lives on a path the checkout carries, the way the
        # real CLI lives on a bound path (the native lanes' shape).
        self.fixture_bin = self.tools / "fixture-bin"
        self.fixture_bin.mkdir()
        # ARIA-HIGH-124 — the canonical suite, answered: `npx`/`npm` record
        # WHERE they ran (cwd, HEAD) and exit 0; `gh` answers `pr create`
        # with the fixture URL, records its argv and the NAMES of the
        # credential variables it saw, and refuses everything else.
        self.suite_log = self.root / "validation-calls.jsonl"
        self.gh_log = self.root / "gh-calls.jsonl"
        for name in ("npx", "npm"):
            self._install_fixture_executable(name, self._suite_fixture_body(name))
        self._install_fixture_executable("gh", (
            "import json, os, sys, time\n"
            "argv = sys.argv[1:]\n"
            # (round 5) what the worktree's keys dir holds at the moment the
            # PR is opened: the identity must already be retired (no
            # private key), and the token file must never have been there.
            "keys_dir = os.path.join(os.getcwd(), 'aria-debts', 'keys')\n"
            "keys_dir_entries = sorted(os.listdir(keys_dir)) if os.path.isdir(keys_dir) else None\n"
            f"with open({str(self.gh_log)!r}, 'a', encoding='utf-8') as log:\n"
            "    log.write(json.dumps({'time': time.time(), 'argv': argv, 'cwd': os.getcwd(), 'keys_dir_entries': keys_dir_entries,\n"
            "        'credential_names': sorted(n for n in os.environ if n in ('GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'))}) + '\\n')\n"
            "if argv[:2] == ['pr', 'create']:\n"
            f"    print({FIXTURE_PR_URL!r}); raise SystemExit(0)\n"
            "sys.stderr.write('fixture gh: refused ' + ' '.join(argv[:2]) + '\\n'); raise SystemExit(1)\n"
        ))
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
            # ARIA-HIGH-143 — the egress boundary the gate probes.
            "HTTPS_PROXY": https_proxy,
            # The suite's hermetic git layers (tests/_helpers/hermetic_git),
            # so the child's git reads no machine-global signing config.
            **{name: os.environ[name] for name in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM") if name in os.environ},
        }
        self.base_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        # The request is STAGED and minted by production's own producer
        # (ARIA-HIGH-124): the baseline runs here, in this process, through
        # the fixture suite on PATH; the envelope carries the staged ids.
        with patch.dict(os.environ, {"ARIA_TOOLS_DIR": str(self.tools), "PATH": self.environment["PATH"]}), \
                patch("aria_kernel.apply_engine.mint_unpredictable_feature_branch_name", _mint_branch_with_a_ten_digit_run):
            self.request = production_staged_implementation_request(
                tools_dir=self.tools, workspace_root=self.repo, plan_id=PLAN_ID,
                allowed_path=SOURCE, cycle_id=CYCLE_ID,
            )
        self.request_id = self.request["request_id"]
        self.ids = self.request["implementation_ids"]
        self.plan_id = PLAN_ID
        self.assertEqual(self.ids["base_sha"], self.base_sha)
        self.assertRegex(self.ids["branch"], _TEN_DIGIT_RUN)
        self.baseline_calls = self._suite_calls()
        # The commit contract the kernel derived: a trailer only when the
        # plan's origin prints one (this fixture plan has no finding origin,
        # so the subject opens with a type the contract admits without one —
        # the PR opener's `commit_contract_honoured` check judges it).
        contract = self.request["commit_contract"]
        trailer = contract["trailer"]
        self.message = f"{contract['commit_types'][0]}(farm-service): halve the sample interval\n\nWHY: the plan says so.\n" + (
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
        the shared `refs/heads`, and with the common dir bound read-only as
        a whole where ARIA-HIGH-141's tmpfs stands (the pre-change shape,
        where nothing under the common git dir was writable: the commit's
        ref update dies EROFS). Every other argv reaches bwrap unchanged."""
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
            "for index in range(len(argv) - 1):\n"
            "    if argv[index] == '--tmpfs' and argv[index + 1].endswith('/.git'):\n"
            "        argv = argv[:index] + ['--ro-bind', argv[index + 1], argv[index + 1]] + argv[index + 2:]\n"
            "        break\n"
            f"os.execv({real!r}, [{real!r}, *argv])\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)

    def _suite_fixture_body(self, name: str, *, exit_code: int = 0, message: str | None = None) -> str:
        """The canonical suite, answered: the executable records WHERE it ran
        (cwd, HEAD) as its stdout — the gate captures that on the
        validation-runs ledger, which is where the pins read it back
        (ARIA-HIGH-124 round 3: the gate runs inside the validation sandbox,
        where a host log outside the worktree is not reachable; the host
        log is still appended when its directory is, for the baseline that
        staging runs in this process). `npm run <script>` does what
        npm-run-script does — reads `package.json` in the cwd and runs
        `scripts[<script>]` through `sh -c` — so a script the AGENT
        committed is what executes."""
        return (
            "import json, os, subprocess, sys\n"
            "argv = sys.argv[1:]\n"
            f"if {name!r} == 'npm' and argv[:1] == ['run'] and os.path.isfile('package.json'):\n"
            "    scripts = json.load(open('package.json', encoding='utf-8')).get('scripts') or {}\n"
            "    if argv[1] in scripts:\n"
            "        raise SystemExit(subprocess.run(['sh', '-c', scripts[argv[1]]]).returncode)\n"
            "head = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()\n"
            f"record = {{'executable': {name!r}, 'argv': argv, 'cwd': os.getcwd(), 'head': head}}\n"
            "try:\n"
            f"    with open({str(self.suite_log)!r}, 'a', encoding='utf-8') as log:\n"
            "        log.write(json.dumps(record) + '\\n')\n"
            "except OSError:\n"
            "    pass\n"
            "print(json.dumps(record))\n"
            + (f"print({message!r})\n" if message else "")
            + f"raise SystemExit({exit_code})\n"
        )

    def _install_fixture_executable(self, name: str, body: str) -> None:
        executable = self.fixture_bin / name
        executable.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        executable.chmod(0o755)

    def _suite_calls(self) -> list[dict]:
        if not self.suite_log.exists():
            return []
        return [json.loads(line) for line in self.suite_log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _gate_calls(self, implementation: dict) -> list[dict]:
        """What the fixture suite printed, read off the runs the gate recorded
        (the executor's stamp carries each run's bounded output)."""
        calls: list[dict] = []
        for row in implementation["validation_results"]:
            # The bounded output is the hash-bound log: `command:`, `argv:`,
            # then the stdout section, then the stderr section.
            log = row["output_head_tail"] or ""
            stdout = log.split("--- stdout ---", 1)[1].split("--- stderr ---", 1)[0] if "--- stdout ---" in log else ""
            first = stdout.strip().splitlines()[:1]
            calls.append(json.loads(first[0]) if first else {})
        return calls

    def _recorded_gate_run_rows(self, implementation: dict) -> list[dict]:
        """The gate's recorded runs as the ledger holds them (their
        `completed_at` is the gate's end for each command)."""
        from aria_kernel.validation_runs_ledger import verify_validation_run

        return [verify_validation_run(row["validation_run_id"], base_dir=self.tools) for row in implementation["validation_results"]]

    def _recorded_gate_runs(self, implementation: dict) -> list[dict]:
        """The gate's recorded runs, each with the argv its hash-bound log
        says executed (`argv: [...]` on the log's second line)."""
        import ast

        from aria_kernel.validation_runs_ledger import _validation_log_path, verify_validation_run

        runs: list[dict] = []
        for row in implementation["validation_results"]:
            ledger_row = verify_validation_run(row["validation_run_id"], base_dir=self.tools)
            log = Path(_validation_log_path(ledger_row, base_dir=self.tools)).read_text(encoding="utf-8")
            argv_line = next(line for line in log.splitlines() if line.startswith("argv: "))
            runs.append({"cmd": ledger_row["cmd"], "argv": ast.literal_eval(argv_line[len("argv: "):])})
        return runs

    def _gh_calls(self) -> list[dict]:
        if not self.gh_log.exists():
            return []
        return [json.loads(line) for line in self.gh_log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _push_calls(self) -> list[dict]:
        if not self.push_log.exists():
            return []
        return [json.loads(line) for line in self.push_log.read_text(encoding="utf-8").splitlines() if line.strip()]

    @staticmethod
    def _epoch(stamp: str) -> float:
        from datetime import datetime, timezone

        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()

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
            self.completed = completed
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

    def _governance_rows(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return list(load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance"))

    def _governance(self, kind: str) -> list[dict]:
        return [row for row in self._governance_rows() if row.get("kind") == kind]

    def _plan_state(self) -> str:
        return str(self._plan_fold()["state"])

    def _plan_fold(self) -> dict:
        from aria_kernel.plan_convergence import fold_plan_state

        return fold_plan_state(plan_id=self.plan_id, base_dir=self.tools)

    def _external_effects(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.recovery import EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE

        path = self.tools.joinpath(*EXTERNAL_EFFECTS_RELPATH)
        return load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE) if path.is_file() else []

    def _change_committed(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        path = self.tools / "change-ledger" / "committed.jsonl"
        return [row for row in load_declared_jsonl(path, expected_surface="change_committed")
                if row.get("change_id") == self.ids["change_id"]] if path.is_file() else []

    def _claim_rows(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        path = self.tools / "agent-invocations" / "claims.jsonl"
        return [row for row in load_declared_jsonl(path, expected_surface="agent_invocation_claims")
                if row.get("request_id") == self.request_id] if path.is_file() else []

    def _claim_id(self) -> str:
        created = [row for row in self._governance("agent_claim_created") if row["details"].get("request_id") == self.request_id]
        self.assertEqual(len(created), 1, created)
        return str(created[0]["details"]["claim_id"])

    def _restage(self, plan_id: str, *, extra_allowed_paths: tuple[str, ...]) -> None:
        """A second request, minted and staged by production's producer on a
        plan that intends more paths than the fixture's; the pins below then
        run THAT request."""
        with patch.dict(os.environ, {"ARIA_TOOLS_DIR": str(self.tools), "PATH": self.environment["PATH"]}), \
                patch("aria_kernel.apply_engine.mint_unpredictable_feature_branch_name", _mint_branch_with_a_ten_digit_run):
            self.request = production_staged_implementation_request(
                tools_dir=self.tools, workspace_root=self.repo, plan_id=plan_id,
                allowed_path=SOURCE, cycle_id=CYCLE_ID, extra_allowed_paths=extra_allowed_paths,
            )
        self.request_id = self.request["request_id"]
        self.ids = self.request["implementation_ids"]
        self.plan_id = plan_id
        self.baseline_calls = self._suite_calls()

    def _validation_groups(self) -> list[dict]:
        from aria_kernel.validation import list_validation_plans

        return [group for group in list_validation_plans(base_dir=self.tools) if group.get("change_id") == self.ids["change_id"]]

    def _apply_action(self) -> dict | None:
        from aria_kernel.apply_engine import latest_apply_action

        return latest_apply_action(proposal_id=self.ids["proposal_id"], base_dir=self.tools)

    def _human_required(self) -> list[dict]:
        path = self.tools / "human-required" / f"{self.request_id}.json"
        return [json.loads(path.read_text(encoding="utf-8"))] if path.is_file() else []

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

        from aria_kernel.mcp_broker import SANDBOX_MCP_BROKER_SOCKET

        self.assertEqual(observed["sandbox"], {
            # ARIA-HIGH-124 — the agent STARTED on the kernel-made branch
            # at the staged base, held no delivery credential, and was
            # handed the MCP broker's socket by name.
            "branch_at_start": self.ids["branch"], "head_at_start": self.base_sha,
            "delivery_token_in_env": False, "git_credential_helper_in_env": False,
            "mcp_broker_env": SANDBOX_MCP_BROKER_SOCKET,
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
        self._assert_delivered(envelope, observed)
        # The IMPL row landed: the bridge accepted the outcome — with the
        # KERNEL's pr_url, which the agent never supplied.
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        self.assertEqual(self._plan_fold()["implementation"]["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(self._plan_fold()["implementation"]["branch_tip_sha"], head)
        self.assertEqual(self._governance("agent_bridge_warning"), [])
        self.assertEqual(self._governance("implementation_signer_fp_overridden"), [])
        self.assertEqual(self._governance("implementation_delivery_overridden"), [])
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

    def _assert_delivered(self, envelope: dict, observed: dict) -> None:
        """ARIA-HIGH-124 — the executor gated, pushed and opened the PR
        OUTSIDE the sandbox, and stamped the kernel's facts on the record."""
        from aria_kernel.implementation_delivery import KERNEL_STAMPED_DELIVERY_FIELDS
        from aria_kernel.mcp_server import READ_TOOLS
        from aria_kernel.validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

        implementation = envelope["details"]["implementation"]
        head = observed["head"]
        # The stamp: every kernel field present, none of it from the agent.
        self.assertEqual(implementation["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(implementation["pr_number"], 124)
        self.assertEqual(implementation["branch"], self.ids["branch"])
        self.assertEqual(implementation["branch_tip_sha"], head)
        self.assertEqual(implementation["base_branch_sha"], self.base_sha)
        expected_diff = _git(["diff", self.base_sha, head], cwd=self.repo).stdout
        self.assertEqual(implementation["diff_hash"], "sha256:" + hashlib.sha256(expected_diff.encode("utf-8")).hexdigest())
        self.assertTrue(implementation["validation_gate_ref"], implementation)
        self.assertEqual(
            [(row["command"], row["exit_code"]) for row in implementation["validation_results"]],
            [(command, 0) for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE],
        )
        self.assertTrue(all(row["validation_run_id"] and row["log_hash"] for row in implementation["validation_results"]))
        self.assertTrue(set(KERNEL_STAMPED_DELIVERY_FIELDS) <= set(implementation), implementation)
        # The gate ran the suite in the REQUEST WORKTREE at the published
        # branch's tip (the baseline ran in the checkout at the base), and
        # promoted the staged action to ready_for_pr with the stamped ref.
        # (round 3) the gate's calls are read off the RECORDED runs — the
        # fixture executables print where they ran, the contained child's
        # stdout is what the executor captured — while the baseline (run
        # in this process by staging) still reaches the host log; the host
        # log sees no gate call at all, because the sandbox does not reach
        # it.
        gate_calls = self._gate_calls(implementation)
        self.assertEqual(self._suite_calls(), self.baseline_calls, "the contained gate cannot reach a host log")
        self.assertEqual([call["head"] for call in self.baseline_calls], [self.base_sha] * len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        self.assertEqual(
            [(" ".join([call["executable"], *call["argv"]]), call["head"]) for call in gate_calls],
            [(command, head) for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE],
        )
        self.assertTrue(all(Path(call["cwd"]).name == f"req-{self.request_id}" for call in gate_calls), gate_calls)
        action = self._apply_action()
        self.assertEqual((action["status"], action["validation_gate_ref"]), ("ready_for_pr", implementation["validation_gate_ref"]))
        # (round 3) every recorded run's executed argv is the SANDBOX's: the
        # hash-bound log names bwrap, the unshared network, the read-only
        # kernel tree and the worktree — the evidence says the run was
        # contained.
        for row in self._recorded_gate_runs(implementation):
            argv = row["argv"]
            self.assertEqual(argv[0], "bwrap", argv[:3])
            self.assertIn("--unshare-net", argv)
            self.assertEqual(argv[argv.index("--") + 1:][:2], row["cmd"].split()[:2])
            bind_sources = {argv[i + 1] for i, token in enumerate(argv) if token in ("--bind", "--ro-bind")}
            self.assertNotIn(str(self.tools), bind_sources, "the store is never a bind of the validation sandbox")
            self.assertNotIn(str(_KERNEL_DIR), bind_sources, "the code root is never a bind of the validation sandbox")
            self.assertNotIn("ARIA_HOOK_BROKER_SOCKET", argv)
            self.assertNotIn("ARIA_MCP_BROKER_SOCKET", argv)
            # (round 5) the keys-dir mask is on the recorded argv: an empty
            # tmpfs over the worktree's `aria-debts/keys`.
            masks = [argv[i + 1] for i, token in enumerate(argv) if token == "--tmpfs"]
            self.assertIn(str(Path(gate_calls[0]["cwd"]) / "aria-debts" / "keys"), masks, argv)
        # (round 2) the change ledger's commit row — the merge gate's
        # `triple_gate_change_committed_missing` input — is the executor's,
        # from the diff's own file list; the agent's contract used to name a
        # kernel function it could not call, and no row was ever written.
        committed = self._change_committed()
        self.assertEqual(len(committed), 1, committed)
        self.assertEqual((committed[0]["change_id"], committed[0]["commit_sha"], committed[0]["claim_id"],
                          committed[0]["implementation_complete"], committed[0]["uncovered_intended_dispositions"]),
                         (self.ids["change_id"], head, self._claim_id(), True, {}))
        self.assertEqual(set(committed[0]["actual_affected_files"]),
                         set(_git(["diff", "--name-only", self.base_sha, head], cwd=self.repo).stdout.split()))
        # The push reached the fixture remote with the executor's credential
        # (the names, never the value, are what the fixture records), and
        # the PR was opened through `open_pr_for_action` against ARIA_PR_BASE.
        self.assertEqual(_git(["rev-parse", f"refs/heads/{self.ids['branch']}"], cwd=self.remote).stdout.strip(), head)
        gh_calls = self._gh_calls()
        self.assertEqual(len(gh_calls), 1, gh_calls)
        self.assertEqual(gh_calls[0]["argv"][:6], ["pr", "create", "--base", "main", "--head", self.ids["branch"]])
        self.assertEqual(gh_calls[0]["credential_names"], ["GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
        self.assertEqual(Path(gh_calls[0]["cwd"]).name, f"req-{self.request_id}")
        # (round 5) at the moment the PR is opened the worktree's keys dir
        # holds NOTHING: the private key was retired right after the
        # publication (before the gate ran the agent's suite), and the
        # delivery token never lived under the workspace — it sits in a
        # private directory of the executor's, which the issued row says.
        # Until round 5 the listing here read `[<cycle>, <cycle>.pub,
        # <lease>.token]`.
        self.assertEqual(gh_calls[0]["keys_dir_entries"], [])
        retired = self._governance(ci_executor.IMPLEMENTATION_IDENTITY_RETIRED_EVENT)
        self.assertEqual(len(retired), 1, retired)
        self.assertEqual((retired[0]["details"]["retired"], retired[0]["details"]["keys_dir_entries"],
                          retired[0]["details"]["cycle_id"]), ("after_publication", [], CYCLE_ID))
        kinds = [row["kind"] for row in self._governance_rows()]
        self.assertLess(kinds.index(ci_executor.IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT),
                        kinds.index(ci_executor.IMPLEMENTATION_IDENTITY_RETIRED_EVENT))
        self.assertLess(kinds.index(ci_executor.IMPLEMENTATION_IDENTITY_RETIRED_EVENT), kinds.index("implementation_delivered"))
        self.assertLess(completed_stderr_index(self, "implementation_identity_retired"), completed_stderr_index(self, "implementation_delivered"))
        self.assertEqual([row["details"]["token_file_outside_workspace"] for row in self._governance("delivery_credential_issued")], [True, True])
        # (round 6) the credential the push and the PR carried was minted
        # WHERE IT IS CONSUMED: after the identity was retired, after every
        # run the gate recorded had completed, right before the push — and
        # revoked before the delivery was recorded. The pre-spawn lease is
        # the ADMISSION's (minted and revoked before the spawn, read by
        # nobody). Until round 6 the one lease was minted before the spawn
        # and revoked at the process's exit: `delivery_credential_issued`
        # preceded `claude_subprocess_env_audit` and `delivery_credential_revoked`
        # followed `implementation_delivered`.
        issued = self._governance("delivery_credential_issued")
        self.assertEqual([row["details"]["consumer"] for row in issued], ["executor_admission", "executor_delivery"])
        admission_issued, delivery_issued = issued
        self.assertEqual([row["details"]["mode"] for row in issued], ["pat_fallback", "pat_fallback"])
        admitted = self._governance("delivery_credential_admitted")
        self.assertEqual([row["details"]["mode"] for row in admitted], ["pat_fallback"])
        self.assertLess(kinds.index("delivery_credential_admitted"), kinds.index("claude_subprocess_env_audit"))
        issued_positions = [index for index, kind in enumerate(kinds) if kind == "delivery_credential_issued"]
        revoked_positions = [index for index, kind in enumerate(kinds) if kind == "delivery_credential_revoked"]
        self.assertEqual(len(revoked_positions), 2, kinds)
        self.assertLess(issued_positions[0], kinds.index("claude_subprocess_env_audit"))
        self.assertLess(revoked_positions[0], kinds.index("claude_subprocess_env_audit"))
        self.assertLess(kinds.index(ci_executor.IMPLEMENTATION_IDENTITY_RETIRED_EVENT), issued_positions[1])
        self.assertLess(issued_positions[1], revoked_positions[1])
        self.assertLess(revoked_positions[1], kinds.index("implementation_delivered"))
        minted_at = self._epoch(delivery_issued["details"]["minted_at_utc"])
        for run in self._recorded_gate_run_rows(implementation):
            self.assertGreaterEqual(minted_at, self._epoch(run["completed_at"]), run)
        self.assertLess(self._epoch(admission_issued["details"]["minted_at_utc"]), minted_at)
        pushes = self._push_calls()
        self.assertEqual(len(pushes), 1, pushes)
        self.assertGreater(pushes[0]["time"], minted_at)
        self.assertLessEqual({"GH_TOKEN", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"}, set(pushes[0]["credential_names"]))
        self.assertIn(f"refs/heads/{self.ids['branch']}", pushes[0]["refs"])
        self.assertGreater(gh_calls[0]["time"], pushes[0]["time"])
        self.assertLess(completed_stderr_index(self, "delivery_credential_admitted mode=pat_fallback"),
                        completed_stderr_index(self, "claude_returned_exit"))
        # (round 3) the PR body cites the gate's own recorded runs — resolved
        # through the action's comparison chain, not a plan name the
        # executor's gate never gives — and the worktree it ran in.
        body = gh_calls[0]["argv"][gh_calls[0]["argv"].index("--body") + 1]
        self.assertNotIn("No validation run refs recorded", body)
        evidence = body.split("### Validation Evidence", 1)[1].split("## Baseline Comparison", 1)[0]
        self.assertEqual(len([line for line in evidence.splitlines() if line.startswith("- `")]),
                         len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        self.assertIn(f"- Worktree: `{_git(['rev-parse', '--show-toplevel'], cwd=self.repo).stdout.strip()}/aria-worktrees/req-{self.request_id}`", body)
        effects = [(row["operation_id"].split(":", 1)[0], row["event"], row.get("status"))
                   for row in self._external_effects() if row.get("request_id") == self.request_id]
        self.assertEqual(effects, [("git_push", "intent", None), ("git_push", "receipt", "confirmed"),
                                   ("pr_create", "intent", None), ("pr_create", "receipt", "confirmed")])
        self.assertEqual(recovery_unresolved_intents(self.request_id, base_dir=self.tools), [])
        delivered = self._governance("implementation_delivered")
        self.assertEqual(len(delivered), 1, delivered)
        self.assertEqual((delivered[0]["details"]["pr_url"], delivered[0]["details"]["pr_number"], delivered[0]["details"]["branch_tip_sha"]),
                         (FIXTURE_PR_URL, 124, head))
        self.assertEqual(self._governance("implementation_delivery_refused"), [])
        # The credentials were minted for the executor's admission and its
        # delivery and revoked; neither rode a spawn.
        self.assertEqual(len(self._governance("delivery_credential_revoked")), 2)
        # Inside the sandbox the command policy refused the kernel's
        # commands BY NAME through the real broker; a read stayed allowed.
        policy = observed["policy"]
        self.assertEqual((policy["apply_gate"]["exit_code"], policy["pr_create"]["exit_code"], policy["push"]["exit_code"]), (2, 2, 2))
        self.assertIn("kernel_authority:kernel_cli", policy["apply_gate"]["reason"])
        self.assertIn("kernel_authority:kernel_cli", policy["pr_create"]["reason"])
        self.assertIn("kernel_authority:git_push_any", policy["push"]["reason"])
        self.assertEqual((policy["status"]["exit_code"], policy["status"]["reason"]), (0, "command_policy_allow"))
        # (round 4) and the commit shapes that would carry another identity,
        # refused by name where the round-3 policy admitted them; the plain
        # commit the contract names stays allowed.
        for probe in ("commit_own_key", "commit_short_key", "commit_author"):
            self.assertEqual(policy[probe]["exit_code"], 2, policy[probe])
            self.assertIn("commit_identity:git_commit_foreign_option", policy[probe]["reason"], policy[probe])
        self.assertEqual((policy["commit_plain"]["exit_code"], policy["commit_plain"]["reason"]), (0, "command_policy_allow"))
        # The `aria` MCP view: the document names the RELAY (run by path
        # under the checkout's kernel tree, no server spawned inside), it
        # answered with the REAL store's rows — this request's own claim —
        # and refused the write tool.
        mcp = observed["mcp"]
        self.assertEqual((mcp.get("error"), mcp["rc"], mcp["server_name"]), (None, 0, "aria"), mcp)
        self.assertEqual(mcp["args_basenames"], ["-I", "mcp_relay.py"])
        self.assertEqual(mcp["env_names"], [])
        self.assertEqual(mcp["tools"], sorted(READ_TOOLS))
        self.assertEqual((mcp["governance_error"], mcp["governance_is_error"]), (None, False))
        self.assertIn(self.request_id, mcp["claim_rows_seen"])
        self.assertTrue(mcp["write_tool"]["is_error"], mcp["write_tool"])
        self.assertEqual(self._governance("mcp_write_tool_used"), [])
        self.assertEqual(self._human_required(), [])

    def test_the_lease_an_implementation_child_claims_with_holds_its_delivery(self) -> None:
        # ARIA-HIGH-124 (round 4) — the claim's lease is THIS child's own
        # priced worst case, including the post-spawn delivery of THIS
        # request (its staged suite and ceiling). The kernel's default
        # (`DEFAULT_LEASE_SECONDS`, 1800) equals MAX_TIMEOUT_SECONDS, so a
        # CLI run at its cap outlived the lease and `submit_claim_result`
        # refused the finished work `lease_expired`; a delivery could not
        # fit under it at all. The trade the longer lease makes: a killed
        # implementation child's request waits that lease out before
        # `reap_stale_claims` re-queues it, which is why the number is
        # priced rather than picked.
        from aria_kernel.agent_invocations import DEFAULT_LEASE_SECONDS
        from aria_kernel.implementation_delivery import staged_delivery_worst_case_seconds

        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        claimed = [row for row in self._claim_rows() if row.get("event") == "claimed"]
        self.assertEqual(len(claimed), 1, claimed)
        expected = ci_executor.child_worst_case_seconds(
            int(self.environment["MAX_TIMEOUT_SECONDS"]),
            implementation_delivery_seconds=staged_delivery_worst_case_seconds(
                proposal_id=self.ids["proposal_id"], base_dir=self.tools,
            ),
        )
        self.assertEqual(claimed[0]["lease_seconds"], expected)
        self.assertNotEqual(claimed[0]["lease_seconds"], DEFAULT_LEASE_SECONDS)
        # The delivery term is the request's own, off its staged action —
        # strictly more than a read-only child's lease.
        self.assertGreater(expected, ci_executor.child_worst_case_seconds(int(self.environment["MAX_TIMEOUT_SECONDS"])))
        self.assertEqual(
            ci_executor._request_delivery_seconds(tools_dir=self.tools, request_id=self.request_id),
            staged_delivery_worst_case_seconds(proposal_id=self.ids["proposal_id"], base_dir=self.tools),
        )

    def test_a_fabricated_delivery_from_the_agent_is_overridden_and_recorded(self) -> None:
        # ARIA-HIGH-124 — an agent that writes pr_url / branch_tip_sha of
        # its own: the kernel's facts replace them, the difference is on
        # governance, and the outcome lands under the kernel's values.
        fabricated = {"pr_url": "https://github.com/fixture/forged/pull/1", "branch_tip_sha": "f" * 40, "pr_number": 1}
        self._install_implementer(claimed_delivery=fabricated)
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        envelope = self._submitted_envelope()
        implementation = envelope["details"]["implementation"]
        self.assertEqual(implementation["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(implementation["branch_tip_sha"], envelope["details"]["agent_observation"]["head"])
        overridden = self._governance("implementation_delivery_overridden")
        self.assertEqual(len(overridden), 1, overridden)
        self.assertEqual(overridden[0]["details"]["agent_supplied"],
                         {"pr_url": fabricated["pr_url"], "branch_tip_sha": fabricated["branch_tip_sha"], "pr_number": "1"})
        self.assertEqual(overridden[0]["details"]["kernel"]["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(overridden[0]["details"]["request_id"], self.request_id)
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        self.assertEqual(self._plan_fold()["implementation"]["pr_url"], FIXTURE_PR_URL)

    def test_an_agent_that_commits_nothing_is_refused_before_any_push_or_pr(self) -> None:
        # ARIA-HIGH-124 — the branch stands at the base with no commit: the
        # publication DISCARDS the kernel's own seed (`branch_unadvanced`,
        # round 2 — it used to adopt it as the agent's branch), the delivery
        # refuses by name at its first stage, nothing is pushed, no `gh`
        # runs, the request is escalated and the claim released
        # request-class — terminal from that release (`HUMAN_REQUIRED`), not
        # after two more claims burned on the same refusal.
        self._install_implementer(commit=False)
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        refused = self._governance("implementation_delivery_refused")
        self.assertEqual(len(refused), 1, refused)
        self.assertEqual(refused[0]["details"]["stage"], "branch_publication")
        # (The agent's own `main.lock` probe is the other discarded ref.)
        self.assertTrue(refused[0]["details"]["reason"].startswith("branch_not_published:refs_published=[]:discarded="), refused)
        self.assertIn(f"{self.ids['branch']}=branch_unadvanced", refused[0]["details"]["reason"])
        published = self._governance(ci_executor.IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT)
        self.assertEqual((published[0]["details"]["refs_published"], published[0]["details"]["head_adopted"]), ([], None))
        self.assertIn({"ref": self.ids["branch"], "reason": "branch_unadvanced"}, published[0]["details"]["refs_discarded"])
        # The seed never became a branch of the shared repository.
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.repo, check=False).returncode, 1,
                         "the kernel's seed was published as a branch")
        self.assertEqual(self._gh_calls(), [])
        self.assertEqual(self._apply_action()["status"], "staged_for_implementation", "the gate never ran")
        self.assertEqual(len(self._validation_groups()), 1, "only the baseline group is recorded")
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1, "nothing was pushed")
        self.assertEqual([row for row in self._external_effects() if row.get("request_id") == self.request_id], [])
        self._assert_escalated_from_the_release("implementation_delivery_refused:branch_publication")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")
        self.assertFalse(Path(self.request["expected_output_path"]).exists() and "pr_url" in
                         json.loads(Path(self.request["expected_output_path"]).read_text(encoding="utf-8"))["details"]["implementation"])

    def test_a_blocked_gate_opens_no_pr(self) -> None:
        # ARIA-HIGH-124 — the canonical suite fails at the branch tip: the
        # gate blocks, the executor pushes nothing and opens nothing, and
        # the refusal names the gate.
        self._install_fixture_executable(
            "npm", self._suite_fixture_body("npm", exit_code=1, message="type error: the change broke the build"),
        )
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        refused = self._governance("implementation_delivery_refused")
        self.assertEqual(len(refused), 1, refused)
        self.assertEqual(refused[0]["details"]["stage"], "apply_gate")
        self.assertTrue(refused[0]["details"]["reason"].startswith("gate_blocked:"), refused)
        self.assertEqual(self._apply_action()["status"], "blocked")
        self.assertEqual(self._gh_calls(), [])
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1, "nothing was pushed")
        self._assert_escalated_from_the_release("implementation_delivery_refused:apply_gate")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")

    def test_a_branch_the_repository_already_holds_is_refused_before_any_turn(self) -> None:
        # ARIA-HIGH-124 — an earlier attempt published the branch: the
        # kernel refuses to stand the sandbox on it before the spawn, no
        # identity survives, no turn is spent, a person decides.
        _git(["branch", self.ids["branch"], self.base_sha], cwd=self.repo)
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no agent turn was spent")
        self.assertNotIn("claude_returned_exit", completed.stderr)
        refusals = self._governance("implementation_branch_collision")
        self.assertEqual(len(refusals), 1, refusals)
        self.assertEqual(refusals[0]["details"]["reason"], "git_containment_refused:implementation_branch_exists")
        self.assertEqual(refusals[0]["details"]["branch"], self.ids["branch"])
        self._assert_escalated_from_the_release("implementation_branch_collision")
        self.assertEqual(self.worktree_keys_after, [], "the identity was revoked with the refusal")
        self.assertEqual(self._gh_calls(), [])

    def _assert_escalated_from_the_release(self, reason: str) -> None:
        """ARIA-HIGH-124 (round 2) — an executor escalation is terminal from
        its own release: the HUMAN_REQUIRED record is on the store, the claim
        event of the same release is `human_required` (requeue_count 1, the
        first request-class fault), the request derives HUMAN_REQUIRED and
        the kernel refuses a second claim. Before this the executor wrote
        the record but released `requeued`, and the drain burned two more
        pre-turn refusals on the same request before the threshold escalated
        it."""
        from aria_kernel.tool_registry import GovernanceError

        self.assertEqual(len(self._human_required()), 1, self._human_required())
        self.assertIn(reason, self._human_required()[0]["reason"])
        escalated = self._governance("agent_human_required")
        self.assertEqual([(row["details"]["reason"], row["details"]["requeue_count"]) for row in escalated], [(reason, 1)])
        self.assertEqual(self._governance("agent_requeued"), [])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "HUMAN_REQUIRED")
        with self.assertRaises(GovernanceError) as refused:
            self.ai.claim_request(request_id=self.request_id, agent_id="retry", base_dir=self.tools)
        self.assertIn("HUMAN_REQUIRED", str(refused.exception))

    def test_a_spawn_that_fails_before_any_commit_leaves_no_branch_and_its_retry_stands_on_it(self) -> None:
        # ARIA-HIGH-124 (round 2) — the CLI exits 1 right after its first
        # reads: the shape of a timeout, a provider outage, an operator
        # cancel (the publication runs in the `finally` before every one of
        # those arms). The kernel's seed is discarded, not published: the
        # shared repository holds no `aria-impl-*` branch, the claim is
        # released harness-class (REQUEUED, budget untouched) and the
        # retry stands on the branch again and delivers. Before this the
        # seed was published as a real branch and the retry was refused
        # pre-turn as a collision — every harness fault of an
        # implementation spawn ended in a human after one wasted retry.
        self._install_implementer(exit_after_start=1)
        completed, _worktree = self._run_in_request_worktree()
        # The executor's own exit for a CLI that ended non-zero (the claim
        # released, nothing submitted).
        self.assertEqual(completed.returncode, 1, self._diagnostic(completed))
        self.assertNotIn("claude_returned_exit", completed.stderr)
        published = self._governance(ci_executor.IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT)
        self.assertEqual(len(published), 1, published)
        self.assertEqual((published[0]["details"]["refs_published"], published[0]["details"]["head_adopted"],
                          published[0]["details"]["refs_discarded"]),
                         ([], None, [{"ref": self.ids["branch"], "reason": "branch_unadvanced"}]))
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.repo, check=False).returncode, 1,
                         "a failed spawn published the kernel's seed as a branch")
        self.assertEqual([(row["details"]["reason"], row["details"]["requeue_count"]) for row in self._governance("agent_requeued")],
                         [("claude_cli_exit_1", 0)])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "REQUEUED")
        self.assertEqual(self._human_required(), [])
        self.assertEqual(self._governance("implementation_delivery_refused"), [])
        self.assertEqual(self._gh_calls(), [])
        # The retry: a fresh worktree, the same request, the branch stood
        # on again — no collision, a commit, a delivery.
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        self.assertIn("implementation_branch_prepared", completed.stderr)
        self.assertEqual(self._governance("implementation_branch_collision"), [])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "ACCEPTED")
        envelope = self._submitted_envelope()
        head = envelope["details"]["agent_observation"]["head"]
        self.assertNotEqual(head, self.base_sha)
        self.assertEqual(_git(["rev-parse", f"refs/heads/{self.ids['branch']}"], cwd=self.repo).stdout.strip(), head)
        self.assertEqual(envelope["details"]["implementation"]["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        self.assertEqual(self._human_required(), [])

    def test_a_kernel_package_planted_at_the_worktree_root_never_runs_as_the_executor(self) -> None:
        # ARIA-HIGH-124 (round 2) — the executor's kernel commands after the
        # spawn run with the request worktree as cwd; `python -m` used to put
        # that cwd FIRST on sys.path, so an `aria_kernel/__main__.py` the
        # agent wrote at its worktree root ran AS the executor's
        # `agent submit-result` (and `human-required record`, `agent
        # release`), outside the sandbox, with the lease token, GH_TOKEN and
        # the store binding in its environment. The agent here plants the
        # package and a stdlib `json` shadow and commits them with its
        # change; the executor's kernel resolves from the code root
        # (`-P`), the marker stays empty, and the real submit lands.
        marker = self.root / "kernel-shadow-marker.jsonl"
        planted = ("aria_kernel/__init__.py", "aria_kernel/__main__.py", "json.py")
        # A plan that intends the planted paths, so the change ledger admits
        # the commit and the delivery reaches the submit — the one kernel
        # subprocess that carries the lease token AND runs after the tree
        # holds the agent's files.
        self._restage("plan-kernel-shadow", extra_allowed_paths=planted)
        self._install_implementer(kernel_shadow_marker=str(marker))
        completed, worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        rows = [json.loads(line) for line in marker.read_text(encoding="utf-8").splitlines()] if marker.exists() else []
        self.assertEqual(rows, [], "a module the agent planted ran in an executor process: " + json.dumps(rows)[:800])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "ACCEPTED")
        envelope = self._submitted_envelope()
        self.assertEqual(envelope["details"]["implementation"]["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        # The planted files are in the agent's commit — the evidence that
        # the tree the executor stood in did carry them.
        tip = envelope["details"]["implementation"]["branch_tip_sha"]
        committed = _git(["show", "--format=", "--name-only", tip], cwd=self.repo).stdout.split()
        self.assertEqual(set(committed), {SOURCE, *planted})
        self.assertEqual(set(self._change_committed()[0]["actual_affected_files"]), {SOURCE, *planted})
        self.assertEqual(ci_executor.KERNEL_CLI_INTERPRETER_FLAGS, ("-P",))

    def test_the_agents_validation_suite_runs_contained_while_the_delivery_lands(self) -> None:
        # ARIA-HIGH-124 (round 3) — the executor's apply gate executes the
        # AGENT's committed tree's suite: `npm run type-check` is whatever
        # `package.json` at the tip says it is. Until round 3 that ran as a
        # plain subprocess in the request worktree — the executor's own
        # uid, unconfined: the durable store, the shared repository's
        # `.git/refs/heads`, the CODE ROOT's `aria-kernel/aria_kernel/` (the
        # tree the executor's next `-P` kernel command resolves from), the
        # runner's `$HOME` and the kernel-held signing agent's socket dir
        # all writable to a script the agent wrote, and the delivery then
        # landed ACCEPTED with the PR. The agent here commits exactly that
        # script; the gate runs it inside the validation sandbox, and the
        # script's own record — captured by the executor from the contained
        # child and stamped on the result — says what it could reach: none
        # of it. The delivery still lands.
        targets = {
            "store": self.tools, "code_root_kernel": _KERNEL_DIR / "aria_kernel",
            "shared_refs_heads": self.repo / ".git" / "refs" / "heads", "real_home": self.home,
        }
        self._restage("plan-validation-probe", extra_allowed_paths=VALIDATION_PROBE_PATHS)
        self._install_implementer(validation_probe=_validation_probe_body(targets=targets))
        completed, _worktree = self._run_in_request_worktree()
        # The HOST's reading: no marker landed anywhere the suite aimed at.
        for name, path in targets.items():
            self.assertFalse((path / VALIDATION_PROBE_MARKER).exists(), f"the suite wrote into {name} on the host")
        self.assertFalse((_KERNEL_DIR / "aria_kernel" / VALIDATION_PROBE_MARKER).exists())
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "ACCEPTED")
        envelope = self._submitted_envelope()
        implementation = envelope["details"]["implementation"]
        self.assertEqual(implementation["pr_url"], FIXTURE_PR_URL)
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        tip = implementation["branch_tip_sha"]
        self.assertEqual(set(_git(["show", "--format=", "--name-only", tip], cwd=self.repo).stdout.split()),
                         {SOURCE, *VALIDATION_PROBE_PATHS})
        from aria_kernel.validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

        results = implementation["validation_results"]
        self.assertEqual([(row["command"], row["exit_code"]) for row in results],
                         [(command, 0) for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE])
        probe = next(self._gate_calls(implementation)[index] for index, row in enumerate(results)
                     if row["command"] == "npm run type-check")
        from aria_kernel.implementation_safety import SANDBOX_HOME, SANDBOX_TMPDIR

        self.maxDiff = None
        # The shared repository's refs are read-only inside (EROFS by the
        # syscall); the store's root and the code root are not the host's —
        # whatever the script "wrote" there stayed in the sandbox's private
        # root, as the host reading above proved; the home is the sandbox's
        # own; no broker, no agent socket, no credential name.
        self.assertEqual(probe["planted"]["shared_refs_heads"], "OSError")
        # (round 5) the keys dir is an EMPTY tmpfs inside the validation
        # sandbox — its own mount, whatever the host directory holds: no
        # `.token`, no private key, nothing to read. Until round 5 the
        # listing read `[<cycle>, <cycle>.pub, <lease>.token]` with the
        # token file and the private key both readable, and the gate
        # recorded that reading on the validation-runs ledger.
        self.assertEqual({name: value for name, value in probe.items() if name != "planted"}, {
            "keys_dir_entries": [], "keys_dir_readable": {}, "keys_dir_masked": True,
            "home_env": SANDBOX_HOME, "tmpdir_env": SANDBOX_TMPDIR,
            "hook_broker_socket": False, "mcp_broker_socket": False, "signing_agent_socket": False,
            "hook_broker_env": None, "mcp_broker_env": None,
            "gh_token_in_env": False, "lease_token_in_env": False, "store_binding_in_env": False,
            "cwd_writable": True, "executable": sys.executable,
        })
        # The recorded run of that command is the sandbox's argv, and the
        # other three commands were the fixture suite at the tip, contained.
        runs = {row["cmd"]: row["argv"] for row in self._recorded_gate_runs(implementation)}
        self.assertEqual(runs["npm run type-check"][0], "bwrap")
        self.assertIn("--unshare-net", runs["npm run type-check"])
        self.assertEqual([call.get("head") for call in self._gate_calls(implementation) if "head" in call], [tip] * 3)
        self.assertEqual(self._governance("implementation_delivery_refused"), [])
        self.assertEqual(self._human_required(), [])

    def test_a_commit_outside_the_plans_scope_is_refused_before_any_push_or_pr(self) -> None:
        # ARIA-HIGH-124 (round 2) — the same planted files against the
        # fixture plan, which intends only the source file: the change
        # ledger refuses the commit's scope drift by name, the delivery
        # stops at that stage — nothing pushed, no `gh` — and the planted
        # modules still run in no executor process (the human-required
        # record and the release run after the refusal, with the lease
        # token in their environment).
        marker = self.root / "kernel-shadow-marker.jsonl"
        self._install_implementer(kernel_shadow_marker=str(marker))
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self.assertFalse(marker.exists(), "a module the agent planted ran in an executor process")
        refused = self._governance("implementation_delivery_refused")
        self.assertEqual(len(refused), 1, refused)
        self.assertEqual(refused[0]["details"]["stage"], "change_ledger")
        self.assertIn("change_committed_refused:scope_drift_requires_human", refused[0]["details"]["reason"])
        self.assertIn("json.py", refused[0]["details"]["reason"])
        self.assertEqual(self._change_committed(), [])
        # (round 3) the scope verdict comes BEFORE the gate: an out-of-scope
        # tip's own suite never executes — the action is still staged, no
        # candidate group was recorded.
        self.assertEqual(self._apply_action()["status"], "staged_for_implementation", "the scope refusal precedes the gate")
        self.assertEqual(len(self._validation_groups()), 1, "only the baseline group is recorded")
        self.assertEqual(self._gh_calls(), [])
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1, "nothing was pushed")
        self.assertEqual([row for row in self._external_effects() if row.get("request_id") == self.request_id], [])
        self._assert_escalated_from_the_release("implementation_delivery_refused:change_ledger")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")

    def test_an_envelope_the_kernel_would_reject_spends_no_suite_no_push_and_no_pr(self) -> None:
        # ARIA-HIGH-124 (round 5) — the same plain, signed, in-scope commit
        # as the passing test, but every evidence ref of the envelope cites
        # `<source>:4000`, a line the file does not have: the envelope the
        # SUBMIT rejects (`agent_evidence_line_missing`, one per matrix
        # entry and one for the top-level refs). Until round 5 nothing
        # before the delivery decided the envelope, so this run pushed the
        # branch under the App's credential, opened the `[ARIA-AUTO]` PR,
        # and was rejected by the submit afterwards — a terminal REJECTED
        # request, no HUMAN_REQUIRED record, no governance row naming the
        # orphan PR, the dispatch summary reading `succeeded`. The delivery
        # now runs the submit's own decision chain against the published
        # tip (stage `result_admissible`) after the scope verdict and
        # BEFORE the suite, the push and the `gh` call.
        self._install_implementer(evidence_line=4000)
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        refused = self._governance("implementation_delivery_refused")
        self.assertEqual(len(refused), 1, refused)
        self.assertEqual(refused[0]["details"]["stage"], "result_admissible")
        self.assertTrue(refused[0]["details"]["reason"].startswith("result_rejected:agent_evidence_line_missing:"), refused)
        # Nothing external, nothing gated: no `gh`, no branch on the
        # remote, no effect intent, the action still staged (the suite
        # never ran), only the baseline group recorded, no commit row.
        self.assertEqual(self._gh_calls(), [])
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1,
                         "the branch was pushed for an envelope the kernel rejects")
        self.assertEqual([row for row in self._external_effects() if row.get("request_id") == self.request_id], [])
        self.assertEqual(self._apply_action()["status"], "staged_for_implementation", "the suite ran for a rejected envelope")
        self.assertEqual(len(self._validation_groups()), 1)
        self.assertEqual(self._change_committed(), [])
        self.assertEqual(self._governance("implementation_delivered"), [])
        # The submit never ran: no result row, no rejection row, no bridge
        # warning — the decision was the delivery's, and it is terminal
        # from the executor's own release.
        self.assertEqual(self._governance("agent_result_rejected"), [])
        self.assertEqual(self._governance("agent_result_accepted"), [])
        self.assertEqual(self._governance("agent_bridge_warning"), [])
        self._assert_escalated_from_the_release("implementation_delivery_refused:result_admissible")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")
        # The identity was retired before the delivery here too, and the
        # published (unpushed) branch is the kernel's own commit.
        self.assertEqual(self._governance(ci_executor.IMPLEMENTATION_IDENTITY_RETIRED_EVENT)[0]["details"]["keys_dir_entries"], [])
        published_tip = _git(["rev-parse", f"refs/heads/{self.ids['branch']}"], cwd=self.repo, check=False)
        self.assertEqual(published_tip.returncode, 0)
        self.assertTrue(self._verify_against_registry(published_tip.stdout.strip(), self._registered()[0]["signer_key_fp"]))

    def test_a_suite_whose_output_is_secret_shaped_opens_no_pr(self) -> None:
        # ARIA-HIGH-124 (round 5) — the gate's recorded runs are the agent's
        # output, hash-bound on the validation-runs ledger (pushed to the
        # state branch) and carried by the stamp. A `package.json` script
        # the agent committed prints a string shaped like a GitHub PAT (a
        # prefix and 36 filler characters, assembled at run time — nothing
        # in the tree matches the pattern): until round 5 the gate recorded
        # it raw, the delivery pushed and opened the PR, and the executor's
        # artifact scrub hid the string from the SUBMITTED envelope, so the
        # submit's own scan never saw what the ledger carried. The delivery
        # now scans exactly the rows the stamp will carry — the recorded
        # output read back through the ledger's verifier — before the push,
        # and refuses by name: a person decides.
        self._restage("plan-secret-shaped-output", extra_allowed_paths=VALIDATION_PROBE_PATHS)
        self._install_implementer(validation_probe=(
            "print('gh' + 'p_' + 'A' * 36)\n"
        ))
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        refused = self._governance("implementation_delivery_refused")
        self.assertEqual(len(refused), 1, refused)
        self.assertEqual(refused[0]["details"]["stage"], "apply_gate")
        self.assertTrue(refused[0]["details"]["reason"].startswith("gate_output_secret_shaped:"), refused)
        # The refusal names the pattern and a count, never the value.
        self.assertNotIn("A" * 36, refused[0]["details"]["reason"])
        self.assertEqual(self._gh_calls(), [])
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1)
        self.assertEqual([row for row in self._external_effects() if row.get("request_id") == self.request_id], [])
        self.assertEqual(self._change_committed(), [])
        self.assertEqual(self._governance("implementation_delivered"), [])
        self._assert_escalated_from_the_release("implementation_delivery_refused:apply_gate")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")

    def test_a_request_whose_implementation_ids_cannot_stand_a_sandbox_is_escalated_not_retried_forever(self) -> None:
        # ARIA-HIGH-124 (round 2) — the request row names a branch that is
        # not an `aria-impl-*` branch: the REQUEST's fact. It used to be
        # released harness-class (`implementation_signing_unavailable`,
        # requeue_count untouched), so the daemon re-claimed it after every
        # back-off without bound and never spent a turn nor escalated. Now:
        # request-class by name, a HUMAN_REQUIRED record, terminal.
        # Minted by the kernel's own envelope mint on a second converged
        # plan, with a branch nothing staged (the ledgers are hash-chained:
        # a row cannot be edited into this shape, only minted into it).
        from aria_kernel.cross_review_bridge import issue_implementation_envelope
        from tests._helpers.production_shaped import production_converged_plan

        with patch.dict(os.environ, {"ARIA_TOOLS_DIR": str(self.tools)}):
            plan = production_converged_plan(
                tools_dir=self.tools, workspace_root=self.repo, plan_id="plan-invalid-ids",
                affected_paths=[SOURCE], evidence_refs=[f"{SOURCE}:1"],
            )
            self.request = issue_implementation_envelope(
                plan_id=plan.plan_id, cross_review_revision_id=plan.revision_id, cross_review_summary_text="{}",
                proposal_id="proposal-unstaged", change_id="chg-unstaged", branch="feature/not-the-kernels",
                base_sha=self.base_sha, cycle_id=CYCLE_ID, base_dir=self.tools,
            )
        self.request_id = self.request["request_id"]
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no agent turn was spent")
        refusals = self._governance("implementation_request_invalid")
        self.assertEqual(len(refusals), 1, refusals)
        self.assertEqual(refusals[0]["details"]["reason"], "git_containment_refused:implementation_branch_name_invalid")
        self.assertEqual(self._governance("implementation_signing_unavailable"), [])
        self._assert_escalated_from_the_release("implementation_request_invalid")
        summary = json.loads((self.runner_temp / f"dispatch-result-{self.request_id}.json").read_text(encoding="utf-8"))
        self.assertEqual((summary["outcome"], summary["failure_detail_code"], summary["failure_class"], summary["retryable"]),
                         ("refused", "implementation_request_invalid", "policy_violation", False))
        self.assertEqual(self.worktree_keys_after, [], "the identity was revoked with the refusal")

    def _assert_refused_before_any_external_effect(self) -> None:
        """ARIA-HIGH-124 (round 4) — a tip the kernel's key did not sign
        reaches NO external surface: the delivery refuses at
        ``commit_identity`` before the gate, the push and the `gh` call, the
        escalation is terminal, and the plan stays where the envelope mint
        left it.

        Until round 4 the executor pushed `refs/heads/aria-impl-*` to origin
        with the App's credential and opened the `[ARIA-AUTO]` PR, and only
        the SUBMIT's bridge then refused the same commit
        `commit_signature_unverified`: a live PR nobody owned, on a plan
        still IMPLEMENTATION_REQUESTED, which a later cycle could request
        into a second branch and PR."""
        refused = self._governance("implementation_delivery_refused")
        self.assertEqual(len(refused), 1, refused)
        self.assertEqual(refused[0]["details"]["stage"], "commit_identity")
        self.assertTrue(refused[0]["details"]["reason"].startswith("commit_unverified:commit_signature_unverified"), refused)
        self.assertEqual(self._gh_calls(), [], "the PR was opened for a commit the kernel refuses")
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1,
                         "the branch was pushed under the App's identity")
        self.assertEqual([row for row in self._external_effects() if row.get("request_id") == self.request_id], [])
        self.assertEqual(self._apply_action()["status"], "staged_for_implementation", "the gate ran on an unverified tip")
        self.assertEqual(self._governance("implementation_delivered"), [])
        # The submit never ran, so no bridge warning stands in for a
        # decision the delivery already made.
        self.assertEqual(self._governance("agent_bridge_warning"), [])
        self._assert_escalated_from_the_release("implementation_delivery_refused:commit_identity")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_REQUESTED")

    def test_an_unsigned_commit_is_refused_by_name(self) -> None:
        self._install_implementer(commit_shape="unsigned")
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self._assert_refused_before_any_external_effect()

    def test_a_commit_signed_with_another_key_is_refused_by_name(self) -> None:
        self._install_implementer(commit_shape="other_key")
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self._assert_refused_before_any_external_effect()
        # The registered key is the executor's; the key the agent made for
        # itself never verifies against it.
        published_tip = _git(["rev-parse", f"refs/heads/{self.ids['branch']}"], cwd=self.repo, check=False)
        self.assertEqual(published_tip.returncode, 0, "the quarantine's publication is what the delivery then judged")
        self.assertFalse(self._verify_against_registry(
            published_tip.stdout.strip(), [row["signer_key_fp"] for row in self._registered()][0],
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

    def test_a_job_window_that_cannot_hold_the_delivery_refuses_before_the_spawn(self) -> None:
        # ARIA-HIGH-124 (round 3) — the job's deadline leaves less than the
        # CLI at its cap plus everything the executor runs after it (the
        # publication, the contained gate at the staged ceiling per command,
        # the push, the PR, the terminal writer, the release): refused
        # BEFORE the spawn — no turn spent, nothing published, no branch —
        # harness-class (the request keeps its budget), the governance row
        # naming the window. Before this the delivery was unpriced and the
        # spawn started into a window that could not hold it.
        import time

        from aria_kernel.implementation_delivery import staged_delivery_worst_case_seconds

        worst_case = staged_delivery_worst_case_seconds(proposal_id=self.ids["proposal_id"], base_dir=self.tools)
        self.assertGreater(worst_case, 12_000)
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree(
            extra_env={"ARIA_JOB_DEADLINE_EPOCH": str(int(time.time()) + worst_case - 600)},
        )
        self.assertEqual(completed.returncode, ci_executor.REFUSAL_EXIT_CODE, self._diagnostic(completed))
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no agent turn was spent")
        self.assertNotIn("claude_returned_exit", completed.stderr)
        self.assertIn("implementation_delivery_unavailable: deadline_insufficient:", completed.stderr)
        refusals = self._governance("implementation_delivery_unavailable")
        self.assertEqual(len(refusals), 1, refusals)
        self.assertTrue(refusals[0]["details"]["reason"].startswith("deadline_insufficient:remaining="), refusals)
        self.assertEqual(refusals[0]["details"]["decided"], "before_spawn")
        self.assertEqual(refusals[0]["details"]["delivery_worst_case_seconds"], worst_case)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "REQUEUED")
        self.assertEqual([(row["details"]["reason"], row["details"]["requeue_count"]) for row in self._governance("agent_requeued")],
                         [("implementation_delivery_unavailable", 0)])
        self.assertEqual(self._governance(ci_executor.IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT), [])
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.repo, check=False).returncode, 1)
        self.assertEqual(self._human_required(), [])
        summary = json.loads((self.runner_temp / f"dispatch-result-{self.request_id}.json").read_text(encoding="utf-8"))
        self.assertEqual((summary["outcome"], summary["failure_detail_code"], summary["failure_class"], summary["retryable"]),
                         ("refused", "implementation_delivery_unavailable", "harness_unavailable", True))
        self.assertEqual(self.worktree_keys_after, [], "the identity was revoked with the refusal")
        # The same request with the room: the delivery lands.
        self._install_implementer()
        completed, _worktree = self._run_in_request_worktree(
            extra_env={"ARIA_JOB_DEADLINE_EPOCH": str(int(time.time()) + worst_case + 7200)},
        )
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")

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
