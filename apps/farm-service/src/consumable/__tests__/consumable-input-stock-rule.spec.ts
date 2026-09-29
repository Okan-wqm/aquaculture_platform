/**
 * Consumable input DTOs — stock is ledger-owned (FARM-HIGH-337).
 *
 * WHY: CreateConsumableInput / UpdateConsumableInput could set `quantity`,
 * and the update input any status, beside the storage ledger. WHAT this pins,
 * under the global ValidationPipe options (whitelist + forbidNonWhitelisted):
 *   - `quantity` is not a field of either input and is rejected;
 *   - LOW_STOCK / OUT_OF_STOCK are rejected (they are derived bands);
 *   - AVAILABLE and DISCONTINUED (the one lifecycle status) are accepted.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { CreateConsumableInput } from '../dto/create-consumable.input';
import { UpdateConsumableInput } from '../dto/update-consumable.input';
import { ConsumableCategory, ConsumableStatus } from '../entities/consumable.entity';

const CONSUMABLE_ID = '22222222-2222-4222-8222-222222222222';
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

const CREATE_BASE = {
  name: 'Nitrile Gloves',
  code: 'PPE-01',
  category: ConsumableCategory.PPE,
  unit: 'box',
};

// Compile-time proof: neither input type has a `quantity` key.
type HasQuantity<T> = 'quantity' extends keyof T ? true : false;
const createHasQuantity: HasQuantity<CreateConsumableInput> = false;
const updateHasQuantity: HasQuantity<UpdateConsumableInput> = false;

async function createErrors(extra: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(
    plainToInstance(CreateConsumableInput, { ...CREATE_BASE, ...extra }),
    PIPE_OPTIONS,
  );
}

async function updateErrors(extra: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(
    plainToInstance(UpdateConsumableInput, { id: CONSUMABLE_ID, ...extra }),
    PIPE_OPTIONS,
  );
}

function constraintsOn(errors: ValidationError[], property: string): string[] {
  return errors
    .filter((error) => error.property === property)
    .flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('Consumable input DTOs — ledger-owned stock (FARM-HIGH-337)', () => {
  it('has no quantity key on either input type', () => {
    // SCENARIO: the type-level assertions above compile. EXPECTS: both false.
    expect([createHasQuantity, updateHasQuantity]).toEqual([false, false]);
  });

  it.each([
    ['create', createErrors],
    ['update', updateErrors],
  ])('%s input rejects a quantity field as non-whitelisted', async (_label, errorsFor) => {
    // SCENARIO: a client sends quantity. EXPECTS: forbidNonWhitelisted rejects it.
    const errors = await errorsFor({ quantity: 100 });
    expect(constraintsOn(errors, 'quantity')).toEqual(['whitelistValidation']);
  });

  it.each([ConsumableStatus.LOW_STOCK, ConsumableStatus.OUT_OF_STOCK])(
    'update input rejects the derived band %s',
    async (status) => {
      // SCENARIO: a client tries to set a stock band. EXPECTS: an isIn violation.
      expect(constraintsOn(await updateErrors({ status }), 'status')).toEqual(['isIn']);
    },
  );

  it.each([ConsumableStatus.AVAILABLE, ConsumableStatus.DISCONTINUED])(
    'update input accepts the settable status %s',
    async (status) => {
      // SCENARIO: DISCONTINUED or AVAILABLE ("derive from stock"). EXPECTS: valid.
      expect(await updateErrors({ status })).toEqual([]);
    },
  );

  it('update input accepts a minStock change on its own', async () => {
    // SCENARIO: only the reorder threshold moves. EXPECTS: valid input.
    expect(await updateErrors({ minStock: 8 })).toEqual([]);
  });
});
