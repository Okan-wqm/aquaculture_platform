/**
 * Cache Control Interceptor
 *
 * Manages HTTP caching headers for optimal performance and resource utilization.
 * Supports conditional caching, ETags, and cache invalidation strategies.
 * Configurable per-route caching policies.
 */

import { createHash } from 'crypto';

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap, map } from 'rxjs/operators';

/**
 * Cache policy options
 */
export interface CachePolicy {
  maxAge?: number; // seconds
  sMaxAge?: number; // shared cache max age
  staleWhileRevalidate?: number;
  staleIfError?: number;
  private?: boolean;
  public?: boolean;
  noCache?: boolean;
  noStore?: boolean;
  noTransform?: boolean;
  mustRevalidate?: boolean;
  proxyRevalidate?: boolean;
  immutable?: boolean;
  varyHeaders?: string[];
}

/**
 * Cache metadata key
 */
export const CACHE_POLICY_KEY = 'cache_policy';

/**
 * Decorator to set cache policy on routes
 */
export const CachePolicy = (policy: CachePolicy) => SetMetadata(CACHE_POLICY_KEY, policy);

/**
 * Decorator for no-cache routes
 */
export const NoCache = () => CachePolicy({ noCache: true, noStore: true });

/**
 * Decorator for public cached routes
 */
export const PublicCache = (maxAge: number) => CachePolicy({ public: true, maxAge });

/**
 * Decorator for private cached routes
 */
export const PrivateCache = (maxAge: number) => CachePolicy({ private: true, maxAge });

/**
 * Decorator for immutable resources
 */
export const ImmutableCache = (maxAge: number) =>
  CachePolicy({ public: true, maxAge, immutable: true });

/**
 * Default cache policies by route pattern
 */
const DEFAULT_CACHE_POLICIES: Record<string, CachePolicy> = {
  '/health': { public: true, maxAge: 10 },
  '/api/v1/static': { public: true, maxAge: 86400, immutable: true },
  '/graphql': { noStore: true, noCache: true },
};

/**
 * Cache Control Interceptor
 * Intelligent HTTP caching management
 */
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheControlInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contextType = context.getType<string>();
    const isGraphQL = contextType === 'graphql';

    let request: Request;
    let response: Response;

    if (isGraphQL) {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext<{ req: Request; res: Response }>();
      request = ctx.req;
      response = ctx.res;
    } else {
      request = context.switchToHttp().getRequest<Request>();
      response = context.switchToHttp().getResponse<Response>();
    }

    // Skip if no response object (some contexts)
    if (!response || typeof response.setHeader !== 'function') {
      return next.handle();
    }

    // Get cache policy from decorator or defaults
    const policy = this.getCachePolicy(context, request);

    // Handle conditional requests (If-None-Match, If-Modified-Since)
    const conditionalResult = this.handleConditionalRequest(request, response);
    if (conditionalResult.notModified) {
      return next.handle();
    }

    return next.handle().pipe(
      tap((data) => {
        // Generate and set ETag
        if (data && !policy.noStore) {
          const etag = this.generateETag(data);
          response.setHeader('ETag', etag);
        }

        // Set Last-Modified for relevant responses
        if (data && typeof data === 'object' && 'updatedAt' in data) {
          const lastModified = new Date((data as { updatedAt: Date }).updatedAt);
          response.setHeader('Last-Modified', lastModified.toUTCString());
        }
      }),
      map((data: unknown) => {
        // Set cache control headers
        this.setCacheHeaders(response, policy);

        // Set Vary headers
        this.setVaryHeaders(response, policy);

        return data;
      }),
    );
  }

  /**
   * Get cache policy for the current context
   */
  private getCachePolicy(context: ExecutionContext, request: Request): CachePolicy {
    // Check for route-specific decorator
    const decoratorPolicy = this.reflector.getAllAndOverride<CachePolicy>(CACHE_POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (decoratorPolicy) {
      return decoratorPolicy;
    }

    // Check for path-based default policies
    const path = request.path;
    for (const [pattern, policy] of Object.entries(DEFAULT_CACHE_POLICIES)) {
      if (path.startsWith(pattern)) {
        return policy;
      }
    }

    // Default policy based on method
    if (request.method === 'GET') {
      return {
        private: true,
        maxAge: 0,
        mustRevalidate: true,
        varyHeaders: ['Authorization', 'Accept', 'Accept-Language'],
      };
    }

    // Non-GET requests should not be cached
    return { noStore: true, noCache: true };
  }

  /**
   * Handle conditional requests
   */
  private handleConditionalRequest(
    request: Request,
    _response: Response,
  ): { notModified: boolean } {
    const ifNoneMatch = request.headers['if-none-match'];
    const ifModifiedSince = request.headers['if-modified-since'];

    // These will be validated after response is generated
    // For now, store them for later comparison
    if (ifNoneMatch) {
      (request as Request & { conditionalETag?: string }).conditionalETag = ifNoneMatch;
    }

    if (ifModifiedSince) {
      (request as Request & { conditionalModifiedSince?: string }).conditionalModifiedSince =
        ifModifiedSince;
    }

    return { notModified: false };
  }

  /**
   * Generate ETag from response data
   */
  private generateETag(data: unknown): string {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    const hash = createHash('md5').update(content).digest('hex');
    return `"${hash}"`;
  }

  /**
   * Generate weak ETag (for semantic equivalence)
   */
  private generateWeakETag(data: unknown): string {
    const etag = this.generateETag(data);
    return `W/${etag}`;
  }

  /**
   * Set Cache-Control headers based on policy
   */
  private setCacheHeaders(response: Response, policy: CachePolicy): void {
    const directives: string[] = [];

    // Visibility directives
    if (policy.public) {
      directives.push('public');
    } else if (policy.private) {
      directives.push('private');
    }

    // Age directives
    if (policy.maxAge !== undefined) {
      directives.push(`max-age=${policy.maxAge}`);
    }

    if (policy.sMaxAge !== undefined) {
      directives.push(`s-maxage=${policy.sMaxAge}`);
    }

    // Revalidation directives
    if (policy.noCache) {
      directives.push('no-cache');
    }

    if (policy.noStore) {
      directives.push('no-store');
    }

    if (policy.mustRevalidate) {
      directives.push('must-revalidate');
    }

    if (policy.proxyRevalidate) {
      directives.push('proxy-revalidate');
    }

    // Transform directives
    if (policy.noTransform) {
      directives.push('no-transform');
    }

    // Stale directives
    if (policy.staleWhileRevalidate !== undefined) {
      directives.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`);
    }

    if (policy.staleIfError !== undefined) {
      directives.push(`stale-if-error=${policy.staleIfError}`);
    }

    // Immutable directive
    if (policy.immutable) {
      directives.push('immutable');
    }

    // Set the header
    if (directives.length > 0) {
      response.setHeader('Cache-Control', directives.join(', '));
    }

    // Set Pragma for HTTP/1.0 compatibility
    if (policy.noCache || policy.noStore) {
      response.setHeader('Pragma', 'no-cache');
    }

    // Set Expires for HTTP/1.0 compatibility
    if (policy.maxAge !== undefined && policy.maxAge > 0) {
      const expires = new Date(Date.now() + policy.maxAge * 1000);
      response.setHeader('Expires', expires.toUTCString());
    } else if (policy.noCache || policy.noStore) {
      response.setHeader('Expires', '0');
    }
  }

  /**
   * Set Vary headers for proper cache variation
   */
  private setVaryHeaders(response: Response, policy: CachePolicy): void {
    const varyHeaders = policy.varyHeaders || ['Accept', 'Accept-Encoding'];

    // Get existing Vary header
    const existingVary = response.getHeader('Vary');
    const existingHeaders: string[] =
      typeof existingVary === 'string'
        ? existingVary.split(',').map((h) => h.trim())
        : [];

    // Combine and deduplicate
    const allHeaders = [...new Set([...existingHeaders, ...varyHeaders])];

    if (allHeaders.length > 0) {
      response.setHeader('Vary', allHeaders.join(', '));
    }
  }

  /**
   * Check if ETags match (strong comparison)
   */
  static compareETags(clientETag: string, serverETag: string): boolean {
    // Strip weak indicator for comparison
    const normalizeETag = (etag: string): string => {
      return etag.replace(/^W\//, '').replace(/"/g, '');
    };

    return normalizeETag(clientETag) === normalizeETag(serverETag);
  }

  /**
   * Check if response should be cached
   */
  static shouldCache(statusCode: number, method: string): boolean {
    // Only cache successful GET and HEAD requests
    if (!['GET', 'HEAD'].includes(method)) {
      return false;
    }

    // Cacheable status codes
    const cacheableStatuses = [200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501];
    return cacheableStatuses.includes(statusCode);
  }
}

/**
 * Helper to build Cache-Control header string
 */
export function buildCacheControlHeader(policy: CachePolicy): string {
  const parts: string[] = [];

  if (policy.public) parts.push('public');
  if (policy.private) parts.push('private');
  if (policy.noCache) parts.push('no-cache');
  if (policy.noStore) parts.push('no-store');
  if (policy.maxAge !== undefined) parts.push(`max-age=${policy.maxAge}`);
  if (policy.sMaxAge !== undefined) parts.push(`s-maxage=${policy.sMaxAge}`);
  if (policy.mustRevalidate) parts.push('must-revalidate');
  if (policy.immutable) parts.push('immutable');

  return parts.join(', ');
}
