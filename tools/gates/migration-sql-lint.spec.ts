#!/usr/bin/env ts-node

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { scanMigrationSql } from './migration-sql-lint';

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
