import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { Server } from 'socket.io';
import {
  createBaseEvent,
  LOW_STOCK_DETECTED_VERSION,
  validateFarmEvent,
  type PoolLowStockDetectedEvent,
  type SiteLowStockDetectedEvent,
} from '@platform/event-contracts';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

import { FarmGateway } from '../farm.gateway';
import { FarmNatsBridgeService } from '../farm-nats-bridge.service';
import { tenantRoomLowStock } from '../low-stock-tenant-room';

/**
 * LowStockDetected tiers vs the farm tenant room (plan K8, V-B1-11).
 *
 * farm-service emits one LowStockDetected per stock tier. A SITE event names
 * one site and that site's on-hand; farm-service shows site rows only to users
 * assigned to that site (SEC-HIGH-051). The farm gateway's only room is
 * `tenant:{tenantId}` — it has no site-scoped room — so a site event must not
 * be broadcast at all, while a POOL event (a tenant aggregate) and a v1 event
 * (tierless; the upcaster lifts it to pool) still reach the tenant.
 *
 * The fixtures are real wire payloads: built with the contract types, passed
 * through JSON like the NATS bridge receives them, and accepted by the same
 * schema validator the bridge runs before routing.
 */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type WirePayload = Record<string, unknown> & {
  eventId: string;
  eventType: string;
  tenantId: string;
  timestamp: string;
};

function wire(event: object): WirePayload {
  const parsed: WirePayload = JSON.parse(JSON.stringify(event));
  expect(validateFarmEvent('LowStockDetected', parsed).valid).toBe(true);
  return parsed;
}

function siteEvent(): WirePayload {
  const event: SiteLowStockDetectedEvent = {
    ...createBaseEvent<SiteLowStockDetectedEvent>('LowStockDetected', TENANT, {
      version: LOW_STOCK_DETECTED_VERSION,
    }),
    level: 'site',
    siteId: SITE,
    itemType: 'feed',
    itemId: ITEM,
    itemName: 'Grower 3mm',
    currentQuantity: 30,
    unit: 'kg',
    minimumThreshold: 40,
    severity: 'low_stock',
  };
  return wire(event);
}

function poolEvent(): WirePayload {
  const event: PoolLowStockDetectedEvent = {
    ...createBaseEvent<PoolLowStockDetectedEvent>('LowStockDetected', TENANT, {
      version: LOW_STOCK_DETECTED_VERSION,
    }),
    level: 'pool',
    itemType: 'feed',
    itemId: ITEM,
    itemName: 'Grower 3mm',
    currentQuantity: 110,
    unit: 'kg',
    minimumThreshold: 120,
    severity: 'low_stock',
    onOrderQuantity: 5,
  };
  return wire(event);
}

/** A v1 payload as the pre-K8 producer emitted it: no tier at all. */
function v1Event(): WirePayload {
  const { level: _level, onOrderQuantity: _onOrder, ...rest } = poolEvent();
  return wire({ ...rest, version: 1 });
}

describe('LowStockDetected → farm tenant room (plan K8, V-B1-11)', () => {
  let emit: jest.Mock;
  let to: jest.Mock;
  let bridge: FarmNatsBridgeService;
  let revalidator: WsTokenRevalidator;

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    const configService = {
      get: jest.fn().mockReturnValue('test'),
    } as Partial<ConfigService> as ConfigService;
    revalidator = new WsTokenRevalidator({ intervalMs: 3_600_000, isStillValid: async () => true });
    const gateway = new FarmGateway(
      {} as Partial<JwtService> as JwtService,
      configService,
      new TenantConnectionLimiter(),
      revalidator,
    );
    gateway.server = { to } as Partial<Server> as Server;
    bridge = new FarmNatsBridgeService(configService, gateway);
  });

  afterEach(() => {
    // The revalidator starts its interval in the constructor; stop it so the
    // run exits instead of holding an open timer.
    revalidator.onModuleDestroy();
  });

  /** The bridge's routing step, exactly as the NATS subscription loop calls it. */
  function route(payload: WirePayload): void {
    bridge['handleEvent'](TENANT, 'LowStockDetected', payload);
  }

  it('withholds a SITE-tier event from the tenant room', () => {
    // SCENARIO: site C fell below its policy minimum; the event carries siteId
    // and that site's on-hand. EXPECTS: nothing is emitted to any room — the
    // gateway has no site-scoped room, so the tenant room would leak it to
    // users not assigned to the site.
    route(siteEvent());

    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('broadcasts a v2 POOL-tier event to the tenant room, verbatim', () => {
    // SCENARIO: the tenant pool crossed its reorder threshold (a tenant
    // aggregate). EXPECTS: one lowStockDetected emit to tenant:{tenantId}
    // carrying the payload unchanged.
    const payload = poolEvent();
    route(payload);

    expect(to).toHaveBeenCalledWith(`tenant:${TENANT}`);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('lowStockDetected', payload);
  });

  it('broadcasts a v1 (tierless) event to the tenant room', () => {
    // SCENARIO: an outbox row written before v2 relayed after the deploy; it
    // has no level (the upcaster lifts it to pool). EXPECTS: delivered.
    const payload = v1Event();
    route(payload);

    expect(to).toHaveBeenCalledWith(`tenant:${TENANT}`);
    expect(emit).toHaveBeenCalledWith('lowStockDetected', payload);
  });
});

describe('tenantRoomLowStock', () => {
  it('admits pool and tierless payloads, refuses anything that names a site', () => {
    // SCENARIO: the four shapes a payload can take at the bridge. EXPECTS: the
    // same object back for pool / v1, null for a site tier and for a payload
    // that carries a siteId without a level (fail closed).
    const pool = poolEvent();
    const v1 = v1Event();
    expect(tenantRoomLowStock(pool)).toBe(pool);
    expect(tenantRoomLowStock(v1)).toBe(v1);
    expect(tenantRoomLowStock(siteEvent())).toBeNull();
    expect(tenantRoomLowStock({ ...v1, siteId: SITE })).toBeNull();
  });
});
