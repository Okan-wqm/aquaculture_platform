import { DynamicModule, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LegalHoldEntity } from './legal-hold.entity';
import { LegalHoldService } from './legal-hold.service';

/**
 * Canonical legal-hold module — the single source of truth every
 * service registers to consume the canonical LegalHoldService.
 *
 * # Why @Global + forRoot()
 *
 * Legal hold is cross-cutting — every destructive op across all 15
 * services needs the guard. @Global makes the service injectable
 * platform-wide without per-feature-module imports. forRoot() registers
 * the TypeORM entity feature so the repository is available for DI.
 *
 * # Registration
 *
 * Each service's AppModule:
 *
 * ```ts
 * imports: [
 *   …,
 *   LegalHoldModule.forRoot(),
 * ]
 * ```
 *
 * Services with a Redis client should ALSO bridge the cache token:
 *
 * ```ts
 * providers: [
 *   { provide: LEGAL_HOLD_CACHE_CLIENT, useExisting: REDIS_CLIENT },
 * ]
 * ```
 *
 * Services without Redis fall through to direct DB lookup on every call.
 *
 * Closes: foundation for LEGAL-CRITICAL-001..003 + LEGAL-HIGH-002..006.
 */
@Global()
@Module({})
export class LegalHoldModule {
  static forRoot(): DynamicModule {
    return {
      module: LegalHoldModule,
      global: true,
      imports: [TypeOrmModule.forFeature([LegalHoldEntity])],
      providers: [LegalHoldService],
      exports: [LegalHoldService],
    };
  }
}
