import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function gitLsFiles(patterns: string[]): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', ...patterns], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean).sort();
}

function trackedIfExists(paths: string[]): string[] {
  return paths.filter((path) => existsSync(resolve(REPO_ROOT, path)));
}

function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function migrationConfigFiles(): string[] {
  const services = gitLsFiles(['apps/*/src/app.module.ts']).map((path) => path.split('/')[1]);
  const candidates = new Set<string>([
    'apps/db-migrate/src/schema-registry.ts',
    ...services.map((service) => `apps/${service}/src/app.module.ts`),
    ...services.map((service) => `apps/${service}/src/database/data-source.ts`),
  ]);
  return trackedIfExists(Array.from(candidates).sort());
}

function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    literals.push(match[2] ?? '');
  }
  return literals;
}

describe('migration glob contract', () => {
  it('all TypeORM migration globs only match timestamp-prefixed migration files', () => {
    const violations: string[] = [];

    for (const relPath of migrationConfigFiles()) {
      const source = stripTsComments(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
      for (const literal of stringLiterals(source)) {
        if (!literal.includes('/migrations/')) continue;
        if (!literal.includes('*')) continue;

        const migrationSegment = literal.slice(literal.indexOf('/migrations/'));
        if (!/\/migrations\/(?:[a-z0-9_-]+\/)*\[0-9\]\*/.test(migrationSegment)) {
          violations.push(`${relPath}: ${literal}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('tracked migration classes live in timestamp-prefixed files', () => {
    const files = gitLsFiles([
      'apps/*/src/migrations/*.ts',
      'apps/*/src/migrations/**/*.ts',
      'apps/*/src/database/migrations/*.ts',
      'apps/*/src/database/migrations/**/*.ts',
    ]);
    const violations: string[] = [];

    for (const relPath of files) {
      if (relPath.endsWith('.spec.ts') || relPath.endsWith('.test.ts')) continue;
      const basename = relPath.split('/').at(-1) ?? relPath;
      if (/^\d{13}-/.test(basename)) continue;

      const source = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      if (/export\s+class\s+[A-Z][A-Za-z0-9]*\d{13}\b/.test(source)) {
        violations.push(relPath);
      }
    }

    expect(violations).toEqual([]);
  });
});
