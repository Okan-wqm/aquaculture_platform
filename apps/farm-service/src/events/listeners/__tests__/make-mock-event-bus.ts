/**
 * Fully-typed `IEventBus` test double for the migrated NATS listener specs.
 *
 * Returns a `jest.Mocked<IEventBus>` with every interface method stubbed as a
 * jest.fn(), so it can be passed straight into a listener's `EVENT_BUS` slot
 * with NO cast (the listener constructor takes `IEventBus | undefined`). Tests
 * assert on `.subscribeWildcard` / `.publish` and ignore the rest.
 *
 * Lives next to the specs (under __tests__) so it is excluded from production
 * builds while still being a single source of truth for the listener bus
 * doubles — no per-spec re-declaration drift.
 */
import type { EventBusHealth, IEventBus } from '@platform/event-bus';

const HEALTHY: EventBusHealth = {
  isHealthy: true,
  connectionState: 'connected',
};

export function makeMockEventBus(): jest.Mocked<IEventBus> {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
    publishBatch: jest.fn().mockResolvedValue(undefined),
    publishTo: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    subscribeForTenant: jest.fn().mockResolvedValue(undefined),
    subscribeTo: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribeFrom: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getHealth: jest.fn().mockResolvedValue(HEALTHY),
  };
}
