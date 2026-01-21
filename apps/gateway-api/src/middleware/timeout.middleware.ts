/**
 * Timeout Middleware
 *
 * Enforces request timeout limits to prevent long-running requests.
 * Returns 504 Gateway Timeout when request exceeds configured timeout.
 * Supports per-route and per-method timeout configuration.
 */

import { Injectable, NestMiddleware, Logger, GatewayTimeoutException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * Timeout configuration
 */
export interface TimeoutConfig {
  default: number; // Default timeout in ms
  routes: Record<string, number>; // Route-specific timeouts
  methods: Record<string, number>; // Method-specific timeouts
  excludePaths: string[]; // Paths to exclude from timeout
  enableStreaming: boolean; // Allow streaming responses without timeout
}

/**
 * Extended request with timeout tracking
 */
interface TimeoutRequest extends Request {
  _timeoutTimer?: ReturnType<typeof setTimeout>;
  _isTimedOut?: boolean;
  _startTime?: number;
}

/**
 * Timeout Middleware
 * Enforces request timeout limits
 */
@Injectable()
export class TimeoutMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TimeoutMiddleware.name);
  private readonly config: TimeoutConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      default: this.configService.get<number>('REQUEST_TIMEOUT', 30000), // 30 seconds
      routes: this.parseRoutesConfig(),
      methods: {
        GET: this.configService.get<number>('REQUEST_TIMEOUT_GET', 30000),
        POST: this.configService.get<number>('REQUEST_TIMEOUT_POST', 60000),
        PUT: this.configService.get<number>('REQUEST_TIMEOUT_PUT', 60000),
        PATCH: this.configService.get<number>('REQUEST_TIMEOUT_PATCH', 60000),
        DELETE: this.configService.get<number>('REQUEST_TIMEOUT_DELETE', 30000),
      },
      excludePaths: this.configService
        .get<string>('REQUEST_TIMEOUT_EXCLUDE', '/health,/sse,/ws,/stream')
        .split(',')
        .map((p) => p.trim()),
      enableStreaming: this.configService.get<boolean>('REQUEST_TIMEOUT_STREAMING', true),
    };
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const timeoutReq = req as TimeoutRequest;
    timeoutReq._startTime = Date.now();

    // Check if path should be excluded
    if (this.shouldExclude(req)) {
      return next();
    }

    // Check if this is a streaming request
    if (this.isStreamingRequest(req)) {
      return next();
    }

    // Determine timeout duration
    const timeout = this.getTimeout(req);

    // Set timeout timer
    timeoutReq._timeoutTimer = setTimeout(() => {
      if (!res.headersSent) {
        timeoutReq._isTimedOut = true;

        const duration = Date.now() - (timeoutReq._startTime || 0);

        this.logger.warn('Request timeout', {
          path: req.path,
          method: req.method,
          timeout,
          duration,
          ip: req.ip,
        });

        res.status(504).json({
          success: false,
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: 'Request timeout exceeded',
            details: {
              timeout,
              path: req.path,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            path: req.path,
            method: req.method,
            statusCode: 504,
          },
        });

        // Destroy the request to stop processing
        req.destroy();
      }
    }, timeout);

    // Clear timeout on response finish
    res.on('finish', () => {
      if (timeoutReq._timeoutTimer) {
        clearTimeout(timeoutReq._timeoutTimer);
      }
    });

    // Clear timeout on response close
    res.on('close', () => {
      if (timeoutReq._timeoutTimer) {
        clearTimeout(timeoutReq._timeoutTimer);
      }
    });

    // Clear timeout on error
    res.on('error', () => {
      if (timeoutReq._timeoutTimer) {
        clearTimeout(timeoutReq._timeoutTimer);
      }
    });

    next();
  }

  /**
   * Determine timeout for request
   */
  private getTimeout(req: Request): number {
    // Check route-specific timeout first
    for (const [pattern, timeout] of Object.entries(this.config.routes)) {
      if (this.matchRoute(req.path, pattern)) {
        return timeout;
      }
    }

    // Check method-specific timeout
    const methodTimeout = this.config.methods[req.method];
    if (methodTimeout) {
      return methodTimeout;
    }

    // Return default timeout
    return this.config.default;
  }

  /**
   * Check if path should be excluded from timeout
   */
  private shouldExclude(req: Request): boolean {
    return this.config.excludePaths.some((path) => req.path.startsWith(path));
  }

  /**
   * Check if this is a streaming request
   */
  private isStreamingRequest(req: Request): boolean {
    if (!this.config.enableStreaming) {
      return false;
    }

    // Check Accept header for streaming content types
    const accept = req.headers['accept'] || '';
    const streamingTypes = [
      'text/event-stream',
      'application/octet-stream',
      'application/x-ndjson',
    ];

    return streamingTypes.some((type) => accept.includes(type));
  }

  /**
   * Match route pattern
   */
  private matchRoute(path: string, pattern: string): boolean {
    // Simple pattern matching (supports * wildcard)
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(path);
    }

    return path.startsWith(pattern);
  }

  /**
   * Parse routes config from environment
   */
  private parseRoutesConfig(): Record<string, number> {
    const routesConfig = this.configService.get<string>('REQUEST_TIMEOUT_ROUTES', '');
    const routes: Record<string, number> = {};

    if (!routesConfig) {
      // Default route configurations
      return {
        '/api/v1/reports/*': 120000, // 2 minutes for reports
        '/api/v1/export/*': 180000, // 3 minutes for exports
        '/api/v1/import/*': 300000, // 5 minutes for imports
        '/api/v1/upload/*': 300000, // 5 minutes for uploads
      };
    }

    try {
      const parsed: unknown = JSON.parse(routesConfig);
      return parsed as Record<string, number>;
    } catch {
      this.logger.warn('Failed to parse routes timeout config');
      return routes;
    }
  }
}

/**
 * Decorator to set custom timeout for a route
 */
export function Timeout(ms: number) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;

    descriptor.value = async function (...args: unknown[]) {
      // The timeout will be handled by the middleware
      // This decorator is for documentation/metadata purposes
      return originalMethod.apply(this, args);
    };

    // Store timeout metadata
    Reflect.defineMetadata('timeout', ms, descriptor.value);

    return descriptor;
  };
}

/**
 * Create a timeout promise
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage = 'Operation timed out',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GatewayTimeoutException(errorMessage));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Check if request has timed out
 */
export function hasTimedOut(req: Request): boolean {
  return (req as TimeoutRequest)._isTimedOut === true;
}

/**
 * Get request elapsed time
 */
export function getElapsedTime(req: Request): number {
  const startTime = (req as TimeoutRequest)._startTime;
  if (!startTime) return 0;
  return Date.now() - startTime;
}
