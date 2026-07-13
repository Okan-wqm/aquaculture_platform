import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import type { BillingTenantProvisioningCommand } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { BillingAdminNatsHandler } from '../billing-admin-nats.handler';

/**
 * Regression guard for the billing subscription break (ORPHAN-CRITICAL-393 /
 * ORPHAN-HIGH-394).
 *
 * The handler must:
 *   - write billing.subscription_module_items from the command's priced
 *     moduleItems (real subtotal/discount/total), NEVER 0-hardcodes;
 *   - NEVER issue the schema-unqualified `SELECT ... FROM modules` query that
 *     failed (no billing grant on auth.modules) and rolled the whole
 *     SERIALIZABLE transaction — including the just-created subscription — back;
 *   - set the subscription's pricing.basePrice to the sum of module totals;
 *   - reject a command that selects modules but carries no moduleItems at the
 *     boundary (VALIDATION_ERROR), not mid-transaction.
 */
describe('BillingAdminNatsHandler.provisionTenantSubscription', () => {
  const MODULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MODULE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  let handler: BillingAdminNatsHandler;
  let recordedQueries: Array<{ sql: string; params: unknown[] }>;
  let dataSourceQuery: jest.Mock;

  const plan = {
    id: 'plan-starter-1',
    tier: 'starter',
    billingCycle: 'monthly',
    isActive: true,
    isDeleted: false,
    basePrice: 49,
    name: 'Starter',
    currency: 'USD',
    version: 1,
    sortOrder: 1,
    limits: { maxFarms: 1 },
    pricing: { perFarmPrice: 10, perSensorPrice: 2, perUserPrice: 5 },
  };

  const buildCommand = (
    overrides: Partial<BillingTenantProvisioningCommand> = {},
  ): BillingTenantProvisioningCommand => ({
    operationId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    idempotencyKey: 'idem-key-0123456789abcdef',
    requestPayloadHash: 'reqhash',
    actorId: '33333333-3333-4333-8333-333333333333',
    tenantName: 'Acme Aqua',
    tier: 'starter',
    billingCycle: 'monthly',
    moduleIds: [MODULE_A, MODULE_B],
    moduleItems: [
      {
        moduleId: MODULE_A,
        code: 'FARM',
        name: 'Farm Management',
        quantities: { moduleId: MODULE_A, farms: 2 },
        lineItems: [{ metric: 'base_price', total: 100 }],
        subtotal: 100,
        discountAmount: 0,
        total: 100,
      },
      {
        moduleId: MODULE_B,
        code: 'SENSOR',
        name: 'Sensors',
        quantities: { moduleId: MODULE_B, sensors: 5 },
        lineItems: [],
        subtotal: 50,
        discountAmount: 0,
        total: 50,
      },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    recordedQueries = [];

    const managerQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
      recordedQueries.push({ sql, params });
      if (/FROM billing\.command_receipts/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [];
      }
      if (/INSERT INTO billing\.command_receipts/.test(sql)) {
        return [
          {
            id: 'receipt-1',
            payloadHash: 'x',
            status: 'STARTED',
            resultSummary: null,
            updatedAt: new Date(),
          },
        ];
      }
      if (/FROM billing\.subscriptions/.test(sql) && /plan_id as "planId"/.test(sql)) {
        return [];
      }
      if (/INSERT INTO billing\.subscriptions/.test(sql)) {
        return [{ id: 'sub-1', status: 'active' }];
      }
      if (/INSERT INTO billing\.subscription_module_items/.test(sql)) {
        return [];
      }
      if (/SELECT COUNT\(\*\)/.test(sql) && /subscription_module_items/.test(sql)) {
        return [{ count: '2' }];
      }
      if (/UPDATE billing\.command_receipts/.test(sql)) {
        return [];
      }
      return [];
    });

    const mockManager = {
      query: managerQuery,
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(plan),
      }),
    };

    dataSourceQuery = jest.fn().mockResolvedValue([]);
    const mockDataSource = {
      transaction: jest.fn(
        async (_level: string, cb: (m: typeof mockManager) => Promise<unknown>) => cb(mockManager),
      ),
      query: dataSourceQuery,
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BillingAdminNatsHandler],
      providers: [
        { provide: CommandBus, useValue: { execute: jest.fn() } },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    handler = moduleRef.get(BillingAdminNatsHandler);
  });

  afterEach(() => jest.restoreAllMocks());

  it('writes module items from the command with real prices and never queries auth.modules', async () => {
    const result = await handler.provisionTenantSubscription(buildCommand());

    expect(result.success).toBe(true);
    expect(result.subscriptionId).toBe('sub-1');

    // The schema-unqualified cross-schema modules query must be gone.
    for (const { sql } of recordedQueries) {
      expect(sql).not.toMatch(/\bFROM\s+modules\b/i);
    }

    const moduleInserts = recordedQueries.filter((q) =>
      /INSERT INTO billing\.subscription_module_items/.test(q.sql),
    );
    expect(moduleInserts).toHaveLength(2);

    // Params order: [subscriptionId, moduleId, code, name, quantities, lineItems,
    //                subtotal, discountAmount, total, currency]
    const farmInsert = moduleInserts.find((q) => q.params[1] === MODULE_A);
    expect(farmInsert).toBeDefined();
    expect(farmInsert?.params[2]).toBe('FARM');
    expect(farmInsert?.params[3]).toBe('Farm Management');
    expect(farmInsert?.params[6]).toBe(100); // subtotal — NOT 0
    expect(farmInsert?.params[7]).toBe(0); // discountAmount
    expect(farmInsert?.params[8]).toBe(100); // total — NOT 0
    expect(farmInsert?.params[5]).toBe(JSON.stringify([{ metric: 'base_price', total: 100 }]));
  });

  it('sets subscription pricing.basePrice to the sum of module item totals', async () => {
    await handler.provisionTenantSubscription(buildCommand());

    const subInsert = recordedQueries.find((q) => /INSERT INTO billing\.subscriptions/.test(q.sql));
    expect(subInsert).toBeDefined();
    // pricing jsonb is param index 7 (JSON.stringify(pricing)).
    const pricing = JSON.parse(subInsert?.params[7] as string);
    expect(pricing.basePrice).toBe(150); // 100 + 50, NOT the catalog base (49)
  });

  it('rejects a command that selects modules but carries no moduleItems (VALIDATION_ERROR)', async () => {
    const result = await handler.provisionTenantSubscription(buildCommand({ moduleItems: [] }));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    // No subscription may be created for a rejected command.
    expect(recordedQueries.some((q) => /INSERT INTO billing\.subscriptions/.test(q.sql))).toBe(
      false,
    );
  });
});
