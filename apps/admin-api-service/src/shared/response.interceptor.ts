import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  InternalServerErrorException,
  StreamableFile,
} from '@nestjs/common';
import {
  hasUnissuedPaginationShapeV1,
  isStandardPaginatedResult,
  paginationMetadataV1,
  type PaginationMetadataV1,
} from '@aquaculture/backend-common/pagination';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

export interface ApiResponseMetaV1 {
  readonly timestamp: string;
}

export type PaginatedApiResponseMetaV1 = ApiResponseMetaV1 & PaginationMetadataV1;

export interface ApiResponse<T> {
  readonly success: true;
  readonly data: T;
  readonly meta: ApiResponseMetaV1;
}

export interface PaginatedApiResponseV1<T> {
  readonly success: true;
  readonly data: readonly T[];
  readonly meta: PaginatedApiResponseMetaV1;
}

type InterceptedResponse<T> = ApiResponse<T> | PaginatedApiResponseV1<unknown> | T;

/** Routes that should NOT be wrapped in the response envelope. */
const SKIP_PREFIXES = ['/health', '/docs', '/docs-json', '/docs-yaml'];

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, InterceptedResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<InterceptedResponse<T>> {
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
      map((data: T): InterceptedResponse<T> => {
        if (data instanceof StreamableFile || Buffer.isBuffer(data)) {
          return data;
        }

        if (isStandardPaginatedResult(data)) {
          return {
            success: true,
            data: data.items,
            meta: {
              ...paginationMetadataV1(data),
              timestamp: new Date().toISOString(),
            },
          };
        }

        if (hasUnissuedPaginationShapeV1(data)) {
          throw new InternalServerErrorException({
            code: 'UNISSUED_PAGINATION_RESULT',
            message: 'Pagination results must be issued by the platform pagination authority',
          });
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
