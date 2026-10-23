import { createHash } from 'crypto';

import { BadRequestException } from '@nestjs/common';

import {
  canonicalJsonBytes,
  contractTimestamp,
  type ContractJson,
} from '../edge-device/edge-contract';
import type { OsBundle, UpdateTerms } from '../edge-device/edge-update-manifest.service';
import { parseRecipe, type UpdateRecipe } from '../edge-device/edge-update-recipe';

import { EdgeRolloutKind } from './entities/edge-rollout.entity';

/**
 * A rollout's plan (ADR-048 DEC-2.4, DEC-23): what is installed, under which
 * terms, in which window, on which devices in which order, and how many failures
 * stop it. The plan is the thing two people approve, so it has one canonical form
 * and one digest ({@link planDigest}); an approval names that digest, and the
 * plan is never edited after it is stored.
 */

/** A rollout is a deliberate cohort, not a fleet-wide broadcast. */
export const MAX_ROLLOUT_DEVICES = 500;
export const MAX_ROLLOUT_WAVES = 10;

interface PlanBase {
  readonly terms: UpdateTerms;
  /** Null: the window opens when each statement is signed. */
  readonly windowNotBefore: Date | null;
  readonly windowSeconds: number;
  /** The rollout halts when more devices than this fail. */
  readonly maxFailures: number;
  /** Device ids, wave by wave; wave n+1 starts only after wave n concluded. */
  readonly waves: readonly (readonly string[])[];
}

/** An agent release for every device of the cohort. */
export interface EdgeRolloutPlan extends PlanBase {
  readonly kind: EdgeRolloutKind.EDGE_UPDATE;
  readonly version: string;
}

/** An OS bundle for every device of the cohort. */
export interface OsRolloutPlan extends PlanBase {
  readonly kind: EdgeRolloutKind.OS_UPDATE;
  readonly bundle: OsBundle;
}

export type RolloutPlan = EdgeRolloutPlan | OsRolloutPlan;

/** What the rollout row stores as `target`, and the digest covers. */
export function targetOf(plan: RolloutPlan): Record<string, ContractJson> {
  if (plan.kind === EdgeRolloutKind.EDGE_UPDATE) return { version: plan.version };
  const { version, rollbackFloor, minCurrentVersion, supportedAgentAbi, url, sha256, sizeBytes } =
    plan.bundle;
  return {
    bundle: {
      version,
      rollbackFloor,
      minCurrentVersion,
      supportedAgentAbi,
      url,
      sha256,
      sizeBytes,
    },
  };
}

/** Why a plan cannot be a rollout; nothing was stored. */
export class RolloutPlanError extends BadRequestException {
  constructor(detail: string) {
    super(`The rollout plan is not acceptable: ${detail}`);
    this.name = 'RolloutPlanError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every device id of the plan, in wave order. */
export function planDevices(plan: RolloutPlan): string[] {
  return plan.waves.flat();
}

/** The structural rules of a plan that need no device, release or bundle to check. */
export function assertPlanShape(plan: RolloutPlan): void {
  if (plan.waves.length < 1 || plan.waves.length > MAX_ROLLOUT_WAVES) {
    throw new RolloutPlanError(
      `it has ${plan.waves.length} waves, between 1 and ${MAX_ROLLOUT_WAVES} are allowed`,
    );
  }
  const seen = new Set<string>();
  for (const [index, wave] of plan.waves.entries()) {
    if (wave.length === 0) throw new RolloutPlanError(`wave ${index + 1} has no device`);
    for (const id of wave) {
      if (!UUID.test(id)) throw new RolloutPlanError(`${id.slice(0, 40)} is not a device id`);
      if (seen.has(id)) throw new RolloutPlanError(`device ${id} is in the cohort twice`);
      seen.add(id);
    }
  }
  if (seen.size > MAX_ROLLOUT_DEVICES) {
    throw new RolloutPlanError(
      `it names ${seen.size} devices, at most ${MAX_ROLLOUT_DEVICES} are allowed`,
    );
  }
  if (!Number.isInteger(plan.maxFailures) || plan.maxFailures < 0 || plan.maxFailures > seen.size) {
    throw new RolloutPlanError(
      `the failure allowance ${plan.maxFailures} is not between 0 and the cohort size`,
    );
  }
  if (plan.windowNotBefore !== null) {
    try {
      contractTimestamp(plan.windowNotBefore);
    } catch (error) {
      throw new RolloutPlanError(
        error instanceof Error ? error.message : 'the window start is invalid',
      );
    }
  }
  if (recipeOf({ ...plan, target: targetOf(plan) }) === null) {
    throw new RolloutPlanError('its target, terms or window length are not what the kind needs');
  }
}

/**
 * What re-issues every statement of the rollout: the stored target, terms and
 * window length, read through the one parser that admits a recipe. Null when the
 * target does not fit its kind.
 */
export function recipeOf(stored: {
  readonly kind: string;
  readonly target: object;
  readonly terms: object;
  readonly windowSeconds: number;
}): UpdateRecipe | null {
  return parseRecipe({
    kind: stored.kind,
    ...stored.target,
    terms: stored.terms,
    windowSeconds: stored.windowSeconds,
  });
}

/**
 * The digest of the canonical plan: sorted members, whole-second window start,
 * the devices of each wave in sorted order (a wave is a set). It is what an
 * approval confirms and what the rollout row stores.
 */
export function planDigest(plan: RolloutPlan): string {
  const canonical: ContractJson = {
    version: 1,
    kind: plan.kind,
    target: targetOf(plan),
    terms: {
      local_approval: plan.terms.localApproval,
      blockers_override: plan.terms.blockersOverride,
      max_outage_seconds: plan.terms.maxOutageSeconds,
    },
    window_not_before:
      plan.windowNotBefore === null ? null : contractTimestamp(plan.windowNotBefore),
    window_seconds: plan.windowSeconds,
    max_failures: plan.maxFailures,
    waves: plan.waves.map((wave) => [...wave].sort()),
  };
  return createHash('sha256').update(canonicalJsonBytes(canonical)).digest('hex');
}
