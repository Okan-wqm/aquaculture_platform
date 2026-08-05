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
  readonly tenantQueries: readonly string[];
} {
  const counters = { releases: 0, tenantQueries: [] as string[] };
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
      query: ((...args: unknown[]): Promise<unknown> => {
        counters.tenantQueries.push(String(args[0]));
        return Promise.resolve([]);
      }) as QueryRunner['query'],
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
    get tenantQueries() {
      return counters.tenantQueries;
    },
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    const { dataSource } = makeDataSource(Array.from({ length: 8 }, (_, i) => `tenant_${i}`));
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

  it('logs only a stable outcome without tenant or provider error identifiers', async () => {
    const { dataSource } = makeDataSource(['tenant_sensitive']);
    const logger = { warn: jest.fn(), error: jest.fn() };

    await forEachTenantSchema(
      dataSource,
      () => Promise.reject(new Error('provider-secret-detail')),
      { concurrency: 1, perTenantTimeoutMs: 0, logger },
    );

    expect(logger.error).toHaveBeenCalledWith('action=tenant_schema_fanout outcome=error');
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('tenant_sensitive');
    expect(logged).not.toContain('provider-secret-detail');
  });

  it('aborts and drains a timed-out tenant before continuing to the rest', async () => {
    const { dataSource } = makeDataSource(['tenant_a', 'tenant_b']);
    const completed: string[] = [];

    const results = await forEachTenantSchema(
      dataSource,
      async ({ schema, signal }) => {
        if (schema === 'tenant_a') {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
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

  it('classifies a directly abort-rejecting handler deterministically as timeout', async () => {
    const { dataSource } = makeDataSource(['tenant_a']);

    const results = await forEachTenantSchema(
      dataSource,
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('direct abort')), {
            once: true,
          });
        }),
      { concurrency: 1, perTenantTimeoutMs: 20 },
    );

    expect(results[0]?.outcome).toBe('timeout');
    expect(results[0]?.error).toBeInstanceOf(Error);
    expect(results[0]?.error?.name).toBe('TenantSchemaTimeoutError');
  });

  it('drains cooperative abort cleanup before releasing the tenant connection', async () => {
    const harness = makeDataSource(['tenant_a']);
    let cleanupComplete = false;

    const results = await forEachTenantSchema(
      harness.dataSource,
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                cleanupComplete = true;
                reject(new Error('cleanup complete'));
              }, 5);
            },
            { once: true },
          );
        }),
      { concurrency: 1, perTenantTimeoutMs: 20 },
    );

    expect(results[0]?.outcome).toBe('timeout');
    expect(cleanupComplete).toBe(true);
    expect(harness.releases).toBe(1);
  });

  it('bounds DB statements by a shorter per-tenant deadline by default', async () => {
    const harness = makeDataSource(['tenant_a']);

    await forEachTenantSchema(harness.dataSource, () => Promise.resolve(), {
      perTenantTimeoutMs: 30_000,
    });

    expect(harness.tenantQueries).toContain('SET LOCAL statement_timeout = 30000');
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

    await forEachTenantSchema(harness.dataSource, () => Promise.reject(new Error('always fails')), {
      concurrency: 1,
      perTenantTimeoutMs: 0,
    });

    expect(harness.releases).toBe(2); // released once per schema despite throwing
  });
});
