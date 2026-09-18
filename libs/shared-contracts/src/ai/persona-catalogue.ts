/**
 * AI specialty + persona catalogue — FARM-AI PR-0 (Sprint 1.1).
 *
 * The cross-stack (backend trust boundary + aquamobil standalone bundle)
 * single source of truth for WHICH personas exist and WHICH resource
 * permissions each one requires. Everything here is display/authorization
 * metadata only — system prompts and tool names are backend-owned
 * (ai-service personas/, PR-2) and deliberately do NOT live here.
 *
 * Composition rule (frozen, derived): general × 4 tiers + 3 farm
 * specialties × {operator, manager, expert} = 13 entries. Farm specialties
 * are never published at supervisor tier (supervisory actuation stays
 * general-purpose; a "supervisor-farm-*" persona does not exist).
 *
 * ZERO imports except the grammar module. `as const` — never `enum`
 * (ORPHAN-087 invariant).
 */
import { AI_PERSONA_TIERS, formatAiPersonaId, type AiPersonaTier, type AiSpecialtyId } from './persona-id';

export interface AiSpecialtyDefinition {
  id: AiSpecialtyId;
  name: string;
  description: string;
  /** Lucide icon name for frontend rendering. */
  icon: string;
  /** Theme color key for UI styling. */
  color: string;
  /** Human-readable capability labels (display only — not permissions). */
  capabilities: readonly string[];
  /** Tenant module entitlement the specialty needs, or null for none. */
  requiresModule: 'farm' | null;
  /** Tiers this specialty is published at (drives catalogue derivation). */
  publishedTiers: readonly AiPersonaTier[];
}

export const AI_SPECIALTY_CATALOGUE: readonly AiSpecialtyDefinition[] = [
  {
    id: 'general',
    name: 'General Assistant',
    description: 'Ask anything about your aquaculture operations',
    icon: 'bot',
    color: 'purple',
    capabilities: ['General questions', 'Basic guidance', 'Platform help'],
    requiresModule: null,
    publishedTiers: AI_PERSONA_TIERS,
  },
  {
    id: 'farm-water-health',
    name: 'Water & Health',
    description: 'Water chemistry, fish health, sensor readings, calibration, safe ranges',
    icon: 'droplets',
    color: 'cyan',
    capabilities: [
      'Water quality parameters',
      'Health events and treatments',
      'Sensor readings',
      'Ammonia/H2S/CO2 toxicity',
      'Carbonate chemistry',
    ],
    requiresModule: 'farm',
    publishedTiers: ['operator', 'manager', 'expert'],
  },
  {
    id: 'farm-production',
    name: 'Production',
    description: 'Tanks, batches, feeding, growth analytics, dosing',
    icon: 'fish',
    color: 'blue',
    capabilities: [
      'Growth analytics',
      'Feed optimization',
      'Reagent dosing',
      'Biomass/SGR/FCR analytics',
      'Risk assessment',
    ],
    requiresModule: 'farm',
    publishedTiers: ['operator', 'manager', 'expert'],
  },
  {
    id: 'farm-operations',
    name: 'Operations',
    description: 'Tasks, work orders, maintenance, stock, alert triage',
    icon: 'clipboard-list',
    color: 'green',
    capabilities: [
      'Task and work-order tracking',
      'Maintenance scheduling',
      'Stock inventory',
      'Alert analysis',
      'Escalation support',
    ],
    requiresModule: 'farm',
    publishedTiers: ['operator', 'manager', 'expert'],
  },
];

/** Display label per tier (catalogue names are English, like the legacy registry). */
export const AI_PERSONA_TIER_LABELS: Readonly<Record<AiPersonaTier, string>> = {
  operator: 'Operator',
  manager: 'Manager',
  expert: 'Expert',
  supervisor: 'Supervisor',
};

export interface AiPersonaCatalogueEntry {
  /** Canonical persona id (`<tier>[-<specialty>]-v<version>`). */
  id: string;
  tier: AiPersonaTier;
  specialty: AiSpecialtyId;
  /** `${specialty.name} (${tierLabel})` */
  name: string;
  description: string;
  icon: string;
  color: string;
  capabilities: readonly string[];
  /**
   * Resource permissions required to USE this persona (all-of). Farm
   * specialties additionally require the `ai_specialties:farm` capability,
   * which itself is all-of modules ['ai','farm'] (PR-1).
   */
  requiredCapabilities: readonly string[];
}

function buildCatalogue(): readonly AiPersonaCatalogueEntry[] {
  const entries: AiPersonaCatalogueEntry[] = [];
  for (const specialty of AI_SPECIALTY_CATALOGUE) {
    for (const tier of specialty.publishedTiers) {
      const id = formatAiPersonaId({ tier, specialty: specialty.id, version: 1 });
      entries.push({
        id,
        tier,
        specialty: specialty.id,
        name: `${specialty.name} (${AI_PERSONA_TIER_LABELS[tier]})`,
        description: specialty.description,
        icon: specialty.icon,
        color: specialty.color,
        capabilities: specialty.capabilities,
        requiredCapabilities:
          specialty.requiresModule === 'farm'
            ? [`ai_personas:${tier}`, 'ai_specialties:farm']
            : [`ai_personas:${tier}`],
      });
    }
  }
  return Object.freeze(entries.map((e) => Object.freeze(e)));
}

/** Frozen derived catalogue: 4 general + 3×3 farm = 13 entries. */
export const AI_PERSONA_CATALOGUE: readonly AiPersonaCatalogueEntry[] = buildCatalogue();

/** Default persona when a caller/topic does not pick one explicitly. */
export const DEFAULT_AI_PERSONA_ID = 'operator-v1';

/**
 * The `id: null` "tenant default" picker entry messaging has always shown
 * first (legacy 'General AI Assistant'). Null means "no specific persona" —
 * the tenant default applies. Its requiredCapabilities mirror the default
 * persona (operator tier) so pickers filtering by permission keep it
 * available exactly when the default persona is usable.
 */
export const AI_GENERAL_ASSISTANT_PICKER_ENTRY: Readonly<{
  id: null;
  name: string;
  description: string;
  icon: string;
  color: string;
  capabilities: readonly string[];
  requiredCapabilities: readonly string[];
}> = Object.freeze({
  id: null,
  name: 'General AI Assistant',
  description: 'Ask anything about your aquaculture operations',
  icon: 'bot',
  color: 'purple',
  capabilities: ['General questions', 'Basic guidance', 'Platform help'],
  requiredCapabilities: Object.freeze(['ai_personas:operator']),
});

/** Look up a catalogue entry by canonical persona id. Null = unknown. */
export function findAiPersona(id: string): AiPersonaCatalogueEntry | null {
  return AI_PERSONA_CATALOGUE.find((e) => e.id === id) ?? null;
}
