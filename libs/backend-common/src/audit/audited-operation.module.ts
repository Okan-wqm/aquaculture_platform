import { Module, Global, DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuditedOperationInterceptor } from './audited-operation.interceptor';

/**
 * AuditedOperationModule
 *
 * Registers the AuditedOperationInterceptor as a GLOBAL interceptor.
 * When imported into the root AppModule, every handler decorated with
 * @AuditedOperation() will automatically get transactional, non-swallowable
 * audit logging.
 *
 * ## Usage:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *     AuditedOperationModule,
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * ## Requirements:
 *
 * - A TypeORM DataSource must be available in the DI container (required by
 *   the interceptor to write audit rows and to use QueryRunner transactions).
 * - The AuditLogEntity must be registered in the TypeORM entity list
 *   (it is auto-loaded if AuditLogModule is also imported, or if the entity
 *   is included in the `entities` array of the TypeORM config).
 *
 * ## Why global?
 *
 * The interceptor reads metadata from handler decorators. If it were scoped
 * to a specific module, handlers in other modules would silently skip audit
 * logging — defeating the purpose of mandatory audit enforcement.
 */
@Global()
@Module({})
export class AuditedOperationModule {
  /**
   * Register the AuditedOperationInterceptor globally.
   *
   * This is a static method so it can be called in imports[] directly:
   * ```ts
   * imports: [AuditedOperationModule.forRoot()]
   * ```
   */
  static forRoot(): DynamicModule {
    return {
      module: AuditedOperationModule,
      global: true,
      providers: [
        AuditedOperationInterceptor,
        {
          provide: APP_INTERCEPTOR,
          useExisting: AuditedOperationInterceptor,
        },
      ],
      exports: [AuditedOperationInterceptor],
    };
  }
}
