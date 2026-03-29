import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { CHANNEL_CONTEXT_KEY } from '../guards/channel-member.guard';

/**
 * Parameter decorator that extracts the {@link ChannelMember} placed on the
 * request by {@link ChannelMemberGuard}.
 *
 * Must be used on endpoints protected by `@UseGuards(ChannelMemberGuard)`.
 *
 * @example
 * ```ts
 * @UseGuards(ChannelMemberGuard)
 * @Mutation(() => Message)
 * async sendMessage(
 *   @CurrentChannel() membership: ChannelMember,
 * ) { ... }
 * ```
 */
export const CurrentChannel = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ChannelMember | undefined => {
    const contextType = ctx.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req as Record<string, unknown>;
      return request[CHANNEL_CONTEXT_KEY] as ChannelMember | undefined;
    }

    const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    return request[CHANNEL_CONTEXT_KEY] as ChannelMember | undefined;
  },
);
