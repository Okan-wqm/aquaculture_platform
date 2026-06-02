import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { IS_PUBLIC_KEY } from '@aquaculture/backend-common/decorators';
import { AccessTokenVerifierService } from '@aquaculture/backend-common/security';
import { Request } from 'express';

import { JwtPayload } from '../services/token.service';

/**
 * Extended request with user payload
 */
interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

/**
 * GraphQL context with request
 */
interface GqlContext {
  req: AuthenticatedRequest;
}

@Injectable()
export class JwtAuthGuard {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AccessTokenVerifierService)
    private readonly accessTokenVerifier: AccessTokenVerifierService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if endpoint is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = this.getRequest(context);
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No authentication token provided');
    }

    const payload = await this.accessTokenVerifier.verifyAccessToken<JwtPayload>(token, {
      context: 'auth-service.JwtAuthGuard',
    });
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    request.user = payload;
    return true;
  }

  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const ctx = gqlCtx.getContext<GqlContext>();
      return ctx.req;
    }

    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const authHeader = request.headers?.authorization;
    if (!authHeader) return null;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' && token ? token : null;
  }
}
