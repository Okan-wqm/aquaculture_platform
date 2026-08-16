/**
 * emergency-override-check — Phase 4.5 / R16 runtime read helper.
 * ============================================================================
 *
 * Queries `observability.emergency_overrides` for an ACTIVE
 * (expires_at > NOW() AND revoked_at IS NULL) row matching the
 * caller's service + kind. Returns `{active, row?}` so downstream
 * code can both decide AND log which override it honoured.
 *
 * Used by SchemaDriftValidator when a fatal drift is detected —
 * if an active `drift_fatal_bypass` row covers the service, the
 * validator logs + continues instead of throwing. It does not emit
 * schema_drift_clean; deploy guards still treat the boot as unclean.
 *
 * # Fail-safe semantics
 *
 * If the query itself fails (DB down, table missing, permission
 * denied, etc.), the helper returns `{active: false, error}` — it
 * NEVER returns `active: true` on its own failure. The caller then
 * falls through to its default (fatal → throw). An operator cannot
 * accidentally bypass fatal drift by breaking observability.
 */
import type { DataSource } from 'typeorm';

import { executeQueryRowsNormalized } from './query-result-normalizer';

export type EmergencyOverrideKind = 'drift_fatal_bypass' | 'migration_skip' | 'validator_disable';

export interface EmergencyOverrideRow {
  readonly id: string;
  readonly serviceName: string;
  readonly kind: EmergencyOverrideKind;
  readonly reason: string;
  readonly actor: string;
  readonly expiresAt: Date;
  readonly environment: string;
}

export interface EmergencyOverrideLookupResult {
  readonly active: boolean;
  readonly row?: EmergencyOverrideRow;
  readonly error?: string;
}

export interface EmergencyOverrideLookupOptions {
  readonly dataSource: DataSource;
  readonly serviceName: string;
  readonly kind: EmergencyOverrideKind;
  readonly environment: string;
}

export async function lookupEmergencyOverride(
  opts: EmergencyOverrideLookupOptions,
): Promise<EmergencyOverrideLookupResult> {
  try {
    const rows = await executeQueryRowsNormalized<{
      id: string;
      service_name: string;
      kind: EmergencyOverrideKind;
      reason: string;
      actor: string;
      expires_at: Date;
      environment: string;
    }>(
      opts.dataSource,
      `SELECT id, service_name, kind, reason, actor, expires_at, environment
         FROM observability.emergency_overrides
        WHERE service_name = $1
          AND kind = $2
          AND environment = $3
          AND expires_at > NOW()
          AND revoked_at IS NULL
        ORDER BY expires_at DESC
        LIMIT 1`,
      [opts.serviceName, opts.kind, opts.environment],
    );
    if (rows.length === 0) {
      return { active: false };
    }
    const r = rows[0];
    if (!r) {
      return { active: false };
    }
    return {
      active: true,
      row: {
        id: r.id,
        serviceName: r.service_name,
        kind: r.kind,
        reason: r.reason,
        actor: r.actor,
        expiresAt: new Date(r.expires_at),
        environment: r.environment,
      },
    };
  } catch (err) {
    // Fail-safe: any lookup failure → active=false. The validator's
    // default fatal path runs; an operator cannot silence fatal drift
    // by breaking observability.
    const msg = err instanceof Error ? err.message : String(err);
    return { active: false, error: msg };
  }
}
