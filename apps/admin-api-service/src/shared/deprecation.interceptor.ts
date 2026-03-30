import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Response } from 'express';

/**
 * DeprecationInterceptor
 *
 * Adds RFC 8594 Deprecation and Sunset headers to all responses
 * from the decorated controller. Used to signal API consumers
 * that endpoints are deprecated and will be removed.
 *
 * Usage: @UseInterceptors(new DeprecationInterceptor('2026-06-01'))
 */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly sunsetDate: string) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Deprecation', 'true');
    response.setHeader('Sunset', this.sunsetDate);

    return next.handle().pipe(
      tap(() => {
        // Headers already set before response
      }),
    );
  }
}
