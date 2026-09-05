/**
 * Production posture of admin-api-service — declared once, asserted at boot.
 *
 * Until 2026-09-05 production was fail-closed by accident: explorer writes
 * and the raw SQL explorer were each off only because nobody had set their
 * `ENABLE_*` variable (the debug-tools module, the third such flag, is
 * deleted under ADR-0007). Nothing pinned any of it; any
 * compose refactor could silently un-close the platform (INFRA-HIGH-142).
 * (`TRUST_PROXY`, the AUTH-010 half of that finding, moved to the kernel's
 * edge-hardening bundle under ADR-0006.)
 *
 * This file is the single declaration. `assertProductionPosture()` runs
 * before the Nest app is created and refuses to start a production process
 * whose environment does not state each decision explicitly:
 *
 *   - every `pinnedFalse` variable must be PRESENT and equal to 'false' —
 *     absence is an omission, not a decision, and 'true' is a breach;
 *   - every `required` variable must be present and non-empty.
 *
 * `tests/invariants/admin-api-production-posture.spec.ts` asserts that
 * docker-compose.droplet.yml states the same decisions as literals, so the
 * deploy artefact and the boot assertion cannot drift apart.
 */

export const ADMIN_API_PRODUCTION_POSTURE = Object.freeze({
  /** Feature flags that must be an explicit 'false' in production. */
  pinnedFalse: Object.freeze(['ENABLE_DB_EXPLORER_WRITES', 'ENABLE_RAW_SQL_EXPLORER'] as const),
  /**
   * Variables the service cannot run without: WALG_BACKUP_EPOCH because a
   * tenant schema drop must name the WAL-G archive that can restore it
   * (ADR-0009). TRUST_PROXY is no longer listed here: since ADR-0006 the
   * bootstrap factory refuses to start ANY `serviceVisibility: 'public'`
   * service in production without it (libs/backend-common/src/bootstrap/
   * edge-hardening.ts), so a second, admin-only assertion would be a second
   * authority for the same rule.
   */
  required: Object.freeze(['WALG_BACKUP_EPOCH'] as const),
});

export type ProductionPostureEnv = Readonly<Record<string, string | undefined>>;

export function productionPostureViolations(env: ProductionPostureEnv): string[] {
  const violations: string[] = [];
  for (const name of ADMIN_API_PRODUCTION_POSTURE.pinnedFalse) {
    const value = env[name];
    if (value === undefined) {
      violations.push(`${name} is not set; production must state ${name}=false explicitly`);
    } else if (value !== 'false') {
      violations.push(
        `${name}=${value} is not permitted in production; the only accepted value is 'false'`,
      );
    }
  }
  for (const name of ADMIN_API_PRODUCTION_POSTURE.required) {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      violations.push(`${name} is required in production and is not set`);
    }
  }
  return violations;
}

/**
 * Refuses to boot a production process whose environment does not state the
 * posture. Outside production the function is a no-op: developers toggle
 * these flags locally on purpose.
 */
export function assertProductionPosture(env: ProductionPostureEnv = process.env): void {
  if (env['NODE_ENV'] !== 'production') return;
  const violations = productionPostureViolations(env);
  if (violations.length === 0) return;
  throw new Error(
    `admin-api-service refuses to start: production posture is not declared.\n` +
      violations.map((violation) => `  - ${violation}`).join('\n') +
      `\nSee apps/admin-api-service/src/config/production-posture.ts.`,
  );
}
