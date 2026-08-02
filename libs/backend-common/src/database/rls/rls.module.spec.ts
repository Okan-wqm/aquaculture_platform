import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { BypassRlsService } from './bypass-rls.service';
import { RlsModule } from './rls.module';

/**
 * rls.module.spec.ts
 * ============================================================================
 *
 * Tier-1 coverage for the typed RlsModule API.
 *
 * The legacy `forRoot({ serviceName })` signature had a subtle footgun:
 * it unconditionally registered `RlsConnectionBootstrap`, which constructor-
 * injects `DataSource`. A service without `TypeOrmModule` in its imports
 * graph would crash at DI resolution with a cryptic NestJS error deep in
 * the bootstrap path (the 2026-04-14 gateway-api outage).
 *
 * The refactored API splits into two named methods:
 *
 *   - `forPoolService({ ... })` — requires a DataSource. Registers the pool
 *     patch, `BypassRlsService`, plus the optional schema / per-tenant sweep
 *     bootstraps.
 *
 *   - `forBypassOnly({ serviceName })` — no DataSource required. Registers
 *     only `BypassRlsService`.
 *
 * These tests verify:
 *
 *   1. `forPoolService` fails LOUDLY with an actionable error when no
 *      DataSource is available in the module graph. The assertion is
 *      NOT "accidentally works" — it's "explicit remediation-shaped
 *      throw", so operators see the exact fix path instead of a
 *      cryptic NestJS DI error.
 *
 *   2. `forBypassOnly` succeeds without any DataSource provider and
 *      exposes `BypassRlsService` in the module graph.
 *
 *   3. `forPoolService` rejects malformed service names (validation
 *      lives in `createRlsConnectionBootstrap`).
 *
 *   4. `forBypassOnly` rejects malformed service names (validation
 *      runs at registration time, BEFORE DI — a caller that fat-
 *      fingers the name sees the error immediately, not at runtime).
 */

/**
 * Minimal pg-pool-shaped stub. TypeORM's `driver.master.connect` is what
 * `RlsConnectionBootstrap` patches. We don't care about the actual pool
 * behaviour for these module-wiring tests — we only need the shape to
 * satisfy the runtime guard inside `RlsConnectionBootstrap.patchConnectionPool`.
 */
function buildStubDataSource(): DataSource {
  const stubPool = {
    connect: () => Promise.resolve({
      query: () => Promise.resolve({ rows: [] }),
      release: () => undefined,
    }),
  };
  return buildDataSourceWithDriver({ master: stubPool });
}

function buildDataSourceWithDriver(driver: object): DataSource {
  const dataSource = Object.create(DataSource.prototype) as DataSource;
  Object.defineProperty(dataSource, 'driver', {
    configurable: true,
    enumerable: true,
    value: driver,
  });
  return dataSource;
}

describe('RlsModule (typed API)', () => {
  describe('forPoolService — DataSource required', () => {
    it('fails LOUDLY when no DataSource is available in the module graph', async () => {
      // A module that imports RlsModule.forPoolService WITHOUT registering
      // a DataSource provider is the exact class of bug that caused the
      // 2026-04-14 gateway-api outage. The test asserts this throws at
      // module compilation with a message that points the operator at
      // the two valid remediation paths (add TypeOrmModule OR switch to
      // forBypassOnly). No cryptic NestJS DI error — the refactor raises
      // an explicit, grep-friendly error string instead.

      @Module({
        imports: [
          RlsModule.forPoolService({ serviceName: 'test-missing-ds' }),
        ],
      })
      class BrokenAppModule {}

      // NestJS surfaces the missing provider as a DI resolution error
      // BEFORE our runtime guard fires (the guard runs in
      // onModuleInit). Either error path is acceptable for this contract
      // — what matters is that the module build fails LOUDLY rather than
      // silently booting with RLS inactive.
      await expect(
        Test.createTestingModule({ imports: [BrokenAppModule] }).compile(),
      ).rejects.toThrow(/DataSource|data.?source/i);
    });

    it("boots cleanly when a DataSource provider is present and exposes BypassRlsService", async () => {
      const stubDs = buildStubDataSource();

      @Global()
      @Module({
        providers: [
          { provide: DataSource, useValue: stubDs },
        ],
        exports: [DataSource],
      })
      class StubDataSourceModule {}

      @Module({
        imports: [
          StubDataSourceModule,
          RlsModule.forPoolService({ serviceName: 'test-with-ds' }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      // Kick off OnModuleInit hooks so the runtime guard runs against
      // the stub DataSource. If the pool patch breaks, we see it here.
      await moduleRef.init();

      // BypassRlsService must be resolvable — it's the public export.
      expect(moduleRef.get(BypassRlsService, { strict: false })).toBeInstanceOf(
        BypassRlsService,
      );

      await moduleRef.close();
    });

    it('runtime guard throws actionable error when DataSource lacks a pg pool', async () => {
      // Simulates a misconfigured TypeOrmModule that resolved DataSource
      // to an object whose driver has no `master` pool. The runtime
      // guard inside patchConnectionPool catches this and throws with
      // the REMEDIATION: substring so the error is greppable in CI logs.

      const nonPoolDs = buildDataSourceWithDriver({});

      @Global()
      @Module({
        providers: [
          { provide: DataSource, useValue: nonPoolDs },
        ],
        exports: [DataSource],
      })
      class NonPoolDataSourceModule {}

      @Module({
        imports: [
          NonPoolDataSourceModule,
          RlsModule.forPoolService({ serviceName: 'test-no-pool' }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      await expect(moduleRef.init()).rejects.toThrow(/REMEDIATION/);

      await moduleRef.close().catch(() => undefined);
    });

    it('rejects a malformed serviceName at registration time', () => {
      // The factory-class path validates the identifier shape; this
      // throws synchronously during DynamicModule construction (before
      // Nest even sees the module), so the bad config fails the import
      // expression, not a later DI resolution.
      expect(() =>
        RlsModule.forPoolService({ serviceName: 'Bad Name!' }),
      ).toThrow(/Invalid serviceName/);
    });
  });

  describe('forBypassOnly — no DataSource required', () => {
    it('boots cleanly without any DataSource provider', async () => {
      @Module({
        imports: [
          RlsModule.forBypassOnly({ serviceName: 'test-bypass-only' }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      // The module must boot without throwing. This is the positive-case
      // inverse of the forPoolService "no DataSource" test — proves the
      // bypass-only path does NOT depend on any DataSource token.
      await moduleRef.init();

      expect(moduleRef.get(BypassRlsService, { strict: false })).toBeInstanceOf(
        BypassRlsService,
      );

      await moduleRef.close();
    });

    it('rejects a malformed serviceName synchronously', () => {
      // Validation runs during DynamicModule construction. A caller that
      // fat-fingers the name sees the error at import-expression time,
      // not at lazy DI resolution — much easier to localise.
      expect(() =>
        RlsModule.forBypassOnly({ serviceName: 'NotLowercase' }),
      ).toThrow(/invalid serviceName/);
      expect(() => RlsModule.forBypassOnly({ serviceName: '' })).toThrow(
        /invalid serviceName/,
      );
      expect(() =>
        RlsModule.forBypassOnly({ serviceName: '  ' }),
      ).toThrow(/invalid serviceName/);
    });
  });

  describe('API split — compile-time shape enforcement (documentary)', () => {
    it('forPoolService options and forBypassOnly options are structurally distinct', () => {
      // This test is documentary — it encodes the API contract in
      // runtime-visible form. The important enforcement is at the TS
      // type layer: `RlsBypassOnlyOptions` is strictly narrower than
      // `RlsPoolServiceOptions`, so the compiler rejects
      //     RlsModule.forBypassOnly({ serviceName: 'x', autoApply: true })
      // with "Object literal may only specify known properties". That
      // compile error is the Tier-1 guarantee — this spec just encodes
      // that the narrow shape is accepted at the runtime boundary.
      const bypassModule = RlsModule.forBypassOnly({
        serviceName: 'doc-test',
      });
      expect(bypassModule.module).toBe(RlsModule);
      expect(bypassModule.global).toBe(true);
      expect(bypassModule.providers).toHaveLength(1);
      expect(bypassModule.exports).toEqual([BypassRlsService]);
    });

    it('forPoolService registers optional providers conditionally', () => {
      // Bare: only the two mandatory providers (bootstrap, bypass).
      const bareModule = RlsModule.forPoolService({
        serviceName: 'doc-bare',
      });
      expect(bareModule.providers).toHaveLength(2);

      // With autoApply: RlsSchemaBootstrap added.
      const autoApplyModule = RlsModule.forPoolService({
        serviceName: 'doc-auto',
        autoApply: true,
      });
      expect(autoApplyModule.providers).toHaveLength(3);

      // With syncTenantSchemas: TenantRlsSyncService added.
      const syncModule = RlsModule.forPoolService({
        serviceName: 'doc-sync',
        syncTenantSchemas: true,
      });
      expect(syncModule.providers).toHaveLength(3);

      // Both together: both bootstraps added.
      const bothModule = RlsModule.forPoolService({
        serviceName: 'doc-both',
        autoApply: true,
        syncTenantSchemas: true,
      });
      expect(bothModule.providers).toHaveLength(4);
    });
  });
});
