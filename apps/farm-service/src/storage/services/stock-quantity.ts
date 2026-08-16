import { BadRequestException } from '@nestjs/common';

const STOCK_QUANTITY_SCALE = 100;

/** Sole fixed-cent quantity compiler for every stock mutation/allocation path. */
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

export function stockQuantityFromUnits(units: number): number {
  if (!Number.isSafeInteger(units)) {
    throw new BadRequestException('Stock quantity units must be a safe integer');
  }
  return units / STOCK_QUANTITY_SCALE;
}
