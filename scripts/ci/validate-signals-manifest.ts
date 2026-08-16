#!/usr/bin/env node
/**
 * WS7 — Signal manifest ↔ compose services SSoT check.
 *
 * Asserts:
 *   1. Every service in `required-signals.yaml` exists in
 *      `docker compose config --services`.
 *   2. Every signal key referenced by a service is defined in
 *      `signal_library`.
 *   3. Every signal pattern matches BOOT_INVARIANT_SIGNALS.
 *   4. canonicalSource / emitterSources exist.
 *   5. Services that register SchemaDriftModule require schema_drift_clean.
 *   6. Services that register EventBusModule require nats_auth_mode_mtls.
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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { writeDummyEnvForCompose } from './lib/compose-dummy-env.ts';
import {
  BOOT_INVARIANT_SIGNAL_AUTHORITY_PATH,
  BOOT_INVARIANT_SIGNALS,
  type BootInvariantSignalKey,
} from '../../platform/libs/service-catalog/src/boot-invariant-signals.ts';

const COMPOSE_FILE =
  process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const MANIFEST_PATH =
  process.env['MANIFEST'] ?? 'infrastructure/deploy/required-signals.yaml';

interface SignalDef {
  pattern: string;
  description?: string;
  canonicalSource?: string;
  emitterSources?: string[];
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
  const { envPath, cleanup } = writeDummyEnvForCompose(composeFile);
  try {
    const out = execFileSync(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        '--env-file',
        envPath,
        'config',
        '--services',
      ],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::compose YAML parse failed: ${msg}`);
    process.exit(2);
  } finally {
    cleanup();
  }
}

function serviceAppModule(serviceName: string): string {
  return join('apps', serviceName, 'src', 'app.module.ts');
}

function serviceSrcDir(serviceName: string): string {
  return join('apps', serviceName, 'src');
}

function serviceRequiresSchemaDrift(serviceName: string): boolean {
  const appModule = serviceAppModule(serviceName);
  return (
    existsSync(appModule) &&
    readFileSync(appModule, 'utf8').includes('SchemaDriftModule.forRoot')
  );
}

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      if (
        entry === 'node_modules' ||
        entry === 'dist' ||
        entry === '__tests__' ||
        entry === '__mocks__'
      ) {
        continue;
      }
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        stack.push(path);
      } else if (path.endsWith('.ts')) {
        files.push(path);
      }
    }
  }
  return files;
}

function serviceRequiresNatsEventBus(serviceName: string): boolean {
  return tsFilesUnder(serviceSrcDir(serviceName)).some((file) =>
    /EventBusModule\.forRoot(?:Async)?\s*\(/.test(readFileSync(file, 'utf8')),
  );
}

function manifestServiceMap(services: ServiceReq[]): Map<string, ServiceReq> {
  return new Map(services.map((svc) => [svc.name, svc]));
}

function main(): void {
  const manifest = loadManifest(MANIFEST_PATH);
  const signals = manifest.signal_library ?? {};
  const services = manifest.services ?? [];
  const composeSvcs = listComposeServices(COMPOSE_FILE);
  const servicesByName = manifestServiceMap(services);

  const errors: string[] = [];

  if (manifest.schema_version !== 2) {
    errors.push(
      `schema_version must be 2 for structured boot-signal matching (got ${String(manifest.schema_version)})`,
    );
  }

  for (const key of Object.keys(BOOT_INVARIANT_SIGNALS)) {
    if (!(key in signals)) {
      errors.push(
        `BOOT_INVARIANT_SIGNALS.${key} is missing from signal_library`,
      );
    }
  }

  for (const [key, def] of Object.entries(signals)) {
    if (!def || typeof def !== 'object') {
      errors.push(`signal_library.${key} is not an object`);
      continue;
    }
    if (!(key in BOOT_INVARIANT_SIGNALS)) {
      errors.push(
        `signal_library.${key} has no matching BOOT_INVARIANT_SIGNALS entry`,
      );
      continue;
    }
    if (typeof def.pattern !== 'string' || !def.pattern) {
      errors.push(
        `signal_library.${key}.pattern is missing or not a non-empty string`,
      );
    } else {
      const expected =
        BOOT_INVARIANT_SIGNALS[key as BootInvariantSignalKey].pattern;
      if (def.pattern !== expected) {
        errors.push(
          `signal_library.${key}.pattern "${def.pattern}" does not match ` +
            `BOOT_INVARIANT_SIGNALS.${key}.pattern "${expected}"`,
        );
      }
    }
    if (def.canonicalSource !== BOOT_INVARIANT_SIGNAL_AUTHORITY_PATH) {
      errors.push(
        `signal_library.${key}.canonicalSource must be "${BOOT_INVARIANT_SIGNAL_AUTHORITY_PATH}"`,
      );
    } else if (!existsSync(def.canonicalSource)) {
      errors.push(
        `signal_library.${key}.canonicalSource does not exist: ${def.canonicalSource}`,
      );
    }
    if (!Array.isArray(def.emitterSources) || def.emitterSources.length === 0) {
      errors.push(
        `signal_library.${key}.emitterSources must list at least one source file`,
      );
    } else {
      for (const source of def.emitterSources) {
        if (!existsSync(source)) {
          errors.push(
            `signal_library.${key}.emitterSources entry does not exist: ${source}`,
          );
        }
      }
    }
  }

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
      errors.push(`service "${svc.name}" not found in ${COMPOSE_FILE}`);
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

  for (const serviceName of composeSvcs) {
    const manifestEntry = servicesByName.get(serviceName);
    if (serviceRequiresSchemaDrift(serviceName)) {
      if (!manifestEntry?.signals.includes('schema_drift_clean')) {
        errors.push(
          `compose service "${serviceName}" registers SchemaDriftModule.forRoot ` +
            'but does not require schema_drift_clean in required-signals.yaml',
        );
      }
    }
    if (serviceRequiresNatsEventBus(serviceName)) {
      if (!manifestEntry?.signals.includes('nats_auth_mode_mtls')) {
        errors.push(
          `compose service "${serviceName}" registers EventBusModule.forRoot ` +
            'but does not require nats_auth_mode_mtls in required-signals.yaml',
        );
      }
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
