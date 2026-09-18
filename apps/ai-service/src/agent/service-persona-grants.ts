/**
 * FARM-AI Sprint 1.2 — server-side service→persona grant map.
 *
 * Program principle #3: authority is NEVER taken from the payload. When a
 * calling service identifies itself on a ChatRequest (`serviceId`), whether
 * that service may drive the requested persona is decided HERE, in
 * ai-service, not by anything the payload claims. The map is the SSoT for
 * service-originated AI:
 *
 *   - messaging_service / gateway_api: user-chat surfaces — granted exactly
 *     the frozen catalogue personas (13). User-level entitlement still rides
 *     the caller-capability check; this map only bounds the ORIGIN.
 *   - farm_service: service-originated AI only — the action_watch narrative
 *     path (Faz 4). Granted narrator-v1 EXCLUSIVELY: a scanner must never
 *     escalate into a tooled persona, and no user path can reach the
 *     narrator even with every capability claimed.
 *
 * New service origins (routine orchestrator, Faz 5) get an explicit row in
 * the same commit as their caller — an unlisted serviceId is denied for
 * EVERY persona (fail-closed).
 */
import { AI_PERSONA_CATALOGUE } from '@aquaculture/shared-contracts';

/** Every id the frozen cross-stack catalogue publishes (user-chat personas). */
const CHAT_PERSONA_IDS: ReadonlySet<string> = new Set(
  AI_PERSONA_CATALOGUE.map((entry) => entry.id),
);

export const SERVICE_PERSONA_GRANTS: Readonly<Record<string, ReadonlySet<string>>> = {
  messaging_service: CHAT_PERSONA_IDS,
  gateway_api: CHAT_PERSONA_IDS,
  farm_service: new Set(['narrator-v1']),
};
