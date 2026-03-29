/**
 * @module ForwardMessageCommand
 * @description CQRS command to forward an existing message to another channel.
 * The handler validates dual-channel membership, copies message content and
 * attachment references (without duplicating storage), and emits a
 * MessageForwarded outbox event.
 * @see ADR-012 section 5.5 (Message Forwarding)
 */

import { ICommand } from '@nestjs/cqrs';

export class ForwardMessageCommand implements ICommand {
  constructor(
    /** Tenant UUID — for multi-tenant isolation. */
    public readonly tenantId: string,
    /** User UUID of the person forwarding the message. */
    public readonly userId: string,
    /** UUID of the message being forwarded. */
    public readonly sourceMessageId: string,
    /** createdAt of the source message — required for partition routing. */
    public readonly sourceMessageCreatedAt: Date,
    /** Target channel UUID to forward the message into. */
    public readonly targetChannelId: string,
  ) {}
}
