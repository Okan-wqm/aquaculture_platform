/**
 * The discount writer, against a fake DataSource (ADR-0013 /
 * BILLING-CRITICAL-002).
 *
 * Two behaviours are the reason this service exists at all and are pinned
 * here:
 *
 *   - `create` refuses a value that does not belong to the kind. The admin
 *     table stored a percentage and an amount in one `numeric(10,2)`, so 150
 *     was a legal 150% and a legal $150 at once.
 *   - `apply` takes the code row FOR UPDATE before asking any rule. The
 *     previous implementation validated, inserted a redemption, then did a
 *     read-modify-write of `currentRedemptions`, so two requests racing on the
 *     last remaining use both passed and both redeemed.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { BillingDiscountCodeInput } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import {
  DiscountAppliesTo,
  DiscountCode,
  DiscountDuration,
  DiscountRedemption,
  DiscountType,
} from '../entities/discount-code.entity';
import {
  DiscountCodeService,
  DiscountRejectedError,
  normalizeCode,
  toDiscountCodeSnapshot,
} from '../services/discount-code.service';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const TENANT = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<DiscountCode> = {}): DiscountCode {
  return Object.assign(
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      code: 'SUMMER',
      name: 'Summer',
      description: null,
      discountType: DiscountType.PERCENTAGE,
      percentOff: new Decimal('10'),
      amountOff: null,
      freeMonths: null,
      trialExtensionDays: null,
      currency: 'USD',
      appliesTo: DiscountAppliesTo.ALL_PLANS,
      applicablePlanIds: null,
      duration: DiscountDuration.ONCE,
      durationInMonths: null,
      isActive: true,
      validFrom: null,
      validUntil: null,
      maxRedemptions: null,
      currentRedemptions: 0,
      maxRedemptionsPerTenant: null,
      minimumOrderAmount: null,
      campaignId: null,
      campaignName: null,
      stripePromotionCodeId: null,
      stripeCouponId: null,
      metadata: null,
      isReferralCode: false,
      referrerId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      updatedBy: null,
    } satisfies DiscountCode,
    overrides,
  );
}

interface Fakes {
  service: DiscountCodeService;
  codeRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  redemptionRepo: { count: jest.Mock; create: jest.Mock; save: jest.Mock };
  txCodeRepo: { findOne: jest.Mock; save: jest.Mock };
  txRedemptionRepo: { count: jest.Mock; create: jest.Mock; save: jest.Mock };
}

async function build(): Promise<Fakes> {
  const codeRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((value: Partial<DiscountCode>) => value),
    save: jest.fn((value: DiscountCode) => Promise.resolve(value)),
  };
  const redemptionRepo = {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((value: Partial<DiscountRedemption>) => value),
    save: jest.fn((value: DiscountRedemption) => Promise.resolve({ ...value, id: 'redemption-1' })),
  };
  // `apply` reaches the database through the entity-first EntityManager
  // overloads, so every statement stays on the transaction's own connection
  // and the claimed row stays locked. These fakes mirror that surface.
  const txCodeRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((value: DiscountCode) => Promise.resolve(value)),
  };
  const txRedemptionRepo = {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((value: Partial<DiscountRedemption>) => value),
    save: jest.fn((value: DiscountRedemption) => Promise.resolve({ ...value, id: 'redemption-1' })),
  };

  const manager = {
    findOne: (entity: unknown, options: unknown) =>
      entity === DiscountCode ? txCodeRepo.findOne(options) : Promise.resolve(null),
    count: (entity: unknown, options: unknown) =>
      entity === DiscountRedemption ? txRedemptionRepo.count(options) : Promise.resolve(0),
    create: (entity: unknown, value: Partial<DiscountRedemption>) =>
      entity === DiscountRedemption ? txRedemptionRepo.create(value) : value,
    // `manager.save(entity)` without a target: a redemption draft carries no
    // id, a claimed code always does.
    save: (value: { id?: string; discountCodeId?: string }) =>
      value.discountCodeId === undefined
        ? txCodeRepo.save(value as DiscountCode)
        : txRedemptionRepo.save(value as DiscountRedemption),
  };

  const dataSource = {
    transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      DiscountCodeService,
      { provide: getRepositoryToken(DiscountCode), useValue: codeRepo },
      { provide: getRepositoryToken(DiscountRedemption), useValue: redemptionRepo },
      { provide: getDataSourceToken(), useValue: dataSource },
    ],
  }).compile();

  return {
    service: moduleRef.get(DiscountCodeService),
    codeRepo,
    redemptionRepo,
    txCodeRepo,
    txRedemptionRepo,
  };
}

const percentageInput = (over: Partial<BillingDiscountCodeInput> = {}): BillingDiscountCodeInput =>
  ({
    name: 'Summer',
    discountType: 'percentage',
    percentOff: '10',
    ...over,
  }) as BillingDiscountCodeInput;

describe('normalizeCode', () => {
  it('upper-cases and strips punctuation', () => {
    expect(normalizeCode('summer-2026!')).toBe('SUMMER2026');
  });

  it('refuses a code that normalises to nothing usable', () => {
    expect(() => normalizeCode('--')).toThrow(BadRequestException);
  });
});

describe('DiscountCodeService.create (BILLING-CRITICAL-002)', () => {
  it('writes the percentage into its own column and leaves the others null', async () => {
    const { service, codeRepo } = await build();
    await service.create('summer2026', percentageInput(), ACTOR);

    const written = codeRepo.create.mock.calls[0]?.[0] as Partial<DiscountCode>;
    expect(written.code).toBe('SUMMER2026');
    expect(written.percentOff?.toString()).toBe('10');
    expect(written.amountOff).toBeNull();
    expect(written.freeMonths).toBeNull();
    expect(written.trialExtensionDays).toBeNull();
    expect(written.createdBy).toBe(ACTOR);
  });

  it('refuses a percentage above 100 — the value the old shared column allowed', async () => {
    const { service } = await build();
    await expect(
      service.create('OVER', percentageInput({ percentOff: '150' }), ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a zero or negative value', async () => {
    const { service } = await build();
    await expect(
      service.create('ZERO', percentageInput({ percentOff: '0' }), ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a fractional month count', async () => {
    const { service } = await build();
    await expect(
      service.create(
        'HALF',
        {
          name: 'Half',
          discountType: 'free_months',
          freeMonths: 2.5,
        } as BillingDiscountCodeInput,
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a validity window that ends before it starts', async () => {
    const { service } = await build();
    await expect(
      service.create(
        'WINDOW',
        percentageInput({ validFrom: '2026-06-01T00:00:00Z', validUntil: '2026-05-01T00:00:00Z' }),
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a duplicate code', async () => {
    const { service, codeRepo } = await build();
    codeRepo.findOne.mockResolvedValueOnce(row());
    await expect(service.create('SUMMER', percentageInput(), ACTOR)).rejects.toThrow(
      ConflictException,
    );
  });

  it('rounds a fixed amount to the currency minor unit', async () => {
    const { service, codeRepo } = await build();
    await service.create(
      'JPYOFF',
      {
        name: 'Yen',
        discountType: 'fixed_amount',
        amountOff: '500.4',
        currency: 'jpy',
      } as BillingDiscountCodeInput,
      ACTOR,
    );
    const written = codeRepo.create.mock.calls[0]?.[0] as Partial<DiscountCode>;
    expect(written.currency).toBe('JPY');
    expect(written.amountOff?.toString()).toBe('500');
  });
});

describe('DiscountCodeService.apply (BILLING-CRITICAL-002)', () => {
  it('locks the code row before asking any rule', async () => {
    const { service, txCodeRepo } = await build();
    txCodeRepo.findOne.mockResolvedValue(row());

    await service.apply('SUMMER', TENANT, new Decimal('100.00'), { redeemedBy: ACTOR });

    expect(txCodeRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('records the redemption, advances the counter and returns exact amounts', async () => {
    const { service, txCodeRepo, txRedemptionRepo } = await build();
    const subject = row({ percentOff: new Decimal('25') });
    txCodeRepo.findOne.mockResolvedValue(subject);

    const applied = await service.apply('SUMMER', TENANT, new Decimal('80.00'), {
      redeemedBy: ACTOR,
      invoiceId: 'inv-1',
    });

    expect(applied.discountAmount.toString()).toBe('20');
    expect(applied.finalAmount.toString()).toBe('60');
    expect(applied.redemptionId).toBe('redemption-1');
    expect(txRedemptionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, currency: 'USD', invoiceId: 'inv-1' }),
    );
    // Advanced on the LOCKED row, so a concurrent redeemer waits for this
    // transaction rather than reading a stale count.
    expect(subject.currentRedemptions).toBe(1);
    expect(txCodeRepo.save).toHaveBeenCalledWith(subject);
  });

  it('refuses the last use twice — the counter is checked under the lock', async () => {
    const { service, txCodeRepo, txRedemptionRepo } = await build();
    txCodeRepo.findOne.mockResolvedValue(row({ maxRedemptions: 1, currentRedemptions: 1 }));

    await expect(service.apply('SUMMER', TENANT, new Decimal('100.00'), {})).rejects.toBeInstanceOf(
      DiscountRejectedError,
    );
    expect(txRedemptionRepo.save).not.toHaveBeenCalled();
  });

  it('refuses an unknown code with a reason rather than a crash', async () => {
    const { service, txCodeRepo } = await build();
    txCodeRepo.findOne.mockResolvedValue(null);
    await expect(service.apply('NOPE', TENANT, new Decimal('1.00'), {})).rejects.toMatchObject({
      reason: 'unknown_code',
    });
  });

  it('records a zero-money redemption for a free-months code and reports the grant', async () => {
    const { service, txCodeRepo, txRedemptionRepo } = await build();
    txCodeRepo.findOne.mockResolvedValue(
      row({ discountType: DiscountType.FREE_MONTHS, percentOff: null, freeMonths: 3 }),
    );

    const applied = await service.apply('FREE3', TENANT, new Decimal('100.00'), {});

    expect(applied.grantedFreeMonths).toBe(3);
    expect(applied.discountAmount.toString()).toBe('0');
    expect(applied.finalAmount.toString()).toBe('100');
    expect(txRedemptionRepo.save).toHaveBeenCalled();
  });

  it('counts this tenant’s own redemptions under the same lock', async () => {
    const { service, txCodeRepo, txRedemptionRepo } = await build();
    txCodeRepo.findOne.mockResolvedValue(row({ maxRedemptionsPerTenant: 1 }));
    txRedemptionRepo.count.mockResolvedValue(1);

    await expect(service.apply('SUMMER', TENANT, new Decimal('10.00'), {})).rejects.toMatchObject({
      reason: 'tenant_limit_reached',
    });
  });
});

describe('toDiscountCodeSnapshot', () => {
  it('sends the value branch that matches the kind, as exact decimal strings', () => {
    expect(toDiscountCodeSnapshot(row())).toMatchObject({
      discountType: 'percentage',
      percentOff: '10',
      currency: 'USD',
    });

    const fixed = toDiscountCodeSnapshot(
      row({
        discountType: DiscountType.FIXED_AMOUNT,
        percentOff: null,
        amountOff: new Decimal('19.9900'),
      }),
    );
    expect(fixed).toMatchObject({ discountType: 'fixed_amount', amountOff: '19.99' });
    expect(fixed).not.toHaveProperty('percentOff');
  });
});
