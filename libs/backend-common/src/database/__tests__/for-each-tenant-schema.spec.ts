/**
 * forEachVerifiedTenantSchema — fair bounded per-tenant cron fan-out (cron-fairness)
 * that binds every pass to ITS tenant (FARM-HIGH-481).
 *
 * Proves the four behaviours the hand-rolled serial loops lacked: bounded
 * concurrency, per-tenant timeout, error isolation, and rotation — plus
 * always-release lifecycle — and the one the loops got wrong: each pass runs
 * with `app.current_tenant` bound (and read back) and inside the tenant's
 * AsyncLocalStorage frame, because the tenant tables sit under FORCE row-level
 * security and a runner with only a `search_path` reads nothing. The DataSource
 * is a real (never-initialized) instance with `query`/`createQueryRunner` spied
 * onto an in-memory fake, so no real Postgres is needed (the real-Postgres
 * proof is `task-crons.rls.postgres.spec.ts` in farm-service).
 */
import { createHash } from 'node:crypto';

import { DataSource, QueryRunner } from 'typeorm';

import { getRequestContext } from '../../logging/request-context';
import {
  forEachVerifiedRetainedTenantSchema,
  forEachVerifiedTenantSchema,
} from '../for-each-tenant-schema';
import { getTenantSchemaName } from '../tenant-schema.utils';

/** A deterministic v4-shaped tenant id for a readable label. */
function tenantOf(label: string): string {
  const hex = createHash('md5').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const schemaOf = (label: string): string => getTenantSchemaName(tenantOf(label));
const labelOf = (schemaName: string, labels: readonly string[]): string =>
  labels.find((label) => schemaOf(label) === schemaName) ?? schemaName;

interface RecordedQuery {
  readonly sql: string;
  readonly params: unknown[] | undefined;
}

function makeDataSource(
  active: string[],
  options: { retained?: string[]; bindingTakes?: boolean } = {},
): {
  dataSource: DataSource;
  readonly releases: number;
  readonly tenantQueries: readonly string[];
  readonly recorded: readonly RecordedQuery[];
  readonly ledgerQueries: readonly string[];
} {
  const counters = {
    releases: 0,
    tenantQueries: [] as string[],
    recorded: [] as RecordedQuery[],
    ledgerQueries: [] as string[],
  };
  const ds = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: 5499,
    database: 'test',
    entities: [],
  });

  const mapping = (labels: string[]) =>
    labels.map((label) => ({
      schema_name: schemaOf(label),
      tenant_id: tenantOf(label),
      schema_exists: true,
      committed_proof: true,
    }));

  jest.spyOn(ds, 'query').mockImplementation((sql: string) => {
    counters.ledgerQueries.push(sql);
    if (sql.includes('list_active_tenant_schema_mappings')) {
      return Promise.resolve(mapping(active));
    }
    if (sql.includes('list_retained_tenant_schema_mappings')) {
      return Promise.resolve(mapping(options.retained ?? active));
    }
    return Promise.resolve([]);
  });

  jest.spyOn(ds, 'createQueryRunner').mockImplementation(() => {
    let isTransactionActive = false;
    // What the "connection" answers when the binding is read back.
    let boundTenant: string | null = null;
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
        const sql = String(args[0]);
        const params = args[1] as unknown[] | undefined;
        counters.tenantQueries.push(sql);
        counters.recorded.push({ sql, params });
        if (
          sql.startsWith('SELECT set_config($1, $2, true)') &&
          params?.[0] === 'app.current_tenant'
        ) {
          boundTenant = options.bindingTakes === false ? null : String(params[1]);
        }
        if (sql.includes('current_setting($1, true) AS tenant')) {
          return Promise.resolve([{ tenant: boundTenant, bypass: 'off' }]);
        }
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
    get recorded() {
      return counters.recorded;
    },
    get ledgerQueries() {
      return counters.ledgerQueries;
    },
  };
}

const LABELS_ABC = ['a', 'b', 'c'];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => jest.restoreAllMocks());

describe('forEachVerifiedTenantSchema', () => {
  it('runs the handler once per tenant schema and reports ok', async () => {
    const { dataSource } = makeDataSource(LABELS_ABC);
    const seen: string[] = [];

    const results = await forEachVerifiedTenantSchema(
      dataSource,
      ({ schemaName }) => {
        seen.push(labelOf(schemaName, LABELS_ABC));
        return Promise.resolve();
      },
      { perTenantTimeoutMs: 0 },
    );

    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('bounds concurrency to the configured cap', async () => {
    const { dataSource } = makeDataSource(Array.from({ length: 8 }, (_, i) => `t${i}`));
    let inFlight = 0;
    let maxInFlight = 0;

    await forEachVerifiedTenantSchema(
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
    const { dataSource } = makeDataSource(LABELS_ABC);
    const seen: string[] = [];

    const results = await forEachVerifiedTenantSchema(
      dataSource,
      ({ schemaName }) => {
        seen.push(labelOf(schemaName, LABELS_ABC));
        if (labelOf(schemaName, LABELS_ABC) === 'b') {
          return Promise.reject(new Error('boom'));
        }

        return Promise.resolve();
      },
      { concurrency: 1, perTenantTimeoutMs: 0 },
    );

    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    const b = results.find((r) => r.schemaName === schemaOf('b'));
    expect(b?.outcome).toBe('error');
    expect(b?.error?.message).toBe('boom');
    expect(results.filter((r) => r.outcome === 'ok')).toHaveLength(2);
  });

  it('logs only a stable outcome without tenant or provider error identifiers', async () => {
    const { dataSource } = makeDataSource(['sensitive']);
    const logger = { warn: jest.fn(), error: jest.fn() };

    await forEachVerifiedTenantSchema(
      dataSource,
      () => Promise.reject(new Error('provider-secret-detail')),
      { concurrency: 1, perTenantTimeoutMs: 0, logger },
    );

    expect(logger.error).toHaveBeenCalledWith('action=tenant_schema_fanout outcome=error');
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain(schemaOf('sensitive'));
    expect(logged).not.toContain(tenantOf('sensitive'));
    expect(logged).not.toContain('provider-secret-detail');
  });

  it('aborts and drains a timed-out tenant before continuing to the rest', async () => {
    const { dataSource } = makeDataSource(['a', 'b']);
    const completed: string[] = [];

    const results = await forEachVerifiedTenantSchema(
      dataSource,
      async ({ schemaName, signal }) => {
        if (labelOf(schemaName, LABELS_ABC) === 'a') {
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
        completed.push(labelOf(schemaName, LABELS_ABC));
      },
      { concurrency: 1, perTenantTimeoutMs: 30 },
    );

    const a = results.find((r) => r.schemaName === schemaOf('a'));
    const b = results.find((r) => r.schemaName === schemaOf('b'));
    expect(a?.outcome).toBe('timeout');
    expect(b?.outcome).toBe('ok');
    expect(completed).toContain('b'); // the hung tenant did not block it
  });

  it('classifies a directly abort-rejecting handler deterministically as timeout', async () => {
    const { dataSource } = makeDataSource(['a']);

    const results = await forEachVerifiedTenantSchema(
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
    const harness = makeDataSource(['a']);
    let cleanupComplete = false;

    const results = await forEachVerifiedTenantSchema(
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
    const harness = makeDataSource(['a']);

    await forEachVerifiedTenantSchema(harness.dataSource, () => Promise.resolve(), {
      perTenantTimeoutMs: 30_000,
    });

    expect(harness.tenantQueries).toContain('SET LOCAL statement_timeout = 30000');
  });

  it('rotates the start order by rotateBy', async () => {
    const { dataSource } = makeDataSource(LABELS_ABC);
    const order: string[] = [];

    await forEachVerifiedTenantSchema(
      dataSource,
      ({ schemaName }) => {
        order.push(labelOf(schemaName, LABELS_ABC));
        return Promise.resolve();
      },
      { concurrency: 1, perTenantTimeoutMs: 0, rotateBy: 1 },
    );

    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('releases the QueryRunner even when the handler throws', async () => {
    const harness = makeDataSource(['a', 'b']);

    await forEachVerifiedTenantSchema(
      harness.dataSource,
      () => Promise.reject(new Error('always fails')),
      {
        concurrency: 1,
        perTenantTimeoutMs: 0,
      },
    );

    expect(harness.releases).toBe(2); // released once per schema despite throwing
  });

  describe('tenant binding (FARM-HIGH-481)', () => {
    it("binds each pass's own tenant on its transaction: set transaction-locally, bypass off, read back", async () => {
      const harness = makeDataSource(['a', 'b']);

      await forEachVerifiedTenantSchema(harness.dataSource, () => Promise.resolve(), {
        concurrency: 1,
        perTenantTimeoutMs: 0,
      });

      const tenantBindings = harness.recorded
        .filter(
          (entry) =>
            entry.sql.startsWith('SELECT set_config($1, $2, true)') &&
            entry.params?.[0] === 'app.current_tenant',
        )
        .map((entry) => entry.params?.[1]);
      expect(tenantBindings).toEqual([tenantOf('a'), tenantOf('b')]);
      expect(
        harness.recorded.filter(
          (entry) =>
            entry.sql === `SELECT set_config($1, 'off', true)` &&
            entry.params?.[0] === 'app.bypass_rls',
        ),
      ).toHaveLength(2);
    });

    it('binds before the handler runs, after the schema is on the path', async () => {
      const harness = makeDataSource(['a']);
      const seenWhenHandlerRuns: string[] = [];

      await forEachVerifiedTenantSchema(
        harness.dataSource,
        () => {
          seenWhenHandlerRuns.push(...harness.tenantQueries);
          return Promise.resolve();
        },
        { perTenantTimeoutMs: 0 },
      );

      const searchPathAt = seenWhenHandlerRuns.findIndex((sql) =>
        sql.includes("set_config('search_path'"),
      );
      const bindAt = seenWhenHandlerRuns.findIndex((sql) =>
        sql.startsWith('SELECT set_config($1, $2, true)'),
      );
      expect(searchPathAt).toBeGreaterThanOrEqual(0);
      expect(bindAt).toBeGreaterThan(searchPathAt);
    });

    it("runs the handler inside the tenant's AsyncLocalStorage frame (a service call checks out its own connection)", async () => {
      const harness = makeDataSource(['a', 'b']);
      const frames: Array<string | undefined> = [];

      await forEachVerifiedTenantSchema(
        harness.dataSource,
        ({ tenantId }) => {
          frames.push(`${tenantId}:${getRequestContext().tenantId}`);
          return Promise.resolve();
        },
        { concurrency: 1, perTenantTimeoutMs: 0 },
      );

      expect(frames).toEqual([
        `${tenantOf('a')}:${tenantOf('a')}`,
        `${tenantOf('b')}:${tenantOf('b')}`,
      ]);
      expect(getRequestContext().tenantId).toBeUndefined(); // nothing leaks out of the pass
    });

    it('hands the handler the canonical tenant identity, not a value read out of the schema', async () => {
      const harness = makeDataSource(['a']);
      const received: Array<{ schemaName: string; tenantId: string }> = [];

      await forEachVerifiedTenantSchema(
        harness.dataSource,
        ({ schemaName, tenantId }) => {
          received.push({ schemaName, tenantId });
          return Promise.resolve();
        },
        { perTenantTimeoutMs: 0 },
      );

      expect(received).toEqual([{ schemaName: schemaOf('a'), tenantId: tenantOf('a') }]);
    });

    it('fails the pass closed when the binding did not take: the handler never runs', async () => {
      const harness = makeDataSource(['a'], { bindingTakes: false });
      const handler = jest.fn().mockResolvedValue(undefined);

      const results = await forEachVerifiedTenantSchema(harness.dataSource, handler, {
        perTenantTimeoutMs: 0,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(results[0]?.outcome).toBe('error');
      expect(results[0]?.error?.name).toBe('TenantContextError');
      expect(harness.releases).toBe(1);
    });

    it('serves the active ledger by default and the retained ledger on request', async () => {
      const harness = makeDataSource(['a', 'b'], { retained: ['a', 'b', 's'] });
      const active: string[] = [];
      const retained: string[] = [];

      await forEachVerifiedTenantSchema(
        harness.dataSource,
        ({ tenantId }) => {
          active.push(tenantId);
          return Promise.resolve();
        },
        { perTenantTimeoutMs: 0 },
      );
      await forEachVerifiedRetainedTenantSchema(
        harness.dataSource,
        ({ tenantId }) => {
          retained.push(tenantId);
          return Promise.resolve();
        },
        { perTenantTimeoutMs: 0 },
      );

      expect(active.sort()).toEqual([tenantOf('a'), tenantOf('b')].sort());
      expect(retained.sort()).toEqual([tenantOf('a'), tenantOf('b'), tenantOf('s')].sort());
    });

    it('does not swallow a ledger failure: "cannot list" is never "no tenants"', async () => {
      const harness = makeDataSource(['a']);
      jest.spyOn(harness.dataSource, 'query').mockRejectedValue(new Error('ledger denied'));

      await expect(
        forEachVerifiedTenantSchema(harness.dataSource, () => Promise.resolve(), {
          perTenantTimeoutMs: 0,
        }),
      ).rejects.toThrow('ledger denied');
    });
  });
});
