import {
  createBaseEvent,
  type TelemetryCapacityEntitlementChangedEvent,
  validateTelemetryCapacityEvent,
} from '../index';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('TelemetryCapacityEntitlementChanged contract', () => {
  it('accepts the complete versioned M/R entitlement snapshot', () => {
    const event: TelemetryCapacityEntitlementChangedEvent = {
      ...createBaseEvent<TelemetryCapacityEntitlementChangedEvent>(
        'TelemetryCapacityEntitlementChanged',
        TENANT_ID,
      ),
      operationId: '22222222-2222-4222-8222-222222222222',
      reservationId: '33333333-3333-4333-8333-333333333333',
      entitlementId: '44444444-4444-4444-8444-444444444444',
      entitlementVersion: 2,
      activationState: 'ACTIVE',
      effectiveAt: '2026-08-25T12:00:00.000Z',
      capacityEnvelopeVersion: 7,
      sustainedIngressMessagesPerSecond: 20,
      sustainedMetricRowsPerMinute: 1_200,
    };

    expect(validateTelemetryCapacityEvent(event)).toEqual({ valid: true });
  });

  it('rejects an unknown activation state and missing capacity dimensions', () => {
    const result = validateTelemetryCapacityEvent({
      ...createBaseEvent('TelemetryCapacityEntitlementChanged', TENANT_ID),
      operationId: '22222222-2222-4222-8222-222222222222',
      reservationId: '33333333-3333-4333-8333-333333333333',
      entitlementId: '44444444-4444-4444-8444-444444444444',
      entitlementVersion: 2,
      activationState: 'ENABLED',
      effectiveAt: '2026-08-25T12:00:00.000Z',
      capacityEnvelopeVersion: 7,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toMatch(/activationState|sustainedIngress|sustainedMetricRows/);
    }
  });
});
