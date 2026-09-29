/**
 * A fake pooled Postgres connection for code that runs under the tenant
 * boundary (`runInTenantRead` / `TenantScope`, K10 / PR-T1).
 *
 * WHY a stateful fake instead of `query: jest.fn().mockResolvedValue([])`:
 * the boundary pins `search_path` and the RLS settings, reads them back and
 * compares. A mock that answers every query with `[]` makes that comparison
 * skip, so a test would pass even if the boundary asserted nothing. This fake
 * remembers what was set and answers `current_schema()` / `current_setting()`
 * from it, so the boundary's assertion and the responder's served-tenant
 * read-back run for real — and a test can move the connection to another
 * schema to prove they catch it.
 *
 * It has no dependency on the boundary's code: it models Postgres, keyed by
 * the setting names the SQL passes as parameters.
 */
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { createMockDataSource } from './mock-datasource.factory';

export interface FakeTenantConnectionState {
  /** Schemas in search_path order; `current_schema()` is the first one. */
  searchPath: string[];
  /** `set_config` values by setting name. */
  readonly settings: Map<string, string>;
}

export interface FakeTenantConnection {
  readonly dataSource: jest.Mocked<DataSource>;
  readonly queryRunner: jest.Mocked<QueryRunner>;
  readonly manager: jest.Mocked<EntityManager>;
  readonly state: FakeTenantConnectionState;
  /** Answer for any SQL the fake does not model (default: no rows). */
  answer: (sql: string, parameters?: unknown[]) => unknown;
}

/** `"tenant_x", "farm", public` → ['tenant_x', 'farm', 'public']. */
function parseSearchPath(value: unknown): string[] {
  return String(value)
    .split(',')
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter((part) => part.length > 0);
}

export function createFakeTenantConnection(): FakeTenantConnection {
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const state: FakeTenantConnectionState = { searchPath: ['public'], settings: new Map() };
  const fake: FakeTenantConnection = {
    dataSource: mockDataSource,
    queryRunner: mockQueryRunner,
    manager: mockManager,
    state,
    answer: () => [],
  };

  mockQueryRunner.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
    const params = parameters ?? [];
    if (sql.includes("set_config('search_path'")) {
      state.searchPath = parseSearchPath(params[0]);
      return [];
    }
    if (sql.includes('current_schema()')) {
      const setting = (index: number): string | null =>
        sql.includes(`current_setting($${index + 1}`)
          ? (state.settings.get(String(params[index])) ?? null)
          : null;
      return [{ schema: state.searchPath[0] ?? null, tenant: setting(0), bypass: setting(1) }];
    }
    if (sql.includes("set_config($1, 'off', true)")) {
      state.settings.set(String(params[0]), 'off');
      return [];
    }
    if (sql.includes('set_config($1, $2, true)')) {
      state.settings.set(String(params[0]), String(params[1]));
      return [];
    }
    if (/^\s*SET TRANSACTION/i.test(sql)) return [];
    return fake.answer(sql, params);
  });

  return fake;
}
