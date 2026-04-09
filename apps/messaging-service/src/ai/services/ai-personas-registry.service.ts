/**
 * @module AiPersonasRegistryService
 * @description Registry of available AI personas for the messaging system.
 * Maintains a static list of default personas sourced from the ai-service
 * persona definitions, and provides tenant-scoped access control.
 *
 * Future: persona availability will be configurable per tenant via the admin API.
 * Custom personas backed by external MCP servers will be registerable here.
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */
import { Injectable, Logger } from '@nestjs/common';

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

/**
 * Default personas sourced from ai-service persona definitions.
 * Ordered by increasing capability / access level.
 */
const DEFAULT_PERSONAS: ReadonlyArray<AiPersonaDefinition> = [
  {
    id: null,
    name: 'General AI Assistant',
    description: 'Ask anything about your aquaculture operations',
    icon: 'bot',
    color: 'purple',
    capabilities: ['General questions', 'Basic guidance', 'Platform help'],
  },
  {
    id: 'operator-v1',
    name: 'Water Quality Specialist',
    description: 'Water chemistry, sensors, calibration, safe ranges',
    icon: 'droplets',
    color: 'cyan',
    capabilities: [
      'Water quality parameters',
      'Sensor readings',
      'Ammonia/H2S/CO2 toxicity',
      'Carbonate chemistry',
    ],
  },
  {
    id: 'expert-v1',
    name: 'Farm Expert',
    description: 'Tanks, batches, feeding, growth analytics, dosing',
    icon: 'fish',
    color: 'blue',
    capabilities: [
      'Growth analytics',
      'Feed optimization',
      'Reagent dosing',
      'Risk assessment',
      'Actuation (with confirmation)',
    ],
  },
  {
    id: 'manager-v1',
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
  },
  {
    id: 'supervisor-v1',
    name: 'SCADA AI',
    description: 'Automation, PLC control, autonomous monitoring (requires confirmation)',
    icon: 'cpu',
    color: 'orange',
    capabilities: [
      'Autonomous monitoring',
      'Equipment actuation',
      'PLC control',
      'Safety limit enforcement',
      'Escalation management',
    ],
  },
];

@Injectable()
export class AiPersonasRegistryService {
  private readonly logger = new Logger(AiPersonasRegistryService.name);

  /**
   * Get all AI personas available for a given tenant.
   * Currently returns the default set. Future: filter by tenant configuration.
   *
   * @param _tenantId - Tenant identifier (reserved for future per-tenant config)
   * @returns Array of available persona definitions
   */
  getAvailablePersonas(_tenantId: string): AiPersonaDefinition[] {
    return [...DEFAULT_PERSONAS];
  }

  /**
   * Get detailed information for a specific persona.
   *
   * @param personaId - Persona ID (null for general assistant)
   * @returns Persona definition or null if not found
   */
  getPersonaDetails(personaId: string | null): AiPersonaDefinition | null {
    return DEFAULT_PERSONAS.find((p) => p.id === personaId) ?? null;
  }

  /**
   * Check whether a persona is enabled for a given tenant.
   * Currently all default personas are enabled for all tenants.
   * Future: configurable via admin API per-tenant settings.
   *
   * @param _tenantId - Tenant identifier
   * @param personaId - Persona ID to check
   * @returns true if the persona is enabled for this tenant
   */
  isPersonaEnabled(_tenantId: string, personaId: string | null): boolean {
    const exists = DEFAULT_PERSONAS.some((p) => p.id === personaId);
    if (!exists) {
      this.logger.debug(`Persona "${personaId}" not found in registry`);
    }
    return exists;
  }

  /**
   * Get the system prompt for a persona by its name or ID.
   * Returns a description-based prompt suitable for instruction hierarchy wrapping.
   *
   * @param personaNameOrId - Persona display name or persona ID
   * @returns System prompt string
   */
  getPersonaSystemPrompt(personaNameOrId: string): string {
    const persona = DEFAULT_PERSONAS.find(
      (p) => p.id === personaNameOrId || p.name === personaNameOrId,
    );

    if (!persona) {
      return `You are an aquaculture AI assistant. Help users with their aquaculture operations. Provide accurate, safe, and helpful information.`;
    }

    const capabilitiesList = persona.capabilities.join(', ');
    return (
      `You are ${persona.name}. ${persona.description}. ` +
      `Your capabilities include: ${capabilitiesList}. ` +
      `Provide accurate, safe, and helpful information within your area of expertise.`
    );
  }
}
