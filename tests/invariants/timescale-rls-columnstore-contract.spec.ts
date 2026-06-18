/**
 * Platform-wide invariant - INFRA-CRITICAL-006/007:
 *
 * TimescaleDB >=2.18 treats compression as columnstore mode and rejects
 * row-level security on the same hypertable. The production failure happened
 * both ways:
 *
 *   compression/columnstore -> RLS:
 *     "operation not supported on hypertables that have columnstore enabled"
 *
 *   RLS -> compression/columnstore:
 *     "columnstore cannot be used on table with row security"
 *
 * Tenant isolation is the load-bearing invariant, so active migrations may not
 * configure TimescaleDB columnstore/compression on a relation that also gets
 * row-level security. Archived migrations are forensic evidence only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const RLS_DDL_RE =
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)\s+(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/gi;
const COLUMNSTORE_TABLE_OPTION_RE =
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)\s+SET\s*\([^;]*\btimescaledb\.(?:compress|columnstore)\b[^;]*\)/gi;
const COMPRESSION_POLICY_RE =
  /\badd_(?:compression|columnstore)_policy\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const COLUMNSTORE_FUNCTION_RE =
  /\bconvert_to_columnstore\s*\(\s*['"`]([^'"`]+)['"`]/gi;

interface RelationRef {
  readonly relation: string;
  readonly tableName: string;
  readonly file: string;
  readonly line: number;
  readonly statement: string;
}

function listActiveMigrationFiles(): string[] {
  let out: string;
  try {
    out = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'ls-files',
        'apps/*/src/migrations/[0-9]*.ts',
        'apps/*/src/migrations/**/[0-9]*.ts',
        'apps/*/src/database/migrations/[0-9]*.ts',
        'apps/*/src/database/migrations/**/[0-9]*.ts',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }

  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.includes('/.archive/'))
    .filter((file) => !file.includes('/__tests__/'))
    .filter((file) => !file.endsWith('.spec.ts'))
    .filter((file) => !file.endsWith('.test.ts'));
}

function normalizeRelation(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '')
    .replace(/"/g, '')
    .toLowerCase();
}

function tableNameOf(relation: string): string {
  return relation.split('.').at(-1) ?? relation;
}

function lineNumberFor(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function statementPreview(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function relationRefsFor(file: string, source: string, re: RegExp): RelationRef[] {
  const refs: RelationRef[] = [];
  for (const match of source.matchAll(re)) {
    const relationRaw = match[1];
    if (relationRaw === undefined || match.index === undefined) continue;
    const relation = normalizeRelation(relationRaw);
    refs.push({
      relation,
      tableName: tableNameOf(relation),
      file,
      line: lineNumberFor(source, match.index),
      statement: statementPreview(match[0]),
    });
  }
  return refs;
}

function sameRelation(left: RelationRef, right: RelationRef): boolean {
  if (left.relation === right.relation) return true;

  const leftQualified = left.relation.includes('.');
  const rightQualified = right.relation.includes('.');
  return (!leftQualified || !rightQualified) && left.tableName === right.tableName;
}

describe('TimescaleDB columnstore and RLS migration contract', () => {
  const files = listActiveMigrationFiles();

  it('scans live migration files and ignores forensic archives', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.includes('/.archive/'))).toBe(false);
  });

  it('does not configure TimescaleDB columnstore/compression on RLS-protected relations', () => {
    const rlsRefs: RelationRef[] = [];
    const columnstoreRefs: RelationRef[] = [];

    for (const file of files) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      rlsRefs.push(...relationRefsFor(file, source, RLS_DDL_RE));
      columnstoreRefs.push(...relationRefsFor(file, source, COLUMNSTORE_TABLE_OPTION_RE));
      columnstoreRefs.push(...relationRefsFor(file, source, COMPRESSION_POLICY_RE));
      columnstoreRefs.push(...relationRefsFor(file, source, COLUMNSTORE_FUNCTION_RE));
    }

    const violations: Array<{ rls: RelationRef; columnstore: RelationRef }> = [];
    for (const rls of rlsRefs) {
      for (const columnstore of columnstoreRefs) {
        if (sameRelation(rls, columnstore)) {
          violations.push({ rls, columnstore });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map(
          ({ rls, columnstore }) =>
            `  - ${rls.relation}\n` +
            `      RLS: ${rls.file}:${rls.line} ${rls.statement}\n` +
            `      columnstore: ${columnstore.file}:${columnstore.line} ${columnstore.statement}`,
        )
        .join('\n');
      throw new Error(
        `TimescaleDB columnstore/compression cannot share a relation with RLS:\n${detail}\n\n` +
          `Keep RLS for tenant isolation and use retention/chunking without columnstore, ` +
          `or model cold storage through a separate aggregate with its own tenant-scope contract.`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
