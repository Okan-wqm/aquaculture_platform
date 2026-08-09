import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';

import { isValidUUID } from '../database/tenant-schema.utils';

import { withTenantContext } from './with-tenant-context';

interface TenantExecutionRequest {
  tenantId?: string;
  user?: {
    tenantId?: string;
  };
}

interface GraphQLExecutionContext {
  req?: TenantExecutionRequest;
  request?: TenantExecutionRequest;
}

/**
 * A message payload carrying the tenant it acts on.
 *
 * Lifecycle commands arrive over NATS with no HTTP frame, so nothing seeds
 * AsyncLocalStorage for them and the RLS GUC stays empty. The tenant is right
 * there in the command; it just was not being read.
 */
interface TenantCommandPayload {
  tenantId?: unknown;
}

/**
 * Re-enters AsyncLocalStorage around resolver/handler execution.
 *
 * HTTP middleware and guards seed tenant context, but Apollo GraphQL and CQRS
 * add async boundaries before TypeORM checks out a pg connection. This
 * interceptor is the request-execution boundary: if a guard-validated tenant is
 * present on the request/JWT principal, the rest of the resolver pipeline runs
 * inside withTenantContext(), so TenantConnectionBootstrap always resolves the tenant
 * schema before repository queries execute.
 *
 * ORPHAN-CRITICAL-573 — the RPC arm exists because tenant lifecycle commands
 * arrive over NATS, where there is no request to seed context from. Every write
 * those commands make to an RLS-armed table was therefore refused, and tenant
 * onboarding had been broken in production for months. Reading the tenant from
 * the message payload here means a NEW message handler cannot forget to bind
 * it - which is the difference between this and wrapping each handler by hand.
 */
@Injectable()
export class TenantExecutionContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId = this.extractTenantId(context);
    if (!tenantId || !isValidUUID(tenantId)) {
      return next.handle();
    }

    return from(withTenantContext(tenantId, () => lastValueFrom(next.handle())));
  }

  private extractTenantId(context: ExecutionContext): string | undefined {
    if (context.getType() === 'rpc') {
      return this.extractFromRpcPayload(context);
    }

    const httpRequest = context.switchToHttp().getRequest<TenantExecutionRequest | undefined>();
    const httpTenantId = this.extractFromRequest(httpRequest);
    if (httpTenantId) {
      return httpTenantId;
    }

    const graphQlContext = context.getArgByIndex<GraphQLExecutionContext | undefined>(2);
    return this.extractFromRequest(graphQlContext?.req ?? graphQlContext?.request);
  }

  /**
   * The tenant a message acts on, read from its own payload.
   *
   * Only the declared `tenantId` field is honoured. A message is not a
   * request: there is no guard chain behind it, so the payload is the claim
   * itself. That is acceptable here because the platform's NATS identity is
   * the mTLS certificate CN (ADR-015) - the sender is already authenticated
   * as a platform service before the payload is read - and because the value
   * only ever NARROWS access: an absent or malformed id leaves the context
   * unset, which is fail-closed under the RLS predicate.
   */
  private extractFromRpcPayload(context: ExecutionContext): string | undefined {
    const payload = context.switchToRpc().getData<TenantCommandPayload | undefined>();
    const tenantId = payload?.tenantId;
    return typeof tenantId === 'string' ? tenantId : undefined;
  }

  private extractFromRequest(request: TenantExecutionRequest | undefined): string | undefined {
    if (!request) {
      return undefined;
    }

    if (request.tenantId) {
      return request.tenantId;
    }

    if (request.user?.tenantId) {
      return request.user.tenantId;
    }

    return undefined;
  }
}
