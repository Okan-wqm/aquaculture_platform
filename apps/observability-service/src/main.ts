// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { StructuredLoggerService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Lightweight in-process rate limiter (no external dependency required).
// Uses a sliding-window counter keyed by IP address.
// ---------------------------------------------------------------------------
interface RateLimitWindow {
  count: number;
  windowStart: number;
}

function createRateLimiter(maxRequests: number, windowMs: number) {
  const store = new Map<string, RateLimitWindow>();

  // Prune stale entries every 5 minutes to prevent unbounded growth
  const pruneInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [key, window] of store) {
        if (now - window.windowStart >= windowMs) {
          store.delete(key);
        }
      }
    },
    5 * 60 * 1000,
  );
  // Allow the Node.js process to exit even if this timer is still active
  pruneInterval.unref();

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      'unknown';
    const now = Date.now();
    const existing = store.get(ip);

    if (!existing || now - existing.windowStart >= windowMs) {
      // Start a fresh window
      store.set(ip, { count: 1, windowStart: now });
      next();
      return;
    }

    existing.count++;
    if (existing.count > maxRequests) {
      res.status(429).json({
        statusCode: 429,
        message: 'Too Many Requests',
        retryAfter: Math.ceil((windowMs - (now - existing.windowStart)) / 1000),
      });
      return;
    }

    next();
  };
}

async function bootstrap() {
  const logger = new Logger('ObservabilityService');
  /**
   * ARCH-032: Wrap NestFactory.create() to surface readable errors.
   *
   * NestJS ExceptionHandler serializes Error objects via JSON.stringify, which
   * produces '{}' because Error properties (message, stack) are non-enumerable.
   * By catching here, we log the actual error message BEFORE NestJS can swallow it,
   * ensuring container logs always show what went wrong during module initialization.
   */
  let app;
  try {
    app = await NestFactory.create(AppModule, {
      logger: new StructuredLoggerService('observability-service'),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      service: 'observability-service',
      message: `Module initialization failed: ${message}`,
      ...(stack ? { stack } : {}),
      context: 'Bootstrap',
    }));
    process.exit(1);
  }

  // Security middleware
  app.use(helmet());

  // Rate limiting: 60 requests per minute per IP across all observability endpoints.
  // This is generous enough for a Prometheus scraper (default: every 15-60 s) while
  // blocking brute-force attempts against the INTERNAL_API_KEY header.
  app.use(createRateLimiter(60, 60 * 1000));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API prefix - exclude /metrics and /health paths so Prometheus scraper
  // and Kubernetes probes can reach them at their conventional paths
  app.setGlobalPrefix('api/v1', {
    exclude: ['metrics', 'health', 'health/live', 'health/ready', 'health/metrics'],
  });

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  // PORT RESOLUTION: Default 3000 to match Docker healthcheck convention.
  const port = process.env['OBSERVABILITY_SERVICE_PORT'] || process.env['PORT'] || 3000;
  await app.listen(port);

  logger.log(`Observability Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
  logger.log(`Prometheus metrics: http://localhost:${port}/metrics`);
  logger.log(`Health check: http://localhost:${port}/health`);
}

/**
 * ARCH-032: Surface the actual error on bootstrap failure.
 * NestJS Logger serializes Error objects as '{}' via JSON.stringify because
 * Error properties (message, stack) are non-enumerable. Structured JSON
 * ensures the real error is always visible in container logs.
 */
bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    service: 'observability-service',
    message: `Bootstrap failed: ${message}`,
    ...(stack ? { stack } : {}),
    context: 'Bootstrap',
  }));
  process.exit(1);
});
