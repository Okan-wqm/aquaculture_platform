import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
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
      map((data) => {
        // If data already has pagination info, extract it as meta
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
