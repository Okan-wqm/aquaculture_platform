import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from '../../message/entities/message.entity';
import { ChannelMember, ChannelMemberRole } from '../../channel/entities/channel-member.entity';
import { CHANNEL_CONTEXT_KEY } from './channel-member.guard';

interface RequestWithUser {
  user?: { sub: string };
  [key: string]: unknown;
}

/**
 * Guard that validates the current user either:
 * - Owns the message (senderId matches), OR
 * - Has ADMIN or OWNER role in the channel (for delete operations).
 *
 * This guard should be used after {@link ChannelMemberGuard} so that
 * the channel membership is already resolved on the request.
 */
@Injectable()
export class MessageOwnerGuard implements CanActivate {
  private readonly logger = new Logger(MessageOwnerGuard.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { request, messageId } = this.extractContext(context);

    if (!messageId) {
      throw new ForbiddenException('Message ID is required');
    }

    const userId = (request as RequestWithUser).user?.sub;
    if (!userId) {
      throw new ForbiddenException('Authentication required');
    }

    const message = await this.messageRepo.findOne({
      where: { id: messageId },
    });

    if (!message) {
      throw new ForbiddenException('Message not found');
    }

    // Owner check
    if (message.senderId === userId) {
      return true;
    }

    // For privileged roles (ADMIN/OWNER) — typically used for delete operations
    const channelMember = (request as Record<string, unknown>)[CHANNEL_CONTEXT_KEY] as
      | ChannelMember
      | undefined;

    if (
      channelMember &&
      (channelMember.role === ChannelMemberRole.ADMIN ||
        channelMember.role === ChannelMemberRole.OWNER)
    ) {
      return true;
    }

    this.logger.warn(
      `Access denied: user ${userId} does not own message ${messageId} and lacks admin privileges`,
    );
    throw new ForbiddenException(
      'You do not have permission to modify this message',
    );
  }

  private extractContext(context: ExecutionContext): {
    request: RequestWithUser;
    messageId: string | undefined;
  } {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const request = gqlCtx.getContext().req as RequestWithUser;
      const args = gqlCtx.getArgs<Record<string, unknown>>();
      const messageId =
        (args['messageId'] as string | undefined) ??
        (args['input'] as Record<string, unknown> | undefined)?.['messageId'] as string | undefined;
      return { request, messageId };
    }

    const httpRequest = context.switchToHttp().getRequest<RequestWithUser & { params: Record<string, string> }>();
    return {
      request: httpRequest,
      messageId: httpRequest.params['messageId'],
    };
  }
}
