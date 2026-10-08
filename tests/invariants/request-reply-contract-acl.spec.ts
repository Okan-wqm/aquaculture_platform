import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FARM_TIME_ZONE_QUERY_SUBJECTS,
  SENSOR_CHANNEL_QUERY_SUBJECTS,
} from '@platform/event-contracts';
import yaml from 'js-yaml';

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
];

interface ServicesManifest {
  services: Array<{ name: string; publish?: string[]; subscribe?: string[] }>;
}

/** NATS subject matching: `*` is one token, a trailing `>` is one or more. */
export function grantCovers(grant: string, subject: string): boolean {
  const pattern = grant.split('.');
  const tokens = subject.split('.');
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (part === '>') return index === pattern.length - 1 && tokens.length > index;
    if (index >= tokens.length) return false;
    if (part !== '*' && part !== tokens[index]) return false;
  }
  return pattern.length === tokens.length;
}

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
  const manifest = yaml.load(
    readFileSync(resolve(REPO_ROOT, 'infrastructure/nats/services.yaml'), 'utf8'),
  ) as ServicesManifest;
  const grants = (service: string, kind: 'publish' | 'subscribe'): string[] =>
    manifest.services.find((entry) => entry.name === service)?.[kind] ?? [];

  it('matches NATS wildcards the way the broker does', () => {
    expect(grantCovers('request.sensor.>', 'request.sensor.describeChannels')).toBe(true);
    expect(grantCovers('request.*.describeChannels', 'request.sensor.describeChannels')).toBe(true);
    expect(grantCovers('request.sensor.>', 'request.sensor')).toBe(false);
    expect(grantCovers('request.farm.>', 'request.sensor.describeChannels')).toBe(false);
  });

  const cases = CONTRACTS.flatMap((contract) =>
    Object.entries(contract.subjects).map(([key, subject]) => ({ contract, key, subject })),
  );

  it.each(cases)(
    '$contract.name.$key: owner subscribes, callers publish',
    ({ contract, subject }) => {
      expect(grants(contract.owner.service, 'subscribe').some((g) => grantCovers(g, subject))).toBe(
        true,
      );
      for (const caller of contract.callers) {
        expect({
          caller,
          granted: grants(caller, 'publish').some((g) => grantCovers(g, subject)),
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
