import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantScopedRepository } from '@aquaculture/backend-common/database';

import { ConversationTurn } from './conversation-turn.entity';
import { computeTurnCostUsd, TurnTokenUsage } from './model-pricing';

export interface RecordTurnParams {
  tenantId: string;
  conversationId: string;
  /** Persona identifier for the turn; null on personaless paths. */
  personaId: string | null;
  model: string;
  usage: TurnTokenUsage;
  /** Safety-pipeline flags for this turn; empty array persists as NULL. */
  flaggedCategories: string[];
}

/**
 * TurnLedgerService — append-only writer for the durable per-invocation AI
 * cost ledger `conversation_turns` (DB-PEOPLE-MEDIUM-002 / ORPHAN-MEDIUM-380).
 *
 * ARCHITECTURE:
 *  - The DB row is the durable SSoT for per-turn cost; Redis
 *    (TokenBudgetService) stays the fast ENFORCEMENT cache. This service
 *    never gates a chat — it records evidence.
 *  - APPEND-ONLY BY CONSTRUCTION: this class exposes exactly one operation,
 *    `recordTurn`. No update or delete path exists for ConversationTurn
 *    anywhere in the service, which is the tier-1 immutability guarantee
 *    (the wrong behaviour has no API surface to happen through).
 *  - TENANT SCOPING: every write goes through TenantScopedRepository with the
 *    explicit tenantId carried on the ChatRequest. Explicit-tenant
 *    construction (not AsyncLocalStorage resolution) is deliberate — the
 *    chat path is served over NATS request-reply + socket.io as well as
 *    HTTP, and the explicit factory works identically in all of them.
 *    The physical schema routing (search_path → tenant_<uuid>) rides the
 *    same per-request tenant execution context the sibling
 *    agent_conversations writes already use.
 *  - FAILURE ISOLATION: a failed ledger append must not fail the user's
 *    turn (the tokens were already spent at the provider). recordTurn
 *    catches, logs loudly with full context, and returns false — callers
 *    await it (no floating promise) but do not throw.
 */
@Injectable()
export class TurnLedgerService {
  private readonly logger = new Logger(TurnLedgerService.name);

  constructor(
    @InjectRepository(ConversationTurn)
    private readonly turnRepository: Repository<ConversationTurn>,
  ) {}

  /**
   * Append one immutable ledger row for a completed agent invocation.
   *
   * @returns true when the row was durably persisted, false when the append
   *   failed (already logged — the chat path continues either way).
   */
  async recordTurn(params: RecordTurnParams): Promise<boolean> {
    try {
      const { costUsd, catalogMatch } = computeTurnCostUsd(params.model, params.usage);
      if (!catalogMatch) {
        // Loud, actionable signal for finance: the turn was attributed at the
        // default tier because the model is missing from MODEL_PRICING_CATALOG.
        this.logger.warn(
          `AI model '${params.model}' missing from MODEL_PRICING_CATALOG — turn cost attributed at default (Sonnet-tier) rates for tenant ${params.tenantId}`,
        );
      }

      const scopedRepository = TenantScopedRepository.fromRepository(
        this.turnRepository,
        params.tenantId,
      );
      await scopedRepository.save({
        conversationId: params.conversationId,
        personaId: params.personaId,
        model: params.model,
        inputTokens: params.usage.input,
        outputTokens: params.usage.output,
        cacheReadTokens: params.usage.cacheRead,
        cacheCreationTokens: params.usage.cacheCreation,
        costUsd: costUsd.toFixed(6),
        flaggedCategories: params.flaggedCategories.length > 0 ? params.flaggedCategories : null,
      });
      return true;
    } catch (error) {
      // The provider already billed these tokens — losing the ledger row is a
      // finance/forensics gap that MUST be visible, but failing the user's
      // turn would only add product breakage on top of it.
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `AI turn-ledger append FAILED — durable cost row lost (tenant=${params.tenantId} conversation=${params.conversationId} model=${params.model} tokens=${params.usage.input}/${params.usage.output}/${params.usage.cacheRead}/${params.usage.cacheCreation}): ${message}`,
        stack,
      );
      return false;
    }
  }
}
