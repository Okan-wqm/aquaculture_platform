/**
 * GraphQL Mutation Rate Limit Guard
 *
 * In-memory rate limiter that restricts the number of GraphQL mutations
 * per user (or per IP for unauthenticated requests) within a sliding window.
 *
 * - 30 mutations per minute per user/IP
 * - Periodic cleanup of expired entries to prevent memory leaks
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000; // 1 minute
const MAX_MUTATIONS = 30;
const CLEANUP_INTERVAL_MS = 120_000; // 2 minutes

@Injectable()
export class MutationRateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(MutationRateLimitGuard.name);
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Periodic cleanup to prevent memory leaks from expired entries
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the timer to not block Node.js shutdown
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  // SECURITY: Rate-limits GraphQL mutations per user/IP to prevent abuse,
  // credential stuffing via mutations, and resource exhaustion attacks.
  canActivate(context: ExecutionContext): boolean {
    // Only applies to GraphQL context
    const contextType = context.getType<string>();
    if (contextType !== 'graphql') {
      return true;
    }

    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo();

    // Only rate-limit mutations
    if (!info || info.parentType?.name !== 'Mutation') {
      return true;
    }

    const req = gqlContext.getContext()?.req;
    const userId = req?.user?.sub;
    const ip = req?.ip ?? req?.socket?.remoteAddress ?? 'unknown';
    const key = userId ? `user:${userId}` : `ip:${ip}`;

    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      // New window
      this.entries.set(key, { count: 1, windowStart: now });
      return true;
    }

    entry.count++;

    if (entry.count > MAX_MUTATIONS) {
      const remainingMs = WINDOW_MS - (now - entry.windowStart);
      this.logger.warn(
        `Mutation rate limit exceeded for ${key}: ${entry.count}/${MAX_MUTATIONS} (retry in ${remainingMs}ms)`,
      );
      throw new GraphQLError(
        `Mutation rate limit exceeded. Maximum ${MAX_MUTATIONS} mutations per minute. Retry after ${Math.ceil(remainingMs / 1000)} seconds.`,
        {
          extensions: {
            code: 'TOO_MANY_REQUESTS',
            retryAfter: Math.ceil(remainingMs / 1000),
          },
        },
      );
    }

    return true;
  }

  /**
   * Remove expired entries to prevent memory leak.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= WINDOW_MS) {
        this.entries.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired mutation rate limit entries`);
    }
  }

  // Exposed for testing
  /** @internal */ getEntryCount(): number {
    return this.entries.size;
  }
}
