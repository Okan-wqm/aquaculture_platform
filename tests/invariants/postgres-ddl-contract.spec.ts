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
  const migrationFiles = (): string[] =>
    gitLsFiles(['apps/*/src/migrations/*.ts', 'apps/*/src/database/migrations/*.ts']);

  it('does not use unsupported ALTER TYPE IF EXISTS syntax', () => {
    const violations = migrationFiles().filter((relPath) => {
      const source = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      return /\bALTER\s+TYPE\s+IF\s+EXISTS\b/i.test(source);
    });

    expect(violations).toEqual([]);
  });

  it('does not transfer sequence ownership with schema-wide relkind sweeps', () => {
    const violations = migrationFiles().filter((relPath) => {
      const source = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      const changesSequenceOwner = /\bALTER\s+SEQUENCE\b[\s\S]*?\bOWNER\s+TO\b/i.test(source);
      const sweepsSchemaSequences = /\brelkind\s*=\s*'S'\b/i.test(source);
      const scopesByOwnedDependency = /\bJOIN\s+pg_depend\b/i.test(source);

      return changesSequenceOwner && sweepsSchemaSequences && !scopesByOwnedDependency;
    });

    expect(violations).toEqual([]);
  });

  it('scopes config sequence ownership repair to sequences owned by config domain tables', () => {
    const source = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/config-service/src/database/migrations/1789100000000-OwnConfigTablesByConfigService.ts',
      ),
      'utf8',
    );
    const sequenceLoop = source.match(/\bFOR\s+seq\s+IN[\s\S]*?\bLOOP\b/i)?.[0] ?? '';

    expect(sequenceLoop).toContain('JOIN pg_depend dep');
    expect(sequenceLoop).toContain(
      "owning_rel.relname IN ('configurations', 'configuration_history')",
    );
    expect(sequenceLoop).not.toMatch(/\bFROM\s+pg_class\s+c\b[\s\S]*\bAND\s+c\.relkind\s*=\s*'S'/i);
  });
});
