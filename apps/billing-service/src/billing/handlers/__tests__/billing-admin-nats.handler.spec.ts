import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import type {
  BillingAdminCreateInvoiceCommand,
  BillingTenantProvisioningCommand,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { StripeApiService } from '@aquaculture/backend-common/billing';

import { StripeSubscriptionProvisionerService } from '../../services/stripe-subscription-provisioner.service';
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
  let bypassRls: { withBypass: jest.Mock };
  let planFindOne: jest.Mock;
  let stripeApi: { createCustomer: jest.Mock; createSubscription: jest.Mock };

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

    planFindOne = jest.fn().mockResolvedValue(plan);
    const mockManager = {
      query: managerQuery,
      getRepository: jest.fn().mockReturnValue({
        findOne: planFindOne,
      }),
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
      // BILLING-CRITICAL-010: the plan and the tenant's Stripe objects are now
      // resolved BEFORE the SERIALIZABLE transaction opens, so the handler reads
      // the catalogue through dataSource.manager. Same recorded-query mock, so
      // the plan lookup still shows up in query order.
      manager: mockManager,
    };

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

    // Recorded into the SAME ordered log as the SQL, the way the bypass grant
    // already is, so a case can prove Stripe is called BEFORE the transaction
    // opens rather than inside it.
    stripeApi = {
      createCustomer: jest.fn(async () => {
        recordedQueries.push({ sql: '__STRIPE_CUSTOMER_CREATED__', params: [] });
        return { id: 'cus_provisioned' };
      }),
      createSubscription: jest.fn(async () => {
        recordedQueries.push({ sql: '__STRIPE_SUBSCRIPTION_CREATED__', params: [] });
        return { id: 'sub_provisioned', customer: 'cus_provisioned' };
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BillingAdminNatsHandler],
      providers: [
        { provide: CommandBus, useValue: { execute: jest.fn() } },
        { provide: DataSource, useValue: mockDataSource },
        { provide: BypassRlsService, useValue: bypassRls },
        // The REAL provisioner over a mocked Stripe client, so these cases
        // assert what actually reaches Stripe and what lands in the INSERT.
        StripeSubscriptionProvisionerService,
        { provide: StripeApiService, useValue: stripeApi },
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

  /**
   * BILLING-CRITICAL-010. This INSERT's column list omitted stripe_customer_id
   * and stripe_subscription_id entirely, so every operator-provisioned tenant
   * carried NULLs that nothing else ever filled — the only other writer is the
   * GraphQL path, which this flow does not use. Nothing charged them, and two
   * of the five Stripe webhook handlers resolve the tenant from
   * stripe_subscription_id, so those stayed inert for them too.
   */
  describe('Stripe objects (BILLING-CRITICAL-010)', () => {
    const billablePlan = { ...plan, stripePriceIds: { monthly: 'price_monthly_1' } };

    function subscriptionInsert(): { sql: string; params: unknown[] } | undefined {
      return recordedQueries.find((q) => /INSERT INTO billing\.subscriptions/.test(q.sql));
    }

    it('writes the minted customer and subscription ids onto the row', async () => {
      planFindOne.mockResolvedValue(billablePlan);

      const result = await handler.provisionTenantSubscription(buildCommand());

      expect(result.success).toBe(true);
      // Params: [...trialEndDate(10), stripeCustomerId(11), stripeSubscriptionId(12), actorId(13)]
      expect(subscriptionInsert()?.params[11]).toBe('cus_provisioned');
      expect(subscriptionInsert()?.params[12]).toBe('sub_provisioned');
    });

    it('derives the idempotency keys from the tenant and plan, so a replay reuses the objects', async () => {
      planFindOne.mockResolvedValue(billablePlan);

      await handler.provisionTenantSubscription(buildCommand());

      expect(stripeApi.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `cust-create:22222222-2222-4222-8222-222222222222`,
        }),
      );
      expect(stripeApi.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          priceId: 'price_monthly_1',
          idempotencyKey: `sub-create:22222222-2222-4222-8222-222222222222:starter:monthly`,
        }),
      );
    });

    it('calls Stripe BEFORE the transaction opens, never holding a connection across the round trip', async () => {
      planFindOne.mockResolvedValue(billablePlan);

      await handler.provisionTenantSubscription(buildCommand());

      const stripeAt = recordedQueries.findIndex(
        (q) => q.sql === '__STRIPE_SUBSCRIPTION_CREATED__',
      );
      const insertAt = recordedQueries.findIndex((q) =>
        /INSERT INTO billing\.subscriptions/.test(q.sql),
      );
      expect(stripeAt).toBeGreaterThanOrEqual(0);
      expect(insertAt).toBeGreaterThanOrEqual(0);
      expect(stripeAt).toBeLessThan(insertAt);
    });

    it('mints nothing for a FREE tier, which is a permanent $0 plan', async () => {
      planFindOne.mockResolvedValue({ ...billablePlan, tier: 'free' });

      await handler.provisionTenantSubscription(buildCommand());

      expect(stripeApi.createCustomer).not.toHaveBeenCalled();
      expect(stripeApi.createSubscription).not.toHaveBeenCalled();
      expect(subscriptionInsert()?.params[11]).toBeNull();
      expect(subscriptionInsert()?.params[12]).toBeNull();
    });

    it('records a local-only subscription when the plan has no configured price', async () => {
      planFindOne.mockResolvedValue({ ...plan, stripePriceIds: {} });

      const result = await handler.provisionTenantSubscription(buildCommand());

      expect(result.success).toBe(true);
      expect(stripeApi.createSubscription).not.toHaveBeenCalled();
      expect(subscriptionInsert()?.params[12]).toBeNull();
    });

    it('fails the command when Stripe does, instead of provisioning a tenant nothing can charge', async () => {
      planFindOne.mockResolvedValue(billablePlan);
      stripeApi.createSubscription.mockRejectedValue(new Error('stripe unavailable'));

      const result = await handler.provisionTenantSubscription(buildCommand());

      expect(result.success).toBe(false);
      expect(subscriptionInsert()).toBeUndefined();
    });
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
});
