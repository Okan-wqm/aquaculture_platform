import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';

import { SKIP_RESPONSE_ENVELOPE_KEY } from './skip-response-envelope.decorator';

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
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T> | T> {
    const request = context.switchToHttp().getRequest<Request>();
    const url = request.url;

    const skipEnvelope = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipEnvelope) {
      return next.handle();
    }

    // Strip version prefix (e.g. /v1/health -> /health) for matching
    const normalizedUrl = url.replace(/^\/v\d+/, '');

    if (this.shouldSkip(normalizedUrl)) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        // If data already has pagination info, extract it as meta
        if (data && typeof data === 'object' && 'data' in data && 'total' in data) {
          return {
            success: true,
            data: (data as Record<string, unknown>).data as T,
            meta: {
              total: (data as Record<string, unknown>).total as number,
              page: (data as Record<string, unknown>).page as number,
              limit: (data as Record<string, unknown>).limit as number,
              totalPages: (data as Record<string, unknown>).totalPages as number,
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
    return SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
  }
}
