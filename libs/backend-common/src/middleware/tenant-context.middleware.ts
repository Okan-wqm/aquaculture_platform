import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * User payload from JWT (forwarded by gateway)
 */
export interface UserPayload {
  sub: string;
  email: string;
  tenantId: string;
  role?: string;
  roles?: string[];
  modules?: string[];
  firstName?: string;
  lastName?: string;
  iat?: number;
  exp?: number;
}

/**
 * Extended Request with tenant context and user
 */
export interface TenantRequest extends Request {
  tenantId?: string;
  tenantContext?: TenantContext;
  user?: UserPayload;
}

/**
 * Tenant Context information
 */
export interface TenantContext {
  tenantId: string;
  source: 'header' | 'jwt' | 'query' | 'subdomain';
}

/**
 * User Context Middleware
 * Extracts user payload from gateway header (x-user-payload)
 * Must run BEFORE TenantContextMiddleware
 */
@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UserContextMiddleware.name);

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    const userPayloadHeader = req.headers['x-user-payload'] as string;

    if (userPayloadHeader) {
      try {
        const user = JSON.parse(userPayloadHeader) as UserPayload;
        req.user = user;
        this.logger.debug(
          `User context set: ${user.email} (tenant: ${user.tenantId})`,
        );
      } catch (error) {
        this.logger.warn(`Failed to parse x-user-payload header: ${error}`);
      }
    }

    next();
  }
}

/**
 * Tenant Context Middleware
 * Extracts and attaches tenant context to requests
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    const tenantContext = this.extractTenantContext(req);

    if (tenantContext) {
      req.tenantId = tenantContext.tenantId;
      req.tenantContext = tenantContext;
      this.logger.debug(
        `Tenant context set: ${tenantContext.tenantId} (source: ${tenantContext.source})`,
      );
    }

    next();
  }

  private extractTenantContext(req: TenantRequest): TenantContext | null {
    // 1. Try from header
    const headerTenant = req.headers['x-tenant-id'] as string;
    if (headerTenant) {
      return { tenantId: headerTenant, source: 'header' };
    }

    // 2. Try from JWT (if already decoded by auth middleware)
    if ((req as any).user?.tenantId) {
      return { tenantId: (req as any).user.tenantId, source: 'jwt' };
    }

    // 3. Try from query parameter
    const queryTenant = req.query['tenantId'] as string;
    if (queryTenant) {
      return { tenantId: queryTenant, source: 'query' };
    }

    // 4. Try from subdomain (e.g., tenant1.api.example.com)
    const host = req.hostname;
    const parts = host.split('.');
    if (parts.length >= 3) {
      const subdomain = parts[0];
      // Exclude common prefixes
      if (subdomain && !['www', 'api', 'app', 'admin'].includes(subdomain)) {
        return { tenantId: subdomain, source: 'subdomain' };
      }
    }

    return null;
  }
}

/**
 * Correlation ID Middleware
 * Ensures every request has a correlation ID for distributed tracing
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    let correlationId = req.headers['x-correlation-id'] as string;

    if (!correlationId) {
      correlationId = crypto.randomUUID();
      req.headers['x-correlation-id'] = correlationId;
    }

    // Add to response headers for client tracking
    res.setHeader('x-correlation-id', correlationId);

    next();
  }
}

/**
 * Request Logging Middleware
 * Logs all incoming requests with relevant context
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    const startTime = Date.now();
    const { method, originalUrl, ip } = req;
    const correlationId = req.headers['x-correlation-id'];
    const tenantId = req.tenantId || req.headers['x-tenant-id'];

    // Log when response finishes
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const { statusCode } = res;

      const logMessage = `${method} ${originalUrl} ${statusCode} ${duration}ms`;
      const logContext = {
        method,
        url: originalUrl,
        statusCode,
        duration,
        correlationId,
        tenantId,
        ip,
        userAgent: req.headers['user-agent'],
      };

      if (statusCode >= 500) {
        this.logger.error(logMessage, logContext);
      } else if (statusCode >= 400) {
        this.logger.warn(logMessage, logContext);
      } else {
        this.logger.log(logMessage);
      }
    });

    next();
  }
}
