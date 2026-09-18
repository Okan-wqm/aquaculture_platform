/**
 * FARM-AI PR-2 — composed persona catalogue service.
 *
 * Single resolution authority for personas: the 13 catalogue personas are
 * COMPOSED (tier × specialty) against the frozen shared-contracts catalogue;
 * narrator-v1 stays a hand-defined SERVICE persona (service-grant permission
 * model, not in the user catalogue).
 *
 * onApplicationBootstrap runs boot invariants — if any fails the process DOES
 * NOT BOOT. A persona whose bundle references an unregistered tool, whose
 * fragments smuggle chat-template delimiters, or whose derivation has drifted
 * from the cross-stack catalogue is a deployment error, not a runtime surprise.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AI_PERSONA_CATALOGUE, AI_PERSONA_ID_MAX_LENGTH } from '@aquaculture/shared-contracts';
import { UnknownPersonaError } from './agent-profile.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { NARRATOR_PERSONA } from './personas/narrator';
import { composeCatalogue, type ComposedPersona } from './personas/compose';
import { EXPERT_TIER, MANAGER_TIER, OPERATOR_TIER, SUPERVISOR_TIER } from './personas/tiers';
import {
  FARM_OPERATIONS_SPECIALTY,
  FARM_PRODUCTION_SPECIALTY,
  FARM_WATER_HEALTH_SPECIALTY,
  GENERAL_SPECIALTY,
} from './personas/specialties';

/**
 * Chat-template / instruction-hierarchy delimiters a prompt fragment must
 * never contain — a fragment carrying these could restructure the safety
 * wrapper around it (LLM01 prompt-injection class). Checked at BOOT, not at
 * request time: fragments are platform-authored constants.
 */
export const RESTRICTED_PROMPT_DELIMITERS: readonly string[] = [
  '<|im_start|>',
  '<|im_end|>',
  '[INST]',
  '[/INST]',
  '</system>',
  '<system>',
];

const TIERS = {
  operator: OPERATOR_TIER,
  manager: MANAGER_TIER,
  expert: EXPERT_TIER,
  supervisor: SUPERVISOR_TIER,
} as const;

const SPECIALTIES = {
  general: GENERAL_SPECIALTY,
  'farm-water-health': FARM_WATER_HEALTH_SPECIALTY,
  'farm-production': FARM_PRODUCTION_SPECIALTY,
  'farm-operations': FARM_OPERATIONS_SPECIALTY,
} as const;

@Injectable()
export class AgentPersonaCatalogueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentPersonaCatalogueService.name);
  private readonly composed: ReadonlyMap<string, ComposedPersona> = composeCatalogue(
    TIERS,
    SPECIALTIES,
  );

  constructor(private readonly toolRegistry: ToolRegistryService) {}

  /** Boot invariants — a violation aborts startup (fail-closed deployment). */
  onApplicationBootstrap(): void {
    // 1. Catalogue bijection: every catalogue id composes, nothing else does.
    const catalogueIds = new Set(AI_PERSONA_CATALOGUE.map((e) => e.id));
    if (this.composed.size !== catalogueIds.size || ![...catalogueIds].every((id) => this.composed.has(id))) {
      throw new Error(
        `Persona catalogue bijection broken: shared catalogue has ${catalogueIds.size} ids, composition produced ${this.composed.size}`,
      );
    }

    // 2. Every bundle tool name is registered (a dangling name would silently
    // narrow the persona at runtime instead of failing the deploy).
    for (const persona of this.composed.values()) {
      for (const tool of persona.defaultToolNames) {
        if (!this.toolRegistry.hasTool(tool)) {
          throw new Error(`Persona ${persona.id} bundles unregistered tool "${tool}"`);
        }
      }
    }

    // 3. No chat-template delimiters in any fragment (see constant docblock).
    const fragments = [
      ...Object.values(TIERS).map((t) => t.promptFragment),
      ...Object.values(SPECIALTIES).map((s) => s.promptFragment),
    ];
    for (const fragment of fragments) {
      for (const delimiter of RESTRICTED_PROMPT_DELIMITERS) {
        if (fragment.includes(delimiter)) {
          throw new Error(`Prompt fragment contains restricted delimiter "${delimiter}"`);
        }
      }
    }

    // 4. Sanity: ids respect the cross-stack length cap; farm personas require
    //    the farm module on their specialty AND their capability list.
    for (const persona of this.composed.values()) {
      if (persona.id.length > AI_PERSONA_ID_MAX_LENGTH) {
        throw new Error(`Persona id "${persona.id}" exceeds the grammar length cap`);
      }
      if (
        persona.specialty !== 'general' &&
        (!persona.requiredCapabilities.includes('ai_specialties:farm') ||
          SPECIALTIES[persona.specialty].requiresModule !== 'farm')
      ) {
        throw new Error(`Farm persona ${persona.id} lost its farm module/capability binding`);
      }
    }

    this.logger.log(`Persona catalogue composed: ${this.composed.size} entries + narrator-v1`);
  }

  /**
   * Resolve a persona id to its composed definition. Unknown id →
   * UnknownPersonaError (STRICT — no fallback; FARM-AI Sprint 1.2).
   */
  resolve(personaId: string): ComposedPersona {
    const persona = this.composed.get(personaId);
    if (!persona) {
      throw new UnknownPersonaError(personaId);
    }
    return persona;
  }

  /** The 13 user-facing catalogue personas (admin/listing parity). */
  list(): ComposedPersona[] {
    return [...this.composed.values()];
  }

  /** Service personas (service-grant permission model) — narrator today. */
  resolveServicePersona(personaId: string) {
    return NARRATOR_PERSONA.id === personaId ? NARRATOR_PERSONA : null;
  }
}
