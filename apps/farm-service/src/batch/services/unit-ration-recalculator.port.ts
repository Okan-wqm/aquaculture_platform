/**
 * UnitRationRecalculator — the port `TankBatchService` settles a stock change
 * through. Implemented by `DayPlanRecalcService` (feeding-protocol) and bound in
 * `TankBatchModule`.
 *
 * WHY a port rather than a direct dependency: the batch domain must not import
 * the feeding engine's types to guarantee its own invariant. The invariant is
 * "a stock change reprices the day"; WHO reprices is a wiring decision. The
 * dependency is inverted so the batch side owns the contract and the feeding
 * side implements it (`implements UnitRationRecalculator` on the service is the
 * compile-time proof the two still agree).
 *
 * WHY it is not optional: the token is injected without `@Optional()`, so a
 * deployment that forgets to bind a recalculator does not boot. There is no
 * configuration in which a tank's stock can change while nothing reprices the
 * day's remaining meals.
 *
 * @module Batch/Services
 */
import { EntityManager } from 'typeorm';

/**
 * The classified reasons a unit's stock changes. Every one of them moves the
 * day's ration basis by the signed biomass that entered or left the unit.
 *
 * The feeding side widens this into `RecalcLogEntry['reason']`; a value added
 * here that has no log counterpart is a compile error there, so the audit trail
 * cannot fall behind the write paths.
 */
export type StockChangeReason =
  /** Fish stocked into the unit (initial stocking, transfer-in, split). */
  | 'allocation'
  | 'mortality'
  | 'cull'
  | 'transfer'
  | 'harvest'
  /** A cancelled harvest putting the fish back. */
  | 'harvest_reversal'
  /** Operator-applied correction from the allocation/operation ledger. */
  | 'count_reconcile';

export interface UnitRationRecalculator {
  /**
   * Reprice the unit's remaining meals for today, inside the caller's
   * transaction, after its stock changed by `stockBiomassDeltaKg` (signed).
   *
   * Called exactly once per touched unit by `TankBatchService.applyStockChange`,
   * after every delta of that stock change has been written.
   */
  recalcAfterStockChange(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    reason: StockChangeReason,
    stockBiomassDeltaKg: number,
  ): Promise<void>;
}

/** DI token for {@link UnitRationRecalculator} (interfaces have no runtime identity). */
export const UNIT_RATION_RECALCULATOR = Symbol('UNIT_RATION_RECALCULATOR');
