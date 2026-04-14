#!/usr/bin/env node
/**
 * WS8 / ADR-016 Phase A4 — required-secrets manifest consistency check.
 *
 * Asserts that `infrastructure/deploy/required-secrets.yaml` stays
 * in lockstep with every `${VAR:?...}` reference in the tracked
 * compose files. Both directions are enforced:
 *
 *   compose → manifest:  every `${VAR:?}` var MUST appear in the
 *                        manifest. Adding a required env var to
 *                        compose without declaring its purpose /
 *                        rotation / owner / helm mapping fails CI.
 *
 *   manifest → compose:  every manifest entry MUST appear in at
 *                        least one tracked compose file. Stale
 *                        entries that no compose file references
 *                        fail CI so the manifest does not collect
 *                        dead weight.
 *
 * Schema-level checks:
 *   - `type` must be `secret` or `config`.
 *   - `purpose` must be a non-empty string.
 *   - Secrets must declare a `rotation_cadence` and
 *     `rotation_runbook` (operational discipline per CLAUDE.md:
 *     secrets without a rotation story are forbidden).
 *
 * Exit codes:
 *   0  manifest ↔ compose in sync, schema valid
 *   1  drift or schema error
 *   2  invocation error (file missing, YAML malformed)
 */
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const MANIFEST_PATH =
  process.env['MANIFEST'] ??
  'infrastructure/deploy/required-secrets.yaml';

const COMPOSE_FILES = (
  process.env['COMPOSE_FILES'] ??
  'docker-compose.droplet.yml,docker-compose.prod.yml'
).split(',');

const REQUIRED_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*):\?[^}]*\}/g;

interface SecretEntry {
  type: 'secret' | 'config';
  purpose: string;
  rotation_cadence?: string;
  rotation_runbook?: string;
  helm_secret_key?: string;
  notes?: string;
}

interface Manifest {
  schema_version?: number;
  secrets?: Record<string, SecretEntry>;
}

function extractRequiredVars(composePath: string): Set<string> {
  const text = readFileSync(composePath, 'utf8');
  const vars = new Set<string>();
  for (const m of text.matchAll(REQUIRED_VAR_PATTERN)) {
    vars.add(m[1]);
  }
  return vars;
}

function loadManifest(path: string): Record<string, SecretEntry> {
  if (!existsSync(path)) {
    console.error(`::error::manifest not found at ${path}`);
    process.exit(2);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) as Manifest | null;
  if (!data || typeof data !== 'object') {
    console.error(`::error::manifest ${path} is not a YAML mapping`);
    process.exit(2);
  }
  return data.secrets ?? {};
}

function main(): void {
  const manifest = loadManifest(MANIFEST_PATH);
  const manifestKeys = new Set(Object.keys(manifest));

  // Gather the union of `${VAR:?}` references across every tracked
  // compose file. If a var is required in prod but not droplet (or
  // vice versa), it must still be declared in the manifest.
  const unionRequired = new Set<string>();
  for (const f of COMPOSE_FILES) {
    if (!existsSync(f)) {
      console.error(`::error::compose file not found at ${f}`);
      process.exit(2);
    }
    for (const v of extractRequiredVars(f)) {
      unionRequired.add(v);
    }
  }

  const errors: string[] = [];

  // 1. Schema-level checks on each manifest entry.
  for (const [name, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`${name}: not an object`);
      continue;
    }
    if (entry.type !== 'secret' && entry.type !== 'config') {
      errors.push(
        `${name}: invalid type "${entry.type}" (must be "secret" or "config")`,
      );
    }
    if (typeof entry.purpose !== 'string' || !entry.purpose.trim()) {
      errors.push(`${name}: missing or empty \`purpose\``);
    }
    if (entry.type === 'secret') {
      if (!entry.rotation_cadence) {
        errors.push(`${name}: secret must declare \`rotation_cadence\``);
      }
      if (!entry.rotation_runbook) {
        errors.push(`${name}: secret must declare \`rotation_runbook\``);
      }
    }
  }

  // 2. compose → manifest: no undeclared required vars.
  const undeclared = [...unionRequired]
    .filter((v) => !manifestKeys.has(v))
    .sort();
  if (undeclared.length > 0) {
    errors.push(
      `compose references require vars absent from manifest: ${undeclared.join(', ')}`,
    );
    errors.push(
      `  Add each to ${MANIFEST_PATH} with type / purpose / rotation metadata.`,
    );
  }

  // 3. manifest → compose: no stale entries.
  const stale = [...manifestKeys]
    .filter((v) => !unionRequired.has(v))
    .sort();
  if (stale.length > 0) {
    errors.push(
      `manifest entries not referenced by any tracked compose file: ${stale.join(', ')}`,
    );
    errors.push(
      '  Either add a ${VAR:?...} reference in compose or remove the stale entry.',
    );
  }

  if (errors.length > 0) {
    console.error('::error::required-secrets manifest errors:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `OK: ${manifestKeys.size} entries, all in lockstep with ${COMPOSE_FILES.join(', ')}.`,
  );
}

main();
