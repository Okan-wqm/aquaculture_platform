import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  hasAllResourcePermissions,
  type ResourcePermissionUser,
} from '@aquaculture/backend-common/decorators';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import type { ActuationPolicy } from '../tools/core/tool.interface';
import { AgentPersonaCatalogueService } from './agent-persona-catalogue.service';
import { SERVICE_PERSONA_GRANTS } from './service-persona-grants';
import { mostRestrictivePolicy, type ComposedPersona } from './personas/compose';
import type { AgentPersona, ServicePersona } from './personas/types';
import { ZAI_DEFAULT_MODEL } from './providers/zai.provider';

export type { AgentPersona } from './personas/types';

/** Thrown when a user requests a persona above their tenant-RBAC entitlement. */
export class PersonaNotPermittedError extends ForbiddenException {
  constructor(personaId: string) {
    super(`Persona "${personaId}" is not permitted for this user`);
  }
}

export interface ResolvedProfile {
  /**
   * The resolved persona — a composed catalogue persona (user-tier) or a
   * hand-defined service persona (service-grant, e.g. narrator-v1; carries
   * no tier/specialty axes — FARM-AI Sprint 1.2).
   */
  persona: ComposedPersona | ServicePersona;
  effectiveToolNames: string[];
  /** The composed persona prompt — no tenant text (AISAFETY-MEDIUM-025). */
  baseSystemPrompt: string;
  /**
   * The tenant's custom instructions, assembled into the final prompt by the
   * safety pipeline. Null for service-grant personas — their contract is
   * platform-owned (FARM-AI Sprint 1.2).
   */
  tenantCustomPrompt: string | null;
  actuationPolicy: ActuationPolicy;
}

@Injectable()
export class AgentProfileService {
  private readonly logger = new Logger(AgentProfileService.name);

  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly catalogue: AgentPersonaCatalogueService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve effective profile:
   * composed persona (tier × specialty) + tenant additions − tenant removals,
   * filtered by registry membership, tier permission and module scope.
   *
   * AISAFETY-MEDIUM-013 / Faz 7c: the resolved persona is authorized against the
   * caller's tenant-RBAC capabilities before anything else runs —
   * `ai_personas:<tier>` for every persona, plus `ai_specialties:<module>` for a
   * module-scoped specialist (RBAC-MEDIUM-016) — so a user cannot escalate into a
   * higher-privilege persona just by naming it. The tenant admin decides which
   * role may drive which tier / specialty. Admins bypass. Fail-closed.
   *
   * AISAFETY-MEDIUM-024: an unknown persona id is a hard error (UnknownPersonaError,
   * BAD_REQUEST); it never silently resolves to a lower-privilege persona.
   *
   * FARM-AI Sprint 1.2 — server-side service→persona grants: authority is
   * NEVER taken from payload claims. A DECLARED calling service (opts.serviceId)
   * must be granted the persona by SERVICE_PERSONA_GRANTS, and service-grant
   * personas (narrator) are reachable ONLY through that map — no user
   * capability set can reach them, and a service persona skips the
   * user-capability check entirely.
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
    caller: ResourcePermissionUser,
    opts?: { serviceId?: string },
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona =
      this.catalogue.resolveServicePersona(personaId) ?? this.catalogue.resolve(personaId);

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

    // Add tenant additions — persona-tool-ceiling (FARM-AI Sprint 1.2): a
    // persona that forbids additional tools (narrator) is immune to tenant
    // additionalToolNames; its tool ceiling is platform-owned.
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

    // Resolve actuation policy (most restrictive wins)
    const actuationPolicy = this.resolveActuationPolicy(
      basePersona.actuationPolicy,
      config.actuationPolicy,
    );

    // A tool is offered only when the registry has it, the persona's tier may
    // run it (the executor's own check), and its module matches the specialty's
    // scope. Under a `blocked` policy, confirmation-class tools are withheld
    // rather than offered-then-refused. Service personas carry no tier — with
    // an empty base toolset and the tool ceiling closed they offer nothing.
    const personaTier = 'tier' in basePersona ? basePersona.tier : null;
    const personaModule = 'requiresModule' in basePersona ? basePersona.requiresModule : null;
    const effectiveToolNames = Array.from(toolNames).filter((name) => {
      const tool = this.toolRegistry.getTool(name);
      if (!tool) return false;
      const metadata = tool.getMetadata();
      if (personaTier === null || !metadata.requiredPermissions.includes(personaTier)) {
        return false;
      }
      if (metadata.requiresModule !== null && metadata.requiresModule !== personaModule) {
        return false;
      }
      if (actuationPolicy === 'blocked' && metadata.requiresConfirmation) return false;
      return true;
    });

    // Model resolution precedence (highest wins):
    //   1. AI_CHAT_MODEL_OVERRIDE — ops fleet-wide escape hatch for a model
    //      retirement, applied without a redeploy or any tenant edit.
    //   2. config.chatModel       — the tenant's own per-tenant override (set
    //      via the BYOK settings CRUD; runs on the tenant's own key/bill).
    //   3. the tier's model       — the platform default for the persona tier.
    // Service-grant personas pin (2) out: the platform contract decides their
    // model class, not tenant configuration (FARM-AI Sprint 1.2) — a tenant
    // must not steer what model narrates its monitoring verdicts.
    // Spread copy below — personas are shared module singletons and must
    // never be mutated per request.
    const personaDefault = config.provider === 'zai' ? ZAI_DEFAULT_MODEL : basePersona.model;
    const model =
      this.configService.get<string>('AI_CHAT_MODEL_OVERRIDE') ??
      (basePersona.permissionModel === 'service-grant' ? null : config.chatModel?.trim() || null) ??
      personaDefault;

    // Tenant custom prompts never apply to service-grant personas — their
    // contract is platform-owned (a tenant must not rewrite what the narrator
    // asserts); the middleware receives null for them.
    const tenantCustomPrompt =
      basePersona.permissionModel === 'service-grant'
        ? null
        : config.customSystemPrompt?.trim() || null;

    return {
      persona: { ...basePersona, model },
      effectiveToolNames,
      baseSystemPrompt: basePersona.systemPrompt,
      tenantCustomPrompt,
      actuationPolicy,
    };
  }

  /**
   * AISAFETY-MEDIUM-013 / Faz 7c + RBAC-MEDIUM-016: fail-closed persona
   * authorization against every capability the catalogue requires for the
   * persona (`ai_personas:<tier>` ∧ `ai_specialties:<module>`). Admins bypass
   * via the shared SSoT check. Throws PersonaNotPermittedError otherwise.
   */
  private assertPersonaPermitted(
    persona: AgentPersona & ComposedPersona,
    caller: ResourcePermissionUser,
  ): void {
    if (!hasAllResourcePermissions(caller, persona.requiredCapabilities)) {
      this.logger.warn(
        `Persona ${persona.id} not permitted — caller lacks one of [${persona.requiredCapabilities.join(', ')}]`,
      );
      throw new PersonaNotPermittedError(persona.id);
    }
  }

  private resolveActuationPolicy(base: ActuationPolicy, tenantOverride: string): ActuationPolicy {
    const override: ActuationPolicy =
      tenantOverride === 'blocked' || tenantOverride === 'allowed'
        ? tenantOverride
        : 'confirm_required';
    return mostRestrictivePolicy(base, override);
  }
}
