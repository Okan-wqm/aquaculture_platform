#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSession, observeGitTool, resolveGitTool, runGit } from './lib/hermetic-git.mjs';

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o700);
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-hermetic-git-'));
const originalPath = process.env.PATH;
const trustedFacts = observeGitTool();
const trustedPath = resolveGitTool(trustedFacts).executablePath;

try {
  const shimRoot = join(ownerRoot, 'shim');
  mkdirSync(shimRoot);
  executable(join(shimRoot, 'git'), `#!/bin/sh\nprintf '%s\\n' '${trustedFacts.version}'\n`);
  process.env.PATH = `${shimRoot}:${originalPath}`;
  assert.throws(
    () => resolveGitTool(trustedFacts),
    /Git executable digest mismatch/u,
    'a PATH-prepended Git shim must not be skipped or trusted',
  );

  const observation = join(ownerRoot, 'environment.txt');
  executable(
    join(shimRoot, 'git'),
    `#!/bin/sh\nenv > '${observation}'\nexec '${trustedPath}' "$@"\n`,
  );
  const instrumentedFacts = observeGitTool();
  const stableSession = createGitSession(instrumentedFacts);
  executable(join(shimRoot, 'git'), '#!/bin/sh\nexit 97\n');
  assert.equal(
    runGit(process.cwd(), ['rev-parse', '--is-inside-work-tree'], stableSession).trim(),
    'true',
    'a verified Git session reused the mutable PATH executable',
  );
  executable(
    join(shimRoot, 'git'),
    `#!/bin/sh\nenv > '${observation}'\nexec '${trustedPath}' "$@"\n`,
  );
  if (existsSync(observation)) unlinkSync(observation);
  process.env.GITHUB_TOKEN = 'must-not-reach-git';
  process.env.ARIA_PRIVATE_SENTINEL = 'must-not-reach-git';
  process.env.GIT_EXTERNAL_DIFF = '/must/not/run';
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
  process.env.GIT_CONFIG_VALUE_0 = '/must/not/run';
  assert.equal(
    runGit(process.cwd(), ['rev-parse', '--is-inside-work-tree'], instrumentedFacts).trim(),
    'true',
  );
  const childEnvironment = readFileSync(observation, 'utf8');
  for (const secret of [
    'GITHUB_TOKEN=',
    'ARIA_PRIVATE_SENTINEL=',
    'GIT_EXTERNAL_DIFF=',
    'GIT_CONFIG_COUNT=',
  ]) {
    assert.equal(childEnvironment.includes(secret), false, `${secret} leaked into Git`);
  }
  delete process.env.GIT_EXTERNAL_DIFF;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;

  process.env.PATH = originalPath;
  const repository = join(ownerRoot, 'repository');
  const fsmonitor = join(ownerRoot, 'fsmonitor');
  const fsmonitorRan = join(ownerRoot, 'fsmonitor-ran');
  mkdirSync(repository);
  execFileSync(trustedPath, ['init', '-q'], { cwd: repository });
  executable(fsmonitor, `#!/bin/sh\n: > '${fsmonitorRan}'\nexit 1\n`);
  execFileSync(trustedPath, ['config', 'core.fsmonitor', fsmonitor], { cwd: repository });
  assert.equal(runGit(repository, ['status', '--porcelain=v1'], trustedFacts), '');
  assert.equal(existsSync(fsmonitorRan), false, 'repository-local fsmonitor executed');

  const decoy = join(ownerRoot, 'decoy-worktree');
  mkdirSync(decoy);
  writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
  execFileSync(trustedPath, ['add', 'tracked.txt'], { cwd: repository });
  execFileSync(
    trustedPath,
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '-q',
      '-m',
      'fixture',
    ],
    { cwd: repository },
  );
  writeFileSync(join(decoy, 'tracked.txt'), 'committed\n');
  execFileSync(trustedPath, ['config', 'core.worktree', decoy], { cwd: repository });
  writeFileSync(join(repository, 'tracked.txt'), 'modified\n');
  assert.match(
    runGit(repository, ['status', '--porcelain=v1'], trustedFacts),
    /tracked\.txt/u,
    'repository-local core.worktree hid a tracked mutation',
  );
} finally {
  process.env.PATH = originalPath;
  delete process.env.GITHUB_TOKEN;
  delete process.env.ARIA_PRIVATE_SENTINEL;
  delete process.env.GIT_EXTERNAL_DIFF;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS hermetic-git path=digest-pinned env=scrubbed config=neutralized\n');
