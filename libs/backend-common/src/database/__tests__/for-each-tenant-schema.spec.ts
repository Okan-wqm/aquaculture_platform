/**
 * forEachTenantSchema — fair bounded per-tenant cron fan-out (cron-fairness).
 *
 * Proves the four behaviours the hand-rolled serial loops lacked: bounded
 * concurrency, per-tenant timeout, error isolation, and rotation — plus
 * always-release lifecycle. The DataSource is a real (never-initialized)
 * instance with `query`/`createQueryRunner` spied onto an in-memory fake, so no
 * real Postgres is needed and no unsafe double-cast is required.
 */
import { DataSource, QueryRunner } from 'typeorm';

import { forEachTenantSchema } from '../for-each-tenant-schema';

function makeDataSource(schemas: string[]): {
  dataSource: DataSource;
  readonly releases: number;
} {
  const counters = { releases: 0 };
  const ds = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: 5499,
    database: 'test',
    entities: [],
  });

  jest.spyOn(ds, 'query').mockImplementation((sql: string) => {
    if (sql.includes('information_schema.schemata')) {
      return Promise.resolve(schemas.map((s) => ({ schema_name: s })));
    }
    return Promise.resolve([]);
  });

  jest.spyOn(ds, 'createQueryRunner').mockImplementation(() => {
    let isTransactionActive = false;
    const qr: Partial<QueryRunner> = {
      connect: () => Promise.resolve(),
      startTransaction: () => {
        isTransactionActive = true;
        return Promise.resolve();
      },
      commitTransaction: () => {
        isTransactionActive = false;
        return Promise.resolve();
      },
      rollbackTransaction: () => {
        isTransactionActive = false;
        return Promise.resolve();
      },
      get isTransactionActive() {
        return isTransactionActive;
      },
      // QueryRunner.query is overloaded; a variadic unknown-returning stub
      // overlaps every overload so the targeted assertion is legal.
      query: ((..._args: unknown[]): Promise<unknown> =>
        Promise.resolve([])) as QueryRunner['query'],
      release: () => {
        counters.releases += 1;
        return Promise.resolve();
      },
    };
    return qr as QueryRunner;
  });

  return {
    dataSource: ds,
    get releases() {
      return counters.releases;
    },
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => jest.restoreAllMocks());

describe('forEachTenantSchema', () => {
  it('runs the handler once per tenant schema and reports ok', async () => {
    const { dataSource } = makeDataSource(['tenant_a', 'tenant_b', 'tenant_c']);
    const seen: string[] = [];

    const results = await forEachTenantSchema(
      dataSource,
      ({ schema }) => {
        seen.push(schema);
        return Promise.resolve();
      },
      { perTenantTimeoutMs: 0 },
    );

    expect(seen.sort()).toEqual(['tenant_a', 'tenant_b', 'tenant_c']);
    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('bounds concurrency to the configured cap', async () => {
    const { dataSource } = makeDataSource(
      Array.from({ length: 8 }, (_, i) => `tenant_${i}`),
    );
    let inFlight = 0;
    let maxInFlight = 0;

    await forEachTenantSchema(
      dataSource,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(15);
        inFlight -= 1;
      },
      { concurrency: 3, perTenantTimeoutMs: 0 },
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
  });

  it('isolates a failing tenant — others still run', async () => {
    const { dataSource } = makeDataSource(['tenant_a', 'tenant_b', 'tenant_c']);
    const seen: string[] = [];

    const results = await forEachTenantSchema(
      dataSource,
      ({ schema }) => {
        seen.push(schema);
        if (schema === 'tenant_b') {
          return Promise.reject(new Error('boom'));
        }

        return Promise.resolve();
      },
      { concurrency: 1, perTenantTimeoutMs: 0 },
    );

    expect(seen.sort()).toEqual(['tenant_a', 'tenant_b', 'tenant_c']);
    const b = results.find((r) => r.schema === 'tenant_b');
    expect(b?.outcome).toBe('error');
    expect(b?.error?.message).toBe('boom');
    expect(results.filter((r) => r.outcome === 'ok')).toHaveLength(2);
  });

  it('times out a hung tenant and continues to the rest', async () => {
    const { dataSource } = makeDataSource(['tenant_a', 'tenant_b']);
    const completed: string[] = [];

    const results = await forEachTenantSchema(
      dataSource,
      async ({ schema }) => {
        if (schema === 'tenant_a') {
          await delay(10_000); // hang well past the deadline
        }
        completed.push(schema);
      },
      { concurrency: 1, perTenantTimeoutMs: 30 },
    );

    const a = results.find((r) => r.schema === 'tenant_a');
    const b = results.find((r) => r.schema === 'tenant_b');
    expect(a?.outcome).toBe('timeout');
    expect(b?.outcome).toBe('ok');
    expect(completed).toContain('tenant_b'); // the hung tenant did not block it
  });

  it('rotates the start order by rotateBy', async () => {
    const { dataSource } = makeDataSource(['tenant_a', 'tenant_b', 'tenant_c']);
    const order: string[] = [];

    await forEachTenantSchema(
      dataSource,
      ({ schema }) => {
        order.push(schema);
        return Promise.resolve();
      },
      { concurrency: 1, perTenantTimeoutMs: 0, rotateBy: 1 },
    );

    expect(order).toEqual(['tenant_b', 'tenant_c', 'tenant_a']);
  });

  it('releases the QueryRunner even when the handler throws', async () => {
    const harness = makeDataSource(['tenant_a', 'tenant_b']);

    await forEachTenantSchema(
      harness.dataSource,
      () => Promise.reject(new Error('always fails')),
      { concurrency: 1, perTenantTimeoutMs: 0 },
    );

    expect(harness.releases).toBe(2); // released once per schema despite throwing
  });
});
