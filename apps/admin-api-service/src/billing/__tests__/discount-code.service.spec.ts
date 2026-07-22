/**
 * APA-107 — the discount code shown to the admin (generateUniqueCode) must be
 * the exact code stored by create(): one financial identifier, one canonical
 * form. Before the fix, generateUniqueCode emitted `PREFIX_XXXXXXXX` (underscore
 * joined) while create() silently stripped the underscore via
 * replace(/[^A-Z0-9]/g,''), so the code the admin communicated was NOT the code
 * stored or looked up.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/billing-plans.md#APA-107
 */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  DiscountAppliesTo,
  DiscountCode,
  DiscountDuration,
  DiscountRedemption,
  DiscountType,
} from '../entities/discount-code.entity';
import { DiscountCodeService } from '../services/discount-code.service';

describe('DiscountCodeService code canonicalisation (APA-107)', () => {
  let service: DiscountCodeService;
  let discountRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    discountRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((e: unknown) => e),
      save: jest.fn(async (e: Record<string, unknown>) => ({ id: 'dc-1', ...e })),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscountCodeService,
        { provide: getRepositoryToken(DiscountCode), useValue: discountRepo },
        { provide: getRepositoryToken(DiscountRedemption), useValue: { count: jest.fn() } },
        { provide: ConfigService, useValue: { get: (): string => 'USD' } },
      ],
    }).compile();
    service = module.get(DiscountCodeService);
  });

  const baseDto = {
    name: 'Promo',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    appliesTo: DiscountAppliesTo.ALL_PLANS,
    duration: DiscountDuration.ONCE,
    createdBy: 'operator-1',
  };

  it('generate -> create stores exactly the displayed code (prefixed, no underscore)', async () => {
    const generated = await service.generateUniqueCode('PROMO', 8);
    expect(generated).toMatch(/^PROMO[A-Z0-9]{8}$/);
    expect(generated).not.toContain('_');

    await service.create({ ...baseDto, code: generated });

    const savedArg = discountRepo.save.mock.calls[0]?.[0] as { code: string };
    expect(savedArg.code).toBe(generated); // stored === displayed
  });

  it('rejects a code carrying characters outside A-Z0-9 instead of silently stripping them', async () => {
    await expect(
      service.create({ ...baseDto, code: 'PROMO_ABC' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(discountRepo.save).not.toHaveBeenCalled();
  });
});
