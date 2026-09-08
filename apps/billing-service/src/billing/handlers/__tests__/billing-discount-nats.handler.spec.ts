/**
 * The discount command surface (ADR-0013 / BILLING-CRITICAL-002).
 *
 * The distinction this pins: a code REFUSED by a business rule is an answer,
 * not a transport failure. `apply` replies `success: true, valid: false` with
 * the reason and the undiscounted amounts, so admin-api renders "expired"
 * instead of a 502; only a malformed command or a broken invariant comes back
 * as an errorCode.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import Decimal from 'decimal.js';

import { BillingDiscountNatsHandler } from '../billing-discount-nats.handler';
import { DiscountCodeService, DiscountRejectedError } from '../../services/discount-code.service';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const TENANT = '22222222-2222-4222-8222-222222222222';

describe('BillingDiscountNatsHandler', () => {
  let discounts: { apply: jest.Mock; validate: jest.Mock; create: jest.Mock };
  let bypassRls: { withBypass: jest.Mock };
  let handler: BillingDiscountNatsHandler;

  beforeEach(async () => {
    discounts = { apply: jest.fn(), validate: jest.fn(), create: jest.fn() };
    bypassRls = {
      withBypass: jest.fn((_label: string, work: () => Promise<unknown>) => work()),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingDiscountNatsHandler],
      providers: [
        { provide: DiscountCodeService, useValue: discounts },
        { provide: BypassRlsService, useValue: bypassRls },
      ],
    }).compile();
    handler = moduleRef.get(BillingDiscountNatsHandler);
  });

  it('runs every command under an audited RLS bypass', async () => {
    discounts.apply.mockResolvedValue({
      originalAmount: new Decimal('10'),
      discountAmount: new Decimal('1'),
      finalAmount: new Decimal('9'),
      redemptionId: 'r1',
      message: 'ok',
    });

    await handler.applyDiscountCode({
      code: 'X',
      tenantId: TENANT,
      orderAmount: '10',
      actorId: ACTOR,
    });

    expect(bypassRls.withBypass).toHaveBeenCalledWith(
      'billing-discount:apply-discount-code',
      expect.any(Function),
    );
  });

  it('answers a refused code with the reason and the undiscounted amounts', async () => {
    discounts.apply.mockRejectedValue(
      new DiscountRejectedError('expired', 'This discount code has expired'),
    );

    const result = await handler.applyDiscountCode({
      code: 'OLD',
      tenantId: TENANT,
      orderAmount: '250.00',
      actorId: ACTOR,
    });

    expect(result).toEqual({
      success: true,
      valid: false,
      reason: 'expired',
      originalAmount: '250',
      discountAmount: '0',
      finalAmount: '250',
      message: 'This discount code has expired',
    });
  });

  it('reports a genuine failure as an errorCode, not as a refusal', async () => {
    discounts.apply.mockRejectedValue(new Error('connection terminated'));

    const result = await handler.applyDiscountCode({
      code: 'X',
      tenantId: TENANT,
      orderAmount: '10',
      actorId: ACTOR,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INTERNAL_ERROR');
    expect(result.valid).toBeUndefined();
  });

  it('maps a rejected create to VALIDATION_ERROR so admin-api answers 400', async () => {
    discounts.create.mockRejectedValue(new BadRequestException('percentOff must be at most 100'));

    const result = await handler.createDiscountCode({
      code: 'OVER',
      input: { name: 'Over', discountType: 'percentage', percentOff: '150' },
      actorId: ACTOR,
    });

    expect(result).toMatchObject({ success: false, errorCode: 'VALIDATION_ERROR' });
  });

  it('maps a missing code to NOT_FOUND', async () => {
    discounts.validate.mockRejectedValue(new NotFoundException('gone'));

    const result = await handler.validateDiscountCode({
      code: 'GONE',
      tenantId: TENANT,
      actorId: ACTOR,
    });

    expect(result).toMatchObject({ success: false, valid: false, errorCode: 'NOT_FOUND' });
  });

  it('passes the order amount through as an exact Decimal, never a float', async () => {
    discounts.validate.mockResolvedValue({ valid: true, message: 'ok' });

    await handler.validateDiscountCode({
      code: 'X',
      tenantId: TENANT,
      orderAmount: '19.99',
      actorId: ACTOR,
      subscriptionChange: 'upgrade',
    });

    expect(discounts.validate).toHaveBeenCalledWith('X', TENANT, {
      planId: undefined,
      subscriptionChange: 'upgrade',
      orderAmount: new Decimal('19.99'),
    });
  });
});
