/**
 * MSGFIX-FAZ0 — OutboxPendingCollectorService unit tests.
 *
 * Pins the contract that was missing in production: the domain gauge
 * `messaging_outbox_pending` must actually be WRITTEN. The assertions read
 * the prom-client registry OUTPUT (exposition format) of the real
 * MessagingMetricsService — not mock call counts — so the test fails if the
 * gauge is renamed, dropped from the registry, or never set.
 */
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { DataSource } from 'typeorm';

import { MessagingMetricsService } from '../messaging-metrics.service';
import { OutboxPendingCollectorService } from '../outbox-pending-collector.service';

/** Records executed SQL; answers the pending COUNT from a script. */
function createDataSource(opts: { pending?: number; failWith?: Error; setConfigCalls: string[] }): {
  dataSource: DataSource;
  transaction: jest.Mock;
} {
  // Repo-legal mock pattern (see farm-service environment-cron.service.spec):
  // a prototype-based DataSource with jest.fn members — no double casts, and
  // jest.fn() (unimplemented) stays any-callable so the overloaded
  // DataSource.transaction signature accepts it.
  const transaction = jest.fn();
  transaction.mockImplementation(async (work: (manager: unknown) => Promise<unknown>) =>
    work({
      query: jest.fn(async (sql: string) => {
        if (sql.includes('set_config')) {
          opts.setConfigCalls.push(sql);
          return [];
        }
        if (sql.includes('count(*)')) {
          if (opts.failWith) throw opts.failWith;
          return [{ pending: opts.pending ?? 0 }];
        }
        return [];
      }),
    }),
  );
  const dataSource: DataSource = Object.create(DataSource.prototype);
  dataSource.transaction = transaction;
  return { dataSource, transaction };
}

const scheduledJobs = createScheduledJobTestExecutor();

function buildService(dataSource: DataSource) {
  const metrics = new MessagingMetricsService();
  metrics.onModuleInit();
  const collector = new OutboxPendingCollectorService(dataSource, metrics, scheduledJobs.executor);
  return { collector, metrics };
}

describe('OutboxPendingCollectorService (MSGFIX-FAZ0)', () => {
  let setConfigCalls: string[];

  beforeEach(() => {
    setConfigCalls = [];
  });

  it('counts pending rows with the RLS bypass in the same transaction and sets the gauge', async () => {
    const { dataSource } = createDataSource({ pending: 42, setConfigCalls });
    const { collector, metrics } = buildService(dataSource);

    await collector.collectPendingCount();

    // Bypass GUC issued transaction-locally (ORPHAN-HIGH-321 pattern).
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0]).toContain(`set_config('app.bypass_rls', 'on', true)`);

    // The predicate matches the dispatchable backlog: unpublished AND not
    // dead-lettered, against the SOURCE-only messaging schema.
    const output = await metrics.getMetrics();
    expect(output).toContain('# HELP messaging_outbox_pending');
    expect(output).toMatch(/^messaging_outbox_pending 42$/m);
  });

  it('re-seeds the gauge on startup (onModuleInit does not wait for the first cron tick)', async () => {
    const { dataSource } = createDataSource({ pending: 7, setConfigCalls });
    const { collector, metrics } = buildService(dataSource);

    collector.onModuleInit();
    // onModuleInit is deliberately fire-and-forget (a cold DB must not block
    // boot); settle the microtask queue so the seeded value is observable.
    await new Promise((resolve) => setImmediate(resolve));

    const output = await metrics.getMetrics();
    expect(output).toMatch(/^messaging_outbox_pending 7$/m);
  });

  it('swallows query failures — a broken DB never throws out of the cron', async () => {
    const { dataSource } = createDataSource({ failWith: new Error('db gone'), setConfigCalls });
    const { collector, metrics } = buildService(dataSource);

    await expect(collector.collectPendingCount()).resolves.toBeUndefined();

    // prom-client emits an unwritten gauge as 0 — indistinguishable from an
    // empty queue. That is exactly why the platform worker owns the separate
    // pending-age + relay-liveness signals; this collector must simply never
    // crash the scheduler nor write a bogus value.
    const output = await metrics.getMetrics();
    expect(output).toMatch(/^messaging_outbox_pending 0$/m);
    expect(output).not.toMatch(/^messaging_outbox_pending NaN$/m);
  });

  it('treats a null/absent count row as zero instead of NaN', async () => {
    const { dataSource, transaction } = createDataSource({ pending: 0, setConfigCalls });
    // Override the count answer to a null pending value.
    transaction.mockImplementation(async (work: (manager: unknown) => Promise<unknown>) =>
      work({
        query: jest.fn(async (sql: string) => {
          if (sql.includes('set_config')) {
            setConfigCalls.push(sql);
            return [];
          }
          return [{ pending: null }];
        }),
      }),
    );
    const { collector, metrics } = buildService(dataSource);

    await collector.collectPendingCount();

    const output = await metrics.getMetrics();
    expect(output).toMatch(/^messaging_outbox_pending 0$/m);
  });
});
