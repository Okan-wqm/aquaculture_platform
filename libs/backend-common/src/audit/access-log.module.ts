import { DynamicModule, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessLogEntity } from './access-log.entity';
import { AccessLogService } from './access-log.service';

/**
 * AccessLogModule — registers the AccessLogService + entity
 * persistence (AUDITTRAIL-HIGH-004).
 *
 * # Wiring shape (companion to AccessLogMiddleware)
 *
 * Importing this module:
 *
 *   1. Loads the AccessLogEntity into TypeORM's repository registry.
 *   2. Provides AccessLogService at the DI container.
 *   3. Exports the service so AccessLogMiddleware can inject it.
 *
 * The MOUNT is owned by the bootstrap factory (ADR-0006): every service
 * declaring `serviceVisibility: 'public'` gets `AccessLogMiddleware`
 * installed ahead of its Nest middleware by `mountEdgeHardening`
 * (`libs/backend-common/src/bootstrap/edge-hardening.ts`), and the factory
 * refuses to boot a public service whose AppModule does not import this
 * module. `tests/invariants/public-service-edge-hardening.spec.ts` derives
 * the public set from nginx and enforces both halves.
 *
 * # Why @Global and forRoot()
 *
 * Same architectural shape as AuditedOperationModule.forRoot().
 * Access logging is a cross-cutting platform concern; making it
 * Global means a service that imports the module once at the root
 * doesn't have to re-import it in every feature module that
 * defines middleware. The forRoot() static is purely a convention
 * affordance so the call site reads `AccessLogModule.forRoot()`
 * (signaling root-only registration) rather than `AccessLogModule`
 * (which a casual reader could mistakenly import in a feature
 * module).
 */
@Global()
@Module({})
export class AccessLogModule {
  static forRoot(): DynamicModule {
    return {
      module: AccessLogModule,
      global: true,
      imports: [TypeOrmModule.forFeature([AccessLogEntity])],
      providers: [AccessLogService],
      exports: [AccessLogService, TypeOrmModule],
    };
  }
}
