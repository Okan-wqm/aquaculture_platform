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
import {
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  parse,
} from 'graphql';
import { verifyServiceIdentityRequest } from '../utils/service-identity.util';
import { SecurityEventService } from '../security/security-event.service';
import { hashVerifiedUserAssertionHeaders } from '../http/gateway-verified-user-assertion';

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

    // Allow only pure introspection/schema-composition queries without
    // identity headers.
    // The gateway's IntrospectAndCompose polls subgraph schemas periodically
    // and Apollo's internal introspection does not go through willSendRequest
    // context flow (context is undefined for health-check/schema loads).
    // SECURITY: a mixed operation containing `__schema` plus an ordinary
    // resolver is NOT introspection and must pass service identity HMAC.
    const body = req.body as { query?: string; operationName?: string } | undefined;
    if (this.isIntrospectionQuery(body)) {
      return true;
    }

    // SECURITY: bind X-Tenant-ID into signature verification so a compromised
    // caller cannot forward a valid signature with a spoofed tenant header.
    // Absent header verifies with empty string (non-tenant path).
    const tenantHeader = (req.headers['x-tenant-id'] as string | undefined) ?? '';
    const serviceName = (req.headers['x-service-identity'] as string | undefined) ?? 'unknown';

    // Unified v1/v2 verifier — closes SEC-CRITICAL-001 by binding method,
    // path, and body into the v2 canonical input. v1 is accepted only for
    // the W0.A rolling-deploy window; verifier emits a security event on
    // every v1 outcome so the fleet can confirm zero v1 traffic before
    // W0.A-finalize removes v1 acceptance entirely.
    const observedBody = this.serializeBodyForHash(req.body);

    const outcome = verifyServiceIdentityRequest({
      headers: req.headers as Record<string, string | string[] | undefined>,
      observedMethod: req.method ?? 'POST',
      observedPath: this.canonicalisePath(req),
      observedBody,
      observedAssertionHash: hashVerifiedUserAssertionHeaders(
        req.headers as Record<string, string | string[] | undefined>,
      ),
      secret: this.secret,
      expectedTenantId: tenantHeader,
    });

    if (!outcome.valid) {
      this.logger.warn(
        `Rejected request: ${outcome.reason} from "${serviceName}"` +
          (tenantHeader ? ` (tenant=${tenantHeader})` : ''),
      );
      this.securityEventService
        ?.publishServiceIdentityRejected({
          serviceName,
          reason:
            outcome.reason === 'missing-headers'
              ? 'Missing service identity headers'
              : `Service identity verification failed: ${outcome.reason}`,
        })
        .catch(() => {
          /* best-effort */
        });
      throw new ForbiddenException(
        outcome.reason === 'missing-headers'
          ? 'Missing service identity headers. Direct access to subgraph services is not allowed.'
          : 'Invalid service identity signature. Request may be forged, expired, or fields tampered with.',
      );
    }

    if (outcome.version === 'v1') {
      // Deprecated path observed — emit a security event so the metric
      // for "safe to remove v1" can be tracked. Not a rejection (yet).
      this.securityEventService
        ?.publishServiceIdentityRejected({
          serviceName,
          reason: 'service-identity-v1-deprecated-accepted',
        })
        .catch(() => {
          /* best-effort */
        });
    }

    return true;
  }

  /**
   * Coerce the parsed body back into a byte-stable representation for
   * sha256. Express + body-parser already JSON.parse'd the body for us;
   * we re-serialize with stable key ordering by relying on JSON.stringify
   * default ordering (insertion order), which matches what the sender's
   * JSON.stringify produced. Raw-body callers (e.g. webhook controllers)
   * should attach req.rawBody and we prefer that when present.
   */
  private serializeBodyForHash(body: unknown): string | Buffer {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    return JSON.stringify(body);
  }

  /**
   * Extract the path-only component of the request URL for v2 canonical
   * comparison. Express's req.path already excludes the query string in
   * the typical case; this helper is defensive about variants where
   * originalUrl carries query params.
   */
  private canonicalisePath(req: { path?: string; originalUrl?: string; url?: string }): string {
    // GraphQL guards can see a mount-relative `path` such as `/`; the signed
    // gateway request binds the full wire path, so prefer originalUrl.
    const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
    const qIdx = raw.indexOf('?');
    return qIdx === -1 ? raw : raw.slice(0, qIdx);
  }

  /**
   * Detect if a request is a GraphQL introspection query.
   * Introspection queries are used by Apollo Gateway for schema polling,
   * Apollo Studio, GraphQL Playground, and other development tools.
   */
  private isIntrospectionQuery(
    body: { query?: string; operationName?: string } | undefined,
  ): boolean {
    if (!body || typeof body.query !== 'string') {
      return false;
    }

    let document;
    try {
      document = parse(body.query);
    } catch {
      return false;
    }

    const fragments = new Map<string, FragmentDefinitionNode>();
    const operations: OperationDefinitionNode[] = [];
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition);
      } else if (definition.kind === Kind.OPERATION_DEFINITION) {
        operations.push(definition);
      }
    }

    const targetOperations = body.operationName
      ? operations.filter((operation) => operation.name?.value === body.operationName)
      : operations;
    if (targetOperations.length !== 1) {
      return false;
    }

    const operation = targetOperations[0];
    if (!operation || operation.operation !== 'query') {
      return false;
    }

    return this.selectionSetIsPureIntrospection(operation.selectionSet, fragments);
  }

  private selectionSetIsPureIntrospection(
    selectionSet: SelectionSetNode,
    fragments: Map<string, FragmentDefinitionNode>,
    seenFragments = new Set<string>(),
  ): boolean {
    if (selectionSet.selections.length === 0) {
      return false;
    }

    return selectionSet.selections.every((selection) =>
      this.rootSelectionIsIntrospection(selection, fragments, seenFragments),
    );
  }

  private rootSelectionIsIntrospection(
    selection: SelectionNode,
    fragments: Map<string, FragmentDefinitionNode>,
    seenFragments: Set<string>,
  ): boolean {
    if (selection.kind === Kind.FIELD) {
      return this.rootFieldIsIntrospection(selection);
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      return this.selectionSetIsPureIntrospection(selection.selectionSet, fragments, seenFragments);
    }

    const fragmentName = selection.name.value;
    if (seenFragments.has(fragmentName)) {
      return false;
    }
    const fragment = fragments.get(fragmentName);
    if (!fragment) {
      return false;
    }
    seenFragments.add(fragmentName);
    const result = this.selectionSetIsPureIntrospection(
      fragment.selectionSet,
      fragments,
      seenFragments,
    );
    seenFragments.delete(fragmentName);
    return result;
  }

  private rootFieldIsIntrospection(field: FieldNode): boolean {
    const fieldName = field.name.value;
    if (fieldName === '__schema' || fieldName === '__type') {
      return true;
    }
    if (fieldName !== '_service' || !field.selectionSet) {
      return false;
    }
    return field.selectionSet.selections.every(
      (selection) => selection.kind === Kind.FIELD && selection.name.value === 'sdl',
    );
  }
}
