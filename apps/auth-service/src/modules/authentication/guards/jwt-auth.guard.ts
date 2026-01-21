import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '@platform/backend-common';
import { Request } from 'express';

/**
 * Extended request with user payload
 */
interface AuthenticatedRequest extends Request {
  user?: Record<string, unknown>;
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
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
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

    try {
      const payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token);
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      return (gqlCtx.getContext() as GqlContext).req;
    }

    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const authHeader = request.headers?.authorization;
    if (!authHeader) return null;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : null;
  }
}
