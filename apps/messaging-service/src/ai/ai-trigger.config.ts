/**
 * @module AiTriggerConfig
 * @description MSGFIX-FAZ0 (2026-09-16) — AI kill-switch configuration for
 * messaging-service.
 *
 * Background: the messaging AI pipeline processes user message content. Until
 * the consent-gated trigger redesign lands (Faz 2), the trigger side must be
 * DISABLED BY DEFAULT. This config is the single point the Faz 2 trigger will
 * consult before enqueuing ANY AI analysis work.
 *
 * Flags (all strictly opt-in, default 'false'):
 *   - MESSAGING_AI_TRIGGER_ENABLED        — master kill-switch for the Faz 2
 *     trigger path (this module's `AiTriggerConfig.triggerEnabled`).
 *   - MESSAGING_AI_KNOWLEDGE_CRON_ENABLED — gates the hourly knowledge-
 *     extraction cron (consumed by knowledge-extraction.service.ts).
 *
 * REMOVED (MSGFIX-FAZ2 2.1): MESSAGING_AI_EMBEDDING_CRON_ENABLED — the
 * 5-minute embedding cron (embedding.service.ts) was deleted together with
 * the sentiment writer; the env var is inert now and the export below is
 * kept only so external env files referencing it keep parsing.
 *
 * Parsing is STRICT: only the exact (case-insensitive, whitespace-trimmed)
 * string 'true' enables a flag. Unset, empty, or any other value (including
 * '1', 'yes', 'TRUE ' variants beyond trim+case) means DISABLED — a typo'd
 * value must fail CLOSED, not open.
 *
 * NOTE (scope): the egress gate (ai-egress-gate.service.ts) is deliberately
 * NOT touched by this config — it already enforces per-user consent and stays
 * authoritative regardless of the trigger switch. Faz 2 wires the trigger to
 * `triggerEnabled`; this file only reads env and explains itself.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/** Env var names — exported for tests and for the cron gates to reuse. */
export const MESSAGING_AI_TRIGGER_ENABLED_ENV = 'MESSAGING_AI_TRIGGER_ENABLED';
export const MESSAGING_AI_EMBEDDING_CRON_ENABLED_ENV = 'MESSAGING_AI_EMBEDDING_CRON_ENABLED';
export const MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV = 'MESSAGING_AI_KNOWLEDGE_CRON_ENABLED';

/**
 * Strict boolean env parser shared by the trigger config and the cron gates.
 * Anything other than the exact string 'true' (after trim + lowercase) yields
 * the default — which is DISABLED everywhere it is used here.
 */
export function parseMessagingAiEnabledFlag(
  rawValue: string | undefined,
  defaultEnabled = false,
): boolean {
  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultEnabled;
  }
  return rawValue.trim().toLowerCase() === 'true';
}

/** Read a messaging AI flag from the current process env (strict parsing). */
export function messagingAiFlagEnabled(envName: string, defaultEnabled = false): boolean {
  return parseMessagingAiEnabledFlag(process.env[envName], defaultEnabled);
}

/**
 * MSGFIX-FAZ2 2.2: read a positive-integer messaging AI setting from env.
 * Unset/invalid/non-numeric values yield the default; values are clamped to
 * [1, max] so a typo'd env cannot disable a safety cap (limit=0) or blow it
 * to infinity.
 */
export function messagingAiIntSetting(envName: string, defaultValue: number, max: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, 1), max);
}

/** Per-channel daily AI response cap env (messaging-side; ai-service separately enforces 60 req/h/tenant + token budget). */
export const MESSAGING_AI_CHANNEL_DAILY_LIMIT_ENV = 'MESSAGING_AI_CHANNEL_DAILY_LIMIT';
/** Character budget for consent-filtered context history sent to ai-service. */
export const MESSAGING_AI_CONTEXT_CHAR_BUDGET_ENV = 'MESSAGING_AI_CONTEXT_CHAR_BUDGET';

/** Default: at most 50 AI responses per channel per day (messaging-side ceiling). */
export const DEFAULT_AI_CHANNEL_DAILY_LIMIT = 50;
/** Default: at most 24k characters of context history per AI request. */
export const DEFAULT_AI_CONTEXT_CHAR_BUDGET = 24_000;

@Injectable()
export class AiTriggerConfig implements OnModuleInit {
  private readonly logger = new Logger(AiTriggerConfig.name);

  /** Master kill-switch for the (Faz 2) AI trigger path. Default: OFF. */
  readonly triggerEnabled: boolean;

  /**
   * Faz 2 trigger side-guard: max AI responses per (tenant, channel) per
   * UTC day. Counts only trigger attempts that pass the earlier gates, and
   * is enforced BEFORE the NATS round-trip so a chatty channel cannot burn
   * the tenant's ai-service request/token budget.
   */
  readonly channelDailyLimit: number;

  /**
   * Faz 2 bridge memory guard: total character budget for the
   * consent-filtered context history shipped with each AI chat request.
   */
  readonly contextCharBudget: number;

  constructor() {
    this.triggerEnabled = messagingAiFlagEnabled(MESSAGING_AI_TRIGGER_ENABLED_ENV);
    this.channelDailyLimit = messagingAiIntSetting(
      MESSAGING_AI_CHANNEL_DAILY_LIMIT_ENV,
      DEFAULT_AI_CHANNEL_DAILY_LIMIT,
      10_000,
    );
    this.contextCharBudget = messagingAiIntSetting(
      MESSAGING_AI_CONTEXT_CHAR_BUDGET_ENV,
      DEFAULT_AI_CONTEXT_CHAR_BUDGET,
      200_000,
    );
  }

  onModuleInit(): void {
    // One startup line, only when the switch is OFF (the expected state until
    // Faz 2 re-enables it deliberately). Says WHY, so an operator finding a
    // silent AI feature knows exactly which env to flip.
    if (!this.triggerEnabled) {
      const raw = process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV];
      const reason = raw === undefined ? 'env unset' : `env value "${raw}" != "true"`;
      this.logger.log(
        `Messaging AI trigger DISABLED by config (${reason}; set ${MESSAGING_AI_TRIGGER_ENABLED_ENV}='true' to enable).`,
      );
    }
  }
}
