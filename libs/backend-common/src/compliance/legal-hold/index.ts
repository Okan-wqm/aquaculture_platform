/**
 * @aquaculture/backend-common/compliance/legal-hold
 *
 * Canonical legal-hold registry. Single source of truth consulted by
 * every destructive operation across the platform before proceeding.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   LegalHoldService,
 *   LegalHoldModule,
 *   LegalHoldActiveError,
 * } from '@aquaculture/backend-common/compliance/legal-hold';
 *
 * await this.legalHoldService.assertNoHold(tenantId, 'tenant');
 * // ↑ throws LegalHoldActiveError when blocked
 * await this.dataSource.transaction(async (em) => {
 *   await em.query(`DROP SCHEMA "${schema}" CASCADE`);
 * });
 * ```
 */

export { LegalHoldEntity } from './legal-hold.entity';
export {
  LegalHoldService,
  LEGAL_HOLD_CACHE_CLIENT,
} from './legal-hold.service';
export type { LegalHoldCacheClient } from './legal-hold.service';
export { LegalHoldModule } from './legal-hold.module';
export {
  LegalHoldActiveError,
  HOLD_SCOPES,
} from './legal-hold.types';
export type { HoldScope, LegalHoldRecord } from './legal-hold.types';
