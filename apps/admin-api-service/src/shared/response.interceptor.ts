import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  hasUnissuedPaginationShapeV1,
  isCursorPaginationResultV1,
  isStandardPaginatedResult,
  paginationMetadataV1,
  type CursorPaginationResultV1,
  type PaginationMetadataV1,
  type PaginationResultV1,
} from '@platform/pagination-contracts';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** Cursor coordinates, minus the payload the envelope carries separately. */
export type CursorMetadataV1 = Omit<CursorPaginationResultV1<never>, 'items'>;

/**
 * Metadata carried alongside a payload.
 *
 * The pagination half IS the authority's type, so a field added there is a
 * compile error here rather than a silently-missing key on the wire. `meta`
 * used to be four optional numbers copied out of a duck-typed object, which is
 * how `totalPages` could arrive as `undefined` and `hasNextPage` never arrived
 * at all.
 */
export type ApiResponseMeta =
  | { timestamp: string }
  | (PaginationMetadataV1 & { timestamp: string })
  | (CursorMetadataV1 & { timestamp: string });

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta: ApiResponseMeta;
}

/** Routes that should NOT be wrapped in the response envelope. */
const SKIP_PREFIXES = ['/health', '/docs', '/docs-json', '/docs-yaml'];

/**
 * Raised when a handler returns something page-shaped that the pagination
 * authority did not mint.
 *
 * ADMIN-HIGH-004: the previous interceptor duck-typed `'data' in x && 'total'
 * in x` behind four casts and projected whatever fields happened to be present,
 * so a hand-built page reached the browser under the same envelope as a real
 * one and no consumer could tell which contract it was holding. Failing the
 * request is the only outcome that keeps that impossible: a 500 here is a bug
 * in the handler, visible on the first call, instead of a page whose
 * `totalPages` means nothing.
 */
export class UnissuedPaginationShapeError extends InternalServerErrorException {
  constructor(route: string) {
    super(
      `Handler for ${route} returned a paginated shape that was not issued by ` +
        '@platform/pagination-contracts. Build the result with ' +
        'createStandardPaginatedResult() (or createCursorPaginationResultV1() ' +
        'for cursor APIs) instead of assembling the fields by hand.',
    );
  }
}

/**
 * The envelope is a transport concern and deliberately NOT generic over the
 * handler's return type: an interceptor cannot prove at runtime what a handler
 * declared at compile time, and the old signature only kept that pretence alive
 * with casts. Typing the payload as `unknown` end-to-end removes every one of
 * them — the value is forwarded, never reconstructed.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor<unknown, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const url = request.url;

    // Strip version prefix (e.g. /v1/health -> /health) for matching
    const normalizedUrl = url.replace(/^\/v\d+/, '');

    if (this.shouldSkip(normalizedUrl)) {
      return next.handle();
    }

    return next.handle().pipe(map((data: unknown) => this.envelope(data, normalizedUrl)));
  }

  private envelope(data: unknown, route: string): ApiResponse<unknown> {
    const timestamp = new Date().toISOString();

    if (isStandardPaginatedResult(data)) {
      return this.pageEnvelope(data, timestamp);
    }

    if (isCursorPaginationResultV1(data)) {
      const { items, totalCount, hasMore, cursor } = data;
      return {
        success: true,
        data: items,
        meta: { totalCount, hasMore, cursor, timestamp },
      };
    }

    if (hasUnissuedPaginationShapeV1(data)) {
      throw new UnissuedPaginationShapeError(route);
    }

    return { success: true, data, meta: { timestamp } };
  }

  private pageEnvelope(
    page: PaginationResultV1<unknown>,
    timestamp: string,
  ): ApiResponse<readonly unknown[]> {
    return {
      success: true,
      data: page.items,
      meta: { ...paginationMetadataV1(page), timestamp },
    };
  }

  private shouldSkip(url: string): boolean {
    // Strip query string before matching
    const path = url.split('?')[0] ?? url;
    return SKIP_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(prefix + '/'),
    );
  }
}
