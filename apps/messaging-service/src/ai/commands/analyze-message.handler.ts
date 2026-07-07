/**
 * @module AnalyzeMessageHandler
 * @description CQRS command handler that orchestrates AI analysis for a message.
 * Triggers embedding generation, sentiment analysis, and entity extraction
 * in sequence, respecting privacy gates. All operations are optional --
 * failures are logged but do not block the messaging flow.
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture)
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';

import { AnalyzeMessageCommand } from './analyze-message.command';
import { SentimentAnalysisService } from '../services/sentiment-analysis.service';
import { AiChatBridgeService } from '../services/ai-chat-bridge.service';
import { AiPrivacyService } from '../services/ai-privacy.service';

@CommandHandler(AnalyzeMessageCommand)
export class AnalyzeMessageHandler
  implements ICommandHandler<AnalyzeMessageCommand, void>
{
  private readonly logger = new Logger(AnalyzeMessageHandler.name);

  constructor(
    private readonly sentimentService: SentimentAnalysisService,
    private readonly chatBridgeService: AiChatBridgeService,
    private readonly privacyService: AiPrivacyService,
  ) {}

  /**
   * Execute the analyze-message command.
   * 1. Check privacy gates (dual consent)
   * 2. Run sentiment analysis
   * 3. Forward to AI chat bridge if in AI channel
   *
   * Each step is independently try/catch'd for graceful degradation.
   */
  async execute(command: AnalyzeMessageCommand): Promise<void> {
    const {
      tenantId,
      channelId,
      messageId,
      messageCreatedAt,
      senderId,
      content,
    } = command;

    // Privacy gate check
    const canAnalyze = await this.privacyService
      .canAnalyzeMessage(tenantId, senderId)
      .catch(() => false);

    if (!canAnalyze) {
      this.logger.debug(
        `Skipping AI analysis for message ${messageId}: privacy gate denied`,
      );
      // MSG-HIGH-061: still hand off to the AI chat bridge — but the bridge now
      // enforces the AiEgressGateService SSoT (tenant master switch + consent)
      // at its single egress point, so a disabled tenant / non-consented user
      // is blocked THERE. The handler no longer decides chat eligibility.
      await this.safeHandleAiChannel(tenantId, channelId, messageId, content, senderId);
      return;
    }

    // Run sentiment analysis (non-blocking)
    try {
      await this.sentimentService.analyzeMessage(
        tenantId,
        channelId,
        messageId,
        messageCreatedAt,
        senderId,
        content,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Sentiment analysis failed for ${messageId}: ${message}`);
    }

    // Forward to AI chat bridge if applicable
    await this.safeHandleAiChannel(tenantId, channelId, messageId, content, senderId);
  }

  /**
   * Safely attempt to handle message as AI channel message.
   * Failures are logged but do not propagate.
   */
  private async safeHandleAiChannel(
    tenantId: string,
    channelId: string,
    messageId: string,
    content: string,
    senderId: string,
  ): Promise<void> {
    try {
      await this.chatBridgeService.handleAiChannelMessage(
        tenantId,
        channelId,
        messageId,
        content,
        senderId,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI chat bridge failed for ${messageId}: ${message}`);
    }
  }
}
