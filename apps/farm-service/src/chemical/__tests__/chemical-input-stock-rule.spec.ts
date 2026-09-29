/**
 * Chemical input DTOs — stock is ledger-owned (FARM-HIGH-337).
 *
 * WHY: CreateChemicalInput / UpdateChemicalInput could set `quantity`, and the
 * update input any status, beside the storage ledger. WHAT this pins, under
 * the global ValidationPipe options (whitelist + forbidNonWhitelisted):
 *   - `quantity` is not a field of either input and is rejected;
 *   - LOW_STOCK / OUT_OF_STOCK are rejected (they are derived bands);
 *   - AVAILABLE and the lifecycle statuses are accepted.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { CreateChemicalInput } from '../dto/create-chemical.input';
import { UpdateChemicalInput } from '../dto/update-chemical.input';
import { ChemicalStatus, ChemicalType } from '../entities/chemical.entity';

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const CHEMICAL_ID = '22222222-2222-4222-8222-222222222222';
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

const CREATE_BASE = {
  name: 'Hydrogen Peroxide',
  code: 'H2O2-01',
  type: ChemicalType.DISINFECTANT,
  unit: 'L',
  siteId: SITE_ID,
};

// Compile-time proof: neither input type has a `quantity` key.
type HasQuantity<T> = 'quantity' extends keyof T ? true : false;
const createHasQuantity: HasQuantity<CreateChemicalInput> = false;
const updateHasQuantity: HasQuantity<UpdateChemicalInput> = false;

async function createErrors(extra: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(CreateChemicalInput, { ...CREATE_BASE, ...extra }), PIPE_OPTIONS);
}

async function updateErrors(extra: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(
    plainToInstance(UpdateChemicalInput, { id: CHEMICAL_ID, ...extra }),
    PIPE_OPTIONS,
  );
}

function constraintsOn(errors: ValidationError[], property: string): string[] {
  return errors
    .filter((error) => error.property === property)
    .flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('Chemical input DTOs — ledger-owned stock (FARM-HIGH-337)', () => {
  it('has no quantity key on either input type', () => {
    // SCENARIO: the type-level assertions above compile. EXPECTS: both false.
    expect([createHasQuantity, updateHasQuantity]).toEqual([false, false]);
  });

  it.each([
    ['create', createErrors],
    ['update', updateErrors],
  ])('%s input rejects a quantity field as non-whitelisted', async (_label, errorsFor) => {
    // SCENARIO: a client sends quantity. EXPECTS: forbidNonWhitelisted rejects it.
    const errors = await errorsFor({ quantity: 3 });
    expect(constraintsOn(errors, 'quantity')).toEqual(['whitelistValidation']);
  });

  it.each([ChemicalStatus.LOW_STOCK, ChemicalStatus.OUT_OF_STOCK])(
    'update input rejects the derived band %s',
    async (status) => {
      // SCENARIO: a client tries to set a stock band. EXPECTS: an isIn violation.
      expect(constraintsOn(await updateErrors({ status }), 'status')).toEqual(['isIn']);
    },
  );

  it.each([ChemicalStatus.AVAILABLE, ChemicalStatus.EXPIRED, ChemicalStatus.DISCONTINUED])(
    'update input accepts the settable status %s',
    async (status) => {
      // SCENARIO: lifecycle status or AVAILABLE ("derive from stock"). EXPECTS: valid.
      expect(await updateErrors({ status })).toEqual([]);
    },
  );

  it('update input accepts a minStock change on its own', async () => {
    // SCENARIO: only the reorder threshold moves. EXPECTS: valid input.
    expect(await updateErrors({ minStock: 20 })).toEqual([]);
  });
});
