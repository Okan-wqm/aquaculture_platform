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
 *   - MESSAGING_AI_EMBEDDING_CRON_ENABLED — gates the 5-minute embedding cron
 *     (consumed by embedding.service.ts).
 *   - MESSAGING_AI_KNOWLEDGE_CRON_ENABLED — gates the hourly knowledge-
 *     extraction cron (consumed by knowledge-extraction.service.ts).
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

@Injectable()
export class AiTriggerConfig implements OnModuleInit {
  private readonly logger = new Logger(AiTriggerConfig.name);

  /** Master kill-switch for the (Faz 2) AI trigger path. Default: OFF. */
  readonly triggerEnabled: boolean;

  constructor() {
    this.triggerEnabled = messagingAiFlagEnabled(MESSAGING_AI_TRIGGER_ENABLED_ENV);
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
