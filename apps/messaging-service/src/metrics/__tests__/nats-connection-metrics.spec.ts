/**
 * MSGFIX-FAZ0 — NATS connection metrics unit tests.
 *
 * Drives NatsConnectionMetricsService with synthetic event-bus lifecycle
 * snapshots (the same CoreNatsConnectionSnapshot shape NatsEventBus emits)
 * and asserts the Prometheus registry OUTPUT of the real
 * MessagingMetricsService: `messaging_nats_connection_status` (enum gauge)
 * and `messaging_nats_reconnects_total` (recovery counter, initial connect
 * excluded).
 */
import { MessagingMetricsService } from '../messaging-metrics.service';
import { NatsConnectionMetricsService } from '../nats-connection-metrics.service';
import type { CoreNatsConnectionSnapshot } from '@platform/event-bus';

type Listener = (snapshot: CoreNatsConnectionSnapshot) => void;

/** Fake bus exposing only the lifecycle hook — registers the listener and replays snapshots on demand. */
function createLifecycleBus() {
  let listener: Listener | undefined;
  const bus = {
    onCoreConnectionLifecycle: jest.fn((l: Listener) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    }),
    emit(snapshot: CoreNatsConnectionSnapshot): void {
      listener?.(snapshot);
    },
    hasListener(): boolean {
      return listener !== undefined;
    },
  };
  return bus;
}

const snapshot = (
  state: CoreNatsConnectionSnapshot['state'],
): CoreNatsConnectionSnapshot => ({ connection: null, generation: 1, state });

function buildService(bus: object) {
  const metrics = new MessagingMetricsService();
  metrics.onModuleInit();
  const service = new NatsConnectionMetricsService(bus as never, metrics);
  return { service, metrics };
}

describe('NatsConnectionMetricsService (MSGFIX-FAZ0)', () => {
  it('subscribes on module init and the bus delivers the current snapshot immediately', async () => {
    const bus = createLifecycleBus();
    const { service } = buildService(bus);

    service.onModuleInit();

    // The real NatsEventBus invokes the listener synchronously at
    // registration — that immediate call is what seeds the gauge at boot.
    expect(bus.onCoreConnectionLifecycle).toHaveBeenCalledTimes(1);
    expect(bus.hasListener()).toBe(true);
  });

  it('reports connected=2 / reconnecting=1 / disconnected=0 on the status gauge', async () => {
    const bus = createLifecycleBus();
    const { service, metrics } = buildService(bus);
    service.onModuleInit();

    bus.emit(snapshot('connected'));
    expect(await metrics.getMetrics()).toMatch(/^messaging_nats_connection_status 2$/m);

    bus.emit(snapshot('reconnecting'));
    expect(await metrics.getMetrics()).toMatch(/^messaging_nats_connection_status 1$/m);

    bus.emit(snapshot('disconnected'));
    expect(await metrics.getMetrics()).toMatch(/^messaging_nats_connection_status 0$/m);
  });

  it('counts a recovery as a reconnect — the INITIAL connect is not one', async () => {
    const bus = createLifecycleBus();
    const { service, metrics } = buildService(bus);
    service.onModuleInit();

    // Boot path: reconnecting → connected. No reconnect counted.
    bus.emit(snapshot('reconnecting'));
    bus.emit(snapshot('connected'));
    expect(await metrics.getMetrics()).toMatch(/^messaging_nats_reconnects_total 0$/m);

    // Outage + recovery: disconnected → reconnecting → connected = +1.
    bus.emit(snapshot('disconnected'));
    bus.emit(snapshot('reconnecting'));
    bus.emit(snapshot('connected'));
    expect(await metrics.getMetrics()).toMatch(/^messaging_nats_reconnects_total 1$/m);

    // A second outage cycle accumulates.
    bus.emit(snapshot('disconnected'));
    bus.emit(snapshot('connected'));
    expect(await metrics.getMetrics()).toMatch(/^messaging_nats_reconnects_total 2$/m);
  });

  it('degrades gracefully when the event bus does not expose the lifecycle hook', async () => {
    const { service, metrics } = buildService({});

    expect(() => service.onModuleInit()).not.toThrow();

    const output = await metrics.getMetrics();
    // Metrics exist in the registry (HELP/TYPE lines) but hold zero values.
    expect(output).toContain('# HELP messaging_nats_reconnects_total');
    expect(output).toContain('# HELP messaging_nats_connection_status');
    expect(output).toMatch(/^messaging_nats_reconnects_total 0$/m);
  });

  it('unsubscribes on destroy', () => {
    const bus = createLifecycleBus();
    const { service } = buildService(bus);
    service.onModuleInit();

    service.onModuleDestroy();

    expect(bus.hasListener()).toBe(false);
  });
});
