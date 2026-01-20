import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Current User Type - JWT payload structure
 */
export interface CurrentUserPayload {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
  firstName?: string;
  lastName?: string;
  iat?: number;
  exp?: number;
}

/**
 * Current User Decorator
 * Extracts authenticated user from request context
 */
export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const contextType = ctx.getType<string>();
    let user: CurrentUserPayload | undefined;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req;
      user = request.user;
    } else {
      const request = ctx.switchToHttp().getRequest();
      user = request.user;
    }

    if (!user) {
      throw new Error('User not found in request context');
    }

    return data ? user[data] : user;
  },
);

/**
 * Optional Current User Decorator
 * Returns undefined if user is not authenticated
 */
export const OptionalCurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const contextType = ctx.getType<string>();
    let user: CurrentUserPayload | undefined;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req;
      user = request.user;
    } else {
      const request = ctx.switchToHttp().getRequest();
      user = request.user;
    }

    if (!user) {
      return undefined;
    }

    return data ? user[data] : user;
  },
);
