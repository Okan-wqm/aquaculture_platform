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
 * Re-enters AsyncLocalStorage around resolver/handler execution.
 *
 * HTTP middleware and guards seed tenant context, but Apollo GraphQL and CQRS
 * add async boundaries before TypeORM checks out a pg connection. This
 * interceptor is the request-execution boundary: if a guard-validated tenant is
 * present on the request/JWT principal, the rest of the resolver pipeline runs
 * inside withTenantContext(), so TenantConnectionBootstrap always resolves the tenant
 * schema before repository queries execute.
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
    const httpRequest = context.switchToHttp().getRequest<TenantExecutionRequest | undefined>();
    const httpTenantId = this.extractFromRequest(httpRequest);
    if (httpTenantId) {
      return httpTenantId;
    }

    const graphQlContext = context.getArgByIndex<GraphQLExecutionContext | undefined>(2);
    return this.extractFromRequest(graphQlContext?.req ?? graphQlContext?.request);
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
