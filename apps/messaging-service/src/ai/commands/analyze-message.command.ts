/**
 * @module AnalyzeMessageCommand
 * @description CQRS command to trigger AI analysis (embedding, sentiment,
 * entity extraction) for a single message. Respects dual-consent privacy gates.
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture)
 */
import { ICommand } from '@nestjs/cqrs';

/**
 * Command to trigger all AI analysis pipelines for a given message.
 * Dispatched by the outbox consumer when a MessageSent event is published.
 */
export class AnalyzeMessageCommand implements ICommand {
  constructor(
    /** Tenant identifier for privacy gate checks. */
    public readonly tenantId: string,
    /** Channel the message belongs to. */
    public readonly channelId: string,
    /** UUID of the message to analyze. */
    public readonly messageId: string,
    /** Partition key timestamp for composite FK. */
    public readonly messageCreatedAt: Date,
    /** User who sent the message (for consent check). */
    public readonly senderId: string,
    /** Message text content. */
    public readonly content: string,
  ) {}
}
