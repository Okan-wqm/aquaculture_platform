import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface ComposeFile {
  services?: Record<string, { profiles?: unknown }>;
}

interface CriticalityManifest {
  services?: Array<{
    name?: string;
    level?: string;
    profiles?: unknown;
  }>;
}

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as T;
}

function profiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).sort();
}

describe('service criticality profile contract', () => {
  const compose = readYaml<ComposeFile>('docker-compose.droplet.yml');
  const manifest = readYaml<CriticalityManifest>('infrastructure/deploy/service-criticality.yaml');
  const manifestByName = new Map((manifest.services ?? []).map((entry) => [entry.name, entry]));

  it('profile-gated compose services declare matching criticality profiles', () => {
    const mismatches: string[] = [];

    for (const [name, service] of Object.entries(compose.services ?? {})) {
      const composeProfiles = profiles(service.profiles);
      if (composeProfiles.length === 0) continue;

      const entry = manifestByName.get(name);
      const manifestProfiles = profiles(entry?.profiles);
      if (
        composeProfiles.length !== manifestProfiles.length ||
        composeProfiles.some((profile, index) => profile !== manifestProfiles[index])
      ) {
        mismatches.push(
          `${name}: compose=${composeProfiles.join(',')} manifest=${manifestProfiles.join(',')}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('registers the promoted sensor-ingestion pilot under the rust-sidecar profile', () => {
    const entry = manifestByName.get('sensor-ingestion');

    expect(entry).toEqual(
      expect.objectContaining({
        name: 'sensor-ingestion',
        level: 'warning',
        profiles: ['rust-sidecar'],
      }),
    );
  });
});
