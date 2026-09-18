import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VitestResourceProfile {
  maxWorkers: number;
  testTimeoutMs: number;
}

interface VitestResourcePolicy {
  version: number;
  profiles: Record<string, VitestResourceProfile>;
}

const policyPath = resolve(dirname(fileURLToPath(import.meta.url)), 'vitest-resource-policy.json');

let cachedPolicy: VitestResourcePolicy | undefined;

function readPolicy(): VitestResourcePolicy {
  if (cachedPolicy) {
    return cachedPolicy;
  }

  const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as VitestResourcePolicy;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported Vitest resource policy version ${parsed.version}`);
  }

  cachedPolicy = parsed;
  return parsed;
}

function assertPositiveInteger(profileName: string, field: keyof VitestResourceProfile, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Vitest resource profile ${profileName}.${field} must be a positive integer`);
  }
}

export function loadVitestResourceProfile(profileName: string): VitestResourceProfile {
  const policy = readPolicy();
  const profile = policy.profiles[profileName];

  if (!profile) {
    throw new Error(`Vitest resource profile ${profileName} is not defined`);
  }

  assertPositiveInteger(profileName, 'maxWorkers', profile.maxWorkers);
  assertPositiveInteger(profileName, 'testTimeoutMs', profile.testTimeoutMs);

  return profile;
}
