/**
 * Response Transform Interceptor
 *
 * Standardizes API response format across all endpoints.
 * Provides consistent structure for success and error responses.
 * Supports pagination metadata and HATEOAS links.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: ResponseMeta;
  links?: ResponseLinks;
  timestamp: string;
  requestId?: string;
  path: string;
}

/**
 * Response metadata
 */
export interface ResponseMeta {
  page?: number;
  pageSize?: number;
  totalItems?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  processingTime?: number;
  version?: string;
  deprecationWarning?: string;
}

/**
 * HATEOAS links
 */
export interface ResponseLinks {
  self?: string;
  first?: string;
  last?: string;
  next?: string;
  prev?: string;
  related?: Record<string, string>;
}

/**
 * Paginated data structure
 */
export interface PaginatedData<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
}

/**
 * Metadata key for raw response
 */
export const RAW_RESPONSE_KEY = 'raw_response';

/**
 * Decorator to skip response transformation
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);

/**
 * Metadata key for custom response wrapper
 */
export const CUSTOM_WRAPPER_KEY = 'custom_wrapper';

/**
 * Decorator for custom response wrapper
 */
export const CustomWrapper = <T>(wrapper: (data: T) => unknown) =>
  SetMetadata(CUSTOM_WRAPPER_KEY, wrapper);

/**
 * Response Transform Interceptor
 * Standardizes all API responses
 */
@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  private readonly logger = new Logger(ResponseTransformInterceptor.name);
  private readonly apiVersion: string;

  constructor(private readonly reflector: Reflector) {
    this.apiVersion = process.env['API_VERSION'] || '1.0.0';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
    const contextType = context.getType<string>();
    const isGraphQL = contextType === 'graphql';

    // Skip transformation for GraphQL (GraphQL has its own response format)
    if (isGraphQL) {
      return next.handle() as Observable<ApiResponse<T>>;
    }

    // Check for raw response decorator
    const isRawResponse = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isRawResponse) {
      return next.handle() as Observable<ApiResponse<T>>;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startTime = Date.now();

    // Get custom wrapper if defined
    const customWrapper = this.reflector.getAllAndOverride<((data: T) => unknown) | undefined>(
      CUSTOM_WRAPPER_KEY,
      [context.getHandler(), context.getClass()],
    );

    return next.handle().pipe(
      map((data) => {
        // Apply custom wrapper if defined
        if (customWrapper) {
          return customWrapper(data) as ApiResponse<T>;
        }

        const processingTime = Date.now() - startTime;

        // Extract request ID from headers or correlation ID
        const requestId =
          (request.headers['x-request-id'] as string) ||
          (request.headers['x-correlation-id'] as string) ||
          undefined;

        // Build response
        const transformedResponse = this.transformResponse(
          data,
          request,
          response,
          processingTime,
          requestId,
        );

        return transformedResponse;
      }),
    );
  }

  /**
   * Transform data into standard response format
   */
  private transformResponse(
    data: T,
    request: Request,
    response: Response,
    processingTime: number,
    requestId?: string,
  ): ApiResponse<T> {
    const path = request.originalUrl || request.url;
    const timestamp = new Date().toISOString();

    // Check if data is paginated
    const isPaginated = this.isPaginatedResponse(data);

    // Build meta information
    const meta: ResponseMeta = {
      processingTime,
      version: this.apiVersion,
    };

    // Add pagination meta if applicable
    if (isPaginated) {
      const paginatedData = data as unknown as PaginatedData<unknown>;
      const totalPages = Math.ceil(paginatedData.totalItems / paginatedData.pageSize);

      meta.page = paginatedData.page;
      meta.pageSize = paginatedData.pageSize;
      meta.totalItems = paginatedData.totalItems;
      meta.totalPages = totalPages;
      meta.hasNextPage = paginatedData.page < totalPages;
      meta.hasPreviousPage = paginatedData.page > 1;
    }

    // Build HATEOAS links
    const links = this.buildLinks(request, data, isPaginated);

    // Add deprecation warning if applicable
    const deprecation = response.getHeader('Deprecation');
    if (deprecation) {
      meta.deprecationWarning = `This endpoint is deprecated. ${deprecation}`;
    }

    return {
      success: true,
      data: isPaginated ? (data as unknown as PaginatedData<unknown>).items as unknown as T : data,
      meta,
      links,
      timestamp,
      requestId,
      path,
    };
  }

  /**
   * Check if response is paginated
   */
  private isPaginatedResponse(data: unknown): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    const paginated = data as Record<string, unknown>;
    return (
      'items' in paginated &&
      Array.isArray(paginated['items']) &&
      'page' in paginated &&
      'pageSize' in paginated &&
      'totalItems' in paginated
    );
  }

  /**
   * Build HATEOAS links
   */
  private buildLinks(request: Request, data: T, isPaginated: boolean): ResponseLinks {
    const baseUrl = this.getBaseUrl(request);
    const path = request.path;
    const links: ResponseLinks = {
      self: `${baseUrl}${request.originalUrl}`,
    };

    if (isPaginated) {
      const paginatedData = data as unknown as PaginatedData<unknown>;
      const totalPages = Math.ceil(paginatedData.totalItems / paginatedData.pageSize);
      const currentPage = paginatedData.page;
      const pageSize = paginatedData.pageSize;

      // Build query string without page parameter
      const queryParams = new URLSearchParams(request.query as Record<string, string>);

      // First page
      queryParams.set('page', '1');
      queryParams.set('pageSize', pageSize.toString());
      links.first = `${baseUrl}${path}?${queryParams.toString()}`;

      // Last page
      queryParams.set('page', totalPages.toString());
      links.last = `${baseUrl}${path}?${queryParams.toString()}`;

      // Next page
      if (currentPage < totalPages) {
        queryParams.set('page', (currentPage + 1).toString());
        links.next = `${baseUrl}${path}?${queryParams.toString()}`;
      }

      // Previous page
      if (currentPage > 1) {
        queryParams.set('page', (currentPage - 1).toString());
        links.prev = `${baseUrl}${path}?${queryParams.toString()}`;
      }
    }

    return links;
  }

  /**
   * Get base URL from request
   */
  private getBaseUrl(request: Request): string {
    const protocol = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers['host'] || 'localhost';
    return `${protocol}://${host}`;
  }

  /**
   * Transform error response
   */
  static transformError(
    error: Error,
    statusCode: number,
    path: string,
    requestId?: string,
  ): {
    success: boolean;
    error: {
      code: string;
      message: string;
      details?: unknown;
    };
    timestamp: string;
    requestId?: string;
    path: string;
  } {
    return {
      success: false,
      error: {
        code: error.name || 'INTERNAL_ERROR',
        message: error.message || 'An unexpected error occurred',
      },
      timestamp: new Date().toISOString(),
      requestId,
      path,
    };
  }
}

/**
 * Helper to create paginated response
 */
export function createPaginatedResponse<T>(
  items: T[],
  page: number,
  pageSize: number,
  totalItems: number,
): PaginatedData<T> {
  return {
    items,
    page,
    pageSize,
    totalItems,
  };
}

/**
 * Helper to create success response manually
 */
export function createSuccessResponse<T>(
  data: T,
  meta?: Partial<ResponseMeta>,
): Omit<ApiResponse<T>, 'timestamp' | 'path'> {
  return {
    success: true,
    data,
    meta: meta as ResponseMeta,
  };
}

/**
 * Helper to create error response manually
 */
export function createErrorResponse(
  code: string,
  message: string,
  details?: unknown,
): {
  success: boolean;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
} {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
  };
}
