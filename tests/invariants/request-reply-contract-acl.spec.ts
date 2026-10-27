import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FARM_TIME_ZONE_QUERY_SUBJECTS,
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  SENSOR_CHANNEL_QUERY_SUBJECTS,
} from '@platform/event-contracts';

import { loadNatsServices, subjectMatches } from '../../tools/gates/nats-services';

/**
 * INVARIANT: a core-NATS request/reply contract between two services is
 * reachable at the broker — derived from the contract, not written by hand.
 *
 * For every subject of each contract below: the owning service holds a
 * subscribe grant covering it (exact or wildcard), each calling service holds
 * a publish grant covering it, and the owner registers exactly one responder
 * (`.respond<…>(CONTRACT.KEY`). A dropped grant or a renamed subject would
 * otherwise pass every test and time out in production.
 *
 * (The generic RPC scan in e2e/tests/integration/nats-invariants.spec.ts reads
 * calls by shape and cannot tell a responder from a caller, so these
 * contracts are pinned here from their constants.)
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

interface RequestReplyContract {
  readonly name: string;
  readonly subjects: Readonly<Record<string, string>>;
  readonly owner: { readonly service: string; readonly sourceRoot: string };
  readonly callers: readonly string[];
}

const CONTRACTS: readonly RequestReplyContract[] = [
  {
    name: 'FARM_TIME_ZONE_QUERY_SUBJECTS',
    subjects: FARM_TIME_ZONE_QUERY_SUBJECTS,
    owner: { service: 'farm_service', sourceRoot: 'apps/farm-service/src' },
    callers: ['sensor_service'],
  },
  {
    name: 'SENSOR_CHANNEL_QUERY_SUBJECTS',
    subjects: SENSOR_CHANNEL_QUERY_SUBJECTS,
    owner: { service: 'sensor_service', sourceRoot: 'apps/sensor-service/src' },
    callers: ['farm_service'],
  },
  // PKG-06 readiness: one subject per owner module, each answered by its own module.
  {
    name: 'MODULE_ACTIVITY_QUERY_SUBJECTS',
    subjects: { farm: MODULE_ACTIVITY_QUERY_SUBJECTS.farm },
    owner: { service: 'farm_service', sourceRoot: 'apps/farm-service/src' },
    callers: ['auth_service'],
  },
  {
    name: 'MODULE_ACTIVITY_QUERY_SUBJECTS',
    subjects: { hr: MODULE_ACTIVITY_QUERY_SUBJECTS.hr },
    owner: { service: 'hr_service', sourceRoot: 'apps/hr-service/src' },
    callers: ['auth_service'],
  },
  {
    name: 'MODULE_ACTIVITY_QUERY_SUBJECTS',
    subjects: { sensor: MODULE_ACTIVITY_QUERY_SUBJECTS.sensor },
    owner: { service: 'sensor_service', sourceRoot: 'apps/sensor-service/src' },
    callers: ['auth_service'],
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, dir))) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const child = `${dir}/${entry}`;
    if (statSync(resolve(REPO_ROOT, child)).isDirectory()) out.push(...sourceFiles(child));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(child);
  }
  return out;
}

describe('INVARIANT: request/reply contracts are granted at the broker', () => {
  // ARIA-LOW-603 — the SSoT is read, and NATS subjects matched, by the one shared reader
  // (tools/gates/nats-services.ts); this spec used to carry its own parse and its own matcher.
  const services = loadNatsServices();
  const grants = (service: string, kind: 'publish' | 'subscribe'): readonly string[] => {
    const entry = services.find((candidate) => candidate.name === service);
    if (entry === undefined) throw new Error(`services.yaml has no service ${service}`);
    return entry[kind];
  };

  it('matches NATS wildcards the way these contracts need', () => {
    expect(subjectMatches('request.sensor.>', 'request.sensor.describeChannels')).toBe(true);
    expect(subjectMatches('request.*.describeChannels', 'request.sensor.describeChannels')).toBe(
      true,
    );
    expect(subjectMatches('request.sensor.>', 'request.sensor')).toBe(false);
    expect(subjectMatches('request.farm.>', 'request.sensor.describeChannels')).toBe(false);
  });

  const cases = CONTRACTS.flatMap((contract) =>
    Object.entries(contract.subjects).map(([key, subject]) => ({ contract, key, subject })),
  );

  it.each(cases)(
    '$contract.name.$key: owner subscribes, callers publish',
    ({ contract, subject }) => {
      expect(
        grants(contract.owner.service, 'subscribe').some((g) => subjectMatches(g, subject)),
      ).toBe(true);
      for (const caller of contract.callers) {
        expect({
          caller,
          granted: grants(caller, 'publish').some((g) => subjectMatches(g, subject)),
        }).toEqual({ caller, granted: true });
      }
    },
  );

  it.each(cases)(
    '$contract.name.$key: the owner registers exactly one responder',
    ({ contract, key }) => {
      const responder = new RegExp(`\\.respond<[^>]*>\\(\\s*${contract.name}\\.${key}\\b`, 'g');
      const count = sourceFiles(contract.owner.sourceRoot).reduce(
        (total, file) =>
          total + (readFileSync(resolve(REPO_ROOT, file), 'utf8').match(responder) ?? []).length,
        0,
      );
      expect(count).toBe(1);
    },
  );
});
