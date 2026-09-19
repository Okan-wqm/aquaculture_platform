import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT: the JetStream file store fits every stream the event bus declares.
 *
 * WHY (INFRA-HIGH-177): `platform/libs/event-bus/src/nats/nats-event-bus.ts`
 * declares three streams with `max_bytes` budgets. NATS reserves those
 * budgets against `jetstream.max_file_store` and refuses to CREATE OR RECREATE
 * a stream that does not fit ("insufficient storage resources available"). On
 * 2026-08-25 the 6GiB AQUACULTURE_TELEMETRY stream landed while nats.conf
 * stayed at 2GB. The running broker kept the stream it had already accepted,
 * so nothing noticed until the 2026-09-19 deploys recreated the container:
 * the telemetry stream could not be restored, the broker sat unhealthy for
 * hours, and every deploy died at the NATS health wait.
 *
 * The capacity gate written to catch "the half-done version of exactly that
 * change" (`scripts/deploy/droplet-capacity.sh`) did not, because its floor
 * was a hand-typed second copy of the stream sizes and drifted with them. So
 * this spec reads the budgets FROM THE EVENT-BUS SOURCE and holds the three
 * derived numbers to it:
 *
 *   1. nats.conf `max_file_store`           ≥ Σ max_bytes × 1.25 (the gate's reserve)
 *   2. droplet-capacity.sh default floor    = Σ max_bytes × 1.25 exactly
 *   3. JetStreamStorageHigh alert threshold = max_file_store × 0.75 exactly
 *
 * Raising a stream budget without the other three files fails here, at review
 * time, instead of on the droplet after the broker restarts.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const EVENT_BUS = 'platform/libs/event-bus/src/nats/nats-event-bus.ts';
const NATS_CONF = 'infrastructure/docker/nats/nats.conf';
const CAPACITY_GATE = 'scripts/deploy/droplet-capacity.sh';
const ALERT_RULES = 'infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml';

const RESERVE_FACTOR = 1.25;
const ALERT_FRACTION = 0.75;

/**
 * Evaluate a `max_bytes:` right-hand side as the event bus writes it: a
 * product of integer literals, optionally wrapped in
 * `Number(this.configService.get('ENV_NAME', <product>))` for the streams
 * whose default an operator may override. Anything else is a spec failure —
 * a new shape must be taught here rather than silently skipped.
 */
function evaluateByteProduct(expression: string): number {
  const inner = /^Number\(this\.configService\.get\('[A-Z_]+',\s*(.+)\)\)$/.exec(expression.trim());
  const product = (inner?.[1] ?? expression).trim();
  if (!/^\d+(?:\s*\*\s*\d+)*$/.test(product)) {
    throw new Error(`unrecognised max_bytes expression in ${EVENT_BUS}: ${expression}`);
  }
  return product.split('*').reduce((acc, factor) => acc * Number(factor.trim()), 1);
}

function declaredStreamBudgets(): number[] {
  const source = read(EVENT_BUS);
  const budgets = [...source.matchAll(/^\s*max_bytes:\s*(.+?),\s*(?:\/\/.*)?$/gm)].map((m) => {
    const expression = m[1];
    if (expression === undefined) throw new Error(`max_bytes match without a value: ${m[0]}`);
    return evaluateByteProduct(expression);
  });
  if (budgets.length !== 3) {
    throw new Error(
      `expected the event bus to declare exactly three stream budgets (telemetry, events, DLQ); found ${budgets.length}`,
    );
  }
  return budgets;
}

function parseNatsSize(value: string): number {
  const m = /^(\d+)(KB|MB|GB|TB)?$/i.exec(value.trim());
  if (!m) throw new Error(`unparseable NATS size literal: ${value}`);
  const unit = (m[2] ?? '').toUpperCase();
  const scale = { '': 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit];
  if (scale === undefined) throw new Error(`unknown NATS size unit: ${value}`);
  return Number(m[1]) * scale;
}

function configuredMaxFileStore(): number {
  const m = /^\s*max_file_store:\s*(\S+)\s*$/m.exec(read(NATS_CONF));
  const value = m?.[1];
  if (value === undefined) throw new Error(`${NATS_CONF} declares no jetstream.max_file_store`);
  return parseNatsSize(value);
}

function capacityGateDefaultFloor(): number {
  const m = /NATS_REQUIRED_FILE_STORE_BYTES="\$\{NATS_REQUIRED_FILE_STORE_BYTES:-(\d+)\}"/.exec(
    read(CAPACITY_GATE),
  );
  if (!m) throw new Error(`${CAPACITY_GATE} declares no NATS_REQUIRED_FILE_STORE_BYTES default`);
  return Number(m[1]);
}

function alertThreshold(): number {
  const m = /nats_server_jetstream_total_storage_bytes\s*>\s*(\d+)/.exec(read(ALERT_RULES));
  if (!m) throw new Error(`${ALERT_RULES} declares no JetStreamStorageHigh threshold`);
  return Number(m[1]);
}

describe('INVARIANT (INFRA-HIGH-177): the JetStream file store fits the declared streams', () => {
  const budgets = declaredStreamBudgets();
  const declaredTotal = budgets.reduce((a, b) => a + b, 0);
  const requiredStore = Math.floor(declaredTotal * RESERVE_FACTOR);
  const maxFileStore = configuredMaxFileStore();

  it('reads the three stream budgets from the event-bus source', () => {
    // Telemetry (6GiB), events (1.5GiB), DLQ (256MiB) at the time of writing;
    // the assertion is on shape, the values are whatever the source says.
    expect(budgets.every((b) => Number.isInteger(b) && b > 0)).toBe(true);
    expect(declaredTotal).toBeGreaterThan(0);
  });

  it('nats.conf max_file_store holds every declared stream with the 25% reserve', () => {
    expect(maxFileStore).toBeGreaterThanOrEqual(requiredStore);
  });

  it('every single stream fits the store on its own (NATS refuses to recreate one that does not)', () => {
    for (const budget of budgets) expect(budget).toBeLessThan(maxFileStore);
  });

  it("droplet-capacity.sh's default floor is exactly the declared total × 1.25", () => {
    expect(capacityGateDefaultFloor()).toBe(requiredStore);
  });

  it('the JetStreamStorageHigh threshold is exactly 75% of the configured store', () => {
    expect(alertThreshold()).toBe(Math.floor(maxFileStore * ALERT_FRACTION));
  });
});
