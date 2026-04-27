#!/usr/bin/env node
/**
 * WS6 — Service criticality manifest ↔ compose services SSoT check.
 *
 * Asserts that every service declared in
 * `infrastructure/deploy/service-criticality.yaml` exists in the
 * production compose file, and vice versa. Manifest drift is caught
 * at PR-merge time, not at deploy time.
 *
 * This is the Tier-1 Make-Impossible gate behind WS6: you cannot
 * introduce a new service without classifying its deploy criticality,
 * and you cannot retire a service from compose while leaving a stale
 * manifest entry that blocks deploys.
 *
 * Exit codes:
 *   0  manifest and compose are in lockstep
 *   1  drift detected (missing entries either side)
 *   2  invocation error (file missing, YAML malformed)
 *
 * Runs on Node 22+ with built-in TypeScript type-stripping.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { writeDummyEnvForCompose } from './lib/compose-dummy-env.ts';

const COMPOSE_FILE =
  process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const MANIFEST_PATH =
  process.env['MANIFEST'] ??
  'infrastructure/deploy/service-criticality.yaml';

type CriticalityLevel = 'critical' | 'required' | 'warning' | 'ignored';

interface ManifestEntry {
  name: string;
  level: CriticalityLevel;
  reason?: string;
}

interface Manifest {
  schema_version?: number;
  defaults?: { readiness_sla_seconds?: number };
  services?: ManifestEntry[];
}

const VALID_LEVELS: ReadonlySet<CriticalityLevel> = new Set([
  'critical',
  'required',
  'warning',
  'ignored',
]);

function loadManifest(path: string): ManifestEntry[] {
  if (!existsSync(path)) {
    console.error(`::error::manifest not found at ${path}`);
    process.exit(2);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) as Manifest | null;
  if (!data || typeof data !== 'object') {
    console.error(`::error::manifest ${path} is not a YAML mapping`);
    process.exit(2);
  }
  return Array.isArray(data.services) ? data.services : [];
}

function listComposeServices(composeFile: string): string[] {
  if (!existsSync(composeFile)) {
    console.error(`::error::compose file not found at ${composeFile}`);
    process.exit(2);
  }
  // The droplet/prod compose files use `${VAR:?required}` references
  // for every secret. Without an env file, `docker compose config`
  // fails on the first interpolation regardless of whether we care
  // about the values. Emit a throwaway dummy env (sibling to the one
  // preflight-validate.ts writes) so compose can resolve the file
  // and emit the service list we actually want.
  const { envPath, cleanup } = writeDummyEnvForCompose(composeFile);
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', composeFile, '--env-file', envPath, 'config', '--services'],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::docker compose config failed: ${msg}`);
    process.exit(2);
  } finally {
    cleanup();
  }
}

function main(): void {
  const manifestPath = resolve(MANIFEST_PATH);
  const composeFile = resolve(COMPOSE_FILE);

  const entries = loadManifest(manifestPath);
  const composeSvcs = listComposeServices(composeFile);

  // Schema-level checks first: names present, levels valid, no dupes.
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      bad.push(`non-object entry: ${JSON.stringify(entry)}`);
      continue;
    }
    if (typeof entry.name !== 'string' || !entry.name) {
      bad.push(`entry missing \`name\`: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!VALID_LEVELS.has(entry.level)) {
      bad.push(
        `invalid level "${entry.level}" for ${entry.name} ` +
          `(allowed: ${[...VALID_LEVELS].join(', ')})`,
      );
    }
    if (seen.has(entry.name)) {
      bad.push(`duplicate entry for ${entry.name}`);
    }
    seen.add(entry.name);
  }

  if (bad.length > 0) {
    console.error('::error::manifest schema errors:');
    for (const b of bad) console.error(`  - ${b}`);
    process.exit(1);
  }

  const manifestNames = new Set(entries.map((e) => e.name));

  const missingFromManifest = composeSvcs.filter(
    (s) => !manifestNames.has(s),
  );
  const extraInManifest = [...manifestNames].filter(
    (s) => !composeSvcs.includes(s),
  );

  let ok = true;
  if (missingFromManifest.length > 0) {
    console.error(
      '::error::compose services without a criticality entry:',
    );
    for (const s of missingFromManifest) console.error(`  - ${s}`);
    console.error(
      '  Add a `{ name: <svc>, level: <critical|required|warning|ignored>, reason: ... }` entry to',
    );
    console.error(`  ${MANIFEST_PATH}.`);
    ok = false;
  }
  if (extraInManifest.length > 0) {
    console.error(
      '::error::criticality entries pointing at services not in compose:',
    );
    for (const s of extraInManifest) console.error(`  - ${s}`);
    ok = false;
  }

  if (!ok) process.exit(1);

  console.log(
    `OK: ${entries.length} services declared in manifest, ` +
      `all present in ${COMPOSE_FILE}.`,
  );
}

main();
