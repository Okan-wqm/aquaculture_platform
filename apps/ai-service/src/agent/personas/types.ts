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
