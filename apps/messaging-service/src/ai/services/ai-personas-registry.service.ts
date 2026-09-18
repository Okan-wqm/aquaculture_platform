/**
 * @module AiPersonasRegistryService
 * @description The messaging-side view of the AI persona catalogue.
 *
 * AISAFETY-MEDIUM-024: personas are no longer a local hard-coded list. The
 * single source of truth is `AI_PERSONA_CATALOGUE` in
 * `@aquaculture/shared-contracts` — the same catalogue ai-service composes
 * runtime personas from and authorizes against — so the picker can never show
 * a persona ai-service would reject, or drift in names and capability labels.
 *
 * `getAvailablePersonas(caller)` filters by the caller's tenant-RBAC
 * capabilities (`ai_personas:<tier>` ∧ `ai_specialties:<module>`, admins
 * bypass) exactly as ai-service will at chat time, and always prepends the
 * "no persona pinned" entry (an AI channel with `aiPersona: null` is answered
 * by the tenant's default persona). `listAll()` serves the platform-admin
 * inventory (`request.messaging.admin.getPersonas`), unfiltered.
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */
import { Injectable } from '@nestjs/common';
import {
  hasAllResourcePermissions,
  type ResourcePermissionUser,
} from '@aquaculture/backend-common/decorators';
import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
  type AiPersonaCatalogueEntry,
} from '@aquaculture/shared-contracts';

/**
 * Describes an AI persona available for chat channels (the wire shape of
 * `availableAiPersonas` and the admin inventory).
 */
export interface AiPersonaDefinition {
  /** Catalogue persona id. Null = the tenant's default persona. */
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

function toDefinition(entry: AiPersonaCatalogueEntry): AiPersonaDefinition {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    color: entry.color,
    capabilities: [...entry.capabilities],
  };
}

const PICKER_DEFAULT: AiPersonaDefinition = {
  id: AI_GENERAL_ASSISTANT_PICKER_ENTRY.id,
  name: AI_GENERAL_ASSISTANT_PICKER_ENTRY.name,
  description: AI_GENERAL_ASSISTANT_PICKER_ENTRY.description,
  icon: AI_GENERAL_ASSISTANT_PICKER_ENTRY.icon,
  color: AI_GENERAL_ASSISTANT_PICKER_ENTRY.color,
  capabilities: [...AI_GENERAL_ASSISTANT_PICKER_ENTRY.capabilities],
};

@Injectable()
export class AiPersonasRegistryService {
  /**
   * The personas THIS caller may pin on an AI channel: the tenant-default
   * entry plus every catalogue persona whose required capabilities the caller
   * holds (the same rule ai-service enforces per turn, so the picker and the
   * chat gate always agree).
   */
  getAvailablePersonas(caller: ResourcePermissionUser): AiPersonaDefinition[] {
    const permitted = AI_PERSONA_CATALOGUE.filter((entry) =>
      hasAllResourcePermissions(caller, entry.requiredCapabilities),
    );
    return [PICKER_DEFAULT, ...permitted.map(toDefinition)];
  }

  /** Every published persona (platform-admin inventory), unfiltered. */
  listAll(): AiPersonaDefinition[] {
    return [PICKER_DEFAULT, ...AI_PERSONA_CATALOGUE.map(toDefinition)];
  }
}
