import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { OPERATOR_PERSONA } from './personas/operator';
import { MANAGER_PERSONA } from './personas/manager';
import { EXPERT_PERSONA } from './personas/expert';
import { SUPERVISOR_PERSONA } from './personas/supervisor';

export interface AgentPersona {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  defaultToolNames: string[];
  actuationPolicy: 'blocked' | 'confirm_required' | 'allowed';
  maxTokensPerTurn: number;
}

export interface ResolvedProfile {
  persona: AgentPersona;
  effectiveToolNames: string[];
  effectiveSystemPrompt: string;
  actuationPolicy: 'blocked' | 'confirm_required' | 'allowed';
}

const PERSONAS: Record<string, AgentPersona> = {
  'operator-v1': OPERATOR_PERSONA,
  'manager-v1': MANAGER_PERSONA,
  'expert-v1': EXPERT_PERSONA,
  'supervisor-v1': SUPERVISOR_PERSONA,
};

@Injectable()
export class AgentProfileService {
  private readonly logger = new Logger(AgentProfileService.name);

  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve effective profile:
   * Base Profile + tenant additions - tenant removals, filtered by module entitlements
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona =
      PERSONAS[personaId] ?? PERSONAS[config.baseProfileId] ?? OPERATOR_PERSONA;

    // Start with base tool names
    const toolNames = new Set(basePersona.defaultToolNames);

    // Add tenant additions
    for (const tool of config.additionalToolNames) {
      if (this.toolRegistry.hasTool(tool)) {
        toolNames.add(tool);
      }
    }

    // Remove tenant blocks
    for (const tool of config.blockedToolNames) {
      toolNames.delete(tool);
    }

    // Filter by what's actually registered
    const effectiveToolNames = Array.from(toolNames).filter((name) =>
      this.toolRegistry.hasTool(name),
    );

    // Build system prompt with tenant customization
    let systemPrompt = basePersona.systemPrompt;
    if (config.customSystemPrompt) {
      systemPrompt += `\n\n--- Tenant-Specific Instructions ---\n${config.customSystemPrompt}`;
    }

    // Resolve actuation policy (most restrictive wins)
    const actuationPolicy = this.resolveActuationPolicy(
      basePersona.actuationPolicy,
      config.actuationPolicy,
    );

    // FAZ0-BOOT-03: model resolution moved to config. Persona files carry the
    // platform default tier; AI_CHAT_MODEL_OVERRIDE pins one model fleet-wide
    // (ops escape hatch for model retirements without a redeploy). The
    // per-tenant chatModel override (TenantAgentConfig) lands with BYOK Faz 1
    // and will slot in between the two. Spread copy — PERSONAS entries are
    // shared module singletons and must never be mutated per request.
    const model =
      this.configService.get<string>('AI_CHAT_MODEL_OVERRIDE') ??
      basePersona.model;

    return {
      persona: { ...basePersona, model },
      effectiveToolNames,
      effectiveSystemPrompt: systemPrompt,
      actuationPolicy,
    };
  }

  getPersona(personaId: string): AgentPersona | undefined {
    return PERSONAS[personaId];
  }

  getAllPersonas(): AgentPersona[] {
    return Object.values(PERSONAS);
  }

  private resolveActuationPolicy(
    base: string,
    tenantOverride: string,
  ): 'blocked' | 'confirm_required' | 'allowed' {
    const priority = { blocked: 0, confirm_required: 1, allowed: 2 };
    const basePriority = priority[base as keyof typeof priority] ?? 1;
    const overridePriority =
      priority[tenantOverride as keyof typeof priority] ?? 1;
    // Most restrictive wins (lowest priority number)
    const entries = Object.entries(priority);
    const resolved = entries.find(
      ([, v]) => v === Math.min(basePriority, overridePriority),
    );
    return (resolved?.[0] ?? 'confirm_required') as
      | 'blocked'
      | 'confirm_required'
      | 'allowed';
  }
}
