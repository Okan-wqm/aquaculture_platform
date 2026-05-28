/**
 * FarmMetricsInterceptor
 *
 * Wraps every GraphQL resolver invocation (query + mutation) so
 * `farm_mutation_duration_seconds` and `farm_mutation_errors_total`
 * stay accurate without requiring each resolver to record timings
 * by hand. A single APP_INTERCEPTOR registration in AppModule
 * instruments the entire surface.
 *
 * The interceptor deliberately scopes to GraphQL only — HTTP is
 * already measured by `ServiceMetricsService` in
 * `@aquaculture/backend-common/metrics`. GraphQL introspection
 * queries are skipped so pinging the schema does not inflate the
 * `operation=IntrospectionQuery` label.
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Observable, tap } from 'rxjs';

import { FarmDomainMetricsService } from './farm-domain-metrics.service';

interface GraphQLContextRequest {
  tenantId?: string;
  user?: { tenantId?: string | null };
}

@Injectable()
export class FarmMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: FarmDomainMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return next.handle();
    }

    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo<{
      fieldName?: string;
      operation?: { operation?: string; name?: { value?: string } };
      parentType?: { name?: string };
    }>();

    const parentTypeName = info?.parentType?.name;
    // Only measure root-level operations — field resolvers on child
    // types would multiply the counter per row and drown the
    // operation-level signal in noise.
    if (parentTypeName !== 'Mutation' && parentTypeName !== 'Query') {
      return next.handle();
    }

    const operationName = info?.fieldName ?? info?.operation?.name?.value ?? 'unknown';

    // Skip introspection so schema checks do not inflate metrics.
    if (operationName.startsWith('__')) {
      return next.handle();
    }

    const ctx = gqlContext.getContext<{ req?: GraphQLContextRequest }>();
    const resolvedTenant = ctx?.req?.tenantId ?? ctx?.req?.user?.tenantId ?? undefined;
    const tenantId = typeof resolvedTenant === 'string' ? resolvedTenant : undefined;

    const startHrTime = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => {
          this.record(operationName, startHrTime, 'success', tenantId);
        },
        error: (err: unknown) => {
          this.record(operationName, startHrTime, 'error', tenantId);
          const errorClass = this.classifyError(err);
          this.metricsService.recordMutationError({
            operation: operationName,
            errorClass,
            tenantId,
          });
        },
      }),
    );
  }

  private record(
    operation: string,
    startHrTime: bigint,
    outcome: 'success' | 'error',
    tenantId?: string,
  ): void {
    const endHrTime = process.hrtime.bigint();
    const durationSeconds = Number(endHrTime - startHrTime) / 1_000_000_000;
    this.metricsService.recordMutation({
      operation,
      durationSeconds,
      outcome,
      tenantId,
    });
  }

  private classifyError(err: unknown): string {
    if (err && typeof err === 'object' && 'constructor' in err) {
      const ctor = (err as { constructor?: { name?: string } }).constructor;
      if (ctor?.name) return ctor.name;
    }
    return 'UnknownError';
  }
}
