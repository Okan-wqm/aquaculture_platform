import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext, GqlContextType } from '@nestjs/graphql';
import { Observable, tap, catchError, throwError } from 'rxjs';

/**
 * Extended request with optional properties
 */
interface LoggingRequest {
  method: string;
  url: string;
  ip?: string;
  headers?: Record<string, string | undefined>;
  tenantId?: string;
  user?: { sub?: string };
  connection?: { remoteAddress?: string };
}

/**
 * Request metrics
 */
interface RequestMetrics {
  method: string;
  path: string;
  operationName?: string;
  operationType?: string;
  correlationId?: string;
  tenantId?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  statusCode?: number;
  success: boolean;
  errorMessage?: string;
}

/**
 * Request Logging Interceptor
 * Provides detailed logging for all requests (HTTP and GraphQL)
 * Tracks performance metrics and error rates
 * Enterprise-grade with structured logging for observability
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('RequestLogger');
  private readonly slowRequestThreshold: number;

  constructor() {
    this.slowRequestThreshold = parseInt(
      process.env['SLOW_REQUEST_THRESHOLD_MS'] || '3000',
      10,
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startTime = Date.now();
    const metrics = this.buildRequestMetrics(context, startTime);

    return next.handle().pipe(
      tap((response) => {
        this.logSuccess(metrics, response);
      }),
      catchError((error: Error) => {
        this.logError(metrics, error);
        return throwError(() => error);
      }),
    );
  }

  private buildRequestMetrics(
    context: ExecutionContext,
    startTime: number,
  ): RequestMetrics {
    const contextType = context.getType<GqlContextType>();

    if (contextType === 'graphql') {
      return this.buildGraphQLMetrics(context, startTime);
    }

    return this.buildHttpMetrics(context, startTime);
  }

  private buildHttpMetrics(
    context: ExecutionContext,
    startTime: number,
  ): RequestMetrics {
    const request = context.switchToHttp().getRequest<LoggingRequest>();

    return {
      method: request.method,
      path: request.url,
      correlationId: request.headers?.['x-correlation-id'],
      tenantId: request.tenantId || request.headers?.['x-tenant-id'],
      userId: request.user?.sub,
      ip:
        request.ip ||
        request.headers?.['x-forwarded-for']?.split(',')[0] ||
        request.connection?.remoteAddress,
      userAgent: request.headers?.['user-agent'],
      startTime,
      success: true,
    };
  }

  private buildGraphQLMetrics(
    context: ExecutionContext,
    startTime: number,
  ): RequestMetrics {
    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo();
    const request = gqlContext.getContext()?.req;

    return {
      method: 'POST',
      path: '/graphql',
      operationName: info?.operation?.name?.value || 'anonymous',
      operationType: info?.operation?.operation || 'unknown',
      correlationId: request?.headers?.['x-correlation-id'],
      tenantId: request?.tenantId || request?.headers?.['x-tenant-id'],
      userId: request?.user?.sub,
      ip:
        request?.ip ||
        request?.headers?.['x-forwarded-for']?.split(',')[0] ||
        request?.connection?.remoteAddress,
      userAgent: request?.headers?.['user-agent'],
      startTime,
      success: true,
    };
  }

  private logSuccess(metrics: RequestMetrics, response: unknown): void {
    const endTime = Date.now();
    const duration = endTime - metrics.startTime;

    metrics.endTime = endTime;
    metrics.duration = duration;
    metrics.success = true;
    metrics.statusCode = 200;

    const logMessage = this.formatLogMessage(metrics);
    const logContext = this.buildLogContext(metrics, response);

    if (duration > this.slowRequestThreshold) {
      this.logger.warn(`[SLOW] ${logMessage}`, logContext);
    } else {
      this.logger.log(logMessage, logContext);
    }
  }

  private logError(metrics: RequestMetrics, error: Error): void {
    const endTime = Date.now();
    const duration = endTime - metrics.startTime;

    metrics.endTime = endTime;
    metrics.duration = duration;
    metrics.success = false;
    metrics.errorMessage = error.message;

    // Try to extract status code from error
    if ('status' in error && typeof (error as { status?: unknown }).status === 'number') {
      metrics.statusCode = (error as { status: number }).status;
    } else if ('statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number') {
      metrics.statusCode = (error as { statusCode: number }).statusCode;
    } else {
      metrics.statusCode = 500;
    }

    const logMessage = this.formatLogMessage(metrics);
    const logContext = this.buildLogContext(metrics, null, error);

    this.logger.error(logMessage, error.stack, logContext);
  }

  private formatLogMessage(metrics: RequestMetrics): string {
    const parts: string[] = [];

    if (metrics.operationName) {
      // GraphQL
      parts.push(
        `${metrics.operationType?.toUpperCase()} ${metrics.operationName}`,
      );
    } else {
      // HTTP
      parts.push(`${metrics.method} ${metrics.path}`);
    }

    parts.push(`${metrics.statusCode || 0}`);
    parts.push(`${metrics.duration}ms`);

    if (metrics.correlationId) {
      parts.push(`[${metrics.correlationId}]`);
    }

    return parts.join(' ');
  }

  private buildLogContext(
    metrics: RequestMetrics,
    response?: unknown,
    error?: Error,
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {
      type: metrics.operationName ? 'graphql' : 'http',
      method: metrics.method,
      path: metrics.path,
      duration: metrics.duration,
      success: metrics.success,
    };

    if (metrics.operationName) {
      context['operationName'] = metrics.operationName;
      context['operationType'] = metrics.operationType;
    }

    if (metrics.correlationId) {
      context['correlationId'] = metrics.correlationId;
    }

    if (metrics.tenantId) {
      context['tenantId'] = metrics.tenantId;
    }

    if (metrics.userId) {
      context['userId'] = metrics.userId;
    }

    if (metrics.ip) {
      context['ip'] = metrics.ip;
    }

    if (error) {
      context['error'] = {
        message: error.message,
        name: error.name,
      };
    }

    // Add response size if available
    if (response && typeof response === 'object') {
      try {
        const size = JSON.stringify(response).length;
        context['responseSize'] = size;
      } catch {
        // Ignore serialization errors
      }
    }

    return context;
  }
}
