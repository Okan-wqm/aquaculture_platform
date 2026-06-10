import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = process.cwd();
const INVARIANT_DIR = join(REPO_ROOT, 'tests', 'invariants');
const CONFIG_PATH = join(INVARIANT_DIR, 'jest.config.ts');
const DORMANT_MANIFEST_PATH = join(INVARIANT_DIR, 'invariant-reachability.dormant.json');

type DormantEntry = {
  owner: string;
  reason: string;
  expires_on: string;
};

function listedSpecs(configText: string): Set<string> {
  const matches = configText.matchAll(/<rootDir>\/([^'"]+\.spec\.ts)/g);
  return new Set(
    Array.from(matches, (match) => {
      const spec = match[1];
      if (!spec) {
        throw new Error('Invariant Jest config match did not include a spec path capture');
      }
      return spec;
    }),
  );
}

function readDormantManifest(): Record<string, DormantEntry> {
  if (!existsSync(DORMANT_MANIFEST_PATH)) return {};
  return JSON.parse(readFileSync(DORMANT_MANIFEST_PATH, 'utf8')) as Record<string, DormantEntry>;
}

describe('invariant spec reachability', () => {
  it('every invariant spec is listed in Jest config or explicitly dormant', () => {
    const configText = readFileSync(CONFIG_PATH, 'utf8');
    const listed = listedSpecs(configText);
    const dormant = readDormantManifest();
    const specs = readdirSync(INVARIANT_DIR)
      .filter((name) => name.endsWith('.spec.ts'))
      .sort();
    const missing = specs.filter((name) => !listed.has(name) && !dormant[name]);
    expect(missing).toEqual([]);
  });

  it('dormant invariant specs carry owner, reason, and expiry', () => {
    const dormant = readDormantManifest();
    const invalid = Object.entries(dormant)
      .filter(
        ([, entry]) =>
          !entry.owner || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires_on),
      )
      .map(([name]) => name);
    expect(invalid).toEqual([]);
  });
});
