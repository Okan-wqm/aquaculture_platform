import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { AgentRole } from '../tenant-config/agent-config.entity';
import { OPERATOR_PERSONA } from './personas/operator';
import { MANAGER_PERSONA } from './personas/manager';
import { EXPERT_PERSONA } from './personas/expert';
import { SUPERVISOR_PERSONA } from './personas/supervisor';

/**
 * Persona tiers ordered by capability/risk. supervisor can act autonomously
 * (actuationPolicy 'allowed'), so it is the most privileged tier.
 */
const TIER_RANK: Record<AgentRole, number> = {
  operator: 0,
  manager: 1,
  expert: 2,
  supervisor: 3,
};

/**
 * Ceiling: the highest persona tier a platform role may request. AISAFETY-MEDIUM-013:
 * a regular member (MODULE_USER) must never reach the autonomous supervisor
 * persona. Unknown/absent roles get the lowest ceiling (fail-closed).
 */
const ROLE_TIER_CEILING: Record<string, AgentRole> = {
  SUPER_ADMIN: 'supervisor',
  TENANT_ADMIN: 'supervisor',
  MODULE_MANAGER: 'expert',
  MODULE_USER: 'operator',
};

/** Thrown when a user requests a persona above their role/tenant entitlement. */
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
   * AISAFETY-MEDIUM-013: the resolved persona is authorized against the caller's
   * platform-role ceiling before anything else runs, so a user cannot escalate
   * into a higher-privilege persona (e.g. the autonomous supervisor) just by
   * naming it in the request. The additional per-tenant persona allowlist that
   * the audit row also mentioned is deferred to the tenant-configurable RBAC
   * phase (Faz 7, `ai.persona.<tier>` capability) — enforcing it here with the
   * ['operator']-only default while there is no admin write surface would brick
   * manager/expert/supervisor for every tenant (including admins). The role
   * ceiling is the actual escalation control and closes the finding's core.
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
    userRoles: string[],
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona =
      PERSONAS[personaId] ?? PERSONAS[config.baseProfileId] ?? OPERATOR_PERSONA;

    // AISAFETY-MEDIUM-013: authorize the persona tier against the caller's role
    // ceiling. Tier is derived from the RESOLVED persona (not the raw request
    // string), so the fallback path is authorized too. Fail-closed.
    this.assertPersonaPermitted(basePersona, userRoles);

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

  /** The highest persona tier the caller's roles permit (fail-closed default: operator). */
  private userTierCeiling(userRoles: string[]): AgentRole {
    let ceiling: AgentRole = 'operator';
    for (const role of userRoles) {
      const roleCeiling = ROLE_TIER_CEILING[role];
      if (roleCeiling && TIER_RANK[roleCeiling] > TIER_RANK[ceiling]) {
        ceiling = roleCeiling;
      }
    }
    return ceiling;
  }

  /**
   * AISAFETY-MEDIUM-013: fail-closed persona authorization against the caller's
   * role ceiling. A user cannot drive a persona above their role's tier. Throws
   * PersonaNotPermittedError otherwise. (The per-tenant persona allowlist moves
   * to Faz 7 RBAC — see resolveProfile.)
   */
  private assertPersonaPermitted(
    persona: AgentPersona,
    userRoles: string[],
  ): void {
    const tier = this.personaTier(persona);

    const ceiling = this.userTierCeiling(userRoles);
    if (TIER_RANK[tier] > TIER_RANK[ceiling]) {
      this.logger.warn(
        `Persona ${persona.id} (tier ${tier}) exceeds user role ceiling ${ceiling} for roles [${userRoles.join(', ')}]`,
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
