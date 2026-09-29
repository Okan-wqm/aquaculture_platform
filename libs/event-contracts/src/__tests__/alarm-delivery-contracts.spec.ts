import { requiresLifeSafetyRedelivery } from '../event-delivery-semantics';
import {
  validateResolveTenantUserIdsByEmailQuerySchema,
  validateResolveTenantUserIdsByEmailResultSchema,
} from '../schemas/auth-user-queries.schema';
import { waterQualityMeasuredUnit } from '../water-quality-events';

/**
 * S1 alarm-delivery contracts: the ONE measured-unit rule (V-S1a-10), the
 * life-safety redelivery classification (V-S1a-3) and the ids-only
 * resolve-by-email query (decision 7).
 */
const TENANT = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const USER = '44444444-4444-4444-8444-444444444444';

describe('waterQualityMeasuredUnit (V-S1a-10)', () => {
  it('picks the measured equipment first, the legacy tank second, null when neither', () => {
    // SCENARIO: the farm write path and the alert signal key ask the same question.
    // EXPECTS: one answer — equipment wins over tank.
    expect(waterQualityMeasuredUnit({ equipmentId: 'probe-1', tankId: 'tank-1' })).toBe('probe-1');
    expect(waterQualityMeasuredUnit({ equipmentId: null, tankId: 'tank-1' })).toBe('tank-1');
    expect(waterQualityMeasuredUnit({ equipmentId: null, tankId: null })).toBeNull();
  });
});

describe('requiresLifeSafetyRedelivery (V-S1a-3)', () => {
  it.each([
    'WaterQualityCritical',
    'MortalityAlertRaised',
    'LowStockDetected',
    'FeedStockoutForecast',
    'UnfedUnitDetected',
    'AlertEscalated',
    'AlertTriggered',
  ])('%s carries the life-safety budget', (eventType) => {
    expect(requiresLifeSafetyRedelivery(eventType)).toBe(true);
  });

  it.each(['SensorReading', 'BatchCreated'])('%s keeps the bus default', (eventType) => {
    expect(requiresLifeSafetyRedelivery(eventType)).toBe(false);
  });
});

describe('resolve-by-email query (decision 7)', () => {
  it('admits a tenant-bound list of addresses and answers ids only', () => {
    expect(
      validateResolveTenantUserIdsByEmailQuerySchema({ tenantId: TENANT, emails: ['a@b.test'] }),
    ).toBe(true);
    expect(
      validateResolveTenantUserIdsByEmailResultSchema({
        success: true,
        matches: [{ email: 'a@b.test', userId: USER }],
      }),
    ).toBe(true);
  });

  it('refuses a non-uuid tenant, extra keys and any PII beyond the match', () => {
    expect(validateResolveTenantUserIdsByEmailQuerySchema({ tenantId: 'x', emails: [] })).toBe(
      false,
    );
    expect(
      validateResolveTenantUserIdsByEmailResultSchema({
        success: true,
        matches: [{ email: 'a@b.test', userId: USER, firstName: 'Ayşe' }],
      }),
    ).toBe(false);
  });
});
