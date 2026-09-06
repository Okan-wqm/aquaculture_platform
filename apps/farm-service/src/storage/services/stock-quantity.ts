/**
 * Stock quantity arithmetic — the ONE place kilograms become integers.
 *
 * `storage_inventory.quantity` and `stock_movements.quantity` are
 * `numeric(15,2)`. Allocation used to accumulate in IEEE-754 doubles and lean
 * on a `KG_EPSILON` tolerance to decide whether the remainder had converged:
 * a tolerance is a place where "nearly allocated" can pass for "allocated",
 * and the residue it hides is exactly the 0.2–2 kg class that FARM-CRITICAL-245
 * is about. Compiling to fixed hundredths first makes the sum EXACT, so the
 * convergence check is `=== 0` rather than `< epsilon` and no tolerance is
 * needed anywhere downstream.
 *
 * Ported from the 2026-08-16 farm-stock-mutation worktree
 * (`origin/wip/codex-farm-stock-mutation-20260816`), which reached the same
 * conclusion independently on the same eight files.
 *
 * @module Storage/Services
 */
import { BadRequestException } from '@nestjs/common';

/** Hundredths — matches the `numeric(15,2)` scale of every stock column. */
const STOCK_QUANTITY_SCALE = 100;

/**
 * Compile a kilogram amount to integer hundredths, refusing anything the
 * column could not hold exactly.
 *
 * @throws BadRequestException when the value is non-finite, has the wrong
 *   sign, or carries more than two decimal places.
 */
export function stockQuantityUnits(
  quantity: number,
  field: string,
  options: { allowZero?: boolean } = {},
): number {
  const validSign = options.allowZero ? quantity >= 0 : quantity > 0;
  if (!Number.isFinite(quantity) || !validSign) {
    throw new BadRequestException(
      `${field} must be ${options.allowZero ? 'non-negative' : 'positive'}`,
    );
  }
  const units = Math.round(quantity * STOCK_QUANTITY_SCALE);
  if (!Number.isSafeInteger(units) || Math.abs(units / STOCK_QUANTITY_SCALE - quantity) > 1e-9) {
    throw new BadRequestException(`${field} supports at most two decimal places`);
  }
  return units;
}

/** Inverse of {@link stockQuantityUnits}. */
export function stockQuantityFromUnits(units: number): number {
  if (!Number.isSafeInteger(units)) {
    throw new BadRequestException('Stock quantity units must be a safe integer');
  }
  return units / STOCK_QUANTITY_SCALE;
}
