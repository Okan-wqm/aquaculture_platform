/**
 * The tenant's billing block reads billing, and says nothing when billing has
 * nothing to say (ADMIN-HIGH-012, DB-ADMIN-MEDIUM-005).
 *
 * The old implementation read `admin.tenant_billing_info`, a second per-tenant
 * billing store whose only writer — `createOrUpdateBillingInfo` — had zero
 * callers repo-wide. `findOne` therefore always missed, `getBillingSummary`
 * always returned `undefined`, and the panel's billing tab has read "No billing
 * information" for every tenant since it shipped. Widening that table's two
 * `numeric(10,2)` money columns would have left the block just as blank.
 *
 * These cases pin the three facts that matter about the replacement: it asks
 * billing; it distinguishes "billed" from "paid"; and it reports an absent
 * amount as absent rather than as zero in a defaulted currency.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import {
  InvoiceReadOnly,
  SubscriptionReadOnly,
  SubscriptionStatus,
  BillingCycle,
  PlanTier,
} from '../../../analytics/entities/external';
import { TenantActivity } from '../../entities/tenant-activity.entity';
import { Tenant } from '../../entities/tenant.entity';
import { AuthTenantProvisioningClientService } from '../auth-tenant-provisioning-client.service';
import { TenantActivityService } from '../tenant-activity.service';
import { TenantDetailService } from '../tenant-detail.service';

interface Harness {
  service: TenantDetailService;
  subscriptions: { findOne: jest.Mock };
  invoices: { findOne: jest.Mock };
}

function subscription(): SubscriptionReadOnly {
  const row = new SubscriptionReadOnly();
  row.id = '11111111-1111-4111-8111-111111111111';
  row.tenantId = '22222222-2222-4222-8222-222222222222';
  row.planTier = PlanTier.PROFESSIONAL;
  row.planName = 'Professional';
  row.status = SubscriptionStatus.ACTIVE;
  row.billingCycle = BillingCycle.ANNUAL;
  row.pricing = { basePrice: 199, currency: 'EUR' };
  row.currentPeriodEnd = new Date('2027-01-01T00:00:00.000Z');
  return row;
}

function invoice(overrides: Partial<InvoiceReadOnly>): InvoiceReadOnly {
  const row = new InvoiceReadOnly();
  row.tenantId = '22222222-2222-4222-8222-222222222222';
  row.total = 2388.0;
  row.amountPaid = 0;
  row.currency = 'EUR';
  row.issueDate = new Date('2026-01-01T00:00:00.000Z');
  row.periodStart = new Date('2026-01-01T00:00:00.000Z');
  row.periodEnd = new Date('2026-12-31T00:00:00.000Z');
  row.paidAt = null;
  return Object.assign(row, overrides);
}

async function build(): Promise<Harness> {
  const subscriptions = { findOne: jest.fn().mockResolvedValue(null) };
  const invoices = { findOne: jest.fn().mockResolvedValue(null) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      TenantDetailService,
      { provide: getRepositoryToken(Tenant), useValue: {} },
      { provide: getRepositoryToken(TenantActivity), useValue: {} },
      { provide: getRepositoryToken(SubscriptionReadOnly), useValue: subscriptions },
      { provide: getRepositoryToken(InvoiceReadOnly), useValue: invoices },
      { provide: getDataSourceToken(), useValue: {} },
      { provide: TenantActivityService, useValue: {} },
      { provide: AuthTenantProvisioningClientService, useValue: {} },
    ],
  }).compile();

  return { service: module.get(TenantDetailService), subscriptions, invoices };
}

const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('TenantDetailService billing summary', () => {
  it('reports nothing when billing holds no subscription for the tenant', async () => {
    const { service, invoices } = await build();

    await expect(service['getBillingSummary'](TENANT_ID)).resolves.toBeUndefined();
    // And it does not go looking for invoices belonging to a subscription that
    // does not exist.
    expect(invoices.findOne).not.toHaveBeenCalled();
  });

  it('reads the plan, cycle and status from billing.subscriptions', async () => {
    const { service, subscriptions } = await build();
    subscriptions.findOne.mockResolvedValue(subscription());

    const summary = await service['getBillingSummary'](TENANT_ID);

    expect(subscriptions.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_ID } }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        currentPlan: 'Professional',
        planTier: PlanTier.PROFESSIONAL,
        billingCycle: BillingCycle.ANNUAL,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        nextBillingDate: new Date('2027-01-01T00:00:00.000Z'),
      }),
    );
  });

  it('reports no amount and no currency until an invoice exists', async () => {
    // Not `0` in `USD`. An unbilled tenant and a tenant billed nothing are
    // different facts, and only one of them is true here.
    const { service, subscriptions } = await build();
    subscriptions.findOne.mockResolvedValue(subscription());

    const summary = await service['getBillingSummary'](TENANT_ID);

    expect(summary?.lastInvoiceAmount).toBeNull();
    expect(summary?.lastInvoiceIssuedAt).toBeNull();
    expect(summary?.currency).toBeNull();
    expect(summary?.lastPaymentAmount).toBeNull();
    expect(summary?.lastPaymentDate).toBeNull();
  });

  it('does not report an unpaid invoice as a payment', async () => {
    // The open invoice is the last one billed; nothing has been paid. Reporting
    // its total as a payment is how a dashboard shows revenue that never
    // arrived.
    const { service, subscriptions, invoices } = await build();
    subscriptions.findOne.mockResolvedValue(subscription());
    invoices.findOne.mockImplementation(async (options: { where: { paidAt?: unknown } }) =>
      options.where.paidAt === undefined ? invoice({}) : null,
    );

    const summary = await service['getBillingSummary'](TENANT_ID);

    expect(summary?.lastInvoiceAmount).toBe(2388.0);
    expect(summary?.currency).toBe('EUR');
    expect(summary?.lastPaymentAmount).toBeNull();
    expect(summary?.lastPaymentDate).toBeNull();
  });

  it('selects the last payment by the timestamp billing writes, not by status', async () => {
    const { service, subscriptions, invoices } = await build();
    subscriptions.findOne.mockResolvedValue(subscription());
    const paid = invoice({
      amountPaid: 1194.0,
      paidAt: new Date('2026-03-04T09:00:00.000Z'),
    });
    invoices.findOne.mockImplementation(async (options: { where: { paidAt?: unknown } }) =>
      options.where.paidAt === undefined ? invoice({}) : paid,
    );

    const summary = await service['getBillingSummary'](TENANT_ID);

    // A partially paid invoice moved money; a status filter of 'paid' would
    // have dropped it.
    const paidQuery = invoices.findOne.mock.calls
      .map(([options]: [{ where: Record<string, unknown> }]) => options.where)
      .find((where) => 'paidAt' in where);
    expect(paidQuery).toBeDefined();
    expect(paidQuery).not.toHaveProperty('status');

    expect(summary?.lastPaymentAmount).toBe(1194.0);
    expect(summary?.lastPaymentDate).toEqual(new Date('2026-03-04T09:00:00.000Z'));
  });
});
