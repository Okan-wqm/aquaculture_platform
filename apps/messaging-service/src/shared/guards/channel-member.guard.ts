import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

/** Key on the request object where the resolved channel is stored. */
export const CHANNEL_CONTEXT_KEY = '__channel';

interface RequestWithUser {
  user?: { sub: string };
  [CHANNEL_CONTEXT_KEY]?: ChannelMember;
}

/**
 * Guard that validates the authenticated user is an active member of
 * the channel referenced in the current request.
 *
 * The channelId is extracted from:
 * 1. GraphQL args (`channelId` field)
 * 2. HTTP route params (`channelId`)
 *
 * On success, the resolved {@link ChannelMember} is attached to the
 * request as `req[CHANNEL_CONTEXT_KEY]` so downstream decorators/resolvers
 * can access it without an additional DB lookup.
 */
@Injectable()
export class ChannelMemberGuard implements CanActivate {
  private readonly logger = new Logger(ChannelMemberGuard.name);

  constructor(
    @InjectRepository(ChannelMember)
    private readonly memberRepo: Repository<ChannelMember>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { request, channelId } = this.extractContext(context);

    if (!channelId) {
      throw new ForbiddenException('Channel ID is required');
    }

    const userId = request.user?.sub;
    if (!userId) {
      throw new ForbiddenException('Authentication required');
    }

    const member = await this.memberRepo.findOne({
      where: {
        channelId,
        userId,
        leftAt: IsNull(),
      },
    });

    if (!member) {
      this.logger.warn(
        `Access denied: user ${userId} is not a member of channel ${channelId}`,
      );
      throw new ForbiddenException('You are not a member of this channel');
    }

    // Attach to request for downstream usage
    (request as Record<string, unknown>)[CHANNEL_CONTEXT_KEY] = member;

    return true;
  }

  private extractContext(context: ExecutionContext): {
    request: RequestWithUser;
    channelId: string | undefined;
  } {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const request = gqlCtx.getContext().req as RequestWithUser;
      const args = gqlCtx.getArgs<Record<string, unknown>>();
      const channelId =
        (args['channelId'] as string | undefined) ??
        (args['input'] as Record<string, unknown> | undefined)?.['channelId'] as string | undefined;
      return { request, channelId };
    }

    const httpRequest = context.switchToHttp().getRequest<RequestWithUser & { params: Record<string, string> }>();
    return {
      request: httpRequest,
      channelId: httpRequest.params['channelId'],
    };
  }
}
