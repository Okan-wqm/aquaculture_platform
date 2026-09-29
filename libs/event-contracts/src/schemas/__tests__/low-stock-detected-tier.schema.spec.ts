import { createBaseEvent } from '../../base-event';
import {
  LOW_STOCK_DETECTED_VERSION,
  type PoolLowStockDetectedEvent,
  type SiteLowStockDetectedEvent,
} from '../../storage-events';
import { createDefaultRegistry } from '../../upcasters';
import { lowStockDetectedUpcaster } from '../../upcasters/low-stock-detected-v1-to-v2.upcaster';
import { validateFarmEvent } from '../validator';

/**
 * Trust-boundary validation for the two-tier LowStockDetected (plan K8).
 *
 * The gateway validates the RAW wire payload before any upcaster runs, so the
 * one schema must accept v1 (no tier) and v2 (site | pool) while rejecting
 * every mixed shape. The upcaster tests pin the NatsEventBus path, where a v1
 * event reaches typed consumers only after being lifted to v2.
 */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function siteEvent(): SiteLowStockDetectedEvent {
  return {
    ...createBaseEvent<SiteLowStockDetectedEvent>('LowStockDetected', TENANT, {
      version: LOW_STOCK_DETECTED_VERSION,
    }),
    level: 'site',
    siteId: SITE,
    itemType: 'feed',
    itemId: ITEM,
    itemName: 'Skretting 3mm',
    currentQuantity: 120,
    unit: 'kg',
    minimumThreshold: 500,
    severity: 'low_stock',
  };
}

function poolEvent(): PoolLowStockDetectedEvent {
  return {
    ...createBaseEvent<PoolLowStockDetectedEvent>('LowStockDetected', TENANT, {
      version: LOW_STOCK_DETECTED_VERSION,
    }),
    level: 'pool',
    itemType: 'spare_part',
    itemId: ITEM,
    itemName: 'Pump seal',
    currentQuantity: 1,
    unit: 'piece',
    minimumThreshold: 4,
    severity: 'low_stock',
    onOrderQuantity: 2,
  };
}

/** A v1 wire payload as the pre-K8 producer emitted it: no tier at all. */
function v1Payload(): Record<string, unknown> {
  const { level: _level, onOrderQuantity: _onOrder, ...rest } = poolEvent();
  return { ...rest, version: 1, itemType: 'feed' };
}

describe('LowStockDetected tier schema (plan K8)', () => {
  it('accepts a site event that names its site', () => {
    // SCENARIO: site tier crossed its policy minimum. EXPECTS: valid.
    expect(validateFarmEvent('LowStockDetected', siteEvent()).valid).toBe(true);
  });

  it('accepts a pool event carrying the open purchase-order remainder', () => {
    // SCENARIO: pool inventory position crossed the reorder threshold. EXPECTS: valid.
    expect(validateFarmEvent('LowStockDetected', poolEvent()).valid).toBe(true);
  });

  it('accepts a v1 event with no tier (in flight across the deploy)', () => {
    // SCENARIO: an outbox row written before v2 is relayed after it. EXPECTS: the
    // gateway still accepts it instead of silently dropping a stock alert.
    expect(validateFarmEvent('LowStockDetected', v1Payload()).valid).toBe(true);
  });

  it('rejects a site event without siteId', () => {
    // SCENARIO: producer forgot the site. EXPECTS: rejected (ambiguous alert).
    const { siteId: _siteId, ...withoutSite } = siteEvent();
    expect(validateFarmEvent('LowStockDetected', withoutSite).valid).toBe(false);
  });

  it('rejects a site event carrying a pool-only field', () => {
    // SCENARIO: site payload with onOrderQuantity. EXPECTS: rejected.
    expect(
      validateFarmEvent('LowStockDetected', { ...siteEvent(), onOrderQuantity: 3 }).valid,
    ).toBe(false);
  });

  it('rejects a pool event that names a site', () => {
    // SCENARIO: pool payload with siteId. EXPECTS: rejected — the pool has no site.
    expect(validateFarmEvent('LowStockDetected', { ...poolEvent(), siteId: SITE }).valid).toBe(
      false,
    );
  });

  it('rejects an unknown tier', () => {
    // SCENARIO: level outside the closed vocabulary. EXPECTS: rejected.
    expect(validateFarmEvent('LowStockDetected', { ...poolEvent(), level: 'region' }).valid).toBe(
      false,
    );
  });

  it('accepts the spare_part item type (spare parts share the storage ledger)', () => {
    // SCENARIO: spare-part pool event. EXPECTS: valid item type.
    expect(validateFarmEvent('LowStockDetected', poolEvent()).valid).toBe(true);
  });
});

describe('LowStockDetected v1 → v2 upcaster', () => {
  it('lifts a v1 event to a v2 pool event with an unknown on-order remainder', () => {
    // SCENARIO: v1 had one producer (tenant-wide SUM). EXPECTS: level pool,
    // onOrderQuantity null (unknown, not zero), version 2, fields preserved.
    const lifted = lowStockDetectedUpcaster.upcast(v1Payload());
    expect(lifted).toMatchObject({
      version: 2,
      level: 'pool',
      onOrderQuantity: null,
      itemId: ITEM,
      currentQuantity: 1,
    });
    expect(lifted).not.toHaveProperty('siteId');
  });

  it('is chained by the default registry so NatsEventBus consumers see v2', () => {
    // SCENARIO: NatsEventBus deserialises a v1 payload. EXPECTS: v2 pool shape.
    const lifted = createDefaultRegistry().upcast(v1Payload());
    expect(lifted['version']).toBe(LOW_STOCK_DETECTED_VERSION);
    expect(lifted['level']).toBe('pool');
    expect(validateFarmEvent('LowStockDetected', lifted).valid).toBe(true);
  });

  it('leaves a v2 event untouched', () => {
    // SCENARIO: current producer output. EXPECTS: identity.
    const event = { ...siteEvent() };
    expect(createDefaultRegistry().upcast(event)).toEqual(event);
  });
});
