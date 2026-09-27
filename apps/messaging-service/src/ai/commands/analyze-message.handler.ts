/**
 * @module AnalyzeMessageHandler
 * @description CQRS command handler that forwards a newly sent message to the
 * AI chat bridge when it lands in an AI channel. Dispatched (only) by the
 * Faz 2 AI trigger consumer (ai-trigger-nats.handler.ts).
 *
 * MSGFIX-FAZ2 (2026-09-16) — sentiment branch REMOVED: the pipeline ran
 * `request.ai.analyzeSentiment` on EVERY message with NO responder on
 * ai-service, so each dispatch burned a full 30s NATS timeout BEFORE the
 * chat bridge ever ran (the handler called sentiment first). The sentiment
 * writer (sentiment-analysis.service.ts) and its dead egress purpose are
 * deleted; the read-only sentimentTrends GraphQL query over historical
 * message_analysis rows stays (it makes no AI egress calls).
 *
 * The privacy decision lives in ONE place: AiEgressGateService at the
 * bridge's single egress point (tenant master switch + per-user consent,
 * fail-closed). This handler deliberately does NOT re-check consent — a
 * second scattered check is the drift the gate was created to remove.
 *
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture — writer removed)
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';

import { AnalyzeMessageCommand } from './analyze-message.command';
import { AiChatBridgeService } from '../services/ai-chat-bridge.service';

@CommandHandler(AnalyzeMessageCommand)
export class AnalyzeMessageHandler implements ICommandHandler<AnalyzeMessageCommand, void> {
  private readonly logger = new Logger(AnalyzeMessageHandler.name);

  constructor(private readonly chatBridgeService: AiChatBridgeService) {}

  /**
   * Execute the analyze-message command: hand the message to the AI chat
   * bridge (which verifies AI-channel type, consent, roles and budget
   * before anything leaves the service).
   */
  async execute(command: AnalyzeMessageCommand): Promise<void> {
    const { tenantId, channelId, messageId, content, senderId } = command;

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
