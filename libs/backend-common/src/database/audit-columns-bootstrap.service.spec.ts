import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import { AuditColumnsBootstrap } from './audit-columns-bootstrap.service';

/**
 * audit-columns-bootstrap.service.spec.ts
 * ============================================================================
 *
 * Behavioural tests for the OnApplicationBootstrap wrapper that runs
 * `convertAuditColumnsToTimestamptz()` once per cold start in services
 * without a TypeORM migration runner (hr, billing, notification,
 * config, ai).
 *
 * Coverage:
 *   1. Connects + releases the QueryRunner cleanly on success.
 *   2. Releases the QueryRunner even when the helper throws — no
 *      connection leak on the failure path.
 *   3. Failure path emits the `audit_columns.bootstrap.failed` log
 *      substring (operator alerting hook) and does NOT rethrow.
 *   4. The `disabled` flag short-circuits the bootstrap entirely.
 */

/**
 * Build a mock DataSource that hands out a single QueryRunner whose
 * `query()` method is scripted with FIFO replies.
 */
function makeMockDataSource(opts: {
  /** Reply queue for the QueryRunner.query() calls. */
  replies: ReadonlyArray<unknown>;
  /** If set, every query() throws this error (to simulate failure). */
  failOnQuery?: Error;
}): {
  ds: DataSource;
  releasedRunners: number;
  createdRunners: number;
} {
  let releasedRunners = 0;
  let createdRunners = 0;
  let replyIdx = 0;

  const ds = {
    createQueryRunner: () => {
      createdRunners++;
      const runner: QueryRunner = {
        connect: (): Promise<void> => {
          // No-op in mock — connect always succeeds
          return Promise.resolve();
        },
        query: (): Promise<unknown> => {
          if (opts.failOnQuery) {
            return Promise.reject(opts.failOnQuery);
          }
          if (replyIdx >= opts.replies.length) {
            // Default empty reply for unscripted DDL
            return Promise.resolve(undefined);
          }
          return Promise.resolve(opts.replies[replyIdx++]);
        },
        release: (): Promise<void> => {
          releasedRunners++;
          return Promise.resolve();
        },
      } as unknown as QueryRunner;
      return runner;
    },
  } as unknown as DataSource;

  return {
    ds,
    get createdRunners() {
      return createdRunners;
    },
    get releasedRunners() {
      return releasedRunners;
    },
  };
}

describe('AuditColumnsBootstrap', () => {
  describe('happy path', () => {
    it('connects, runs the helper, and releases on success', async () => {
      // Replies for the helper's discovery sequence:
      //   1. SELECT current_schema()  → 'billing'
      //   2. pg_settings TimeZone     → 'UTC'
      //   3. discovery query          → empty (no qualifying columns)
      const mock = makeMockDataSource({
        replies: [[{ schema: 'billing' }], [{ setting: 'UTC' }], []],
      });
      const bootstrap = new AuditColumnsBootstrap(mock.ds, {
        serviceName: 'billing',
      });

      await bootstrap.onApplicationBootstrap();

      expect(mock.createdRunners).toBe(1);
      expect(mock.releasedRunners).toBe(1);
    });
  });

  describe('failure path', () => {
    it('catches helper failures and releases the runner', async () => {
      const mock = makeMockDataSource({
        replies: [],
        failOnQuery: new Error('simulated discovery failure'),
      });
      const bootstrap = new AuditColumnsBootstrap(mock.ds, {
        serviceName: 'config',
      });

      // MUST NOT throw — bootstrap catches and logs
      await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();

      // Connection released even on failure (no leak)
      expect(mock.createdRunners).toBe(1);
      expect(mock.releasedRunners).toBe(1);
    });

    it('emits the audit_columns.bootstrap.failed log substring on failure', async () => {
      const mock = makeMockDataSource({
        replies: [],
        failOnQuery: new Error('simulated failure'),
      });
      const bootstrap = new AuditColumnsBootstrap(mock.ds, {
        serviceName: 'notification',
      });

      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await bootstrap.onApplicationBootstrap();

      // Operators alert on this exact substring (see Phase 2 deploy
      // guide §4.1). Test guards against accidental wording changes.
      const errorLogs = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(errorLogs.some((log) => log.includes('audit_columns.bootstrap.failed'))).toBe(true);
      expect(errorLogs.some((log) => log.includes('service="notification"'))).toBe(true);

      errorSpy.mockRestore();
    });

    it('rethrows db-migrate authority violations instead of hiding production DDL attempts', async () => {
      const originalAuthoritative = process.env['DB_MIGRATE_AUTHORITATIVE'];
      const originalDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
      process.env['DB_MIGRATE_AUTHORITATIVE'] = 'true';
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');

      try {
        const mock = makeMockDataSource({ replies: [] });
        const bootstrap = new AuditColumnsBootstrap(mock.ds, {
          serviceName: 'notification',
        });

        await expect(bootstrap.onApplicationBootstrap()).rejects.toThrow(/db-migrate authority/);
        // PR#363 port: the bootstrap-level assertRuntimeDdlAllowed fires
        // BEFORE createQueryRunner — an authority violation must not even
        // pin a pool connection.
        expect(mock.createdRunners).toBe(0);
        expect(mock.releasedRunners).toBe(0);
      } finally {
        if (originalAuthoritative === undefined) {
          Reflect.deleteProperty(process.env, 'DB_MIGRATE_AUTHORITATIVE');
        } else {
          process.env['DB_MIGRATE_AUTHORITATIVE'] = originalAuthoritative;
        }
        if (originalDdlAuthority === undefined) {
          Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
        } else {
          process.env['DB_MIGRATE_DDL_AUTHORITY'] = originalDdlAuthority;
        }
      }
    });
  });

  describe('disabled flag', () => {
    it('short-circuits without connecting when disabled', async () => {
      const mock = makeMockDataSource({ replies: [] });
      const bootstrap = new AuditColumnsBootstrap(mock.ds, {
        serviceName: 'ai',
        disabled: true,
      });

      await bootstrap.onApplicationBootstrap();

      // No QueryRunner created at all — disabled path is a hard
      // short-circuit, not "create runner then skip work".
      expect(mock.createdRunners).toBe(0);
      expect(mock.releasedRunners).toBe(0);
    });
  });
});
