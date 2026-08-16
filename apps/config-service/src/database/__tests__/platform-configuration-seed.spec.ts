import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  CONFIGURATION_DEFINITIONS,
  ConfigurationKeyId,
  parseCanonicalConfigurationValue,
} from '@aquaculture/configuration-contracts';

import { CONFIGURATION_SEED_ROWS } from '../generated/configuration-seed.generated';

describe('generated configuration seed projection', () => {
  it('is current with the strict catalog compiler', () => {
    const repoRoot = resolve(__dirname, '../../../../..');
    expect(() =>
      execFileSync(
        process.execPath,
        ['tools/configuration/compile-configuration-catalog.cjs', '--check'],
        { cwd: repoRoot, stdio: 'pipe' },
      ),
    ).not.toThrow();
  });

  it('contains exactly the catalog IDs with authoritative defaults', () => {
    const expectedIds = CONFIGURATION_DEFINITIONS.filter((definition) =>
      Object.prototype.hasOwnProperty.call(definition, 'default'),
    )
      .map((definition) => definition.id)
      .sort();
    const seedIds = CONFIGURATION_SEED_ROWS.map((row) => row.catalogId).sort();
    expect(seedIds).toEqual(expectedIds);
    expect(new Set(seedIds).size).toBe(seedIds.length);
    expect(seedIds.every((catalogId) => catalogId in ConfigurationKeyId)).toBe(true);
  });

  it('round-trips every generated seed through its catalog-owned type rules', () => {
    const definitions = new Map(
      CONFIGURATION_DEFINITIONS.map((definition) => [definition.id, definition]),
    );
    for (const row of CONFIGURATION_SEED_ROWS) {
      const definition = definitions.get(row.catalogId);
      if (!definition) throw new Error(`seed row lost catalog definition ${row.catalogId}`);
      expect(definition.valueType).not.toBe('SECRET');
      expect(() => parseCanonicalConfigurationValue(definition, row.value)).not.toThrow();
      expect(row.service).toBe(definition.service);
      expect(row.key).toBe(definition.key);
      expect(row.requiresRestart).toBe(definition.requiresRestart);
    }
  });

  it('never invents a plaintext default for a secret', () => {
    const secretIds = new Set(
      CONFIGURATION_DEFINITIONS.filter((definition) => definition.valueType === 'SECRET').map(
        (definition) => definition.id,
      ),
    );
    expect(CONFIGURATION_SEED_ROWS.filter((row) => secretIds.has(row.catalogId))).toEqual([]);
  });
});
