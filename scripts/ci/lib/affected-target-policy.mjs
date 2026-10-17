/**
 * The affected-target quarantine policy (scripts/ci/affected-target-policy.json):
 * the one owner of which affected projects a lane gates strictly.
 *
 * WHY. A quarantine entry is tracked debt, and tracked debt has an owner, a
 * reason, an expiry and a finding: the shape every reviewed exception in the
 * repository shares (scripts/ci/lib/reviewed-exception.mjs). A bare reason
 * string was the previous shape here, and 19 `test` entries carried one with
 * no owner, no clock and no finding for four months (PROC-MEDIUM-025).
 *
 * The writer used to refuse the WHOLE policy file once any entry of any
 * target was past its date. That turned one lapsed date into an outage of
 * every lane that reads the file (lint, test, test:integration,
 * test:contract, test:invariant) on every PR and main push: the 40 lint
 * entries that all expired 2026-10-31 would have done exactly that
 * (INFRA-MEDIUM-222), and each later renewal only moved the wall.
 *
 * WHAT.
 *   - A MALFORMED entry, or a policy of another version, still refuses the
 *     file. Only a commit can introduce one, and the invariant spec fails
 *     that commit first.
 *   - An EXPIRED entry quarantines nothing: its project is gated strictly
 *     for that target, and the lane names it. The exception lapses where it
 *     was granted (that project, that target) and fails closed there; every
 *     other project and lane is untouched.
 *
 * tests/invariants/affected-target-quarantine-ssot.spec.ts replays this
 * function over the live policy past every date it names.
 */

import {
  isReviewedExceptionExpired,
  reviewedExceptionShapeProblems,
} from './reviewed-exception.mjs';

export const POLICY_VERSION = 2;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The quarantine map of every target, after refusing a policy that is not
 * version 2 or carries any malformed entry.
 *
 * @param {unknown} policy parsed affected-target-policy.json
 * @returns {Map<string, Record<string, {owner: string, reason: string, expires_on: string, finding_id: string}>>}
 */
function quarantinesOf(policy) {
  if (!isPlainObject(policy) || policy.version !== POLICY_VERSION) {
    const version = isPlainObject(policy) ? policy.version : undefined;
    throw new Error(`affected-target policy version ${String(version)} is not ${POLICY_VERSION}`);
  }
  if (!isPlainObject(policy.targets)) {
    throw new Error('affected-target policy has no targets object');
  }
  const quarantines = new Map();
  const problems = [];
  for (const [target, config] of Object.entries(policy.targets)) {
    if (!isPlainObject(config) || !isPlainObject(config.knownUnstableProjects)) {
      problems.push(`${target}: knownUnstableProjects must be an object`);
      continue;
    }
    for (const [project, entry] of Object.entries(config.knownUnstableProjects)) {
      problems.push(...reviewedExceptionShapeProblems(entry, `${target}/${project}`));
    }
    quarantines.set(target, config.knownUnstableProjects);
  }
  if (problems.length > 0) {
    throw new Error(`affected-target policy quarantine is invalid:\n  ${problems.join('\n  ')}`);
  }
  return quarantines;
}

/**
 * Split one target's affected projects into the ones the lane gates
 * strictly, the ones explicitly excluded, the ones a live entry quarantines,
 * and the ones whose entry has expired (which are gated strictly too).
 *
 * @param {unknown} policy parsed affected-target-policy.json
 * @param {{target: string, affectedProjects: readonly string[], explicitExcludes: readonly string[], today: string}} input
 *        `today` is YYYY-MM-DD, UTC
 * @returns {{
 *   strictProjects: string[],
 *   explicitlyExcludedProjects: string[],
 *   quarantinedProjects: Array<{project: string, owner: string, reason: string, expires_on: string, finding_id: string}>,
 *   expiredQuarantineProjects: Array<{project: string, owner: string, reason: string, expires_on: string, finding_id: string}>,
 * }}
 * @throws when the policy is not version 2 or any entry of any target is malformed
 */
export function partitionAffectedProjects(policy, input) {
  const quarantines = quarantinesOf(policy);
  // A target the policy does not name (test:invariant) has no quarantine.
  const knownUnstable = quarantines.get(input.target) ?? {};
  const excluded = new Set(input.explicitExcludes);
  const partition = {
    strictProjects: [],
    explicitlyExcludedProjects: [],
    quarantinedProjects: [],
    expiredQuarantineProjects: [],
  };
  for (const project of input.affectedProjects) {
    if (excluded.has(project)) {
      partition.explicitlyExcludedProjects.push(project);
    } else if (!Object.prototype.hasOwnProperty.call(knownUnstable, project)) {
      partition.strictProjects.push(project);
    } else if (isReviewedExceptionExpired(knownUnstable[project], input.today)) {
      partition.expiredQuarantineProjects.push({ project, ...knownUnstable[project] });
      partition.strictProjects.push(project);
    } else {
      partition.quarantinedProjects.push({ project, ...knownUnstable[project] });
    }
  }
  return partition;
}
