import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

export interface ProfileAwareService {
  name: string;
  profiles?: string[];
}

interface ComposeFile {
  services?: Record<string, unknown>;
}

function normalizedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)),
  ].sort();
}

export function entryProfiles(entry: ProfileAwareService): string[] {
  return normalizedList(entry.profiles);
}

export function parseActiveProfiles(value = process.env['COMPOSE_PROFILES'] ?? ''): Set<string> {
  return new Set(
    value
      .split(/[,\s]+/)
      .map((profile) => profile.trim())
      .filter(Boolean),
  );
}

export function profilesEnabled(
  serviceProfiles: string[],
  activeProfiles: ReadonlySet<string>,
): boolean {
  if (serviceProfiles.length === 0) return true;
  if (activeProfiles.has('*')) return true;
  return serviceProfiles.some((profile) => activeProfiles.has(profile));
}

export function isProfileActive(
  entry: ProfileAwareService,
  activeProfiles: ReadonlySet<string>,
): boolean {
  return profilesEnabled(entryProfiles(entry), activeProfiles);
}

export function profileLabel(profiles: readonly string[]): string {
  return profiles.length > 0 ? profiles.join(',') : '(default)';
}

export function loadComposeServiceProfiles(composeFile: string): Map<string, string[]> {
  if (!existsSync(composeFile)) {
    throw new Error(`compose file not found at ${composeFile}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(composeFile, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`compose YAML parse failed: ${msg}`);
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('services' in parsed) ||
    typeof (parsed as ComposeFile).services !== 'object' ||
    (parsed as ComposeFile).services === null
  ) {
    throw new Error(`compose file ${composeFile} has no \`services\` mapping`);
  }

  const services = (parsed as ComposeFile).services!;
  const result = new Map<string, string[]>();
  for (const [name, service] of Object.entries(services)) {
    const profiles =
      service && typeof service === 'object'
        ? normalizedList((service as { profiles?: unknown }).profiles)
        : [];
    result.set(name, profiles);
  }
  return result;
}
