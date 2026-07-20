import { isStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
    totalPages?: number;
    timestamp: string;
  };
}

/** Routes that should NOT be wrapped in the response envelope. */
const SKIP_PREFIXES = ['/health', '/docs', '/docs-json', '/docs-yaml'];

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T> | T>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T> | T> {
    // The {success,data,meta} envelope is an HTTP response contract. In the
    // hybrid app this APP_INTERCEPTOR also wraps NATS (RPC) message handlers
    // (e.g. TenantOnboardingAckHandler), whose return value must not be
    // reshaped and which have no HTTP request. Pass RPC through untouched.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const url = request.url;

    // Strip version prefix (e.g. /v1/health -> /health) for matching
    const normalizedUrl = url.replace(/^\/v\d+/, '');

    if (this.shouldSkip(normalizedUrl)) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: T): ApiResponse<T> | T => {
        // Binary/stream downloads must never be JSON-enveloped — enveloping a
        // StreamableFile/Buffer corrupts file exports (admin-api download
        // findings). Pass them through untouched. Computed as a boolean so the
        // handler's declared type T is preserved for the return.
        const isBinary = data instanceof StreamableFile || Buffer.isBuffer(data);
        if (isBinary) {
          return data;
        }

        // RC-1 canonical paginated shape (items[] + all four numeric fields,
        // produced ONLY by createStandardPaginatedResult). The array travels in
        // the envelope `data` slot; pagination numerics travel in `meta`.
        if (isStandardPaginatedResult(data)) {
          return {
            success: true,
            data: data.items as T,
            meta: {
              total: data.total,
              page: data.page,
              limit: data.limit,
              totalPages: data.totalPages,
              timestamp: new Date().toISOString(),
            },
          };
        }

        // RC-1b (tracked ADMIN-CRITICAL-007): legacy {data,total} list
        // producers not yet migrated to the canonical shape are still lifted
        // here so they do not regress. This branch is deleted once every
        // producer routes through createStandardPaginatedResult.
        if (
          data &&
          typeof data === 'object' &&
          'data' in data &&
          'total' in data
        ) {
          return {
            success: true,
            data: (data as Record<string, unknown>).data as T,
            meta: {
              total: (data as Record<string, unknown>).total as number,
              page: (data as Record<string, unknown>).page as number,
              limit: (data as Record<string, unknown>).limit as number,
              totalPages: (data as Record<string, unknown>)
                .totalPages as number,
              timestamp: new Date().toISOString(),
            },
          };
        }

        return {
          success: true,
          data,
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );
  }

  private shouldSkip(url: string): boolean {
    // Strip query string before matching
    const path = url.split('?')[0] ?? url;
    return SKIP_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(prefix + '/'),
    );
  }
}
