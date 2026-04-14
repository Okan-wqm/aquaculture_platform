import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { BypassRlsService } from './bypass-rls.service';
import { RlsModule } from './rls.module';
import { TenantRlsService } from './tenant-rls.service';

/**
 * RlsModule typed-API smoke tests.
 *
 * The architectural guarantee (WS4 — Tier-1 Make-Impossible):
 * `forPoolService` requires a `DataSource` in scope (fails DI
 * otherwise); `forBypassOnly` works without one. The old
 * `forRoot()` API conflated those two shapes, which caused the
 * 2026-04-14 gateway-api boot crash documented in docs/adr/016.
 *
 * We intentionally do NOT mock DI internals here — the whole point
 * of the Tier-1 lift is that the DI container's own behavior
 * catches the misuse. Tests that stub out DI would only verify the
 * stub, not the architectural guarantee.
 */
describe('RlsModule (typed API)', () => {
  describe('forBypassOnly', () => {
    it('registers BypassRlsService without requiring a DataSource', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [RlsModule.forBypassOnly({ serviceName: 'test-bypass' })],
      }).compile();

      const bypass = moduleRef.get(BypassRlsService);
      expect(bypass).toBeInstanceOf(BypassRlsService);
    });
  });

  describe('forPoolService', () => {
    it('fails module compilation when no DataSource is available', async () => {
      // forPoolService declares RlsConnectionBootstrap which injects
      // DataSource. With no TypeOrmModule in the test module tree,
      // NestJS must fail module compilation — this is the Tier-1
      // guarantee. The exact error shape is a NestJS internal so we
      // only assert that compilation rejects.
      await expect(
        Test.createTestingModule({
          imports: [RlsModule.forPoolService({ serviceName: 'test-pool' })],
        }).compile(),
      ).rejects.toThrow();
    });

    it('compiles when DataSource is provided', async () => {
      // Minimal DataSource stub — NestJS only needs the provider
      // token to resolve. No real DB connection is required; the pool
      // patch applies lazily at first checkout, not at module-compile
      // time.
      @Module({
        providers: [
          {
            provide: getDataSourceToken(),
            useValue: {
              driver: { pool: undefined },
              isInitialized: true,
            },
          },
        ],
        exports: [getDataSourceToken()],
      })
      class FakeTypeOrmModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          FakeTypeOrmModule,
          RlsModule.forPoolService({ serviceName: 'test-pool' }),
        ],
      }).compile();

      expect(moduleRef.get(BypassRlsService)).toBeInstanceOf(BypassRlsService);
      expect(moduleRef.get(TenantRlsService)).toBeInstanceOf(TenantRlsService);
    });
  });
});
