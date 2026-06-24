/**
 * Platform-wide invariant: dataSource.synchronize() is FORBIDDEN at runtime.
 *
 * Per CLAUDE.md, migrations are the single source of truth for DDL. The TypeORM
 * `synchronize()` method derives schema from entity metadata at process start,
 * which:
 *   - bypasses migration history,
 *   - cannot generate composite-key FK to partitioned tables (TypeORM 0.3.x
 *     limitation that surfaces as "no unique constraint matching given keys"
 *     for messages(id, createdAt)),
 *   - silently creates columns with WRONG nullability when the migration
 *     history would have arrived at NOT NULL via a backfill step.
 *
 * INFRA-CRITICAL-009 closed the SourceSchemaBootstrapService callsite.
 * This invariant locks the contract platform-wide so a future regression
 * (any service re-introducing synchronize) fails CI immediately.
 *
 * Allowed callsites (whitelisted): test setup files only (e2e harnesses
 * may legitimately use synchronize for spin-up of throwaway test DBs).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files where synchronize is legitimately allowed:
//  - **/test/**, **/tests/**, **/__tests__/**, **/e2e/**, *.spec.ts, *.test.ts
//  - migration / typeorm config files that DEFINE synchronize: false (a config
//    mention, not a runtime call).
// Anything else flagged is a forbidden runtime TypeORM schema writer.
const ALLOWED_PATH_FRAGMENTS = [
  '/test/',
  '/tests/',
  '/__tests__/',
  '/e2e/',
  '/.test.',
  '/.spec.',
];

function isAllowed(filePath: string): boolean {
  return (
    filePath.startsWith('tests/') ||
    filePath.startsWith('e2e/') ||
    ALLOWED_PATH_FRAGMENTS.some((frag) => filePath.includes(frag))
  );
}

function gitGrep(pattern: string): string {
  try {
    return execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'grep',
        '-nE',
        pattern,
        '--',
        'apps',
        'docker-compose.yml',
        'docker-compose.dev.yml',
        'docker-compose.droplet.yml',
        'libs',
        'platform',
        'web',
        'e2e',
        'tests',
        ':!node_modules',
        ':!dist',
        ':!.worktrees',
        ':!.claude/worktrees',
        ':!**/*.md',
        ':!**/*.jsonl',
        ':!**/*.json',
      ],
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return '';
    throw err;
  }
}

type GrepHit = {
  path: string;
  lineNumber: string;
  sourceLine: string;
  raw: string;
};

function parseHits(hits: string): GrepHit[] {
  return hits
    .split('\n')
    .filter((line) => line.length > 0)
    .map((raw) => {
      const parts = raw.split(':');
      const path = parts[0];
      const lineNumber = parts[1];
      const sourceLine = parts.slice(2).join(':').trimStart();
      if (!path || !lineNumber) {
        throw new Error(`Malformed git grep hit: ${raw}`);
      }
      return { path, lineNumber, sourceLine, raw };
    });
}

function isCommentOnly(sourceLine: string): boolean {
  return sourceLine.startsWith('*') || sourceLine.startsWith('//');
}

function importsTypeOrmDataSource(filePath: string): boolean {
  const text = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
  return /from\s+['"]typeorm['"]/.test(text) && /\bDataSource\b/.test(text);
}

describe('INVARIANT: no runtime dataSource.synchronize() callsites', () => {
  it('asserts every TypeORM DataSource.synchronize() callsite lives under a test path', () => {
    const hits = parseHits(gitGrep('\\.synchronize\\s*\\('));
    const forbidden = hits
      .filter((hit) => !isCommentOnly(hit.sourceLine))
      .filter((hit) => !isAllowed(hit.path))
      .filter(
        (hit) =>
          /\bdataSource\.synchronize\s*\(/.test(hit.sourceLine) ||
          importsTypeOrmDataSource(hit.path),
      )
      .map((hit) => hit.raw);

    if (forbidden.length > 0) {
      const formatted = forbidden.map((l) => `  ${l}`).join('\n');
      throw new Error(
        `INFRA-CRITICAL-009 invariant VIOLATED — runtime dataSource.synchronize() callsites:\n${formatted}\n\n` +
          `Per CLAUDE.md, migrations are the single source of truth for DDL. Use a migration\n` +
          `runner (libs/backend-common/src/database/migration-runner) instead of synchronize().\n` +
          `If this is genuinely a test fixture, move the file under a /test/, /tests/, /__tests__/,\n` +
          `or /e2e/ path; the invariant whitelists those.`,
      );
    }
  });

  it('asserts runtime TypeORM configs never enable synchronize: true', () => {
    const hits = parseHits(gitGrep('synchronize\\s*:\\s*true'));
    const forbidden = hits
      .filter((hit) => !isCommentOnly(hit.sourceLine))
      .filter((hit) => !isAllowed(hit.path))
      .map((hit) => hit.raw);

    if (forbidden.length > 0) {
      const formatted = forbidden.map((l) => `  ${l}`).join('\n');
      throw new Error(
        `INFRA-CRITICAL-009 invariant VIOLATED — runtime TypeORM synchronize=true configs:\n${formatted}\n\n` +
          `Use migrations/db-migrate as the DDL SSoT. synchronize=true is allowed only in test fixtures.`,
      );
    }
  });

  it('keeps DATABASE_SYNC guarded by the shared TypeORM config SSoT and bootstrap guard', () => {
    const typeormFactory = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/database/typeorm-config.factory.ts'),
      'utf8',
    );
    expect(typeormFactory).toContain("configService.get<string>('DATABASE_SYNC')");
    expect(typeormFactory).toContain('DATABASE_SYNC=true is retired.');
    expect(typeormFactory).toContain('synchronize: false,');
    expect(typeormFactory).not.toContain("configService.get('DATABASE_SYNC', 'false') === 'true'");

    const createServiceApp = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/bootstrap/create-service-app.ts'),
      'utf8',
    );
    expect(createServiceApp).toContain("const databaseSync = process.env['DATABASE_SYNC'];");
    expect(createServiceApp).toContain(
      'FATAL: DATABASE_SYNC=true is retired.',
    );
  });

  it('keeps retired DATABASE_SYNC out of runtime compose files', () => {
    const hits = parseHits(gitGrep('DATABASE_SYNC\\s*:'));
    const forbidden = hits
      .filter((hit) => !isCommentOnly(hit.sourceLine))
      .filter((hit) => !isAllowed(hit.path))
      .map((hit) => hit.raw);

    if (forbidden.length > 0) {
      const formatted = forbidden.map((l) => `  ${l}`).join('\n');
      throw new Error(
        `INFRA-CRITICAL-009 invariant VIOLATED — retired DATABASE_SYNC appears in runtime compose files:\n${formatted}\n\n` +
          `DATABASE_SYNC is retired; runtime compose files must use migrations/db-migrate and rely on the shared TypeORM factory's synchronize:false contract.`,
      );
    }
  });
});
