/**
 * @module AiTriggerNatsHandler
 * @description MSGFIX-FAZ2 2.2 — the durable `MessageSent` consumer that
 * (re)animates the messaging AI chain.
 *
 * WHY THIS EXISTS: AnalyzeMessageCommand existed but NOTHING dispatched it —
 * the AI chain was dead end-to-end (bridge never called, AI chat in AI
 * channels silently no-op). This handler is the missing wire: it subscribes
 * (wildcard, all tenants) to MessageSent through the platform event bus —
 * the same durable JetStream pattern as MessagingPushNatsHandler — and
 * dispatches AnalyzeMessageCommand for messages that land in AI channels.
 *
 * GATES (in order, cheapest first):
 *   0. Kill-switch: AiTriggerConfig.triggerEnabled (MESSAGING_AI_TRIGGER_ENABLED,
 *      default OFF, strict fail-closed). When OFF the handler does not even
 *      subscribe — no durable consumer is created, no message is consumed,
 *      one DEBUG-level startup note only (no per-message spam).
 *   1. Self-trigger guard (double defense): skip the AI service's own
 *      messages — event.isAiResponse === true OR senderId === AI_USER_ID —
 *      so a persisted AI reply can never trigger another AI turn.
 *   2. messageId idempotency: Redis SETNX msg:ai-trigger:{tenantId}:{messageId}
 *      TTL 24h. The consumer is at-least-once (JetStream redelivery after
 *      ack_wait, max_deliver retries) and runs in its own queue group, so the
 *      same MessageSent can be delivered more than once; the SETNX claim
 *      makes re-entry structurally impossible. A durable DB marker is
 *      unnecessary: the claim only needs to outlive the redelivery window,
 *      and the trigger is best-effort by design (a lost trigger loses one AI
 *      reply, never a user message). Redis errors SKIP the trigger
 *      (fail-closed for AI) rather than retry-spamming.
 *   3. Channel in-flight lock: Redis SETNX msg:ai-inflight:{channelId} TTL
 *      60s. Two near-simultaneous messages in one channel must NOT run two
 *      parallel AI turns (interleaved replies + double token spend). A
 *      skipped message is correct: the in-flight turn's context fetch
 *      happens after persist, and the user can re-ask; released explicitly
 *      on completion, TTL is the crash safety net.
 *   4. Channel daily ceiling: Redis INCR msg:ai-daily:{tenantId}:{channelId}:{yyyyMMdd}
 *      TTL 25h vs MESSAGING_AI_CHANNEL_DAILY_LIMIT (default 50). Above the
 *      cap the channel gets ONE throttled system notice per UTC day and no
 *      AI call. (ai-service separately enforces 60 req/h/tenant + the
 *      monthly token budget — this is the messaging-side per-channel
 *      ceiling.)
 *
 * DB ACCESS: this handler runs from a JetStream consumer — NO HTTP request,
 * NO tenant middleware. Per the Faz 1 RLS lesson (DEPLOY-FAZ1 §3), every DB
 * read below is tenant-pinned through runInTenantRead (search_path +
 * app.current_tenant GUC + explicit tenantId predicate).
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { IEventBus, IEventHandler } from '@platform/event-bus';
import { MessageSentEvent } from '@platform/event-contracts';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import { Channel, ChannelType } from '../channel/entities/channel.entity';
import { Message } from '../message/entities/message.entity';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { AI_USER_ID } from '../shared/ai-user';
import { AiTriggerConfig } from './ai-trigger.config';
import { AnalyzeMessageCommand } from './commands/analyze-message.command';
import { AiChatBridgeService } from './services/ai-chat-bridge.service';

/** Idempotency claim TTL — comfortably outlives JetStream max_deliver retries. */
const TRIGGER_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** In-flight lock TTL — matches the bridge's 60s AI NATS timeout; crash net. */
const CHANNEL_INFLIGHT_TTL_SECONDS = 60;

/** Daily counter TTL — 25h survives the UTC rollover edge. */
const DAILY_COUNTER_TTL_SECONDS = 25 * 60 * 60;

/** SEC-M17-pattern UUID guard — NATS payloads are a trust boundary. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class AiTriggerNatsHandler implements OnModuleInit, IEventHandler<MessageSentEvent> {
  private readonly logger = new Logger(AiTriggerNatsHandler.name);

  constructor(
    private readonly triggerConfig: AiTriggerConfig,
    private readonly commandBus: CommandBus,
    private readonly bridge: AiChatBridgeService,
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.triggerConfig.triggerEnabled) {
      // Single line at DEBUG — the AiTriggerConfig.onModuleInit startup note
      // already explains the WHY and the env to flip. No subscription is
      // created while disabled: no durable consumer, no message consumption.
      this.logger.debug('AI trigger consumer NOT subscribed (kill-switch off)');
      return;
    }
    await this.eventBus.subscribeWildcard('MessageSent', this);
    this.logger.log('Subscribed to durable MessageSent fan-out for AI triggering');
  }

  getEventType(): string {
    return 'MessageSent';
  }

  async handle(event: MessageSentEvent): Promise<void> {
    // Gate 0 — kill-switch (defensive; the subscription only exists when ON,
    // this also covers a config object captured before a toggle).
    if (!this.triggerConfig.triggerEnabled) return;

    // Gate 1 — never react to the AI service's own output. Contract flag
    // first (2.0), senderId identity second: either is sufficient, both are
    // checked so a legacy publisher omitting the flag cannot cause a
    // self-sustaining AI feedback loop.
    if (event.isAiResponse === true || event.senderId === AI_USER_ID) {
      return;
    }

    const { tenantId, channelId, messageId } = event;

    // Trust boundary: shape-validate before any DB/Redis use (SEC-M17
    // pattern — a compromised-container payload must not reach SQL or key
    // interpolation).
    if (!UUID_REGEX.test(tenantId) || !UUID_REGEX.test(channelId) || !UUID_REGEX.test(messageId)) {
      this.logger.warn(
        `AI trigger dropped a MessageSent with malformed ids (tenant=${String(tenantId).slice(0, 12)}…)`,
      );
      return;
    }

    // Gate 2 — at-most-once trigger per message.
    const claimed = await this.claimTrigger(tenantId, messageId);
    if (!claimed) {
      this.logger.debug(`AI trigger already claimed for message ${messageId}`);
      return;
    }

    // Tenant-pinned channel + message read (Faz 1 RLS lesson: JetStream
    // context has no request middleware — runInTenantRead pins search_path
    // AND the RLS GUC; the explicit tenantId predicates are the second
    // defense layer).
    const context = await runInTenantRead(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        const channel = await queryRunner.manager.findOne(Channel, {
          where: { tenantId, id: channelId },
          select: ['id', 'tenantId', 'type', 'aiPersona'],
        });
        if (!channel || channel.type !== ChannelType.AI) {
          return null;
        }
        const message = await queryRunner.manager.findOne(Message, {
          where: { tenantId, id: messageId, channelId, isDeleted: false },
          select: ['id', 'tenantId', 'channelId', 'senderId', 'content', 'createdAt'],
        });
        if (!message || !message.content || message.content.trim() === '') {
          return null;
        }
        return {
          senderId: message.senderId,
          content: message.content,
          messageCreatedAt: message.createdAt,
        };
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI trigger tenant read failed for ${messageId}: ${msg}`);
      return null;
    });

    if (!context) {
      // Non-AI channel, deleted/empty message, or a transient read fault —
      // none warrant a retry loop; the human message itself is untouched.
      return;
    }

    // Gate 4 — per-channel daily ceiling BEFORE spending the in-flight slot
    // or the ai-service budget.
    const dayKey = utcDayKey();
    const daily = await this.incrementDailyCounter(tenantId, channelId, dayKey);
    if (!daily.counterOk) {
      // Counter fault ≠ over-limit: fail closed (no AI turn) but do NOT show
      // the user a false "daily limit reached" notice.
      return;
    }
    if (!daily.allowed) {
      await this.bridge.persistThrottledNotice(
        tenantId,
        channelId,
        this.triggerConfig.channelDailyLimit,
        dayKey,
      );
      this.logger.warn(
        `AI daily ceiling hit for channel ${channelId} (limit ${this.triggerConfig.channelDailyLimit}, count ${daily.count})`,
      );
      return;
    }

    // Gate 3 — one AI turn per channel at a time.
    const lockAcquired = await this.acquireChannelLock(channelId);
    if (!lockAcquired) {
      this.logger.debug(
        `AI turn already in flight for channel ${channelId} — skipping trigger for ${messageId}`,
      );
      return;
    }

    try {
      await this.commandBus.execute(
        new AnalyzeMessageCommand(
          tenantId,
          channelId,
          messageId,
          context.messageCreatedAt,
          context.senderId,
          context.content,
        ),
      );
    } finally {
      // Release the slot for the next message; the TTL covers a crash
      // between acquire and release.
      await this.safeReleaseChannelLock(channelId);
    }
  }

  // ── Redis guards ─────────────────────────────────────────────────────────

  /**
   * At-most-once claim. Redis ERRORS return false (skip the trigger):
   * fail-closed for AI — better one missing AI reply than an unbounded
   * retry storm against the AI budget.
   */
  private async claimTrigger(tenantId: string, messageId: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `msg:ai-trigger:${tenantId}:${messageId}`,
        'claimed',
        'EX',
        TRIGGER_IDEMPOTENCY_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI trigger idempotency claim failed (${msg}) — skipping`);
      return false;
    }
  }

  private async acquireChannelLock(channelId: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `msg:ai-inflight:${channelId}`,
        'inflight',
        'EX',
        CHANNEL_INFLIGHT_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI channel lock acquire failed (${msg}) — skipping`);
      return false;
    }
  }

  private async safeReleaseChannelLock(channelId: string): Promise<void> {
    try {
      await this.redis.del(`msg:ai-inflight:${channelId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI channel lock release failed (${msg}) — TTL will expire it`);
    }
  }

  /**
   * INCR the per-channel daily counter (initialising the TTL on the first
   * increment of the day). Allowed while count <= limit. `counterOk: false`
   * means the counter itself failed — callers skip the turn WITHOUT the
   * limit notice (a Redis fault is not a quota verdict).
   */
  private async incrementDailyCounter(
    tenantId: string,
    channelId: string,
    dayKey: string,
  ): Promise<{ counterOk: boolean; allowed: boolean; count: number }> {
    const key = `msg:ai-daily:${tenantId}:${channelId}:${dayKey}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, DAILY_COUNTER_TTL_SECONDS);
      }
      return { counterOk: true, allowed: count <= this.triggerConfig.channelDailyLimit, count };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI daily counter failed (${msg}) — skipping (fail closed)`);
      return { counterOk: false, allowed: false, count: 0 };
    }
  }
}

/** UTC yyyyMMdd bucket for the daily ceiling. */
function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}
