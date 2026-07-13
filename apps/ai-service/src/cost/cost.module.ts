import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokenBudgetService } from './token-budget.service';
import { RateLimitService } from './rate-limit.service';
import { TurnLedgerService } from './turn-ledger.service';
import { ConversationTurn } from './conversation-turn.entity';

/**
 * Cost management module — rate limiting, token budget tracking, and the
 * durable per-turn cost ledger.
 *
 * TokenBudgetService/RateLimitService accept RedisService via @Optional()
 * injection. When RedisModule is imported in AppModule (production),
 * counters are distributed across instances. Without Redis, they fall back
 * to in-memory Maps (single-instance only).
 *
 * TurnLedgerService (ORPHAN-MEDIUM-380) appends one immutable
 * conversation_turns row per completed agent invocation — the DB is the
 * durable cost SSoT; Redis stays the fast enforcement cache.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ConversationTurn])],
  providers: [TokenBudgetService, RateLimitService, TurnLedgerService],
  exports: [TokenBudgetService, RateLimitService, TurnLedgerService],
})
export class CostModule {}
