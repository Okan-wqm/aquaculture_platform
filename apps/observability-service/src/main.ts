import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
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
  const app = await NestFactory.create(AppModule);

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

  const port = process.env['PORT'] || 3009;
  await app.listen(port);

  logger.log(`Observability Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
  logger.log(`Prometheus metrics: http://localhost:${port}/metrics`);
  logger.log(`Health check: http://localhost:${port}/health`);
}

bootstrap();
