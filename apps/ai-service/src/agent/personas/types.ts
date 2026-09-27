import type {
  AiPersonaTier,
  AiSpecialtyId,
  AiSpecialtyModule,
} from '@aquaculture/shared-contracts';
import type { ActuationPolicy } from '../../tools/core/tool.interface';

/** The runtime persona shape the runner, ledger, audit and proposals consume. */
export interface AgentPersona {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  defaultToolNames: string[];
  actuationPolicy: ActuationPolicy;
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
   * - 'user-tier'    — user chat; authorized by the caller's ALL-OF
   *                    requiredCapabilities set (`ai_personas:<tier>` ∧
   *                    `ai_specialties:<module>` for farm specialists).
   * - 'service-grant'— platform service paths only (e.g. action_watch
   *                    narratives); authorized EXCLUSIVELY by the
   *                    server-side service→persona grant map. No user
   *                    capability can reach these personas.
   */
  permissionModel: 'user-tier' | 'service-grant';
}

/**
 * A hand-defined SERVICE persona (service-grant permission model) — outside
 * the composed catalogue: no tier/specialty axes, unreachable by user chat,
 * authorized only through SERVICE_PERSONA_GRANTS. narrator-v1 today.
 */
export interface ServicePersona extends AgentPersona {
  permissionModel: 'service-grant';
}

/**
 * Authority tier — WHO may drive the persona and HOW far it may go. One per
 * `ai_personas:<tier>` capability. Carries the model, the per-call token
 * budget, the actuation ceiling and the authority/style prompt fragment.
 */
export interface AgentTier {
  readonly id: AiPersonaTier;
  readonly label: string;
  readonly model: string;
  readonly maxTokensPerTurn: number;
  /** The most permissive actuation policy this tier can ever reach. */
  readonly actuationCeiling: ActuationPolicy;
  readonly promptFragment: string;
}

/**
 * Specialty — WHAT the persona knows and which tools it carries. Tool names
 * are the full bundle; the tier filters it at compose time through each
 * tool's `requiredPermissions`. `actuationCap` bounds the tier ceiling
 * (farm specialists advise; the user decides — `confirm_required`).
 */
export interface AgentSpecialty {
  readonly id: AiSpecialtyId;
  readonly toolNames: readonly string[];
  readonly promptFragment: string;
  readonly actuationCap: ActuationPolicy;
  readonly requiresModule: AiSpecialtyModule | null;
}
