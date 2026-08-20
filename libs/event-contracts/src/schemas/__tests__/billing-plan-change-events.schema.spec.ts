import { createBaseEvent } from '../../base-event';
import { BillingPlanTier } from '../../billing/billing-plan-tier';
import type {
  SubscriptionPlanChangeReconciliationRequiredEvent,
  SubscriptionPlanChangeScheduledEvent,
} from '../../billing-events';
import { validateBillingPlanChangeEvent } from '../index';

const SCHEDULED: SubscriptionPlanChangeScheduledEvent = {
  ...createBaseEvent<SubscriptionPlanChangeScheduledEvent>(
    'SubscriptionPlanChangeScheduled',
    '1f1e1d1c-0b0a-4909-8807-060504030299',
    { aggregateId: 'sub-1', aggregateType: 'Subscription' },
  ),
  operationId: '0f0e0d0c-0b0a-4909-8807-060504030201',
  subscriptionId: '1f1e1d1c-0b0a-4909-8807-060504030202',
  previousTier: BillingPlanTier.STARTER,
  newTier: BillingPlanTier.PROFESSIONAL,
  previousPlanName: 'Starter',
  newPlanName: 'Professional',
  newPlanId: '2f2e2d2c-0b0a-4909-8807-060504030203',
  applyAfter: '2026-09-01T00:00:00.000Z',
};

const RECONCILIATION: SubscriptionPlanChangeReconciliationRequiredEvent = {
  ...createBaseEvent<SubscriptionPlanChangeReconciliationRequiredEvent>(
    'SubscriptionPlanChangeReconciliationRequired',
    '1f1e1d1c-0b0a-4909-8807-060504030299',
    { aggregateId: 'sub-1', aggregateType: 'Subscription' },
  ),
  operationId: '0f0e0d0c-0b0a-4909-8807-060504030201',
  subscriptionId: '1f1e1d1c-0b0a-4909-8807-060504030202',
  reasonCode: 'stripe_apply_failed',
  detectedAt: '2026-08-20T12:00:00.000Z',
};

describe('billing plan-change event schemas', () => {
  it('accepts a well-formed Scheduled event', () => {
    expect(validateBillingPlanChangeEvent('SubscriptionPlanChangeScheduled', SCHEDULED)).toEqual({
      valid: true,
    });
  });

  it('accepts a well-formed ReconciliationRequired event', () => {
    expect(
      validateBillingPlanChangeEvent(
        'SubscriptionPlanChangeReconciliationRequired',
        RECONCILIATION,
      ),
    ).toEqual({ valid: true });
  });

  it('rejects an unknown event type', () => {
    const result = validateBillingPlanChangeEvent('SubscriptionPlanChangeWhimsical', SCHEDULED);
    expect(result.valid).toBe(false);
  });

  it('rejects a Scheduled event missing a required field', () => {
    const { applyAfter: _drop, ...missingApplyAfter } = SCHEDULED;
    const result = validateBillingPlanChangeEvent(
      'SubscriptionPlanChangeScheduled',
      missingApplyAfter,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a tier outside the canonical BillingPlanTier set', () => {
    const badTier = {
      ...SCHEDULED,
      newTier: 'platinum-not-a-tier',
    };
    const result = validateBillingPlanChangeEvent('SubscriptionPlanChangeScheduled', badTier);
    expect(result.valid).toBe(false);
  });

  it('rejects a reasonCode longer than the saga varchar(64) column', () => {
    const overlong = {
      ...RECONCILIATION,
      reasonCode: 'x'.repeat(65),
    };
    const result = validateBillingPlanChangeEvent(
      'SubscriptionPlanChangeReconciliationRequired',
      overlong,
    );
    expect(result.valid).toBe(false);
  });
});
