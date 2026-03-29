/**
 * @module ArchiveChannelCommand
 * @description CQRS command for archiving a channel. Dispatched by the
 * ChannelResolver and handled by ArchiveChannelHandler which performs
 * authorization, persistence, and outbox event emission in a single transaction.
 * @see ADR-012 section 3.4 (Channel CQRS)
 */

export class ArchiveChannelCommand {
  constructor(
    /** Tenant UUID from the request context. */
    public readonly tenantId: string,
    /** The user requesting the archive action. */
    public readonly userId: string,
    /** The channel to archive. */
    public readonly channelId: string,
  ) {}
}
