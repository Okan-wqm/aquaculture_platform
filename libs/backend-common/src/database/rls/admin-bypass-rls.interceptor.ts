import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from } from 'rxjs';

import { IS_PUBLIC_KEY } from '../../decorators/roles.decorator';

import { BypassRlsService } from './bypass-rls.service';

/**
 * AdminBypassRlsInterceptor
 * ============================================================================
 *
 * Wraps every request handled by an admin-only service in
 * `BypassRlsService.withBypass()`, so any DB query the handler issues —
 * including raw `dataSource.query("SELECT ... FROM billing.subscriptions")` —
 * sets `app.bypass_rls = 'on'` on the checked-out connection and is granted
 * unrestricted visibility by the tenant_isolation_policy.
 *
 * # Why a global interceptor and not a per-controller decorator?
 *
 * `admin-api-service` is, by design, a SUPER_ADMIN-only service. **Every**
 * endpoint there is cross-tenant; there is no exception. Wrapping each
 * controller method in `withBypass()` manually would:
 *
 * 1. Be 100% noise (every method does the same thing).
 * 2. Be impossible to enforce — a forgotten wrap silently returns empty
 *    results from billing/notification/config queries the moment those
 *    services have RLS enabled.
 *
 * A global interceptor is the only way to make bypass automatic AND
 * uniform. The audit log entry from `BypassRlsService` still fires for
 * every request, so the trail is preserved.
 *
 * # Why this lives in backend-common, not admin-api-service
 *
 * The interceptor depends on `BypassRlsService` from `RlsModule`, and any
 * future admin-only service (e.g. `compliance-api`, `support-tools`) will
 * need the exact same wrapper. Keeping it in `backend-common` next to its
 * dependency avoids duplication.
 *
 * # NOT for use in tenant-scoped services
 *
 * Importing this interceptor in any non-admin service is a P0 security bug:
 * it would grant SUPER_ADMIN visibility to every tenant request. The class
 * name (`AdminBypassRlsInterceptor`) is intentionally explicit; code review
 * should treat its presence outside admin modules as an instant block.
 *
 * # Audit label
 *
 * The interceptor builds the operation label from the HTTP method and route
 * path so audit logs read like:
 *
 *     RLS BYPASS GRANTED [admin-api:GET /tenants]
 *     RLS BYPASS RELEASED [admin-api:GET /tenants]
 *
 * which is grep-able by route. We deliberately do NOT include user IDs in
 * the label (those would bloat the audit grep pattern); they're already in
 * the BypassRlsService log line via `getRequestContext()`.
 *
 * @example
 * ```ts
 * // admin-api-service AppModule
 * import { AdminBypassRlsInterceptor, RlsModule } from '@aquaculture/backend-common/rls';
 *
 * @Module({
 *   imports: [
 *     RlsModule.forPoolService({ serviceName: 'admin-api' }),
 *   ],
 *   providers: [
 *     {
 *       provide: APP_INTERCEPTOR,
 *       useClass: AdminBypassRlsInterceptor,
 *     },
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Injectable()
export class AdminBypassRlsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminBypassRlsInterceptor.name);

  constructor(
    private readonly bypassRls: BypassRlsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Build a stable, grep-friendly audit label. We use the contextType
    // ('http' | 'graphql' | 'rpc') so non-HTTP transports get a sane label
    // too — admin-api is HTTP-only today but the interceptor should not
    // assume that.
    const contextType = String(context.getType());
    const label = this.buildAuditLabel(context, contextType);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      this.logger.warn(
        `RLS BYPASS SKIPPED [${label}] because route is @Public(). ` +
          `Public admin-api routes must never receive cross-tenant DB bypass.`,
      );
      return next.handle();
    }

    // Convert the bypass-wrapped Promise into an Observable so the
    // interceptor contract (`Observable<unknown>` return) is honoured.
    // `from()` flattens the Promise; `switchMap` is unnecessary because the
    // wrapped callback returns an Observable produced by next.handle()
    // — instead we resolve the bypass first, THEN subscribe to the
    // downstream observable.
    return from(
      this.bypassRls.withBypass(label, async () => {
        // The downstream pipeline can be an Observable (REST controllers)
        // or a Promise (async controllers). lastValueFrom would normally be
        // the right tool, but we can't import rxjs/operators.lastValueFrom
        // without bumping the dep tree; so we manually convert via
        // toPromise-style. We use a Promise wrapper to keep the bypass
        // frame open for the entire downstream call tree.
        return await new Promise<unknown>((resolve, reject) => {
          next.handle().subscribe({
            next: (value) => resolve(value),
            error: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
          });
        });
      }),
    );
  }

  /**
   * Compose `<service>:<method> <path>` for HTTP, `<service>:<gql-op>` for
   * GraphQL, `<service>:<pattern>` for RPC. Falls back to a generic label
   * for unknown context types so the interceptor remains future-proof.
   */
  private buildAuditLabel(context: ExecutionContext, contextType: string): string {
    if (contextType === 'http') {
      const req = context.switchToHttp().getRequest<{
        method?: string;
        url?: string;
        route?: { path?: string };
      }>();
      const method = req.method ?? 'UNKNOWN';
      // Prefer the matched route pattern (`/tenants/:id`) over the raw URL
      // (`/tenants/abc-123`). The route pattern is grep-friendly and does
      // not contain PII.
      const path = req.route?.path ?? req.url ?? 'unknown';
      return `admin-api:${method} ${path}`;
    }

    return `admin-api:${contextType}`;
  }
}
