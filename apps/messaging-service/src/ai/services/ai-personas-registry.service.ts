/**
 * @module AiPersonasRegistryService
 * @description Registry of available AI personas for the messaging system.
 *
 * FARM-AI (Sprint 2.3 registry slice): the listing is now SOURCED from the
 * frozen cross-stack persona catalogue in @aquaculture/shared-contracts —
 * the same SSoT the ai-service composes personas from and the channel
 * validator validates against. The hand-written DEFAULT_PERSONAS list (4
 * legacy ids) and the unused prompt/details lookups are gone: the display
 * shape (id/name/description/icon/color/capabilities) is unchanged so the
 * GraphQL schema, the admin panel page and aquamobil keep working — they
 * simply see the full 13-entry catalogue + the id:null tenant-default entry.
 *
 * NOTE (server-side permission filter): this listing is NOT yet filtered by
 * the caller's capabilities — that lands with the persona-picker UI work
 * (PR-6), which threads @CurrentUser caps through the resolver. Chat-time
 * enforcement already exists ai-service-side (tier capability ALL-OF the
 * persona's requiredCapabilities + the service→persona grant map).
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */
import { Injectable } from '@nestjs/common';
import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
} from '@aquaculture/shared-contracts';

/**
 * Describes an AI persona available for chat channels.
 */
export interface AiPersonaDefinition {
  /** Persona ID matching ai-service persona IDs. Null = general AI assistant. */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Short description of what the persona specializes in. */
  description: string;
  /** Icon identifier for frontend rendering (Lucide icon name). */
  icon: string;
  /** Theme color key for UI styling. */
  color: string;
  /** List of capability labels describing what the persona can do. */
  capabilities: string[];
}

/** The frozen catalogue projected onto the wire shape, plus the null default entry. */
const LISTED_PERSONAS: ReadonlyArray<AiPersonaDefinition> = Object.freeze([
  {
    id: AI_GENERAL_ASSISTANT_PICKER_ENTRY.id,
    name: AI_GENERAL_ASSISTANT_PICKER_ENTRY.name,
    description: AI_GENERAL_ASSISTANT_PICKER_ENTRY.description,
    icon: AI_GENERAL_ASSISTANT_PICKER_ENTRY.icon,
    color: AI_GENERAL_ASSISTANT_PICKER_ENTRY.color,
    capabilities: [...AI_GENERAL_ASSISTANT_PICKER_ENTRY.capabilities],
  },
  ...AI_PERSONA_CATALOGUE.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    color: entry.color,
    capabilities: [...entry.capabilities],
  })),
]);

@Injectable()
export class AiPersonasRegistryService {
  /**
   * Get all AI personas available for a given tenant: the id:null
   * "tenant default" entry first, then the frozen 13-entry catalogue.
   *
   * @param _tenantId - Tenant identifier (reserved: per-tenant availability
   *                    rides the PR-6 server-side permission filter)
   */
  getAvailablePersonas(_tenantId: string): AiPersonaDefinition[] {
    // Deep-enough copy: the capabilities ARRAY must not be a shared reference,
    // or one caller's sort/mutate leaks into every later listing.
    return LISTED_PERSONAS.map((persona) => ({ ...persona, capabilities: [...persona.capabilities] }));
  }
}
