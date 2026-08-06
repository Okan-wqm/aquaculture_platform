/**
 * Canary usage must not reach the billing buffer.
 *
 * The write probes need a real account to prove a write lands and comes
 * back. That account's traffic is synthetic, and synthetic traffic in the
 * usage stream is worse than a wrong number: it is a right-looking number.
 * This pins the refusal at the entry point, and pins that the refusal is
 * counted rather than silent.
 */
import { CANARY_TENANT_IDS_ENV } from '@aquaculture/backend-common/billing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { UsageMeteringMetrics, UsageMeteringService } from '../usage-metering.service';

const CANARY = '11111111-2222-4333-8444-555555555555';
const CUSTOMER = '80424281-4ce3-4e13-b44b-0ea497dc34c4';

function usageEvent(tenantId: string): Parameters<UsageMeteringService['recordUsage']>[0] {
  return {
    tenantId,
    meterType: 'api_calls',
    quantity: 1,
  } as Parameters<UsageMeteringService['recordUsage']>[0];
}

describe('UsageMeteringService canary exemption', () => {
  let service: UsageMeteringService;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[CANARY_TENANT_IDS_ENV];
    process.env[CANARY_TENANT_IDS_ENV] = CANARY;
    // Only recordUsage is under test; it emits nothing and needs no Redis.
    service = new UsageMeteringService(new EventEmitter2());
  });

  afterEach(() => {
    // Restore by assignment rather than `delete`: the lint rule is right
    // that dynamic delete on an index signature is a footgun, and an empty
    // value means the same thing to the registry as an absent one.
    process.env[CANARY_TENANT_IDS_ENV] = previous ?? '';
  });

  function metrics(): UsageMeteringMetrics {
    return service.getMetrics();
  }

  it('does not buffer usage for a canary tenant', () => {
    service.recordUsage(usageEvent(CANARY));

    expect(metrics().canaryEventsSkipped).toBe(1);
  });

  it('still meters a real customer with the canary configured', () => {
    service.recordUsage(usageEvent(CUSTOMER));

    expect(metrics().canaryEventsSkipped).toBe(0);
    expect(metrics().totalEventsReceived).toBe(1);
  });

  it('counts the exemption instead of hiding it', () => {
    // A skipped event that leaves no trace is how a mis-set env var becomes
    // an invisible revenue hole.
    service.recordUsage(usageEvent(CANARY));
    service.recordUsage(usageEvent(CANARY));

    expect(metrics().canaryEventsSkipped).toBe(2);
    expect(metrics().totalEventsReceived).toBe(2);
  });
});
