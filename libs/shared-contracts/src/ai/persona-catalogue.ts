/**
 * AI persona catalogue — single source of truth for WHICH personas exist and
 * how they are presented and authorized.
 *
 * Consumed by ai-service (composes the runtime persona from tier × specialty
 * and asserts at boot that every catalogue id composes), messaging-service
 * (`availableAiPersonas`, channel-creation validation), the gateway (persona
 * validation on the AI socket) and the web/mobile pickers. It replaces four
 * hand-maintained copies that had already drifted in names and capability
 * labels.
 *
 * What is deliberately NOT here: system prompts and tool bundles. Those are
 * backend-only and live next to the agent runner in ai-service.
 *
 * Zero-dependency by design (see index.ts).
 */

import {
  AI_PERSONA_TIERS,
  AI_SPECIALTY_IDS,
  formatAiPersonaId,
  type AiPersonaTier,
  type AiSpecialtyId,
} from './persona-id';

/** Icon vocabulary the pickers know how to render (Lucide names). */
export const AI_PERSONA_ICONS = Object.freeze([
  'bot',
  'droplets',
  'fish',
  'bar-chart',
  'cpu',
  'heart-pulse',
  'wrench',
] as const);
export type AiPersonaIcon = (typeof AI_PERSONA_ICONS)[number];

/** Colour vocabulary the pickers map onto theme tokens. */
export const AI_PERSONA_COLORS = Object.freeze([
  'purple',
  'cyan',
  'blue',
  'green',
  'orange',
] as const);
export type AiPersonaColor = (typeof AI_PERSONA_COLORS)[number];

/** Tenant modules a specialty can require. */
export type AiSpecialtyModule = 'farm';

/** The surface capability every AI caller needs before any persona applies. */
export const AI_ASSISTANT_USE_CAPABILITY = 'ai_assistant:use';

export function aiPersonaTierCapability(tier: AiPersonaTier): `ai_personas:${AiPersonaTier}` {
  return `ai_personas:${tier}`;
}

export function aiSpecialtyCapability(
  module: AiSpecialtyModule,
): `ai_specialties:${AiSpecialtyModule}` {
  return `ai_specialties:${module}`;
}

/** Presentation that varies per tier (used by the `general` specialty only). */
interface AiTierPresentation {
  readonly label: string;
  readonly name: string;
  readonly description: string;
  readonly icon: AiPersonaIcon;
  readonly color: AiPersonaColor;
  readonly capabilities: readonly string[];
}

/**
 * Freeze a source definition and its arrays so a runtime mutation of the
 * source catalogues (not only the derived AI_PERSONA_CATALOGUE) is impossible.
 * Typed per definition so the literal icon/colour/tier unions are preserved.
 */
function freezeTier(definition: AiTierPresentation): AiTierPresentation {
  Object.freeze(definition.capabilities);
  return Object.freeze(definition);
}
function freezeSpecialty(definition: AiSpecialtyDefinition): AiSpecialtyDefinition {
  Object.freeze(definition.capabilities);
  Object.freeze(definition.publishedTiers);
  return Object.freeze(definition);
}

export const AI_TIER_PRESENTATION: Readonly<Record<AiPersonaTier, AiTierPresentation>> =
  Object.freeze({
    operator: freezeTier({
      label: 'Operator',
      name: 'Operations Assistant',
      description: 'Water quality readings, sensor values, safe ranges, alerts',
      icon: 'bot',
      color: 'purple',
      capabilities: [
        'Water quality parameters',
        'Sensor readings',
        'Ammonia/H2S/CO2 toxicity',
        'Carbonate chemistry',
      ],
    }),
    manager: freezeTier({
      label: 'Manager',
      name: 'Management Assistant',
      description: 'Analytics, reporting, risk assessment, data-driven insights',
      icon: 'bar-chart',
      color: 'green',
      capabilities: [
        'Report generation',
        'Biomass/SGR/FCR analytics',
        'Trend analysis',
        'Feed management',
        'Alert analysis',
      ],
    }),
    expert: freezeTier({
      label: 'Expert',
      name: 'Aquaculture Expert',
      description: 'Advanced water chemistry, dosing, growth analytics, risk',
      icon: 'fish',
      color: 'blue',
      capabilities: [
        'Growth analytics',
        'Feed optimization',
        'Reagent dosing',
        'Risk assessment',
        'Actuation (with confirmation)',
      ],
    }),
    supervisor: freezeTier({
      label: 'Supervisor',
      name: 'SCADA Supervisor',
      description: 'Automation, PLC control, autonomous monitoring within safety limits',
      icon: 'cpu',
      color: 'orange',
      capabilities: [
        'Autonomous monitoring',
        'Equipment actuation',
        'PLC control',
        'Safety limit enforcement',
        'Escalation management',
      ],
    }),
  });

export interface AiSpecialtyDefinition {
  readonly id: AiSpecialtyId;
  /** Display name; the general specialty defers to the tier presentation. */
  readonly name: string;
  readonly description: string;
  readonly icon: AiPersonaIcon;
  readonly color: AiPersonaColor;
  readonly capabilities: readonly string[];
  /** Tenant module the specialty needs; `null` = core. */
  readonly requiresModule: AiSpecialtyModule | null;
  /**
   * Tiers this specialty is published at. Farm specialists stop at `expert`:
   * the supervisor tier is the autonomous one, and farm experts only advise —
   * the user decides.
   */
  readonly publishedTiers: readonly AiPersonaTier[];
}

export const AI_SPECIALTY_CATALOGUE: Readonly<Record<AiSpecialtyId, AiSpecialtyDefinition>> =
  Object.freeze({
    general: freezeSpecialty({
      id: 'general',
      name: 'General',
      description: 'Ask anything about your aquaculture operations',
      icon: 'bot',
      color: 'purple',
      capabilities: ['General questions', 'Basic guidance', 'Platform help'],
      requiresModule: null,
      publishedTiers: AI_PERSONA_TIERS,
    }),
    'farm-water-health': freezeSpecialty({
      id: 'farm-water-health',
      name: 'Water & Fish Health Specialist',
      description:
        'Water chemistry, critical readings, disease events, treatments, welfare, harvest eligibility',
      icon: 'heart-pulse',
      color: 'cyan',
      capabilities: [
        'Water quality trends & thresholds',
        'Ammonia/H2S/CO2 toxicity',
        'Health events & treatments',
        'Lice counts & welfare',
        'Harvest eligibility (withdrawal)',
      ],
      requiresModule: 'farm',
      publishedTiers: ['operator', 'manager', 'expert'],
    }),
    'farm-production': freezeSpecialty({
      id: 'farm-production',
      name: 'Production Specialist',
      description:
        'Growth, FCR/SGR, feeding plans, harvest planning, biomass reports, production cost',
      icon: 'fish',
      color: 'blue',
      capabilities: [
        'Batch performance & growth',
        'Feeding plans & consumption',
        'Harvest plans & eligibility',
        'Biomass & regulatory reports',
        'Finance summaries',
      ],
      requiresModule: 'farm',
      publishedTiers: ['operator', 'manager', 'expert'],
    }),
    'farm-operations': freezeSpecialty({
      id: 'farm-operations',
      name: 'Farm Operations Specialist',
      description:
        "Today's tasks, overdue work orders, maintenance alerts, equipment, spare parts and stock",
      icon: 'wrench',
      color: 'orange',
      capabilities: [
        'Tasks & work orders',
        'Maintenance alerts',
        'Equipment & feeder calibration',
        'Spare parts & farm stock',
        'Task creation (with confirmation)',
      ],
      requiresModule: 'farm',
      publishedTiers: ['operator', 'manager', 'expert'],
    }),
  });

export interface AiPersonaCatalogueEntry {
  readonly id: string;
  readonly tier: AiPersonaTier;
  readonly specialty: AiSpecialtyId;
  readonly name: string;
  readonly description: string;
  readonly icon: AiPersonaIcon;
  readonly color: AiPersonaColor;
  readonly capabilities: readonly string[];
  /**
   * Every RBAC capability string the caller must hold to drive this persona:
   * `ai_personas:<tier>` plus `ai_specialties:<module>` when the specialty is
   * module-gated. `ai_assistant:use` is the surface gate and is checked by the
   * entry points, not per persona.
   */
  readonly requiredCapabilities: readonly string[];
}

function composeEntry(
  specialty: AiSpecialtyDefinition,
  tier: AiPersonaTier,
): AiPersonaCatalogueEntry {
  const tierPresentation = AI_TIER_PRESENTATION[tier];
  const isGeneral = specialty.id === 'general';
  const presentation = isGeneral ? tierPresentation : specialty;
  const requiredCapabilities: string[] = [aiPersonaTierCapability(tier)];
  if (specialty.requiresModule !== null) {
    requiredCapabilities.push(aiSpecialtyCapability(specialty.requiresModule));
  }
  return Object.freeze({
    id: formatAiPersonaId({ tier, specialty: specialty.id, version: 1 }),
    tier,
    specialty: specialty.id,
    name: `${presentation.name} (${isGeneral ? 'General' : tierPresentation.label})`,
    description: presentation.description,
    icon: presentation.icon,
    color: presentation.color,
    capabilities: Object.freeze([...presentation.capabilities]),
    requiredCapabilities: Object.freeze(requiredCapabilities),
  });
}

/**
 * Every published persona, derived (never hand-listed) as specialty ×
 * publishedTiers in catalogue order: the four general personas first, then
 * each farm specialist at operator / manager / expert.
 */
export const AI_PERSONA_CATALOGUE: readonly AiPersonaCatalogueEntry[] = Object.freeze(
  AI_SPECIALTY_IDS.flatMap((specialtyId) => {
    const specialty = AI_SPECIALTY_CATALOGUE[specialtyId];
    return specialty.publishedTiers.map((tier) => composeEntry(specialty, tier));
  }),
);

const CATALOGUE_BY_ID: ReadonlyMap<string, AiPersonaCatalogueEntry> = new Map(
  AI_PERSONA_CATALOGUE.map((entry) => [entry.id, entry]),
);

/** Catalogue lookup; `undefined` for any id that is not a published persona. */
export function findAiPersona(id: string): AiPersonaCatalogueEntry | undefined {
  return CATALOGUE_BY_ID.get(id);
}

/** The persona a caller gets when they do not name one (tenant default). */
export const DEFAULT_AI_PERSONA_ID = 'operator-v1';

/**
 * The messaging picker's "no persona pinned" entry: an AI channel created with
 * `aiPersona: null` is answered by the tenant's default persona.
 */
export const AI_GENERAL_ASSISTANT_PICKER_ENTRY = Object.freeze({
  id: null,
  name: 'General AI Assistant',
  description: AI_SPECIALTY_CATALOGUE.general.description,
  icon: AI_SPECIALTY_CATALOGUE.general.icon,
  color: AI_SPECIALTY_CATALOGUE.general.color,
  capabilities: Object.freeze([...AI_SPECIALTY_CATALOGUE.general.capabilities]),
} as const);
