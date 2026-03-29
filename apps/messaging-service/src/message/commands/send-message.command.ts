import { ICommand } from '@nestjs/cqrs';
import { MessageContentType } from '../entities/message.entity';

/**
 * Command to send a new message in a channel.
 * Carries all data needed for idempotent, transactional message creation.
 */
export class SendMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly senderId: string,
    public readonly channelId: string,
    public readonly content: string | null,
    public readonly contentType: MessageContentType,
    public readonly idempotencyKey: string,
    public readonly parentId: string | null,
    public readonly attachmentKeys: string[],
    public readonly metadata: Record<string, unknown> | null,
  ) {}
}
