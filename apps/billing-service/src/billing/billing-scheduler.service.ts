import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThanOrEqual, LessThan, In } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent, InvoiceGeneratedEvent } from '@platform/event-contracts';
import { Money } from '@aquaculture/backend-common/monetary';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { Subscription, SubscriptionStatus, BillingCycle } from './entities/subscription.entity';
import { Plan } from './entities/plan.entity';
import { ScheduledPlanChange, ScheduledChangeStatus } from './entities/scheduled-plan-change.entity';
import { Invoice, InvoiceStatus } from './entities/invoice.entity';
import { randomBytes } from 'crypto';

/**
 * D09-F02 / D09-F03 / D09-F06: Automated billing lifecycle scheduler.
 *
 * Handles:
 *  - Trial expiry: transitions TRIAL subscriptions to ACTIVE when trialEndDate passes.
 *  - Overdue detection: marks SENT/PENDING invoices as OVERDUE when dueDate passes.
 *  - Auto-invoice generation: creates monthly invoices for active subscriptions
 *    whose billing period has ended (D09-F03).
 *
 * All jobs are idempotent — re-running them on already-processed records is a no-op
 * because the WHERE clause filters by the pre-transition status or checks for
 * existing invoices covering the same period.
 */
@Injectable()
export class BillingSchedulerService {
  private readonly logger = new Logger(BillingSchedulerService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    // ORPHAN-174: the scheduler applies scheduled plan changes (downgrades) and
    // MUST mirror the immediate change-subscription-plan path at Stripe, else the
    // tenant keeps paying the old price after the downgrade lands locally.
    private readonly stripeApi: StripeApiService,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
  ) {}

  // ─── D09-F02: Trial Expiry ───────────────────────────────────────────

  /**
   * Every hour, find TRIAL subscriptions whose trialEndDate has passed
   * and transition them to ACTIVE with a fresh billing period.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleTrialExpiry(): Promise<void> {
    const now = new Date();

    const expiredTrials = await this.subscriptionRepo.find({
      where: {
        status: SubscriptionStatus.TRIAL,
        trialEndDate: LessThanOrEqual(now),
      },
    });

    if (expiredTrials.length === 0) {
      return;
    }

    this.logger.log(`Found ${expiredTrials.length} expired trial subscription(s)`);

    for (const sub of expiredTrials) {
      try {
        // MEDIUM fix: Check if tenant has a payment method (Stripe customer) before activating.
        // If no payment method on file, transition to PAST_DUE instead of ACTIVE
        // so the tenant is prompted to add payment details.
        if (!sub.stripeCustomerId) {
          sub.status = SubscriptionStatus.PAST_DUE;
          sub.updatedBy = 'system';
          await this.subscriptionRepo.save(sub);
          this.logger.warn(
            `Trial expired: subscription ${sub.id}, tenant ${sub.tenantId} -> PAST_DUE (no payment method on file)`,
          );
          // Publish PAST_DUE event for notification service (payment reminder)
          if (this.eventBus) {
            try {
              await this.eventBus.publish({
                ...createBaseEvent('SubscriptionPastDue', sub.tenantId),
                subscriptionId: sub.id,
                previousStatus: SubscriptionStatus.TRIAL,
                newStatus: SubscriptionStatus.PAST_DUE,
              });
            } catch (e) {
              this.logger.warn(`Failed to publish SubscriptionPastDue: ${(e as Error).message}`);
            }
          }
          continue;
        }

        sub.status = SubscriptionStatus.ACTIVE;
        sub.currentPeriodStart = now;
        sub.currentPeriodEnd = this.calculatePeriodEnd(now, sub.billingCycle);
        sub.updatedBy = 'system';
        await this.subscriptionRepo.save(sub);
        this.logger.log(
          `Trial expired: subscription ${sub.id}, tenant ${sub.tenantId} -> ACTIVE`,
        );
      } catch (error) {
        // Log and continue — don't let one failure block the rest
        this.logger.error(
          `Failed to transition trial subscription ${sub.id} for tenant ${sub.tenantId}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  // ─── Subscription Expiry Detection ─────────────────────────────────

  /**
   * Every hour, find ACTIVE subscriptions whose endDate has passed
   * and transition them to EXPIRED. A 3-day grace period is applied
   * so tenants have a short window to renew before losing access.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleSubscriptionExpiry(): Promise<void> {
    const now = new Date();
    const gracePeriodMs = 3 * 24 * 60 * 60 * 1000; // 3 days
    const cutoff = new Date(now.getTime() - gracePeriodMs);

    const expired = await this.subscriptionRepo.find({
      where: {
        status: SubscriptionStatus.ACTIVE,
        endDate: LessThan(cutoff),
      },
    });

    if (expired.length === 0) {
      return;
    }

    this.logger.log(`Found ${expired.length} expired subscription(s) (past 3-day grace period)`);

    for (const sub of expired) {
      try {
        const previousStatus = sub.status;
        sub.status = SubscriptionStatus.EXPIRED;
        sub.updatedBy = 'system';
        await this.subscriptionRepo.save(sub);
        this.logger.log(
          `Subscription expired: ${sub.id}, tenant ${sub.tenantId} -> EXPIRED`,
        );

        // Publish event — admin and notification services need to react to expiry
        // (suspension notices, feature deactivation, tenant downgrade).
        if (this.eventBus) {
          try {
            await this.eventBus.publish({
              ...createBaseEvent('SubscriptionExpired', sub.tenantId),
              subscriptionId: sub.id,
              previousStatus,
              newStatus: SubscriptionStatus.EXPIRED,
            });
          } catch (e) {
            this.logger.warn(`Failed to publish SubscriptionExpired: ${(e as Error).message}`);
          }
        }
      } catch (error) {
        this.logger.error(
          `Failed to expire subscription ${sub.id} for tenant ${sub.tenantId}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  // ─── D09-F06: Overdue Invoice Detection ──────────────────────────────

  /**
   * Every day at midnight, find SENT or PENDING invoices whose dueDate
   * has passed and mark them as OVERDUE.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleOverdueInvoices(): Promise<void> {
    const now = new Date();

    const overdueInvoices = await this.invoiceRepo.find({
      where: {
        status: In([InvoiceStatus.SENT, InvoiceStatus.PENDING]),
        dueDate: LessThan(now),
      },
    });

    if (overdueInvoices.length === 0) {
      return;
    }

    this.logger.log(`Found ${overdueInvoices.length} overdue invoice(s)`);

    for (const invoice of overdueInvoices) {
      try {
        invoice.status = InvoiceStatus.OVERDUE;
        await this.invoiceRepo.save(invoice);
        this.logger.log(
          `Invoice ${invoice.id} (tenant ${invoice.tenantId}) marked as OVERDUE`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to mark invoice ${invoice.id} as OVERDUE: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  // ─── D09-F03: Auto-Invoice Generation ───────────────────────────────

  /**
   * On the 1st of every month at 01:00, find ACTIVE subscriptions whose
   * currentPeriodEnd has passed, generate an invoice for the completed period,
   * and advance the subscription to the next billing period.
   *
   * Idempotency: before creating an invoice, we check whether one already exists
   * for the same subscription + period. If so, we skip it to prevent duplicates
   * on re-runs or overlapping scheduler instances.
   */
  @Cron('0 1 1 * *') // 1st of every month at 01:00
  async generateMonthlyInvoices(): Promise<void> {
    // Distributed lock: pg_try_advisory_lock prevents two scheduler replicas
    // from running invoice generation concurrently. Without this, both instances
    // read subscriptions with no existing invoice, both generate, and the
    // per-subscription idempotency check only catches WITHIN a single run —
    // not across concurrent runs that interleave reads and writes.
    const INVOICE_GEN_LOCK_ID = 900001; // unique advisory lock ID
    const lockResult = await this.dataSource.query(
      'SELECT pg_try_advisory_lock($1) as acquired', [INVOICE_GEN_LOCK_ID],
    );
    if (!lockResult?.[0]?.acquired) {
      this.logger.log('Another instance holds the invoice generation lock — skipping');
      return;
    }

    try {
    const now = new Date();
    this.logger.log('Starting auto-invoice generation run...');

    const activeSubscriptions = await this.subscriptionRepo.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE]),
        currentPeriodEnd: LessThanOrEqual(now),
      },
    });

    if (activeSubscriptions.length === 0) {
      this.logger.log('No subscriptions due for invoicing');
      return;
    }

    this.logger.log(`Found ${activeSubscriptions.length} subscription(s) due for invoicing`);

    let generated = 0;
    let skipped = 0;

    for (const sub of activeSubscriptions) {
      try {
        // Idempotency check: skip if an invoice already exists for this period
        const existingInvoice = await this.invoiceRepo.findOne({
          where: {
            subscriptionId: sub.id,
            tenantId: sub.tenantId,
            periodStart: sub.currentPeriodStart,
            periodEnd: sub.currentPeriodEnd,
          },
        });

        if (existingInvoice) {
          this.logger.debug(
            `Invoice already exists for subscription ${sub.id}, period ${sub.currentPeriodStart.toISOString()} - ${sub.currentPeriodEnd.toISOString()}. Skipping.`,
          );
          skipped++;
          // Still advance the period so we don't get stuck
          await this.advanceSubscriptionPeriod(sub, now);
          continue;
        }

        // Build line items from subscription pricing using Money
        const pricingCurrency = sub.pricing.currency || 'USD';
        const basePriceMoney = Money.of(sub.pricing.basePrice || 0, pricingCurrency);
        const lineItems = [
          {
            description: `${sub.planName} - Base subscription`,
            quantity: 1,
            unitPrice: basePriceMoney.toDecimal().toNumber(),
          },
        ];

        // Calculate cycle multiplier for non-monthly billing
        const cycleMonths = this.cycleToMonths(sub.billingCycle);
        if (cycleMonths > 1 && lineItems[0]) {
          lineItems[0].description = `${sub.planName} - Base subscription (${cycleMonths} months)`;
          lineItems[0].unitPrice = basePriceMoney.multiply(cycleMonths).toDecimal().toNumber();
        }

        // Generate invoice number
        const invoiceNumber = this.generateInvoiceNumber(sub.tenantId);

        // Due date: 30 days from now
        const dueDate = new Date(now);
        dueDate.setDate(dueDate.getDate() + 30);

        const invoice = this.invoiceRepo.create({
          tenantId: sub.tenantId,
          invoiceNumber,
          subscriptionId: sub.id,
          status: InvoiceStatus.PENDING,
          billingAddress: {
            companyName: sub.tenantId, // Placeholder - tenant name resolved via service
            street: '',
            city: '',
            state: '',
            postalCode: '',
            country: '',
          },
          lineItems: lineItems.map((item) => {
            const lineMoney = Money.of(item.unitPrice, pricingCurrency).multiply(item.quantity);
            return {
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              amount: lineMoney.toDecimal().toNumber(),
            };
          }),
          subtotal: lineItems.reduce(
            (sum, item) => sum.add(Money.of(item.unitPrice, pricingCurrency).multiply(item.quantity)),
            Money.zero(pricingCurrency),
          ).toDecimal(),
          total: lineItems.reduce(
            (sum, item) => sum.add(Money.of(item.unitPrice, pricingCurrency).multiply(item.quantity)),
            Money.zero(pricingCurrency),
          ).toDecimal(),
          amountPaid: Money.zero(pricingCurrency).toDecimal(),
          amountDue: lineItems.reduce(
            (sum, item) => sum.add(Money.of(item.unitPrice, pricingCurrency).multiply(item.quantity)),
            Money.zero(pricingCurrency),
          ).toDecimal(),
          currency: pricingCurrency,
          issueDate: now,
          dueDate,
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
          notes: 'Auto-generated invoice for billing period',
          createdBy: 'system',
          updatedBy: 'system',
        });

        const savedInvoice = await this.invoiceRepo.save(invoice);

        this.logger.log(
          `Auto-invoice created: ${savedInvoice.id} (${savedInvoice.invoiceNumber}) for tenant ${sub.tenantId}, subscription ${sub.id}`,
        );

        // Publish NATS event
        try {
          const event: InvoiceGeneratedEvent = {
            ...createBaseEvent<InvoiceGeneratedEvent>('InvoiceGenerated', sub.tenantId),
            invoiceId: savedInvoice.id,
            invoiceNumber: savedInvoice.invoiceNumber,
            subscriptionId: sub.id,
            subtotal: savedInvoice.subtotal.toNumber(),
            tax: 0,
            total: savedInvoice.total.toNumber(),
            currency: savedInvoice.currency,
            dueDate: savedInvoice.dueDate,
            billingPeriodStart: savedInvoice.periodStart,
            billingPeriodEnd: savedInvoice.periodEnd,
          };
          await this.eventBus?.publish(event);
        } catch (eventError) {
          this.logger.warn(
            `Failed to publish InvoiceGenerated event for auto-invoice ${savedInvoice.id}: ${
              eventError instanceof Error ? eventError.message : 'Unknown error'
            }`,
          );
        }

        // Advance the subscription period
        await this.advanceSubscriptionPeriod(sub, now);

        generated++;
      } catch (error) {
        // Log and continue -- don't let one failure block the rest
        this.logger.error(
          `Failed to generate auto-invoice for subscription ${sub.id}, tenant ${sub.tenantId}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    this.logger.log(
      `Auto-invoice generation complete: ${generated} generated, ${skipped} skipped (already invoiced)`,
    );
    } finally {
      // Always release advisory lock — even on error, so next cron run can acquire it.
      await this.dataSource.query(
        'SELECT pg_advisory_unlock($1)', [INVOICE_GEN_LOCK_ID],
      ).catch((err: Error) => this.logger.warn(`Advisory unlock failed: ${err.message}`));
    }
  }

  /**
   * Advance a subscription's billing period to the next cycle.
   */
  private async advanceSubscriptionPeriod(sub: Subscription, now: Date): Promise<void> {
    sub.currentPeriodStart = sub.currentPeriodEnd;
    sub.currentPeriodEnd = this.calculatePeriodEnd(sub.currentPeriodStart, sub.billingCycle);
    sub.updatedBy = 'system';
    await this.subscriptionRepo.save(sub);
    this.logger.debug(
      `Advanced subscription ${sub.id} period to ${sub.currentPeriodStart.toISOString()} - ${sub.currentPeriodEnd.toISOString()}`,
    );
  }

  /**
   * Generate invoice number with collision-resistant approach for auto-invoices.
   * Format: INV-{YYYYMM}-{tenantPrefix}-{timestamp+random}
   *
   * # Why randomBytes(4) and not (2) (BILLING-LOW-002 cure)
   *
   * Pre-fix the random suffix used `randomBytes(2)` (16 bits → 65 536
   * possible values per timestamp). At 1000 invoices/month per tenant
   * the birthday-paradox collision probability is ~2.4% per month,
   * which crashes the cron mid-batch on the
   * `(tenantId, invoiceNumber)` unique constraint and forces an
   * operator restart.
   *
   * randomBytes(4) (32 bits → ~4.3 billion possible values) drops the
   * collision probability below 1e-7 even at 100k invoices/month per
   * tenant — effectively zero. The 8 extra hex chars on the invoice
   * number are accepted by every downstream display surface (the
   * column is varchar(64); pre-fix output 18 chars, post-fix 22).
   *
   * This is a Tier-3 "make detectable at scale" cure: the architecture
   * itself (timestamp + random suffix) is unchanged; the cure widens
   * the entropy until the collision probability falls below the
   * platform's at-scale threshold. A future Tier-1 cure would
   * eliminate the suffix entirely via a per-tenant Postgres SEQUENCE
   * (or `nextval()` on a hash-partitioned sequence) — tracked under
   * BILLING-LOW-002 follow-on.
   */
  private generateInvoiceNumber(tenantId: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const tenantPrefix = tenantId.replace(/-/g, '').substring(0, 4).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const randomSuffix = randomBytes(4).toString('hex').toUpperCase();
    return `INV-${year}${month}-${tenantPrefix}-${timestamp}${randomSuffix}`;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private calculatePeriodEnd(startDate: Date, billingCycle: BillingCycle): Date {
    const months = this.cycleToMonths(billingCycle);
    return this.addMonthsClamped(startDate, months);
  }

  private cycleToMonths(billingCycle: BillingCycle): number {
    switch (billingCycle) {
      case BillingCycle.MONTHLY:     return 1;
      case BillingCycle.QUARTERLY:   return 3;
      case BillingCycle.SEMI_ANNUAL: return 6;
      case BillingCycle.ANNUAL:      return 12;
    }
  }

  /**
   * Add months to a date, clamping the day to the last valid day of the target month.
   * Avoids the JS Date.setMonth() overflow bug (e.g. Jan 31 + 1 month -> Mar 3).
   */
  private addMonthsClamped(date: Date, months: number): Date {
    const targetYear = date.getFullYear();
    const targetMonth = date.getMonth() + months;
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    const clampedDay = Math.min(date.getDate(), lastDay);

    const result = new Date(date);
    result.setFullYear(targetYear, targetMonth, clampedDay);
    return result;
  }

  // ─── IP-2: Apply Scheduled Plan Changes ─────────────────────────────

  /**
   * Every hour, find PENDING scheduled plan changes whose effectiveDate
   * has passed and apply them to the subscription.
   *
   * WHY: Downgrades are intentionally scheduled for billing-period end
   * so tenants keep access to features they have already paid for.
   * This cron is the mechanism that applies the scheduled change once
   * effectiveDate has passed.
   *
   * SECURITY: Uses pg_try_advisory_lock to prevent concurrent execution
   * across multiple billing-service instances.
   *
   * Idempotent: only processes PENDING changes, marks them APPLIED on success.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async applyScheduledPlanChanges(): Promise<void> {
    const now = new Date();

    // ── Distributed lock ────────────────────────────────────────────────
    const lockId = 900002; // Unique advisory lock ID for scheduled plan changes
    const lockResult = await this.dataSource.query(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [lockId],
    );
    if (!lockResult?.[0]?.acquired) {
      this.logger.debug('Another instance is processing scheduled plan changes — skipping');
      return;
    }

    try {
      // Cross-tenant cron scan: processes pending plan changes for every
      // tenant in one pass. tenantId is not fixed at query time because
      // the cron job has no current tenant context — each matched row's
      // tenantId drives the downstream per-tenant transaction.
      // eslint-disable-next-line no-restricted-syntax -- cross-tenant cron scan
      const changeRepo = this.dataSource.getRepository(ScheduledPlanChange);

      const pendingChanges = await changeRepo.find({
        where: {
          status: ScheduledChangeStatus.PENDING,
          effectiveDate: LessThanOrEqual(now),
        },
      });

      if (pendingChanges.length === 0) {
        return;
      }

      this.logger.log(`Applying ${pendingChanges.length} scheduled plan change(s)`);

      for (const change of pendingChanges) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
          // ── Load subscription with lock ─────────────────────────────────
          const subscription = await queryRunner.manager.findOne(Subscription, {
            where: { id: change.subscriptionId },
            lock: { mode: 'pessimistic_write' },
          });

          if (!subscription) {
            this.logger.warn(`Subscription ${change.subscriptionId} not found — marking change ${change.id} as cancelled`);
            change.status = ScheduledChangeStatus.CANCELLED;
            change.cancelledAt = now;
            change.cancellationReason = 'Subscription not found';
            await queryRunner.manager.save(ScheduledPlanChange, change);
            await queryRunner.commitTransaction();
            continue;
          }

          // ── ORPHAN-174: sync the new plan's price at Stripe BEFORE the local
          // mutation. Fail-closed — a Stripe error throws out of the tx (caught
          // below → rollback), leaving the change PENDING for the next cron pass
          // rather than silently drifting Stripe and the local DB apart. The
          // idempotency key is deterministic (same key as the immediate path) so
          // a retry re-uses it and Stripe dedupes. ──
          if (subscription.stripeSubscriptionId) {
            const newPlan = await queryRunner.manager.findOne(Plan, {
              where: { id: change.newPlanId },
            });
            const newPriceId = newPlan?.stripePriceIds?.[subscription.billingCycle];
            if (newPriceId) {
              await this.stripeApi.updateSubscription({
                tenantId: subscription.tenantId,
                subscriptionId: subscription.stripeSubscriptionId,
                priceId: newPriceId,
                idempotencyKey: `sub-update:${subscription.stripeSubscriptionId}:${change.newPlanId}`,
              });
            }
          }

          // ── Apply the plan change ───────────────────────────────────────
          subscription.planId = change.newPlanId;
          subscription.planTier = change.newPlanTier as Subscription['planTier'];
          subscription.planName = change.newPlanName;
          subscription.limits = change.newLimits;
          subscription.pricing = change.newPricing;
          subscription.updatedBy = change.scheduledBy ?? 'system:billing-scheduler';

          await queryRunner.manager.save(Subscription, subscription);

          // ── Mark change as applied ──────────────────────────────────────
          change.status = ScheduledChangeStatus.APPLIED;
          change.appliedAt = now;
          await queryRunner.manager.save(ScheduledPlanChange, change);

          await queryRunner.commitTransaction();

          this.logger.log(
            `Scheduled plan change applied: tenant=${change.tenantId}, ` +
            `${change.currentPlanTier} → ${change.newPlanTier}, changeId=${change.id}`,
          );

          // ── Publish event ───────────────────────────────────────────────
          // Await the publish so the surrounding try/catch genuinely catches a
          // publish rejection; an unawaited promise rejection would escape this
          // synchronous catch and surface as an unhandled rejection. The publish
          // runs after the transaction has already committed, so a failure here
          // is logged-and-tolerated (the state change is durable) — it does not
          // roll back the applied plan change.
          try {
            await this.eventBus?.publish({
              ...createBaseEvent('SubscriptionUpdated', change.tenantId),
              subscriptionId: subscription.id,
              tier: change.newPlanTier,
              previousPlanTier: change.currentPlanTier,
              isDowngrade: true,
              isScheduledChange: true,
            });
          } catch (eventError) {
            this.logger.warn(`Event publish failed for change ${change.id}: ${(eventError as Error).message}`);
          }
        } catch (error) {
          await queryRunner.rollbackTransaction();
          this.logger.error(
            `Failed to apply scheduled change ${change.id}: ${(error as Error).message}`,
            (error as Error).stack,
          );
        } finally {
          await queryRunner.release();
        }
      }
    } finally {
      // Release advisory lock
      await this.dataSource.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  }
}
