#!/usr/bin/env ts-node

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { assertLintProjectionComplete } from '../aria-adapters/sql-migration-safety-adapter';

import { inspectMigrationSource, scanMigrationSql } from './migration-sql-lint';

function expectR4Pass(sql: string): void {
  const violations = scanMigrationSql(sql).filter(
    ({ ruleId }) => ruleId === 'R4-session-scoped-set-search-path',
  );
  assert.deepStrictEqual(violations, []);
}

function expectR4Failure(sql: string, expectedCount = 1): void {
  const violations = scanMigrationSql(sql).filter(
    ({ ruleId }) => ruleId === 'R4-session-scoped-set-search-path',
  );
  assert.strictEqual(violations.length, expectedCount, JSON.stringify(violations));
}

void test('allows a multiline CREATE OR REPLACE FUNCTION search_path configuration clause', () => {
  expectR4Pass(`
    CREATE OR REPLACE
    FUNCTION "config"."reject_cross_tenant_write"()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, config
    AS $routine$
    BEGIN
      RETURN NEW;
    END;
    $routine$;
  `);
});

void test('allows a quoted search_path configuration clause on CREATE PROCEDURE', () => {
  expectR4Pass(`
    CREATE PROCEDURE "config"."refresh_environment_observations"()
    LANGUAGE plpgsql
    SET "search_path" TO pg_catalog, config
    AS $$
    BEGIN
      PERFORM 1;
    END;
    $$;
  `);
});

void test('rejects standalone and explicitly session-scoped search_path changes', () => {
  expectR4Failure(
    `
    SET search_path = tenant_one, public;
    SET SESSION "search_path" TO tenant_two, public;
  `,
    2,
  );
});

void test('rejects a standalone SET after an otherwise hardened function declaration', () => {
  expectR4Failure(`
    CREATE OR REPLACE FUNCTION hardened() RETURNS integer
    LANGUAGE sql
    SET search_path = pg_catalog
    AS $$ SELECT 1 $$;

    SET search_path TO tenant_one, public;
  `);
});

void test('does not exempt a session-scoped SET inside a dollar-quoted routine body', () => {
  expectR4Failure(`
    CREATE FUNCTION unsafe_body() RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      SET search_path = tenant_one, public;
    END;
    $$;
  `);
});

void test('does not treat SQL-standard routine body statements as declaration options', () => {
  expectR4Failure(`
    CREATE FUNCTION unsafe_sql_body() RETURNS void
    LANGUAGE SQL
    BEGIN ATOMIC
      SET search_path = tenant_one, public;
    END;
  `);
});

function expectR1Pass(sql: string): void {
  const violations = scanMigrationSql(sql).filter(
    ({ ruleId }) => ruleId === 'R1-destructive-without-marker',
  );
  assert.deepStrictEqual(violations, []);
}

function expectR1Failure(sql: string, expectedCount = 1): void {
  const violations = scanMigrationSql(sql).filter(
    ({ ruleId }) => ruleId === 'R1-destructive-without-marker',
  );
  assert.strictEqual(violations.length, expectedCount, JSON.stringify(violations));
}

void test('allows TRUNCATE as a revoked privilege name', () => {
  expectR1Pass(`
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON feeding_record_provenance FROM PUBLIC;
  `);
});

void test('allows TRUNCATE as a granted privilege name', () => {
  expectR1Pass(`
    GRANT SELECT, TRUNCATE ON audit_ledger TO maintenance_role;
  `);
});

void test('allows TRUNCATE as a trigger event that forbids truncation', () => {
  expectR1Pass(`
    CREATE TRIGGER trg_provenance_immutable
      BEFORE TRUNCATE ON feeding_record_provenance
      FOR EACH STATEMENT EXECUTE FUNCTION reject_write();
  `);
});

void test('allows TRUNCATE in a trigger event list introduced by OR', () => {
  expectR1Pass(`
    CREATE TRIGGER trg_provenance_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON feeding_record_provenance
      FOR EACH STATEMENT EXECUTE FUNCTION reject_write();
  `);
});

void test('allows TRUNCATE inside a string literal in a routine body', () => {
  expectR1Pass(`
    CREATE FUNCTION reject_write() RETURNS trigger LANGUAGE plpgsql AS $routine$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'feeding_record_provenance is immutable (TRUNCATE)';
      END IF;
      RETURN NULL;
    END;
    $routine$;
  `);
});

void test('still rejects a bare TRUNCATE statement', () => {
  expectR1Failure(`
    TRUNCATE feeding_record_provenance;
  `);
});

void test('still rejects TRUNCATE TABLE with an ONLY qualifier', () => {
  expectR1Failure(`
    TRUNCATE TABLE ONLY feeding_records;
  `);
});

void test('accepts a real TRUNCATE that carries the DESTRUCTIVE marker', () => {
  expectR1Pass(`
    -- DESTRUCTIVE: rollback via docs/runbooks/database-restore-drill.md
    TRUNCATE feeding_record_provenance;
  `);
});

// ARIA-HIGH-011 — the ARIA migration-safety adapter observes migrations through
// `inspectMigrationSource`, the same pure owner the CLI calls. This pins the
// two readers to ONE verdict: the CLI's `--mode=file` report and the export
// must name the same violations, line for line, for the same TypeORM source —
// including the chunk extraction (template literals, comment stripping) that
// a `.ts` migration needs and a bare `.sql` file does not.
void test('the CLI and inspectMigrationSource report identical violations for one migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-sql-lint-compat-'));
  try {
    const file = join(dir, 'migrations', '1900000000000-Change.ts');
    mkdirSync(join(dir, 'migrations'));
    const source = [
      "import { MigrationInterface, QueryRunner } from 'typeorm';",
      '',
      'export class Change1900000000000 implements MigrationInterface {',
      '  public async up(queryRunner: QueryRunner): Promise<void> {',
      '    // DROP TABLE in a comment is not SQL',
      '    await queryRunner.query(`ALTER TABLE farm.ponds ADD COLUMN depth integer NOT NULL`);',
      '    await queryRunner.query(`CREATE TABLE farm.tanks (id uuid)`);',
      '  }',
      '',
      '  public async down(queryRunner: QueryRunner): Promise<void> {',
      '    await queryRunner.query(`DROP TABLE farm.tanks`);',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(file, source, 'utf8');
    const repoRoot = resolve(__dirname, '..', '..');
    const relPath = relative(repoRoot, file);

    const cli = spawnSync(
      process.execPath,
      [
        join(resolve(__dirname, '..', '..'), 'node_modules', 'ts-node', 'dist', 'bin.js'),
        '--project',
        join(__dirname, 'tsconfig.json'),
        join(__dirname, 'migration-sql-lint.ts'),
        '--mode=file',
        file,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.strictEqual(cli.status, 1, cli.stderr);
    // The CLI report: `[SEV] ruleId` / `file:line` / message / `> snippet`.
    const reported: { severity: string; ruleId: string; line: number; snippet: string }[] = [];
    const lines = cli.stderr.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const head = lines[index]?.match(/^\s{2}\[(CRITICAL|HIGH|MEDIUM)\] (\S+)$/);
      if (!head) continue;
      const location = lines[index + 1]?.trim() ?? '';
      const snippet = (lines[index + 3]?.trim() ?? '').replace(/^> /, '');
      reported.push({
        severity: head[1] ?? '',
        ruleId: head[2] ?? '',
        line: Number(location.slice(location.lastIndexOf(':') + 1)),
        snippet,
      });
    }

    const exported = inspectMigrationSource(relPath, source).map((violation) => ({
      severity: violation.severity,
      ruleId: violation.ruleId,
      line: violation.line,
      snippet: violation.snippet,
    }));
    assert.ok(exported.length >= 3, JSON.stringify(exported));
    assert.deepStrictEqual(reported, exported);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ARIA-HIGH-011 — a rule added to this gate must reach ARIA's observation in
// the same change: the adapter refuses to run with an unprojected rule, and
// this pin fails the commit that would make it refuse.
void test('every rule this gate reports is projected by the ARIA migration-safety adapter', () => {
  assert.doesNotThrow(() => assertLintProjectionComplete());
});
