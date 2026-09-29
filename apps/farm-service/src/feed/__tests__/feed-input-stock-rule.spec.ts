/**
 * Feed input DTOs — stock is ledger-owned (FARM-HIGH-337).
 *
 * WHY: CreateFeedInput / UpdateFeedInput could set `quantity` and any status
 * directly, a second writer beside the storage ledger. WHAT this pins, under
 * the global ValidationPipe options (whitelist + forbidNonWhitelisted):
 *   - `quantity` is not a field of either input and is rejected;
 *   - LOW_STOCK / OUT_OF_STOCK are rejected (they are derived bands);
 *   - AVAILABLE and the lifecycle statuses are accepted.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { CreateFeedInput } from '../dto/create-feed.input';
import { UpdateFeedInput } from '../dto/update-feed.input';
import { FeedStatus, FeedType } from '../entities/feed.entity';

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const FEED_ID = '22222222-2222-4222-8222-222222222222';
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

const CREATE_BASE = {
  name: 'Starter Pellet',
  code: 'ST-01',
  type: FeedType.STARTER,
  siteId: SITE_ID,
};
const UPDATE_BASE = { id: FEED_ID };

// Compile-time proof: neither input type has a `quantity` key.
type HasQuantity<T> = 'quantity' extends keyof T ? true : false;
const createHasQuantity: HasQuantity<CreateFeedInput> = false;
const updateHasQuantity: HasQuantity<UpdateFeedInput> = false;

async function createErrors(extra: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(CreateFeedInput, { ...CREATE_BASE, ...extra }), PIPE_OPTIONS);
}

async function updateErrors(extra: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(UpdateFeedInput, { ...UPDATE_BASE, ...extra }), PIPE_OPTIONS);
}

function constraintsOn(errors: ValidationError[], property: string): string[] {
  return errors
    .filter((error) => error.property === property)
    .flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('Feed input DTOs — ledger-owned stock (FARM-HIGH-337)', () => {
  it('has no quantity key on either input type', () => {
    // SCENARIO: the type-level assertions above compile. EXPECTS: both false.
    expect([createHasQuantity, updateHasQuantity]).toEqual([false, false]);
  });

  it.each([
    ['create', createErrors],
    ['update', updateErrors],
  ])('%s input rejects a quantity field as non-whitelisted', async (_label, errorsFor) => {
    // SCENARIO: a client sends quantity. EXPECTS: forbidNonWhitelisted rejects it.
    const errors = await errorsFor({ quantity: 12 });
    expect(constraintsOn(errors, 'quantity')).toEqual(['whitelistValidation']);
  });

  it.each([
    ['create', FeedStatus.LOW_STOCK, createErrors],
    ['create', FeedStatus.OUT_OF_STOCK, createErrors],
    ['update', FeedStatus.LOW_STOCK, updateErrors],
    ['update', FeedStatus.OUT_OF_STOCK, updateErrors],
  ])('%s input rejects the derived band %s', async (_label, status, errorsFor) => {
    // SCENARIO: a client tries to set a stock band. EXPECTS: an isIn violation.
    const errors = await errorsFor({ status });
    expect(constraintsOn(errors, 'status')).toEqual(['isIn']);
  });

  it.each([
    ['create', FeedStatus.AVAILABLE, createErrors],
    ['create', FeedStatus.EXPIRED, createErrors],
    ['create', FeedStatus.DISCONTINUED, createErrors],
    ['update', FeedStatus.AVAILABLE, updateErrors],
    ['update', FeedStatus.EXPIRED, updateErrors],
    ['update', FeedStatus.DISCONTINUED, updateErrors],
  ])('%s input accepts the settable status %s', async (_label, status, errorsFor) => {
    // SCENARIO: lifecycle status or AVAILABLE ("derive from stock"). EXPECTS: valid.
    expect(await errorsFor({ status })).toEqual([]);
  });

  it('update input accepts a minStock change on its own', async () => {
    // SCENARIO: only the reorder threshold moves. EXPECTS: valid input.
    expect(await updateErrors({ minStock: 50 })).toEqual([]);
  });
});
