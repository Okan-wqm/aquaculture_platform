/**
 * Runtime guards: health checks, probes and memory limits — the one owner (ARIA-HIGH-012).
 *
 * WHY composition is an input: whether a compose service has a health check depends on the
 * image too. A service without `healthcheck.test` inherits the image's HEALTHCHECK (a
 * `healthcheck:` with only timings retimes it), so the caller resolves the image's Dockerfile
 * and passes what it found, or 'unresolved' — in which case no health gap is claimed.
 * Anchors (`<<: *limits`) are already merged by the YAML reader.
 */
import {
  type ComposeService,
  type K8sContainer,
  type K8sWorkload,
  RUN_TO_COMPLETION_KINDS,
  asMap,
  yamlAt,
} from '../lib/infra/workloads';

export type ComposeGuardGap = 'healthcheck' | 'memory_limit';

export interface ComposeGuardComposition {
  /** HEALTHCHECK state of the image's final stage, as resolved by the caller. */
  readonly imageHealthcheck: 'present' | 'absent' | 'disabled' | 'unresolved';
}

export interface ComposeGuardReport {
  readonly missing: readonly ComposeGuardGap[];
  /** Why no health check is required (run-once or profile-only service), or null. */
  readonly healthExempt: 'one_shot' | 'profile_only' | null;
  /** The health verdict depends on an image whose Dockerfile could not be resolved. */
  readonly healthUnresolved: boolean;
}

function isNoneTest(test: unknown): boolean {
  if (test === 'NONE') return true;
  return Array.isArray(test) && test[0] === 'NONE';
}

type OwnHealth = 'present' | 'disabled' | 'inherit';

function ownHealth(service: ComposeService): OwnHealth {
  const healthcheck = asMap(service.spec.healthcheck);
  if (healthcheck === null) return 'inherit';
  if (healthcheck.disable === true || isNoneTest(healthcheck.test)) return 'disabled';
  return healthcheck.test === undefined || healthcheck.test === null ? 'inherit' : 'present';
}

function healthExemption(service: ComposeService): 'one_shot' | 'profile_only' | null {
  const restart = service.spec.restart;
  if (restart === 'no' || restart === false) return 'one_shot';
  const profiles = service.spec.profiles;
  if (Array.isArray(profiles) && profiles.length > 0) return 'profile_only';
  return null;
}

function hasMemoryLimit(service: ComposeService): boolean {
  const memLimit = service.spec.mem_limit;
  if (memLimit !== undefined && memLimit !== null) return true;
  const deployLimit = yamlAt(service.spec, ['deploy', 'resources', 'limits', 'memory']);
  return deployLimit !== undefined && deployLimit !== null;
}

export function composeGuards(
  service: ComposeService,
  composition: ComposeGuardComposition,
): ComposeGuardReport {
  const missing: ComposeGuardGap[] = [];
  const healthExempt = healthExemption(service);
  let healthUnresolved = false;
  if (healthExempt === null) {
    const own = ownHealth(service);
    if (own === 'disabled') missing.push('healthcheck');
    else if (own === 'inherit') {
      if (composition.imageHealthcheck === 'unresolved') healthUnresolved = true;
      else if (composition.imageHealthcheck !== 'present') missing.push('healthcheck');
    }
  }
  if (!hasMemoryLimit(service)) missing.push('memory_limit');
  return { missing, healthExempt, healthUnresolved };
}

export type PodGuardGap = 'memory_limit' | 'readiness_probe' | 'liveness_probe';

export interface PodGuardReport {
  readonly missing: readonly PodGuardGap[];
}

/** Init containers and run-to-completion workloads (Job, CronJob) have no probes to miss. */
export function podGuards(workload: K8sWorkload, container: K8sContainer): PodGuardReport {
  const missing: PodGuardGap[] = [];
  const memory = yamlAt(container.spec, ['resources', 'limits', 'memory']);
  if (memory === undefined || memory === null) missing.push('memory_limit');
  if (!container.init && !RUN_TO_COMPLETION_KINDS.has(workload.kind)) {
    if (asMap(container.spec.readinessProbe) === null) missing.push('readiness_probe');
    if (asMap(container.spec.livenessProbe) === null) missing.push('liveness_probe');
  }
  return { missing };
}
