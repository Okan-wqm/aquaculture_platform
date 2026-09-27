import type { AiPersonaTier } from '@aquaculture/shared-contracts';
import type { AgentTier } from '../types';
import { OPERATOR_TIER } from './operator.tier';
import { MANAGER_TIER } from './manager.tier';
import { EXPERT_TIER } from './expert.tier';
import { SUPERVISOR_TIER } from './supervisor.tier';

/** Every authority tier, keyed by the shared-contracts tier id. */
export const TIERS: Readonly<Record<AiPersonaTier, AgentTier>> = Object.freeze({
  operator: OPERATOR_TIER,
  manager: MANAGER_TIER,
  expert: EXPERT_TIER,
  supervisor: SUPERVISOR_TIER,
});

export { OPERATOR_TIER, MANAGER_TIER, EXPERT_TIER, SUPERVISOR_TIER };
