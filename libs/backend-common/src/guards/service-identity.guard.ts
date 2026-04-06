import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GqlExecutionContext } from '@nestjs/graphql';
import { verifyServiceIdentity } from '../utils/service-identity.util';
import { SecurityEventService } from '../security/security-event.service';

/**
 * ServiceIdentityGuard — validates that incoming requests to a subgraph
 * service carry valid HMAC-signed service identity headers.
 *
 * This guard ensures that only the trusted gateway (or another service
 * sharing the INTERNAL_SERVICE_SECRET) can invoke the subgraph's GraphQL
 * endpoint, preventing direct access from arbitrary processes on the
 * Docker network.
 *
 * Behaviour:
 * - When INTERNAL_SERVICE_SECRET is set: validates X-Service-Identity,
 *   X-Service-Timestamp, and X-Service-Signature headers on every request.
 * - When INTERNAL_SERVICE_SECRET is NOT set (dev mode): logs a warning and
 *   allows all requests through.
 * - GraphQL introspection queries (__schema, __type) are always allowed
 *   without identity headers so that tooling and the gateway's schema
 *   polling continue to work.
 * - Health check endpoints (/health/*) are not affected — they use HTTP
 *   context and the guard only enforces on GraphQL context.
 */
@Injectable()
export class ServiceIdentityGuard implements CanActivate {
  private readonly logger = new Logger(ServiceIdentityGuard.name);
  private readonly secret: string | undefined;
  private warned = false;

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    this.secret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  canActivate(context: ExecutionContext): boolean {
    // Only enforce on GraphQL (HTTP health checks etc. should pass through)
    const contextType = context.getType<string>();
    if (contextType !== 'graphql') {
      return true;
    }

    // If no secret configured, fail-fast in production or skip validation (dev mode)
    if (!this.secret) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error(
          'INTERNAL_SERVICE_SECRET is not set. ' +
          'Inter-service authentication is required in production. ' +
          'Set INTERNAL_SERVICE_SECRET to enable service identity validation.',
        );
      }
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'INTERNAL_SERVICE_SECRET is not set — service identity validation is DISABLED. ' +
          'Set INTERNAL_SERVICE_SECRET in production to enforce inter-service authentication.',
        );
      }
      return true;
    }

    const gqlCtx = GqlExecutionContext.create(context);
    const req = gqlCtx.getContext().req;

    if (!req) {
      // No request object (e.g. subscription) — allow
      return true;
    }

    // Allow introspection queries without identity headers.
    // The gateway's IntrospectAndCompose polls subgraph schemas periodically
    // and Apollo's internal introspection does not go through willSendRequest
    // context flow (context is undefined for health-check/schema loads).
    const body = req.body as { query?: string; operationName?: string } | undefined;
    if (this.isIntrospectionQuery(body)) {
      return true;
    }

    // Extract identity headers
    const serviceName = req.headers['x-service-identity'] as string | undefined;
    const timestamp = req.headers['x-service-timestamp'] as string | undefined;
    const signature = req.headers['x-service-signature'] as string | undefined;

    if (!serviceName || !timestamp || !signature) {
      this.logger.warn(
        'Rejected request: missing service identity headers ' +
        `(identity=${!!serviceName}, timestamp=${!!timestamp}, signature=${!!signature})`,
      );
      this.securityEventService?.publishServiceIdentityRejected({
        serviceName: serviceName ?? 'unknown',
        reason: 'Missing service identity headers',
      }).catch(() => { /* best-effort */ });
      throw new ForbiddenException(
        'Missing service identity headers. Direct access to subgraph services is not allowed.',
      );
    }

    const valid = verifyServiceIdentity(serviceName, timestamp, signature, this.secret);
    if (!valid) {
      this.logger.warn(
        `Rejected request: invalid service identity signature from "${serviceName}"`,
      );
      this.securityEventService?.publishServiceIdentityRejected({
        serviceName,
        reason: 'Invalid service identity signature',
      }).catch(() => { /* best-effort */ });
      throw new ForbiddenException(
        'Invalid service identity signature. Request may be forged or expired.',
      );
    }

    return true;
  }

  /**
   * Detect if a request is a GraphQL introspection query.
   * Introspection queries are used by Apollo Gateway for schema polling,
   * Apollo Studio, GraphQL Playground, and other development tools.
   */
  private isIntrospectionQuery(
    body: { query?: string; operationName?: string } | undefined,
  ): boolean {
    if (!body) {
      return false;
    }

    // Apollo Gateway introspection uses specific operation names
    if (body.operationName === 'IntrospectionQuery') {
      return true;
    }

    // Check if the query body contains introspection fields
    const query = body.query;
    if (typeof query === 'string') {
      const trimmed = query.replace(/\s+/g, ' ').trim();
      // Match __schema or __type introspection patterns
      if (trimmed.includes('__schema') || trimmed.includes('__type')) {
        return true;
      }
      // Apollo Gateway's _service { sdl } federation query
      if (trimmed.includes('_service') && trimmed.includes('sdl')) {
        return true;
      }
    }

    return false;
  }
}
