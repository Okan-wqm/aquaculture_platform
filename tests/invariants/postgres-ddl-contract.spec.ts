import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function gitLsFiles(patterns: string[]): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', ...patterns], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean).sort();
}

describe('PostgreSQL DDL migration contract', () => {
  it('does not use unsupported ALTER TYPE IF EXISTS syntax', () => {
    const migrationFiles = gitLsFiles([
      'apps/*/src/migrations/*.ts',
      'apps/*/src/database/migrations/*.ts',
    ]);
    const violations = migrationFiles.filter((relPath) => {
      const source = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      return /\bALTER\s+TYPE\s+IF\s+EXISTS\b/i.test(source);
    });

    expect(violations).toEqual([]);
  });
});
