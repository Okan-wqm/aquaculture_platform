/**
 * End-to-end: both closure entry points honour an alias's recorded review file.
 *
 * `finding-traceability.spec.ts` pins the matcher. This spec pins the WIRING:
 * the commit-msg gate (admission, run as the CLI it is in the hook and in CI)
 * and `collectMergedClosures` (derivation, what `reconcile` reads) each have to
 * load `alias_review_files` from the sidecar and hand it to the matcher. If
 * either stops doing so, a merged trailer that names an alias and cites the
 * review file where the alias heading lives (the FE-HIGH-321 → FE-HIGH-313
 * case) is refused by one and honoured by the other — the admission/derivation
 * split PROC-MEDIUM-024 was about.
 *
 * Fixture: a throwaway git repo holding a one-row registry, the alias sidecar
 * and both review files.
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { collectMergedClosures } from './finding-registry';
import { removeFixtureTree } from './fixture-tree';

const GATES_DIR = resolve(__dirname);
const repo = mkdtempSync(join(tmpdir(), 'finding-alias-wiring-spec-'));
const HERMETIC_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

const CANONICAL = 'FE-HIGH-313';
const ALIAS = 'FE-HIGH-321';
const CANONICAL_REVIEW = 'docs/reviews/claude/landing.md';
const ALIAS_REVIEW = 'docs/reviews/claude/port.md';

function git(args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: HERMETIC_ENV }).trim();
}

function write(relative: string, content: string): void {
  const path = join(repo, relative);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

git(['init', '--quiet', '--initial-branch=main']);
git(['config', 'user.email', 'spec@invalid.local']);
git(['config', 'user.name', 'finding-alias-wiring-spec']);
write(
  'docs/reviews/_registry/findings.jsonl',
  `${JSON.stringify({ id: CANONICAL, state: 'OPEN', review_file: CANONICAL_REVIEW })}\n`,
);
write(
  'docs/reviews/_registry/finding-id-aliases.yaml',
  [
    'version: 1',
    'aliases:',
    `  - alias: ${ALIAS}`,
    `    canonical: ${CANONICAL}`,
    `    review_file: ${ALIAS_REVIEW}`,
    '    commits: []',
    "    effective_date: '2026-10-10'",
    '    reason: fixture',
    '',
  ].join('\n'),
);
write(CANONICAL_REVIEW, `# Landing\n\n## ${CANONICAL} — gap\n`);
write(ALIAS_REVIEW, `# Port\n\n## ${ALIAS} — same gap\n`);
git(['add', '.']);
git(['commit', '--quiet', '--no-verify', '-m', 'chore: fixture registry']);

const ALIAS_TRAILER = `feat(web): port\n\nCloses: ${ALIAS_REVIEW}#${ALIAS}\n`;
const FOREIGN_TRAILER = `feat(web): port\n\nCloses: docs/reviews/other/elsewhere.md#${ALIAS}\n`;

void after(() => {
  removeFixtureTree(repo);
});

/** The commit-msg gate as the hook runs it, rooted at the fixture repo. */
function admits(message: string): boolean {
  const messageFile = join(repo, '.git', 'COMMIT_EDITMSG');
  writeFileSync(messageFile, message);
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      require.resolve('ts-node/register'),
      join(GATES_DIR, 'commit-msg-validator.ts'),
      '--mode=msg-file',
      messageFile,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...HERMETIC_ENV, TS_NODE_PROJECT: join(GATES_DIR, 'tsconfig.json') },
    },
  );
  return result.status === 0;
}

void test('the commit-msg gate admits an alias trailer citing the alias review file', () => {
  assert.equal(admits(ALIAS_TRAILER), true);
  assert.equal(admits(FOREIGN_TRAILER), false, 'any other anchored file is still refused');
});

void test('reconcile derives the canonical closure from that same merged trailer', () => {
  writeFileSync(join(repo, 'port.txt'), 'port\n');
  git(['add', 'port.txt']);
  git(['commit', '--quiet', '--no-verify', '-m', ALIAS_TRAILER]);
  const closer = git(['rev-parse', 'HEAD']);
  const closures = collectMergedClosures(repo, 'HEAD', [
    { id: CANONICAL, review_file: CANONICAL_REVIEW },
  ]);
  assert.deepEqual(closures, [{ findingId: CANONICAL, sha: closer }]);
});
