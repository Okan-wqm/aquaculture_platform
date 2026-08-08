#!/usr/bin/env node
/**
 * Lint every project except the few that are declared, with a reason, as still
 * failing strict lint.
 *
 * WHY THIS EXISTS. `ci-full` ran `nx run-many --target=lint --all` and
 * `build-status` — a REQUIRED context — depends on it. So a project that fails
 * strict lint blocks every pull request in the repository, whatever the
 * affected lane decided.
 *
 * WHY NOT REUSE THE AFFECTED LANE'S LIST. It quarantines roughly forty
 * projects, most of which lint clean today; the entries are old. Pointing the
 * full lane at that list would collapse its coverage to almost nothing while
 * looking like consolidation. The two lanes answer different questions, so
 * they get different lists, and this one holds only projects that actually
 * fail strict lint today — with the finding that owns paying each down.
 *
 * Extra arguments are forwarded, so `npm run lint:all -- --max-warnings=0`
 * still means what it says.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const exclusionsPath = join(here, 'lint-all-exclusions.json');

const declared = JSON.parse(readFileSync(exclusionsPath, 'utf8'));
const quarantined = Object.keys(declared?.exclusions ?? {}).sort();

const forwarded = process.argv.slice(2);
const args = ['nx', 'run-many', '--target=lint', '--all'];
if (quarantined.length > 0) {
  args.push(`--exclude=${quarantined.join(',')}`);
  console.log(
    `lint:all: excluding ${quarantined.length} lint-quarantined project(s) declared in ` +
      `scripts/ci/lint-all-exclusions.json:\n  ${quarantined.join('\n  ')}`,
  );
} else {
  console.log('lint:all: no lint-quarantined projects declared — linting everything.');
}
args.push(...forwarded);

const result = spawnSync('node', [join('tools', 'toolchain', 'run.mjs'), ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
