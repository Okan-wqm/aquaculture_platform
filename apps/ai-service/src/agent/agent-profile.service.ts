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
import { mostRestrictivePolicy, type ComposedPersona } from './personas/compose';
import type { AgentPersona } from './personas/types';
import { ZAI_DEFAULT_MODEL } from './providers/zai.provider';

export type { AgentPersona } from './personas/types';

/** Thrown when a user requests a persona above their tenant-RBAC entitlement. */
export class PersonaNotPermittedError extends ForbiddenException {
  constructor(personaId: string) {
    super(`Persona "${personaId}" is not permitted for this user`);
  }
}

export interface ResolvedProfile {
  persona: ComposedPersona;
  effectiveToolNames: string[];
  /** The composed persona prompt — no tenant text (AISAFETY-MEDIUM-025). */
  baseSystemPrompt: string;
  /** The tenant's custom instructions, assembled into the final prompt by the safety pipeline. */
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
   */
  async resolveProfile(
    tenantId: string,
    personaId: string,
    caller: ResourcePermissionUser,
  ): Promise<ResolvedProfile> {
    const config = await this.agentConfig.getConfig(tenantId);
    const basePersona = this.catalogue.resolve(personaId);

    this.assertPersonaPermitted(basePersona, caller);

    const toolNames = new Set(basePersona.defaultToolNames);
    for (const tool of config.additionalToolNames) {
      if (this.toolRegistry.hasTool(tool)) {
        toolNames.add(tool);
      }
    }
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
    // rather than offered-then-refused.
    const effectiveToolNames = Array.from(toolNames).filter((name) => {
      const tool = this.toolRegistry.getTool(name);
      if (!tool) return false;
      const metadata = tool.getMetadata();
      if (!metadata.requiredPermissions.includes(basePersona.tier)) return false;
      if (
        metadata.requiresModule !== null &&
        metadata.requiresModule !== basePersona.requiresModule
      ) {
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
    // Spread copy below — composed personas are shared singletons and must
    // never be mutated per request.
    const personaDefault = config.provider === 'zai' ? ZAI_DEFAULT_MODEL : basePersona.model;
    const model =
      this.configService.get<string>('AI_CHAT_MODEL_OVERRIDE') ??
      (config.chatModel?.trim() || null) ??
      personaDefault;

    return {
      persona: { ...basePersona, model },
      effectiveToolNames,
      baseSystemPrompt: basePersona.systemPrompt,
      tenantCustomPrompt: config.customSystemPrompt?.trim() || null,
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
