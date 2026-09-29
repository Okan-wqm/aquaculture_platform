/**
 * NATS boot-order contract (ORPHAN-HIGH-409)
 * ============================================================================
 *
 * `libs/backend-common/src/nats/nats-connection.factory.ts` REFUSES boot when
 * the broker is unreachable in production ("Boot refuses to proceed"). With
 * `restart: unless-stopped` that refusal becomes a crash-loop, and on a cold
 * `up -d` the whole stack starts at once — the broker needs 60-100s to go
 * healthy on a CPU-starved 4-core droplet. Any NATS client that does not WAIT
 * for the broker therefore crash-loops until the deploy health-gate window
 * expires and the release rolls back.
 *
 * ORPHAN-HIGH-409 was closed by hand in `docker-compose.droplet.yml`
 * (commit a702bf968) and nothing pinned it, so the same defect stayed alive in
 * `docker-compose.prod.yml` (four clients with no `nats` entry at all) and in
 * `docker-compose.watch.yml` (six clients gated on `service_started`, which is
 * satisfied the instant the container process exists — before the broker
 * accepts a single connection). This spec is the gate that makes the hand-fix
 * permanent, for every compose stack, derived from the SSoT rather than from a
 * list somebody has to remember to extend.
 *
 * # DERIVATION — no hardcoded service list
 *
 * `infrastructure/nats/services.yaml` is the SSoT of NATS client identities
 * (ADR-014 / ADR-015): one entry per certificate CN, each bound to exactly one
 * runtime `application`. A compose service is a NATS client if and only if its
 * name is one of those `application` values. Both directions are asserted:
 * every client waits for the broker, and nothing that is NOT a client claims a
 * broker dependency (which would mean a container talks to NATS without a cert
 * identity — the ADR-015 violation `e2e/tests/integration/nats-invariants.spec.ts`
 * checks from the certificate side).
 *
 * # STACK vs OVERLAY
 *
 * The discriminator is structural, not a filename allowlist: a compose file is
 * a runnable STACK when its `nats` service carries its own `image` (or
 * `extends` one), and an OVERLAY when the `nats` entry only re-tunes knobs of a
 * base file's definition (`docker-compose.staging.yml` overlays
 * `docker-compose.droplet.yml` and deliberately overrides nothing topological).
 * A new compose file is covered because it exists, not because it was added
 * here.
 *
 * # WHY `service_healthy` AND WHY `/healthz`
 *
 * `service_started` only proves the container was created. The broker's
 * readiness signal is the monitoring endpoint on port 8222: `/healthz` reports
 * ok once the server AND JetStream are serving, which is what a pull-consumer
 * client actually needs. A `nc -z 4222` probe flips healthy on the first TCP
 * accept, i.e. inside the very window `depends_on` exists to close — so the
 * probe target is asserted, not merely the presence of a healthcheck.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVICES_YAML = path.join(REPO_ROOT, 'infrastructure', 'nats', 'services.yaml');
const NATS_SERVICE = 'nats';
const REQUIRED_CONDITION = 'service_healthy';
/** NATS monitoring port + readiness path (`http_port` / `-m 8222` in every stack). */
const READINESS_PROBE_MARKER = '8222/healthz';

interface NatsServiceRegistry {
  services: Array<{ name: string; application: string }>;
}

type DependsOn = Record<string, { condition?: string } | string> | string[];

interface ComposeService {
  image?: string;
  extends?: { file?: string; service?: string };
  depends_on?: DependsOn;
  healthcheck?: { test?: string | string[] };
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

interface ComposeStack {
  file: string;
  broker: ComposeService;
  /** Every service in the file, name-paired so nothing re-indexes the record. */
  entries: Array<[string, ComposeService]>;
}

function loadCompose(file: string): ComposeDocument {
  return (yaml.load(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) ?? {}) as ComposeDocument;
}

function composeFiles(): string[] {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((entry) => /^docker-compose(\..+)?\.ya?ml$/.test(entry))
    .sort();
}

/** Broker dependency declared by a compose service, or undefined when absent. */
function natsCondition(service: ComposeService): string | undefined {
  const dependsOn = service.depends_on;
  if (dependsOn === undefined) return undefined;
  if (Array.isArray(dependsOn)) {
    // Short-form `depends_on: [nats]` is start-order only — compose treats it
    // as `service_started`, so report it as such rather than as compliant.
    return dependsOn.includes(NATS_SERVICE) ? 'service_started' : undefined;
  }
  const entry = dependsOn[NATS_SERVICE];
  if (entry === undefined) return undefined;
  return typeof entry === 'string' ? entry : (entry.condition ?? 'service_started');
}

function healthcheckTest(service: ComposeService, file: string): string {
  const own = service.healthcheck?.test;
  if (own !== undefined) return Array.isArray(own) ? own.join(' ') : own;
  // `extends` pulls the definition (healthcheck included) from another file;
  // resolve one level so an extending stack is judged on its effective config.
  const base = service.extends;
  if (base?.file !== undefined && base.service !== undefined) {
    const baseDoc = loadCompose(base.file);
    const baseService = baseDoc.services?.[base.service];
    const inherited = baseService?.healthcheck?.test;
    if (inherited !== undefined) return Array.isArray(inherited) ? inherited.join(' ') : inherited;
  }
  throw new Error(
    `${file}: the "${NATS_SERVICE}" service declares no healthcheck, so every ` +
      `"condition: ${REQUIRED_CONDITION}" dependency on it is unsatisfiable.`,
  );
}

const registry = yaml.load(fs.readFileSync(SERVICES_YAML, 'utf8')) as NatsServiceRegistry;
const NATS_APPLICATIONS = new Set(registry.services.map((service) => service.application));

const stacks: ComposeStack[] = [];
const overlays: ComposeStack[] = [];
for (const file of composeFiles()) {
  const services = loadCompose(file).services ?? {};
  const broker = services[NATS_SERVICE];
  if (broker === undefined) continue;
  const entry: ComposeStack = { file, broker, entries: Object.entries(services) };
  // A stack OWNS the broker definition (image, or an `extends` of one); an
  // overlay only re-tunes a base file's definition.
  if (broker.image !== undefined || broker.extends !== undefined) {
    stacks.push(entry);
  } else {
    overlays.push(entry);
  }
}

describe('NATS boot-order contract (ORPHAN-HIGH-409)', () => {
  it('derives the client set from infrastructure/nats/services.yaml', () => {
    expect(NATS_APPLICATIONS.size).toBe(registry.services.length);
    expect(NATS_APPLICATIONS.size).toBeGreaterThan(0);
    // Guard the discovery itself: a parsing regression that silently empties
    // the matrix below would turn this whole gate into a no-op.
    expect(stacks.map((stack) => stack.file)).toContain('docker-compose.droplet.yml');
    expect(stacks.length).toBeGreaterThanOrEqual(4);
  });

  describe.each(stacks.map((stack) => [stack.file, stack] as const))('%s', (file, stack) => {
    const clients = stack.entries.filter(([name]) => NATS_APPLICATIONS.has(name));

    it('probes broker READINESS on the monitoring port, not TCP accept on 4222', () => {
      expect(healthcheckTest(stack.broker, file)).toContain(READINESS_PROBE_MARKER);
    });

    it('makes every services.yaml NATS application wait for a HEALTHY broker', () => {
      const violations = clients
        .map(([name, service]) => ({ name, condition: natsCondition(service) }))
        .filter((entry) => entry.condition !== REQUIRED_CONDITION)
        .map((entry) => `${entry.name} → ${entry.condition ?? 'no nats dependency'}`);
      expect(violations).toEqual([]);
    });

    it('declares a broker dependency ONLY for services.yaml applications', () => {
      const impostors = stack.entries
        .filter(
          ([name, service]) =>
            name !== NATS_SERVICE &&
            !NATS_APPLICATIONS.has(name) &&
            natsCondition(service) !== undefined,
        )
        .map(([name]) => name);
      expect(impostors).toEqual([]);
    });
  });

  describe.each(
    overlays.length > 0 ? overlays.map((overlay) => [overlay.file, overlay] as const) : [],
  )('%s (overlay)', (_file, overlay) => {
    it('never weakens the base stack broker dependency', () => {
      const weakened = overlay.entries
        .map(([name, service]) => ({ name, condition: natsCondition(service) }))
        .filter((entry) => entry.condition !== undefined && entry.condition !== REQUIRED_CONDITION)
        .map((entry) => `${entry.name} → ${entry.condition}`);
      expect(weakened).toEqual([]);
    });
  });
});
