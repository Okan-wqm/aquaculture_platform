import { ForbiddenException, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  hasResourcePermission,
  type ResourcePermissionUser,
} from '@aquaculture/backend-common/decorators';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { AgentRole } from '../tenant-config/agent-config.entity';
import { SERVICE_PERSONA_GRANTS } from './service-persona-grants';
import { OPERATOR_PERSONA } from './personas/operator';
import { MANAGER_PERSONA } from './personas/manager';
import { EXPERT_PERSONA } from './personas/expert';
import { SUPERVISOR_PERSONA } from './personas/supervisor';
import { NARRATOR_PERSONA } from './personas/narrator';
import { ZAI_DEFAULT_MODEL } from './providers/zai.provider';

/** Thrown when a user requests a persona above their tenant-RBAC entitlement. */
export class PersonaNotPermittedError extends ForbiddenException {
  constructor(personaId: string) {
    super(`Persona "${personaId}" is not permitted for this user`);
  }
}

/**
 * FARM-AI Sprint 1.2: thrown when a requested persona id is not in the
 * ai-service persona set. Replaces the silent fallback chain
 * (persona → config.baseProfileId → OPERATOR) — an unknown id used to resolve
 * to whatever the tenant's base profile was, hiding caller bugs and letting
 * personaTier() map an unknown prefix to the supervisor tier.
 */
export class UnknownPersonaError extends BadRequestException {
  constructor(personaId: string) {
    super(`Unknown AI persona "${personaId}"`);
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
  /**
   * FARM-AI Sprint 1.2 (persona-tool-ceiling): may the tenant's
   * additionalToolNames expand this persona's toolset? Service-facing
   * personas (narrator) set false — their tool ceiling is part of the
   * platform contract, not tenant configuration.
   */
  allowAdditionalTools: boolean;
  /**
   * FARM-AI Sprint 1.2: who may drive this persona.
   * - 'user-tier'    — user chat; authorized by the caller's
   *                    `ai_personas:<tier>` tenant-RBAC capability.
   * - 'service-grant'— platform service paths only (e.g. action_watch
   *                    narratives); authorized EXCLUSIVELY by the
   *                    server-side service→persona grant map. No user
   *                    capability can reach these personas.
   */
  permissionModel: 'user-tier' | 'service-grant';
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
  'narrator-v1': NARRATOR_PERSONA,
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
   * autonomous supervisor) just by naming it. Admins bypass. Fail-closed.
   *
   * FARM-AI Sprint 1.2 — two hardening changes:
   * 1. STRICT resolution: an unknown persona id throws UnknownPersonaError.
   *    The old chain (persona → config.baseProfileId → OPERATOR) silently
   *    reinterpreted unknown ids as the tenant's base profile.
   * 2. Server-side service→persona grants (serviceId in opts): authority is
   *    NEVER taken from payload claims — a declared calling service must be
   *    granted the persona by SERVICE_PERSONA_GRANTS, and service-grant
   *    personas (narrator) are reachable ONLY through that map, regardless
   *    of what capabilities the payload claims.
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
    caller: ResourcePermissionUser,
    opts?: { serviceId?: string },
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona = PERSONAS[personaId];
    if (!basePersona) {
      throw new UnknownPersonaError(personaId);
    }

    if (basePersona.permissionModel === 'service-grant') {
      // Service personas ignore user capabilities entirely — the grant map is
      // the ONLY authority. A user payload claiming ai_personas:* cannot
      // reach the narrator.
      const serviceId = opts?.serviceId;
      if (!serviceId || !SERVICE_PERSONA_GRANTS[serviceId]?.has(basePersona.id)) {
        this.logger.warn(
          `Service persona ${basePersona.id} denied — serviceId=${serviceId ?? 'absent'} has no grant`,
        );
        throw new PersonaNotPermittedError(basePersona.id);
      }
    } else {
      // A DECLARED calling service must be granted the persona. Absence of
      // serviceId is the legacy/user-direct path and stays on the capability
      // check below (deploy-order tolerant).
      if (opts?.serviceId && !SERVICE_PERSONA_GRANTS[opts.serviceId]?.has(basePersona.id)) {
        this.logger.warn(
          `Persona ${basePersona.id} denied for service ${opts.serviceId} — not in grant map`,
        );
        throw new PersonaNotPermittedError(basePersona.id);
      }
      // Authorize the persona tier against the caller's capabilities. Fail-closed.
      this.assertPersonaPermitted(basePersona, caller);
    }

    // Start with base tool names
    const toolNames = new Set(basePersona.defaultToolNames);

    // Add tenant additions — persona-tool-ceiling: a persona that forbids
    // additional tools (narrator) is immune to tenant additionalToolNames.
    if (basePersona.allowAdditionalTools) {
      for (const tool of config.additionalToolNames) {
        if (this.toolRegistry.hasTool(tool)) {
          toolNames.add(tool);
        }
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

    // Build system prompt with tenant customization. Service-grant personas
    // skip the tenant prompt too — their contract is platform-owned (a tenant
    // custom prompt must not be able to rewrite what the narrator asserts).
    let systemPrompt = basePersona.systemPrompt;
    if (basePersona.permissionModel !== 'service-grant' && config.customSystemPrompt) {
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
    // Service-grant personas pin (2) out: the platform contract decides their
    // model class, not tenant configuration (FARM-AI Sprint 4.2 will pin the
    // narrative model outright; this closes the tenant-override hole early).
    // Spread copy below — PERSONAS entries are shared module singletons and must
    // never be mutated per request.
    const personaDefault =
      config.provider === 'zai' ? ZAI_DEFAULT_MODEL : basePersona.model;
    const model =
      this.configService.get<string>('AI_CHAT_MODEL_OVERRIDE') ??
      (basePersona.permissionModel === 'service-grant'
        ? null
        : config.chatModel?.trim() || null) ??
      personaDefault;

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
   * ('supervisor-v1' → 'supervisor'). Unknown prefix → null (FARM-AI Sprint
   * 1.2: the old mapping of unknown prefixes to the HIGHEST tier silently
   * disappeared with strict resolution; null now DENIES in
   * assertPersonaPermitted — fail-closed, never silently broad). Note the
   * narrator persona never reaches here: its permissionModel routes
   * authorization through the service grant map instead.
   */
  private personaTier(persona: AgentPersona): AgentRole | null {
    const prefix = persona.id.split('-')[0];
    return prefix === 'operator' ||
      prefix === 'manager' ||
      prefix === 'expert' ||
      prefix === 'supervisor'
      ? prefix
      : null;
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
    if (tier === null || !hasResourcePermission(caller, `ai_personas:${tier}`)) {
      this.logger.warn(
        `Persona ${persona.id} (tier ${tier ?? 'unknown'}) not permitted — caller lacks the tier capability`,
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
