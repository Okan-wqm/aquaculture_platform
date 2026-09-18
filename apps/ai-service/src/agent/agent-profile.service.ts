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
import { AgentPersonaCatalogueService } from './agent-persona-catalogue.service';
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
  /**
   * FARM-AI PR-2 Commit B: the persona's BASE prompt and the tenant custom
   * prompt travel SEPARATELY — the final prompt is assembled in exactly one
   * place (AiSafetyMiddleware.preProcess). This service no longer pre-merges
   * them: when the instruction hierarchy was enabled the runner sent the
   * hardened prompt built WITHOUT the tenant part (AISAFETY-MEDIUM), and
   * when disabled it sent a differently-formatted merge.
   */
  baseSystemPrompt: string;
  tenantCustomPrompt: string | null;
  /**
   * FARM-AI PR-2: the persona's tier, carried explicitly by the composed
   * catalogue (null for service-grant personas like the narrator). Replaces
   * the id-prefix derivation the tool executor used to do.
   */
  personaTier: string | null;
  effectiveToolNames: string[];
  actuationPolicy: 'blocked' | 'confirm_required' | 'allowed';
}

@Injectable()
export class AgentProfileService {
  private readonly logger = new Logger(AgentProfileService.name);

  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly configService: ConfigService,
    private readonly personaCatalogue: AgentPersonaCatalogueService,
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
   *
   * FARM-AI PR-2: personas are COMPOSED (tier × specialty) by
   * AgentPersonaCatalogueService against the frozen shared-contracts
   * catalogue — this service no longer holds hand-written persona constants.
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
    caller: ResourcePermissionUser,
    opts?: { serviceId?: string },
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona =
      this.personaCatalogue.resolveServicePersona(personaId) ??
      this.personaCatalogue.resolve(personaId);

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

    // Tenant custom prompts never apply to service-grant personas — their
    // contract is platform-owned (a tenant must not rewrite what the narrator
    // asserts); the middleware receives null for them.
    const tenantCustomPrompt =
      basePersona.permissionModel === 'service-grant' ? null : config.customSystemPrompt ?? null;

    return {
      persona: { ...basePersona, model },
      personaTier: AgentProfileService.explicitTier(basePersona),
      baseSystemPrompt: basePersona.systemPrompt,
      tenantCustomPrompt,
      effectiveToolNames,
      actuationPolicy,
    };
  }

  /**
   * The persona's tier when the definition carries one explicitly (composed
   * personas do; hand-defined service personas like the narrator do not —
   * they authorize through the service grant map, not tiers).
   */
  private static explicitTier(persona: AgentPersona): string | null {
    const tier = (persona as { tier?: unknown }).tier;
    return typeof tier === 'string' ? tier : null;
  }

  /**
   * The capability tier of a persona. Composed personas CARRY their tier
   * explicitly (assertPersonaPermitted prefers it); this prefix derivation is
   * the fallback for non-composed personas and maps unknown prefixes to null
   * — DENY, never silently the highest tier (FARM-AI Sprint 1.2). The narrator
   * never reaches here: its permissionModel routes authorization through the
   * service grant map instead.
   */
  private personaTier(persona: AgentPersona): AgentRole | null {
    if ('tier' in persona && typeof persona.tier === 'string') {
      return persona.tier as AgentRole;
    }
    const prefix = persona.id.split('-')[0];
    return prefix === 'operator' ||
      prefix === 'manager' ||
      prefix === 'expert' ||
      prefix === 'supervisor'
      ? prefix
      : null;
  }

  /**
   * AISAFETY-MEDIUM-013 / Faz 7c + FARM-AI PR-2: fail-closed persona
   * authorization against the persona's FULL required-capability set. Composed
   * personas carry requiredCapabilities from the shared catalogue — the tier
   * grant (`ai_personas:<tier>`) AND, for farm specialists, the specialty
   * grant (`ai_specialties:farm`, itself all-of modules ai+farm). Checking
   * only the tier let a caller with the right tier reach a farm specialist
   * without the farm entitlement; every capability is now required (all-of).
   * Non-composed user-tier personas fall back to the tier capability. Admins
   * bypass (via the shared SSoT check). Throws PersonaNotPermittedError.
   */
  private assertPersonaPermitted(
    persona: AgentPersona,
    caller: ResourcePermissionUser,
  ): void {
    const required =
      'requiredCapabilities' in persona && Array.isArray(persona.requiredCapabilities)
        ? (persona.requiredCapabilities as readonly string[])
        : null;
    const tier = this.personaTier(persona);
    const capabilities =
      required !== null && required.length > 0 ? required : tier !== null ? [`ai_personas:${tier}`] : [];

    if (
      capabilities.length === 0 ||
      capabilities.some((capability) => !hasResourcePermission(caller, capability))
    ) {
      const missing = capabilities.filter((c) => !hasResourcePermission(caller, c));
      this.logger.warn(
        `Persona ${persona.id} (tier ${tier ?? 'unknown'}) not permitted — caller lacks ${missing.join(', ') || 'any known tier'}`,
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
