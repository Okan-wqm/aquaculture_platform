import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  hasResourcePermission,
  type ResourcePermissionUser,
} from '@aquaculture/backend-common/decorators';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { AgentRole } from '../tenant-config/agent-config.entity';
import { OPERATOR_PERSONA } from './personas/operator';
import { MANAGER_PERSONA } from './personas/manager';
import { EXPERT_PERSONA } from './personas/expert';
import { SUPERVISOR_PERSONA } from './personas/supervisor';

/** Thrown when a user requests a persona above their tenant-RBAC entitlement. */
export class PersonaNotPermittedError extends ForbiddenException {
  constructor(personaId: string) {
    super(`Persona "${personaId}" is not permitted for this user`);
  }
}

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
   * Base Profile + tenant additions - tenant removals, filtered by module entitlements.
   *
   * AISAFETY-MEDIUM-013 / Faz 7c: the resolved persona is authorized against the
   * caller's tenant-RBAC capabilities (`ai_personas:<tier>`) before anything else
   * runs, so a user cannot escalate into a higher-privilege persona (e.g. the
   * autonomous supervisor) just by naming it. This replaces the earlier fixed
   * platform-role ceiling with the tenant-configurable capability model: the
   * tenant admin decides which role may drive which persona tier (seeded defaults
   * grant operator to all, higher tiers to senior roles; supervisor stays
   * admin-only). Admins bypass. Fail-closed.
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
    caller: ResourcePermissionUser,
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona =
      PERSONAS[personaId] ?? PERSONAS[config.baseProfileId] ?? OPERATOR_PERSONA;

    // Authorize the persona tier against the caller's capabilities. Tier is
    // derived from the RESOLVED persona (not the raw request string), so the
    // fallback path is authorized too. Fail-closed.
    this.assertPersonaPermitted(basePersona, caller);

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

    // Model resolution precedence (highest wins):
    //   1. AI_CHAT_MODEL_OVERRIDE — ops fleet-wide escape hatch for a model
    //      retirement, applied without a redeploy or any tenant edit.
    //   2. config.chatModel       — the tenant's own per-tenant override (set
    //      via the BYOK settings CRUD; runs on the tenant's own key/bill).
    //   3. basePersona.model      — the platform default for the persona tier.
    // Spread copy below — PERSONAS entries are shared module singletons and must
    // never be mutated per request.
    const model =
      this.configService.get<string>('AI_CHAT_MODEL_OVERRIDE') ??
      (config.chatModel?.trim() || null) ??
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

  /**
   * The capability tier of a persona, derived from its id prefix
   * ('supervisor-v1' → 'supervisor'). An UNKNOWN prefix maps to the HIGHEST tier
   * (supervisor) so a mis-named / future persona is treated as maximally
   * privileged and thus reachable only by the highest role — fail-safe, never
   * silently broadly-accessible.
   */
  private personaTier(persona: AgentPersona): AgentRole {
    const prefix = persona.id.split('-')[0];
    return prefix === 'operator' ||
      prefix === 'manager' ||
      prefix === 'expert' ||
      prefix === 'supervisor'
      ? prefix
      : 'supervisor';
  }

  /**
   * AISAFETY-MEDIUM-013 / Faz 7c: fail-closed persona authorization against the
   * caller's tenant-RBAC capability `ai_personas:<tier>`. A user cannot drive a
   * persona tier they were not granted. Admins bypass (via the shared SSoT
   * check). Throws PersonaNotPermittedError otherwise.
   */
  private assertPersonaPermitted(
    persona: AgentPersona,
    caller: ResourcePermissionUser,
  ): void {
    const tier = this.personaTier(persona);

    if (!hasResourcePermission(caller, `ai_personas:${tier}`)) {
      this.logger.warn(
        `Persona ${persona.id} (tier ${tier}) not permitted — caller lacks ai_personas:${tier}`,
      );
      throw new PersonaNotPermittedError(persona.id);
    }
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
