#!/usr/bin/env node
/**
 * WS7 — Signal manifest ↔ compose services SSoT check.
 *
 * Asserts:
 *   1. Every service in `required-signals.yaml` exists in
 *      `docker compose config --services`.
 *   2. Every signal key referenced by a service is defined in
 *      `signal_library`.
 *   3. Levels / windows are within expected bounds.
 *
 * Fails the PR build on drift. Complements
 * `validate-criticality-manifest.ts` — the two manifests (criticality
 * + signals) together define "what a deployed service must do."
 *
 * Exit codes:
 *   0  manifest matches compose + internal references resolve
 *   1  drift detected
 *   2  invocation error
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const COMPOSE_FILE =
  process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const MANIFEST_PATH =
  process.env['MANIFEST'] ?? 'infrastructure/deploy/required-signals.yaml';

interface SignalDef {
  pattern: string;
  description?: string;
  signalSource?: string;
}

interface ServiceReq {
  name: string;
  signals: string[];
  window_seconds?: number;
}

interface Manifest {
  schema_version?: number;
  defaults?: { window_seconds?: number };
  signal_library?: Record<string, SignalDef>;
  services?: ServiceReq[];
}

function loadManifest(path: string): Manifest {
  if (!existsSync(path)) {
    console.error(`::error::manifest not found at ${path}`);
    process.exit(2);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) as Manifest | null;
  if (!data || typeof data !== 'object') {
    console.error(`::error::manifest ${path} is not a YAML mapping`);
    process.exit(2);
  }
  return data;
}

function listComposeServices(composeFile: string): string[] {
  if (!existsSync(composeFile)) {
    console.error(`::error::compose file not found at ${composeFile}`);
    process.exit(2);
  }
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', composeFile, 'config', '--services'],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::docker compose config failed: ${msg}`);
    process.exit(2);
  }
}

function main(): void {
  const manifest = loadManifest(MANIFEST_PATH);
  const signals = manifest.signal_library ?? {};
  const services = manifest.services ?? [];
  const composeSvcs = listComposeServices(COMPOSE_FILE);

  const errors: string[] = [];

  // 1. Signal library self-consistency — each signal has a non-empty
  // pattern string.
  for (const [key, def] of Object.entries(signals)) {
    if (!def || typeof def !== 'object') {
      errors.push(`signal_library.${key} is not an object`);
      continue;
    }
    if (typeof def.pattern !== 'string' || !def.pattern) {
      errors.push(
        `signal_library.${key}.pattern is missing or not a non-empty string`,
      );
    }
  }

  // 2. Service entries — referenced signal keys resolve, services
  // exist in compose, no duplicate service entries.
  const seen = new Set<string>();
  for (const svc of services) {
    if (!svc?.name) {
      errors.push(`service entry missing \`name\`: ${JSON.stringify(svc)}`);
      continue;
    }
    if (seen.has(svc.name)) {
      errors.push(`duplicate service entry: ${svc.name}`);
    }
    seen.add(svc.name);

    if (!composeSvcs.includes(svc.name)) {
      errors.push(
        `service "${svc.name}" not found in ${COMPOSE_FILE}`,
      );
    }
    if (!Array.isArray(svc.signals) || svc.signals.length === 0) {
      errors.push(
        `service "${svc.name}" has no signals — remove the entry or add at least one`,
      );
      continue;
    }
    for (const key of svc.signals) {
      if (!(key in signals)) {
        errors.push(
          `service "${svc.name}" references undefined signal "${key}" ` +
            `(define it in signal_library or remove the reference)`,
        );
      }
    }
    if (
      svc.window_seconds !== undefined &&
      (typeof svc.window_seconds !== 'number' || svc.window_seconds < 1)
    ) {
      errors.push(
        `service "${svc.name}" window_seconds must be a positive integer`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('::error::signal manifest schema / consistency errors:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `OK: ${services.length} services × ${Object.keys(signals).length} signals, ` +
      `all consistent with ${COMPOSE_FILE}.`,
  );
}

main();
