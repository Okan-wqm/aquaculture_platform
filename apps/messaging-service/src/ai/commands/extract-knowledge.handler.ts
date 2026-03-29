/**
 * @module ExtractKnowledgeHandler
 * @description CQRS command handler that processes a batch of messages
 * for knowledge extraction. Delegates to KnowledgeExtractionService
 * which performs regex-based entity extraction and knowledge entry creation.
 * @see ADR-012 section 12.3 (Knowledge Extraction)
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';

import { ExtractKnowledgeCommand } from './extract-knowledge.command';
import { KnowledgeExtractionService } from '../services/knowledge-extraction.service';

@CommandHandler(ExtractKnowledgeCommand)
export class ExtractKnowledgeHandler
  implements ICommandHandler<ExtractKnowledgeCommand, void>
{
  private readonly logger = new Logger(ExtractKnowledgeHandler.name);

  constructor(
    private readonly knowledgeService: KnowledgeExtractionService,
  ) {}

  /**
   * Execute the extract-knowledge command.
   * Triggers the hourly batch processing pipeline for knowledge extraction.
   * Errors are caught and logged for graceful degradation.
   */
  async execute(command: ExtractKnowledgeCommand): Promise<void> {
    const { tenantId, messageIds } = command;

    this.logger.debug(
      `Processing knowledge extraction for ${messageIds.length} messages in tenant ${tenantId}`,
    );

    try {
      // Trigger the batch processing via the service's existing pipeline
      await this.knowledgeService.processHourlyBatch();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Knowledge extraction batch failed: ${message}`);
    }
  }
}
