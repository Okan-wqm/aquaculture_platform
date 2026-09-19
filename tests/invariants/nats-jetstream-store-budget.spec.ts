/**
 * Platform-wide invariant — JetStream store budget.
 *
 * Every stream the event bus provisions carries a `max_bytes` RESERVATION.
 * JetStream refuses to create — or, after a restart, to recover — a stream
 * whose reservation does not fit in `max_file_store` minus what the other
 * streams already hold (error 10047, "insufficient storage resources
 * available"), and a server that cannot recover a stream never passes its
 * healthcheck. The 2026-08-25 telemetry stream (SENSOR-HIGH-092) reserved
 * 6 GiB while nats.conf still said 2 GiB; the production NATS came back
 * unhealthy on the next restart and every deploy stopped at the ACL reload.
 *
 * The budget is pinned here at the source: the conf value must cover the
 * sum of the three defaults in nats-event-bus.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const NATS_CONF = 'infrastructure/docker/nats/nats.conf';
const EVENT_BUS = 'platform/libs/event-bus/src/nats/nats-event-bus.ts';
const CAPACITY_GATE = 'scripts/deploy/droplet-capacity.sh';
const ALERT_RULES = 'infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml';

/**
 * INFRA-HIGH-177: two more numbers are copies of this budget and drifted with
 * it. `droplet-capacity.sh` guards `max_file_store >= reserved × 1.25` on the
 * droplet — the gate written to catch "the half-done version of exactly that
 * change" — but its floor was a hand-typed second copy of the stream sizes
 * (the events stream alone), so it stayed green while the telemetry stream
 * tripled the reservation. And `JetStreamStorageHigh` fires at 75% of the
 * store, a third copy. Both are held to the source here: the floor must equal
 * the reserve exactly, the alert must equal 75% of the configured store.
 */
const CAPACITY_RESERVE_FACTOR = 1.25;
const ALERT_FRACTION = 0.75;

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `2GB`, `10GB`, `96MB` → bytes, as nats-server reads them (binary units). */
function parseNatsSize(value: string): number {
  const match = /^(\d+)([KMGT])B?$/i.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2]?.toUpperCase();
  const multiplier = unit === undefined ? undefined : UNIT[unit];
  if (amount === undefined || multiplier === undefined) {
    throw new Error(`unparseable nats size: ${value}`);
  }
  return Number(amount) * multiplier;
}

/** The literal byte expression on a `max_bytes:` line, e.g. `1536 * 1024 * 1024`. */
function evaluateByteExpression(expression: string): number {
  const factors = expression.split('*').map((part) => part.trim());
  if (factors.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`max_bytes expression is not a product of integers: ${expression}`);
  }
  return factors.reduce((product, part) => product * Number(part), 1);
}

function streamReservations(source: string): Map<string, number> {
  const reservations = new Map<string, number>();
  const pattern =
    /max_bytes:\s*(?:Number\(this\.configService\.get\('([A-Z_]+)',\s*([\d\s*]+)\)\)|([\d\s*]+)),/g;
  for (const match of source.matchAll(pattern)) {
    const label = match[1] ?? `literal@${match.index}`;
    reservations.set(label, evaluateByteExpression(match[2] ?? match[3] ?? ''));
  }
  return reservations;
}

describe('INVARIANT: nats.conf max_file_store covers every JetStream stream reservation', () => {
  const conf = readFileSync(resolve(REPO_ROOT, NATS_CONF), 'utf8');
  const source = readFileSync(resolve(REPO_ROOT, EVENT_BUS), 'utf8');

  it('declares max_file_store once, in the jetstream block', () => {
    const matches = conf.match(/^\s*max_file_store:\s*\S+/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('the three stream defaults are readable from the event bus source', () => {
    const reservations = streamReservations(source);
    // EVENTS (literal), DLQ (NATS_DLQ_MAX_BYTES) and TELEMETRY (NATS_TELEMETRY_MAX_BYTES).
    expect(reservations.size).toBe(3);
    expect(reservations.has('NATS_TELEMETRY_MAX_BYTES')).toBe(true);
    expect(reservations.has('NATS_DLQ_MAX_BYTES')).toBe(true);
  });

  it('the sum of the reservations fits under max_file_store', () => {
    const storeLimit = parseNatsSize(/^\s*max_file_store:\s*(\S+)/m.exec(conf)?.[1] ?? '');
    const reserved = [...streamReservations(source).values()].reduce((a, b) => a + b, 0);
    expect({
      reservedBytes: reserved,
      maxFileStoreBytes: storeLimit,
      fits: reserved < storeLimit,
    }).toEqual({ reservedBytes: reserved, maxFileStoreBytes: storeLimit, fits: true });
  });

  it('every single stream fits the store on its own (a restart recreates them one at a time)', () => {
    const storeLimit = parseNatsSize(/^\s*max_file_store:\s*(\S+)/m.exec(conf)?.[1] ?? '');
    for (const [label, bytes] of streamReservations(source)) {
      expect({ label, fits: bytes < storeLimit }).toEqual({ label, fits: true });
    }
  });

  it("droplet-capacity.sh's default floor is exactly the reserved total × 1.25", () => {
    const gate = readFileSync(resolve(REPO_ROOT, CAPACITY_GATE), 'utf8');
    const floor =
      /NATS_REQUIRED_FILE_STORE_BYTES="\$\{NATS_REQUIRED_FILE_STORE_BYTES:-(\d+)\}"/.exec(
        gate,
      )?.[1];
    const reserved = [...streamReservations(source).values()].reduce((a, b) => a + b, 0);
    expect(Number(floor)).toBe(Math.floor(reserved * CAPACITY_RESERVE_FACTOR));
  });

  it('max_file_store covers the capacity gate reserve, not just the bare sum', () => {
    const storeLimit = parseNatsSize(/^\s*max_file_store:\s*(\S+)/m.exec(conf)?.[1] ?? '');
    const reserved = [...streamReservations(source).values()].reduce((a, b) => a + b, 0);
    expect(storeLimit).toBeGreaterThanOrEqual(Math.floor(reserved * CAPACITY_RESERVE_FACTOR));
  });

  it('the JetStreamStorageHigh threshold is exactly 75% of the configured store', () => {
    const rules = readFileSync(resolve(REPO_ROOT, ALERT_RULES), 'utf8');
    const threshold = /nats_server_jetstream_total_storage_bytes\s*>\s*(\d+)/.exec(rules)?.[1];
    const storeLimit = parseNatsSize(/^\s*max_file_store:\s*(\S+)/m.exec(conf)?.[1] ?? '');
    expect(Number(threshold)).toBe(Math.floor(storeLimit * ALERT_FRACTION));
  });
});
