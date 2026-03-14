import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';

import { RequestContextMiddleware } from './request-context.middleware';

/**
 * Registers the RequestContextMiddleware globally so that every
 * incoming HTTP request gets an AsyncLocalStorage-based RequestContext.
 *
 * Import this module in your AppModule:
 * ```ts
 * @Module({ imports: [LoggingModule, ...] })
 * export class AppModule {}
 * ```
 *
 * The StructuredLoggerService does NOT require this module to function --
 * it will simply omit request-scoped fields if no context is available.
 * However, for full observability (tenantId, correlationId, traceId, etc.)
 * you should import LoggingModule in every service's AppModule.
 */
@Module({})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
