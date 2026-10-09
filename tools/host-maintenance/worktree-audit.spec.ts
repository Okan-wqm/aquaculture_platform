import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { globToRegex, isDetached, ownerForPath, parseRoutingTable } from './worktree-audit.ts';
import { parseWorktreeList } from './worktree-list.ts';

void test('the inventory files branchless worktrees, bare main included, as detached', () => {
  const entries = parseWorktreeList(
    [
      'worktree /repo',
      'bare',
      '',
      'worktree /repo/a',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /tmp/repo',
      'HEAD def',
      'detached',
      '',
    ].join('\0'),
  );

  assert.deepEqual(
    entries.map((entry) => [entry.path, isDetached(entry)]),
    [
      ['/repo', true],
      ['/repo/a', false],
      ['/tmp/repo', true],
    ],
  );
});

void test('globToRegex supports rooted, recursive, and brace patterns', () => {
  assert.equal(globToRegex('e2e/**').test('e2e/tests/integration/schema.spec.ts'), true);
  assert.equal(globToRegex('**/*.spec.ts').test('apps/auth-service/src/auth/foo.spec.ts'), true);
  assert.equal(
    globToRegex('apps/auth-service/src/{privacy,modules/gdpr}/**').test(
      'apps/auth-service/src/modules/gdpr/export.ts',
    ),
    true,
  );
  assert.equal(globToRegex('docker-compose*').test('docs/docker-compose.yml'), false);
});

void test('routing table parser picks the most specific primary owner', () => {
  const rules = parseRoutingTable(`
| File Pattern | Primary Agent | Also Notify |
|---|---|---|
| \`apps/auth-service/**\` | auth-security-expert | security-reviewer |
| \`**/*.spec.ts\`, \`e2e/**\` | test-runner | |
| \`docs/adr/**\` | architectural-arbiter | prompt-writer |
`);

  assert.equal(ownerForPath('apps/auth-service/src/login.ts', rules).owner, 'auth-security-expert');
  assert.equal(ownerForPath('e2e/tests/integration/schema.spec.ts', rules).owner, 'test-runner');
  assert.equal(ownerForPath('unknown/path.txt', rules).owner, 'PROCESS HIGH ownership gap');
});
