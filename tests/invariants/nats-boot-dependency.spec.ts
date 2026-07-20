import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every compose service that connects to NATS at boot MUST declare
 * `depends_on: nats: { condition: service_healthy }`.
 *
 * WHY: the NATS client factory (`libs/backend-common/src/nats/
 * nats-connection.factory.ts`) THROWS in production when NATS is unreachable,
 * and with `restart: unless-stopped` that becomes a crash-loop. Eight services
 * mounted the NATS client certs (so they connect at boot) but declared no
 * `nats` dependency, and two used the weaker `service_started` — on a cold full
 * deploy (~14 containers up at once on a CPU-starved droplet) NATS may not be
 * healthy when they boot, so the factory throws and they crash-loop until the
 * deploy health-gate window expires (ORPHAN-HIGH-409). Every NATS consumer
 * mounts the canonical public-CA anchor in addition to its exact identity.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const COMPOSE = 'docker-compose.droplet.yml';

// Every NATS client references the one public-CA anchor. Private identities
// are deliberately exact-file mounts, enforced independently by
// production-cert-identity-store.spec.ts; no shared private-key anchor exists.
const NATS_CA_ANCHOR = '*nats-ca-mount';

interface ServiceBlock {
  name: string;
  body: string;
}

function serviceBlocks(): ServiceBlock[] {
  const lines = readFileSync(resolve(REPO_ROOT, COMPOSE), 'utf8').split('\n');
  const starts: { name: string; idx: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(l);
    if (m?.[1] !== undefined) starts.push({ name: m[1], idx: i });
  });
  return starts.map((s, k) => ({
    name: s.name,
    body: lines.slice(s.idx, starts[k + 1]?.idx ?? lines.length).join('\n'),
  }));
}

function dependsOnBlock(body: string): string {
  // depends_on: up to the next top-level (4-space) service key.
  const m = /\n {4}depends_on:\n([\s\S]*?)(?=\n {4}[a-z]|\n {2}[a-z0-9-]+:|$)/.exec(body);
  return m?.[1] ?? '';
}

describe('NATS boot dependency', () => {
  it('every NATS-cert-mounting service declares nats: service_healthy', () => {
    const offenders: string[] = [];
    for (const svc of serviceBlocks()) {
      if (svc.name === 'nats') continue;
      const connectsToNats = svc.body.includes(NATS_CA_ANCHOR);
      if (!connectsToNats) continue;
      const dep = dependsOnBlock(svc.body);
      const healthy = / {6}nats:\n {8}condition: service_healthy/.test(dep);
      if (!healthy) {
        const weak = / {6}nats:\n {8}condition: service_started/.test(dep);
        offenders.push(
          `${svc.name} (${weak ? 'service_started — must be service_healthy' : 'no nats depends_on'})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
