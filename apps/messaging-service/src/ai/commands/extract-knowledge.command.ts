/**
 * @module ExtractKnowledgeCommand
 * @description CQRS command to process a batch of messages for knowledge
 * extraction. Creates knowledge_entries for verified operational patterns
 * such as feeding schedules, water quality notes, and incident reports.
 * @see ADR-012 section 12.3 (Knowledge Extraction)
 */
import { ICommand } from '@nestjs/cqrs';

/**
 * Command to trigger knowledge extraction for a batch of message IDs.
 * Dispatched by the hourly cron job or manually by administrators.
 */
export class ExtractKnowledgeCommand implements ICommand {
  constructor(
    /** Tenant identifier for scoping the extraction. */
    public readonly tenantId: string,
    /** Message IDs to process for knowledge extraction. */
    public readonly messageIds: string[],
  ) {}
}
