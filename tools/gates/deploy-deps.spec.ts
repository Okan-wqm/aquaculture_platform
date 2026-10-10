#!/usr/bin/env ts-node
/**
 * Behavior of the deploy-owned dependency tree (INFRA-HIGH-218).
 *
 * On 2026-10-10 the development deploy of 1b64b69cb failed critical_health →
 * rollback_failed because the deploy checkout's node_modules was a symlink to
 * the interactive source repo's node_modules and a session's `npm ci` emptied
 * it. scripts/deploy/deploy-deps.ts now installs the deploy's own tree from the
 * deploy SHA's lockfile. These tests run the REAL tool (and, in the last test,
 * the real deploy-paths.sh functions over a fixture git repo) against a fake
 * `npm` on PATH, so install, reuse, retention, failure atomicity and the
 * capacity projection are exercised without the network.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { removeFixtureTree } from './fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TOOL = join(REPO_ROOT, 'scripts/deploy/deploy-deps.ts');
const DEPLOY_PATHS = join(REPO_ROOT, 'scripts/deploy/deploy-paths.sh');
const KEY = /^[0-9a-f]{64}$/u;

// npm runs with a scrubbed environment, so the fake reads its mode from and
// logs to files beside its own bin/ directory, never from env.
const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ "\${1:-}" = --version ]; then echo 10.9.8; exit 0; fi
ws=no; [ -f libs/a/package.json ] && ws=yes
leak=none; [ -n "\${GHCR_TOKEN:-}\${NODE_OPTIONS:-}" ] && leak=present
printf 'cwd=%s args=%s cache=%s userconfig=%s globalconfig=%s home=%s leak=%s ws=%s\\n' "$PWD" "$*" "\${npm_config_cache:-}" "\${npm_config_userconfig:-}" "\${npm_config_globalconfig:-}" "\${HOME:-}" "$leak" "$ws" >> "$here/npm.log"
mode=ok; [ -f "$here/npm-mode" ] && mode="$(cat "$here/npm-mode")"
case "$mode" in
  fail) echo 'fake npm: registry unreachable' >&2; exit 7 ;;
  empty) mkdir -p node_modules; exit 0 ;;
esac
mkdir -p node_modules/fake-dep
printf '{"name":"fake-dep","version":"1.0.0","type":"module","exports":"./index.js"}\\n' > node_modules/fake-dep/package.json
printf 'export default "fake-dep-loaded";\\n' > node_modules/fake-dep/index.js
`;

interface Fixture {
  base: string;
  checkout: string;
  root: string;
  bin: string;
  npmLog: string;
}

function lockfile(revision: string): string {
  return `${JSON.stringify({
    name: 'fx',
    revision,
    lockfileVersion: 3,
    packages: {
      '': { name: 'fx', workspaces: ['libs/*'], dependencies: { 'fake-dep': '1.0.0' } },
      'libs/a': { name: 'a', version: '0.0.0' },
      'node_modules/fake-dep': { version: '1.0.0' },
    },
  })}\n`;
}

/** A minimal deploy checkout: manifests + one deploy script importing fake-dep. */
function writeCheckout(dir: string, revision = 'r1'): void {
  mkdirSync(join(dir, 'scripts/deploy'), { recursive: true });
  mkdirSync(join(dir, 'libs/a'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fx', workspaces: ['libs/*'], dependencies: { 'fake-dep': '1.0.0' } }),
  );
  writeFileSync(join(dir, 'package-lock.json'), lockfile(revision));
  writeFileSync(join(dir, 'libs/a/package.json'), JSON.stringify({ name: 'a', version: '0.0.0' }));
  writeFileSync(join(dir, 'scripts/package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(dir, 'scripts/deploy/gate.ts'),
    "import dep from 'fake-dep';\nprocess.stdout.write(`${String(dep)}\\n`);\n",
  );
  copyFileSync(TOOL, join(dir, 'scripts/deploy/deploy-deps.ts'));
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'aqua-deploy-deps-'));
  const checkout = join(base, 'checkout');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), FAKE_NPM);
  chmodSync(join(bin, 'npm'), 0o755);
  writeCheckout(checkout);
  return { base, checkout, root: join(base, 'deps'), bin, npmLog: join(base, 'npm.log') };
}

function env(fx: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${fx.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: fx.base,
    FAKE_NPM_LOG: fx.npmLog,
    ...extra,
  };
}

function tool(
  fx: Fixture,
  command: string,
  extra: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const { FAKE_NPM_MODE: mode, ...rest } = extra;
  const modeFile = join(fx.base, 'npm-mode');
  if (mode === undefined) rmSync(modeFile, { force: true });
  else writeFileSync(modeFile, mode);
  const result = spawnSync(
    process.execPath,
    [TOOL, command, '--checkout', fx.checkout, '--root', fx.root],
    { encoding: 'utf8', env: env(fx, rest) },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function npmCalls(fx: Fixture): string[] {
  return existsSync(fx.npmLog) ? readFileSync(fx.npmLog, 'utf8').trim().split('\n') : [];
}

function keyDirs(fx: Fixture): string[] {
  return readdirSync(fx.root)
    .filter((name) => KEY.test(name))
    .sort();
}

function keyOf(fx: Fixture): string {
  return tool(fx, 'key').stdout.trim();
}

function runGate(fx: Fixture): string {
  const result = spawnSync(process.execPath, [join(fx.checkout, 'scripts/deploy/gate.ts')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

void test('installs from the lockfile into a deploy-owned key dir and replaces a borrowed link', () => {
  const fx = fixture();
  try {
    // The incident shape: node_modules borrowed from a session-owned tree.
    const sessionTree = join(fx.base, 'source-repo-node_modules');
    mkdirSync(sessionTree);
    writeFileSync(join(sessionTree, 'sentinel'), 'session-owned');
    symlinkSync(sessionTree, join(fx.checkout, 'node_modules'));

    // A deploy secret in the caller's environment must never reach npm.
    const run = tool(fx, 'provision', { GHCR_TOKEN: 'ghs_fixture_secret' });
    assert.equal(run.status, 0, run.stderr);

    const key = keyOf(fx);
    assert.match(key, KEY);
    assert.deepEqual(keyDirs(fx), [key]);
    assert.ok(lstatSync(join(fx.checkout, 'node_modules')).isSymbolicLink());
    assert.equal(
      realpathSync(join(fx.checkout, 'node_modules')),
      realpathSync(join(fx.root, key, 'node_modules')),
    );
    // The borrowed tree is unlinked, never touched.
    assert.equal(readFileSync(join(sessionTree, 'sentinel'), 'utf8'), 'session-owned');
    assert.equal(runGate(fx), 'fake-dep-loaded');

    const calls = npmCalls(fx);
    assert.equal(calls.length, 1);
    const call = calls[0] ?? '';
    assert.match(call, /args=ci --ignore-scripts --omit=dev --no-audit --no-fund /u);
    assert.match(call, new RegExp(`cwd=${realpathSync(fx.root)}/\\.staging-${key}-\\d+/pkg `, 'u'));
    assert.match(call, /cache=[^ ]*\/\.staging-[^ ]*\/npm-cache /u);
    assert.match(
      call,
      /userconfig=[^ ]*\/\.staging-[^ ]*\/npmrc-user-empty /u,
      'user npmrc is not read',
    );
    assert.match(call, /globalconfig=[^ ]*\/\.staging-[^ ]*\/npmrc-global-empty /u);
    assert.match(call, /home=[^ ]*\/\.staging-[^ ]* /u);
    assert.match(call, /leak=none /u, 'GHCR_TOKEN must be scrubbed from the npm env');
    assert.match(call, /ws=yes$/u, 'workspace manifests are staged for npm ci');

    const marker = JSON.parse(readFileSync(join(fx.root, key, '.deploy-deps.json'), 'utf8')) as {
      key: string;
      specifiers: string[];
      installedBytes: number;
    };
    assert.equal(marker.key, key);
    assert.deepEqual(marker.specifiers, ['fake-dep']);
    assert.ok(marker.installedBytes > 0);
    assert.deepEqual(JSON.parse(readFileSync(join(fx.root, 'history.json'), 'utf8')), [key]);
    assert.ok(!readdirSync(fx.root).some((n) => n.startsWith('.staging-')), 'staging is gone');

    assert.equal(tool(fx, 'verify').status, 0);
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('reuses the tree for an unchanged lockfile without running npm', () => {
  const fx = fixture();
  try {
    assert.equal(tool(fx, 'provision').status, 0);
    rmSync(join(fx.checkout, 'node_modules'));
    const again = tool(fx, 'provision');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /reusing deploy-owned dependencies/u);
    assert.equal(npmCalls(fx).length, 1);
    assert.equal(runGate(fx), 'fake-dep-loaded');
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('retains exactly the current and previous key, and prunes staging leftovers', () => {
  const fx = fixture();
  try {
    const keys: string[] = [];
    for (const revision of ['r1', 'r2', 'r3']) {
      writeFileSync(join(fx.checkout, 'package-lock.json'), lockfile(revision));
      mkdirSync(join(fx.root, '.staging-crashed-run'), { recursive: true });
      const run = tool(fx, 'provision');
      assert.equal(run.status, 0, run.stderr);
      keys.push(keyOf(fx));
    }
    assert.equal(new Set(keys).size, 3);
    assert.deepEqual(keyDirs(fx), [keys[1], keys[2]].sort());
    assert.deepEqual(JSON.parse(readFileSync(join(fx.root, 'history.json'), 'utf8')), [
      keys[1],
      keys[2],
    ]);
    assert.ok(!readdirSync(fx.root).some((n) => n.startsWith('.staging-')));

    // Redeploying the previous lockfile (a rollback redeploy) reuses its tree.
    writeFileSync(join(fx.checkout, 'package-lock.json'), lockfile('r2'));
    const rollback = tool(fx, 'provision');
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.match(rollback.stderr, /reusing deploy-owned dependencies/u);
    assert.equal(npmCalls(fx).length, 3);
    assert.deepEqual(keyDirs(fx), [keys[1], keys[2]].sort());
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('a failed install leaves the live link and tree untouched and creates no key dir', () => {
  const fx = fixture();
  try {
    assert.equal(tool(fx, 'provision').status, 0);
    const liveKey = keyOf(fx);
    const liveTarget = readlinkSync(join(fx.checkout, 'node_modules'));

    writeFileSync(join(fx.checkout, 'package-lock.json'), lockfile('r2'));
    const failed = tool(fx, 'provision', { FAKE_NPM_MODE: 'fail' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /::error::deploy-deps: npm ci failed/u);
    assert.ok(
      !readdirSync(fx.root).some((n) => n.startsWith('.staging-')),
      'a failed install removes its own staging dir',
    );
    assert.equal(readlinkSync(join(fx.checkout, 'node_modules')), liveTarget);
    assert.deepEqual(keyDirs(fx), [liveKey]);
    // The checkout's lockfile no longer matches the linked tree: verify fails
    // closed instead of running gates against the wrong dependency set.
    assert.notEqual(tool(fx, 'verify').status, 0);

    // An install that does not provide a deploy-script import is rejected too.
    const empty = tool(fx, 'provision', { FAKE_NPM_MODE: 'empty' });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /do not load/u);
    assert.deepEqual(keyDirs(fx), [liveKey]);

    // The next good run clears the crashed staging dirs and installs.
    const ok = tool(fx, 'provision');
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(!readdirSync(fx.root).some((n) => n.startsWith('.staging-')));
    assert.deepEqual(keyDirs(fx), [liveKey, keyOf(fx)].sort());
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('the live tree is never pruned, even when history disagrees with the link', () => {
  const fx = fixture();
  try {
    assert.equal(tool(fx, 'provision').status, 0);
    const k1 = keyOf(fx);
    // A crash between the link swap and the history write leaves history
    // without the live key.
    writeFileSync(join(fx.root, 'history.json'), '[]\n');
    writeFileSync(join(fx.checkout, 'package-lock.json'), lockfile('r2'));
    assert.equal(tool(fx, 'provision').status, 0);
    const k2 = keyOf(fx);
    assert.deepEqual(keyDirs(fx), [k1, k2].sort(), 'previously live k1 is kept as previous');

    writeFileSync(join(fx.root, 'history.json'), `${JSON.stringify([k1])}\n`);
    writeFileSync(join(fx.checkout, 'package-lock.json'), lockfile('r3'));
    assert.equal(tool(fx, 'provision').status, 0);
    assert.deepEqual(keyDirs(fx), [k2, keyOf(fx)].sort(), 'live k2 survives a stale history');
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('a key dir whose installed lockfile no longer hashes to its key is reinstalled', () => {
  const fx = fixture();
  try {
    assert.equal(tool(fx, 'provision').status, 0);
    const key = keyOf(fx);
    writeFileSync(join(fx.root, key, 'package-lock.json'), lockfile('tampered'));
    assert.notEqual(tool(fx, 'verify').status, 0);
    const again = tool(fx, 'provision');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(npmCalls(fx).length, 2);
    assert.equal(tool(fx, 'verify').status, 0);
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('a package imported through a relative helper outside scripts/deploy is verified too', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.checkout, 'tools'), { recursive: true });
    writeFileSync(join(fx.checkout, 'tools/helper.ts'), "export { default } from 'fake-dep2';\n");
    writeFileSync(
      join(fx.checkout, 'scripts/deploy/gate.ts'),
      "import dep from '../../tools/helper.ts';\nprocess.stdout.write(`${String(dep)}\\n`);\n",
    );
    assert.equal(tool(fx, 'imports').stdout.trim(), '["fake-dep2"]');
    const run = tool(fx, 'provision');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /do not load/u);
    assert.deepEqual(keyDirs(fx), []);
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('verify rejects a node_modules that is not the deploy-owned tree', () => {
  const fx = fixture();
  try {
    assert.equal(tool(fx, 'provision').status, 0);
    const foreign = join(fx.base, 'foreign');
    mkdirSync(join(foreign, 'fake-dep'), { recursive: true });
    rmSync(join(fx.checkout, 'node_modules'));
    symlinkSync(foreign, join(fx.checkout, 'node_modules'));
    const run = tool(fx, 'verify');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /resolves to .*foreign, expected/u);

    rmSync(join(fx.checkout, 'node_modules'));
    const missing = tool(fx, 'verify');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /not a live symlink/u);
  } finally {
    removeFixtureTree(fx.base);
  }
});

void test('plan projects 0 when reusable, the measured size otherwise, a fixed estimate on a fresh host', () => {
  const fx = fixture();
  try {
    assert.equal(tool(fx, 'plan').stdout.trim(), String(2 * 1024 * 1024 * 1024));
    assert.equal(tool(fx, 'provision').status, 0);
    assert.equal(tool(fx, 'plan').stdout.trim(), '0');

    const marker = JSON.parse(
      readFileSync(join(fx.root, keyOf(fx), '.deploy-deps.json'), 'utf8'),
    ) as { installedBytes: number };
    writeFileSync(join(fx.checkout, 'package-lock.json'), lockfile('r2'));
    assert.equal(tool(fx, 'plan').stdout.trim(), String(Math.ceil(marker.installedBytes * 1.5)));
  } finally {
    removeFixtureTree(fx.base);
  }
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'user.name',
      GIT_CONFIG_VALUE_2: 'fixture',
      GIT_CONFIG_KEY_3: 'user.email',
      GIT_CONFIG_VALUE_3: 'fixture@example.invalid',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

void test('deploy-paths.sh: materialize strips a borrowed node_modules; provision survives the incident', () => {
  const fx = fixture();
  try {
    // origin (bare) <- source repo (the shared object store) -> deploy worktree
    const work = join(fx.base, 'work');
    writeCheckout(work);
    git(work, ['init', '-q', '-b', 'main']);
    git(work, ['add', '.']);
    git(work, ['commit', '-q', '-m', 'base']);
    const sha = git(work, ['rev-parse', 'HEAD']);
    const origin = join(fx.base, 'origin.git');
    git(fx.base, ['clone', '-q', '--bare', work, origin]);
    const source = join(fx.base, 'source');
    git(fx.base, ['clone', '-q', origin, source]);
    const sessionTree = join(source, 'node_modules');
    mkdirSync(join(sessionTree, 'fake-dep'), { recursive: true });
    writeFileSync(join(sessionTree, 'sentinel'), 'session-owned');

    const checkout = join(fx.base, 'deploy', 'checkout');
    const script = `
set -euo pipefail
source "${DEPLOY_PATHS}"
materialize_deploy_checkout "${sha}" >/dev/null
# Recreate the ORPHAN-HIGH-250 link, as an older deploy left it on the host.
ln -s "${sessionTree}" "\${DEPLOY_CHECKOUT_DIR}/node_modules"
materialize_deploy_checkout "${sha}" >/dev/null
if [ -e "\${DEPLOY_CHECKOUT_DIR}/node_modules" ] || [ -L "\${DEPLOY_CHECKOUT_DIR}/node_modules" ]; then
  echo "borrowed link survived materialize" >&2; exit 1
fi
provision_deploy_dependencies >/dev/null 2>&1
# The incident: a session empties its own tree mid-deploy.
rm -rf "${sessionTree}"
node "\${DEPLOY_CHECKOUT_DIR}/scripts/deploy/gate.ts"
verify_deploy_dependencies 2>/dev/null
# A deploy-owned link survives re-materialization.
materialize_deploy_checkout "${sha}" >/dev/null
readlink -f "\${DEPLOY_CHECKOUT_DIR}/node_modules"
`;
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: env(fx, {
        DEPLOY_SOURCE_REPO: source,
        DEPLOY_CHECKOUT_DIR: checkout,
        DEPLOY_DEPS_ROOT: fx.root,
        DEPLOY_ENV_FILE: join(fx.base, 'env'),
        DEPLOY_CERTS_DIR: join(fx.base, 'certs'),
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const [gateOutput, linked] = result.stdout.trim().split('\n');
    assert.equal(gateOutput, 'fake-dep-loaded');
    assert.ok(
      (linked ?? '').startsWith(`${realpathSync(fx.root)}/`),
      `checkout node_modules must resolve into the deploy-owned root: ${String(linked)}`,
    );
  } finally {
    removeFixtureTree(fx.base);
  }
});
