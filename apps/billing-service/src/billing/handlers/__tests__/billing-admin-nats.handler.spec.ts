import { Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { BillingCommandReceiptService } from '../../services/billing-command-receipt.service';
import { SubscriptionWriterService } from '../../services/subscription-writer.service';
import type {
  BillingAdminCreateInvoiceCommand,
  BillingTenantProvisioningCommand,
} from '@platform/event-contracts';
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
  const TENANT = '22222222-2222-4222-8222-222222222222';
  const MODULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MODULE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  let handler: BillingAdminNatsHandler;
  let recordedQueries: Array<{ sql: string; params: unknown[] }>;
  let dataSourceQuery: jest.Mock;
  let bypassRls: { withBypass: jest.Mock };
  let planFindOne: jest.Mock;
  let subscriptionWriter: { ensureStripeObjects: jest.Mock; createWithin: jest.Mock };
  let mockDataSourceRef: { transaction: jest.Mock; manager: { query: jest.Mock } };

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
    // W4b normalised the per-cycle matrix into rows; a cycle is purchasable
    // exactly when the plan carries one.
    cyclePrices: [
      { billingCycle: 'monthly', discountPercent: new Decimal(0) },
      { billingCycle: 'quarterly', discountPercent: new Decimal(5) },
      { billingCycle: 'semi_annual', discountPercent: new Decimal(10) },
      // Deliberately NOT the platform default: this is the plan's own term,
      // and the sale must snapshot it rather than a global constant.
      { billingCycle: 'annual', discountPercent: new Decimal(22) },
    ],
  };

  const buildCommand = (
    overrides: Partial<BillingTenantProvisioningCommand> = {},
  ): BillingTenantProvisioningCommand => ({
    operationId: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT,
    idempotencyKey: 'idem-key-0123456789abcdef',
    correlationId: 'corr-0123456789abcdef',
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
        subtotal: '100',
        discountAmount: '0',
        total: '100',
      },
      {
        moduleId: MODULE_B,
        code: 'SENSOR',
        name: 'Sensors',
        quantities: { moduleId: MODULE_B, sensors: 5 },
        lineItems: [],
        subtotal: '50',
        discountAmount: '0',
        total: '50',
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

    planFindOne = jest.fn().mockResolvedValue(plan);
    const mockManager = {
      query: managerQuery,
      getRepository: jest.fn().mockReturnValue({
        findOne: planFindOne,
      }),
    };

    // ADR-0014: the subscription row is written by SubscriptionWriterService
    // now, not by a raw INSERT here. This spec is about the provisioning
    // ORCHESTRATION — receipts, the RLS bypass, module items — so the writer is
    // a collaborator, and what it was ASKED for is the assertion.
    subscriptionWriter = {
      ensureStripeObjects: jest.fn().mockResolvedValue({
        stripeCustomerId: 'cus_test',
        stripeSubscriptionId: 'sub_test',
      }),
      createWithin: jest.fn().mockResolvedValue({ id: 'sub-1', status: 'active' }),
    };

    // dataSource.query is the OUT-OF-TRANSACTION path (the failure receipt in
    // markBillingReceiptFailed). Record it into the same ordered log so a test
    // can prove it also runs AFTER the RLS bypass was granted.
    dataSourceQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
      recordedQueries.push({ sql, params });
      return [];
    });
    const mockDataSource = {
      transaction: jest.fn(
        async (_level: string, cb: (m: typeof mockManager) => Promise<unknown>) => cb(mockManager),
      ),
      query: dataSourceQuery,
      // The plan is resolved OUTSIDE the receipt transaction now, so the Stripe
      // objects can be minted before it opens (SSOT-C-12).
      manager: mockManager,
    };
    mockDataSourceRef = mockDataSource;

    // London-style collaborator: the real BypassRlsService.withBypass sets
    // app.bypass_rls='on' for the callback's async frame (RlsConnectionBootstrap
    // reads it on pool checkout). The mock records the grant in query order and
    // runs the callback so the receipt/subscription writes still execute — which
    // lets a test prove the grant precedes every command_receipts write.
    bypassRls = {
      withBypass: jest.fn(async (operation: string, cb: () => Promise<unknown>) => {
        recordedQueries.push({ sql: `__BYPASS_GRANTED__ ${operation}`, params: [] });
        return cb();
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BillingAdminNatsHandler],
      providers: [
        // The controller binds BillingCommandReceiptInterceptor. At-most-once
        // behaviour is covered by its own spec; here it only has to construct.
        { provide: BillingCommandReceiptService, useValue: { runOnce: jest.fn() } },
        { provide: CommandBus, useValue: { execute: jest.fn() } },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SubscriptionWriterService, useValue: subscriptionWriter },
        { provide: BypassRlsService, useValue: bypassRls },
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
    // ADR-0013: money crosses as an exact decimal string and goes straight
    // into the `numeric` column — Postgres parses it losslessly, so nothing on
    // this path widens a price through a double.
    expect(farmInsert?.params[6]).toBe('100'); // subtotal — NOT 0
    expect(farmInsert?.params[7]).toBe('0'); // discountAmount
    expect(farmInsert?.params[8]).toBe('100'); // total — NOT 0
    expect(farmInsert?.params[5]).toBe(JSON.stringify([{ metric: 'base_price', total: 100 }]));
  });

  it('sets subscription pricing.basePrice to the sum of module item totals', async () => {
    await handler.provisionTenantSubscription(buildCommand());

    const written = subscriptionWriter.createWithin.mock.calls[0]?.[1];
    expect(written.pricing.basePrice).toBe(150); // 100 + 50, NOT the catalog base (49)
  });

  // ADR-0014: the raw INSERT this replaced left stripe_customer_id and
  // stripe_subscription_id NULL, so every tenant an operator provisioned had a
  // subscription this platform believed in and Stripe had never heard of.
  it('mints the Stripe objects and writes them onto the subscription', async () => {
    await handler.provisionTenantSubscription(buildCommand());

    expect(subscriptionWriter.ensureStripeObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: '22222222-2222-4222-8222-222222222222',
        billingCycle: 'monthly',
      }),
    );
    const written = subscriptionWriter.createWithin.mock.calls[0]?.[1];
    expect(written.stripe).toEqual({
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
    });
  });

  it('mints the Stripe objects BEFORE the receipt transaction opens', async () => {
    // A network call inside the SERIALIZABLE transaction would hold a pool
    // connection for its whole duration (SSOT-C-12).
    const order: string[] = [];
    subscriptionWriter.ensureStripeObjects.mockImplementation(async () => {
      order.push('stripe');
      return { stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test' };
    });
    const transaction = mockDataSourceRef.transaction as jest.Mock;
    const original = transaction.getMockImplementation()!;
    transaction.mockImplementation(async (...args: unknown[]) => {
      order.push('transaction');
      return original(...(args as Parameters<typeof original>));
    });

    await handler.provisionTenantSubscription(buildCommand());

    expect(order).toEqual(['stripe', 'transaction']);
  });

  it('rejects a command that selects modules but carries no moduleItems (VALIDATION_ERROR)', async () => {
    const result = await handler.provisionTenantSubscription(buildCommand({ moduleItems: [] }));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    // No subscription may be created for a rejected command.
    expect(subscriptionWriter.createWithin).not.toHaveBeenCalled();
    expect(recordedQueries.some((q) => /INSERT INTO billing\.subscriptions/.test(q.sql))).toBe(
      false,
    );
  });

  /**
   * Regression guard for ORPHAN-CRITICAL-412: provisioning arrives over NATS
   * with no HTTP tenant context, so app.bypass_rls defaults to 'off' and the
   * billing.command_receipts tenant_isolation RLS policy denies the receipt
   * INSERT — rolling back the whole SERIALIZABLE transaction so no subscription
   * ever persists. The handler must therefore establish an audited RLS bypass
   * BEFORE the first command_receipts write.
   */
  it('grants an audited RLS bypass before the command_receipts write', async () => {
    const result = await handler.provisionTenantSubscription(buildCommand());
    expect(result.success).toBe(true);

    expect(bypassRls.withBypass).toHaveBeenCalledWith(
      'billing-admin:provision-tenant-subscription',
      expect.any(Function),
    );
    // Exactly one grant covers the receipt AND the subscription/module writes.
    expect(bypassRls.withBypass).toHaveBeenCalledTimes(1);

    const grantIdx = recordedQueries.findIndex((q) =>
      q.sql.startsWith('__BYPASS_GRANTED__ billing-admin:provision-tenant-subscription'),
    );
    const firstReceiptWriteIdx = recordedQueries.findIndex(
      (q) =>
        /billing\.command_receipts/.test(q.sql) &&
        (/INSERT INTO/.test(q.sql) || /FOR UPDATE/.test(q.sql)),
    );
    expect(grantIdx).toBeGreaterThanOrEqual(0);
    expect(firstReceiptWriteIdx).toBeGreaterThan(grantIdx);
  });

  it('writes the FAILED command_receipts (outside the transaction) under the same bypass', async () => {
    // Force plan resolution to fail so the SERIALIZABLE transaction throws and
    // the catch-block failure receipt (a SEPARATE dataSource.query outside the
    // transaction) runs. It must still be inside the one audited bypass frame.
    planFindOne.mockResolvedValue(null);

    const result = await handler.provisionTenantSubscription(buildCommand());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CATALOG_MISSING');

    // One grant only — the whole command (txn + failure receipt) is covered.
    expect(bypassRls.withBypass).toHaveBeenCalledTimes(1);

    const grantIdx = recordedQueries.findIndex((q) =>
      q.sql.startsWith('__BYPASS_GRANTED__ billing-admin:provision-tenant-subscription'),
    );
    const failureReceiptIdx = recordedQueries.findIndex(
      (q) => /INSERT INTO billing\.command_receipts/.test(q.sql) && /'FAILED'/.test(q.sql),
    );
    expect(grantIdx).toBeGreaterThanOrEqual(0);
    expect(failureReceiptIdx).toBeGreaterThan(grantIdx);
  });

  it('runs a CommandBus-delegating admin command under an audited RLS bypass', async () => {
    // createInvoice delegates to the CommandBus handler, which writes the
    // RLS-protected billing.invoices table with no HTTP tenant context. The
    // bypass must wrap it too (the mapInvoice on the undefined execute() result
    // throws and is caught — the bypass grant is the assertion, not the result).
    const nowIso = new Date().toISOString();
    const command: BillingAdminCreateInvoiceCommand = {
      tenantId: '22222222-2222-4222-8222-222222222222',
      actorId: '33333333-3333-4333-8333-333333333333',
      idempotencyKey: 'operator-request-1:create-invoice:t2',
      correlationId: 'corr-1',
      input: {
        billingAddress: {
          companyName: 'Acme',
          street: '1 Farm Rd',
          city: 'Aqua',
          state: 'CA',
          postalCode: '00000',
          country: 'US',
        },
        lineItems: [],
        dueDate: nowIso,
        periodStart: nowIso,
        periodEnd: nowIso,
      },
    };
    await handler.createInvoice(command);

    expect(bypassRls.withBypass).toHaveBeenCalledWith(
      'billing-admin:create-invoice',
      expect.any(Function),
    );
  });
  /**
   * BILLING-CRITICAL-003: three of the four billing cycles could not be sold.
   *
   * Provisioning resolved a plan by `{tier, billingCycle}` against `plans`,
   * which demanded a row whose DEFAULT cycle equalled the requested one — and
   * the seed wrote monthly rows only. Quarterly, semi-annual and annual every
   * answered CATALOG_MISSING. W4b had already normalised the per-cycle matrix
   * into `plan_cycle_prices`, so the plan a tenant buys annually is the same
   * plan, priced for that cycle.
   */
  it('provisions on a cycle the plan is priced for, whatever the plan default is', async () => {
    const result = await handler.provisionTenantSubscription(
      buildCommand({ billingCycle: 'annual' }),
    );

    expect(result.success).toBe(true);
    // Resolved by tier alone — the cycle is not part of the plans lookup.
    expect(planFindOne.mock.calls[0][0].where).not.toHaveProperty('billingCycle');
    expect(subscriptionWriter.createWithin.mock.calls[0][1].billingCycle).toBe('annual');
    // The Stripe price id and idempotency key are per-cycle, so the requested
    // cycle has to reach Stripe too.
    expect(subscriptionWriter.ensureStripeObjects.mock.calls[0][0].billingCycle).toBe('annual');
    // BILLING-CRITICAL-003: the sale snapshots the PLAN's commitment term, so
    // a later catalogue edit cannot re-price a customer who already signed.
    expect(
      subscriptionWriter.createWithin.mock.calls[0][1].commitmentDiscountPercent.toString(),
    ).toBe('22');
  });

  it('refuses a cycle the plan carries no price for, instead of billing a default', async () => {
    planFindOne.mockResolvedValue({
      ...plan,
      cyclePrices: [{ billingCycle: 'monthly' }],
    });

    const result = await handler.provisionTenantSubscription(
      buildCommand({ billingCycle: 'annual' }),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CATALOG_MISSING');
    expect(subscriptionWriter.createWithin).not.toHaveBeenCalled();
  });
  /**
   * BILLING-CRITICAL-003: every custom-plan activation failed.
   *
   * `customPlanId` is a `billing.custom_plans` id and provisioning looked it
   * up in `billing.plans`. Different tables — it could never match, so a
   * negotiated plan that had passed admin-api's `approved` guard died one call
   * later with CATALOG_MISSING, and nothing said the id had been resolved
   * against the wrong table.
   */
  describe('custom plans price a subscription; they are not catalogue rows', () => {
    const CUSTOM_PLAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const customPlanCommand = () =>
      buildCommand({ tier: 'enterprise', customPlanId: CUSTOM_PLAN_ID });

    const withCustomPlanRow = (row: { tenantId: string; status: string } | null): void => {
      const managerQuery = (mockDataSourceRef.manager as { query: jest.Mock }).query;
      const inner = managerQuery.getMockImplementation()!;
      managerQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/FROM billing\.custom_plans/.test(sql)) {
          recordedQueries.push({ sql, params });
          return row ? [row] : [];
        }
        return inner(sql, params);
      });
    };

    it('resolves the CATALOGUE plan by tier and verifies the custom plan separately', async () => {
      withCustomPlanRow({ tenantId: TENANT, status: 'approved' });

      const result = await handler.provisionTenantSubscription(customPlanCommand());

      expect(result.success).toBe(true);
      // The plans lookup is by tier — the custom plan id never reaches it.
      expect(planFindOne.mock.calls[0][0].where).not.toHaveProperty('id');
      expect(planFindOne.mock.calls[0][0].where.tier).toBe('enterprise');
      expect(recordedQueries.some((q) => /FROM billing\.custom_plans/.test(q.sql))).toBe(true);
    });

    it('refuses a custom plan that belongs to another tenant', async () => {
      withCustomPlanRow({ tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'approved' });

      const result = await handler.provisionTenantSubscription(customPlanCommand());

      expect(result.success).toBe(false);
      expect(subscriptionWriter.createWithin).not.toHaveBeenCalled();
    });

    it('refuses a custom plan that is not approved', async () => {
      withCustomPlanRow({ tenantId: TENANT, status: 'rejected' });

      const result = await handler.provisionTenantSubscription(customPlanCommand());

      expect(result.success).toBe(false);
      expect(subscriptionWriter.createWithin).not.toHaveBeenCalled();
    });

    it('refuses a custom plan id that names no row', async () => {
      withCustomPlanRow(null);

      const result = await handler.provisionTenantSubscription(customPlanCommand());

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('CATALOG_MISSING');
      expect(subscriptionWriter.createWithin).not.toHaveBeenCalled();
    });
  });
});
