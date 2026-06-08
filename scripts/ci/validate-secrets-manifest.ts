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

const MANIFEST_PATH = process.env['MANIFEST'] ?? 'infrastructure/deploy/required-secrets.yaml';

const REQUIRED_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*):\?[^}]*\}/g;

interface RequiredEnvEntry {
  name: string;
  owner: string;
  class: 'secret' | 'runtime-env';
  purpose: string;
  rotation_intent: string;
  provisioning_mode: string;
  required_by: string[];
}

interface Manifest {
  version?: number;
  compose_files?: string[];
  secrets?: RequiredEnvEntry[];
  runtime_required_env?: RequiredEnvEntry[];
}

function extractRequiredVars(composePath: string): Set<string> {
  const text = readFileSync(composePath, 'utf8');
  const vars = new Set<string>();
  for (const m of text.matchAll(REQUIRED_VAR_PATTERN)) {
    vars.add(m[1]);
  }
  return vars;
}

function failInvocation(message: string): never {
  console.error(`::error::${message}`);
  process.exit(2);
}

function requireNonEmptyString(entry: RequiredEnvEntry, key: keyof RequiredEnvEntry): string[] {
  const value = entry[key];
  return typeof value === 'string' && value.trim()
    ? []
    : [`${entry.name || '<unnamed>'}: missing or empty \`${key}\``];
}

function loadManifest(path: string): Manifest {
  if (!existsSync(path)) {
    failInvocation(`manifest not found at ${path}`);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) as Manifest | null;
  if (!data || typeof data !== 'object') {
    failInvocation(`manifest ${path} is not a YAML mapping`);
  }
  if (data.version !== 1) {
    failInvocation(`manifest ${path} version mismatch; expected 1`);
  }
  if (!Array.isArray(data.compose_files) || data.compose_files.length === 0) {
    failInvocation(`manifest ${path} missing non-empty \`compose_files\` list`);
  }
  if (!Array.isArray(data.secrets) || data.secrets.length === 0) {
    failInvocation(`manifest ${path} missing non-empty \`secrets\` list`);
  }
  if (data.runtime_required_env !== undefined && !Array.isArray(data.runtime_required_env)) {
    failInvocation(`manifest ${path} \`runtime_required_env\` must be a list`);
  }
  return data;
}

function main(): void {
  const manifest = loadManifest(MANIFEST_PATH);
  const composeFiles =
    process.env['COMPOSE_FILES']?.split(',').filter(Boolean) ?? manifest.compose_files ?? [];
  const sections = {
    secrets: manifest.secrets ?? [],
    runtime_required_env: manifest.runtime_required_env ?? [],
  };
  const entriesByName = new Map<string, RequiredEnvEntry>();
  const sectionByName = new Map<string, keyof typeof sections>();
  const errors: string[] = [];

  for (const [section, entries] of Object.entries(sections) as Array<
    [keyof typeof sections, RequiredEnvEntry[]]
  >) {
    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== 'object') {
        errors.push(`${section}[${index}]: not an object`);
        continue;
      }
      const name = entry.name || `${section}[${index}]`;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        errors.push(`${section}[${index}]: missing or empty \`name\``);
      }
      if (entriesByName.has(entry.name)) {
        errors.push(`${name}: duplicate entry across required-secrets manifest`);
      }
      entriesByName.set(entry.name, entry);
      sectionByName.set(entry.name, section);

      if (section === 'secrets' && entry.class !== 'secret') {
        errors.push(`${name}: secrets entry must declare class "secret"`);
      }
      if (section === 'runtime_required_env' && entry.class !== 'runtime-env') {
        errors.push(`${name}: runtime_required_env entry must declare class "runtime-env"`);
      }
      errors.push(...requireNonEmptyString(entry, 'owner'));
      errors.push(...requireNonEmptyString(entry, 'purpose'));
      errors.push(...requireNonEmptyString(entry, 'rotation_intent'));
      errors.push(...requireNonEmptyString(entry, 'provisioning_mode'));
      if (!Array.isArray(entry.required_by) || entry.required_by.length === 0) {
        errors.push(`${name}: \`required_by\` must be a non-empty list`);
      }
    }
  }
  const manifestKeys = new Set(entriesByName.keys());

  // Gather the union of `${VAR:?}` references across every tracked
  // compose file. If a var is required in prod but not droplet (or
  // vice versa), it must still be declared in the manifest.
  const unionRequired = new Set<string>();
  const requiredByCompose = new Map<string, Set<string>>();
  for (const f of composeFiles) {
    if (!existsSync(f)) {
      console.error(`::error::compose file not found at ${f}`);
      process.exit(2);
    }
    const vars = extractRequiredVars(f);
    for (const v of vars) {
      unionRequired.add(v);
      const files = requiredByCompose.get(v) ?? new Set<string>();
      files.add(f);
      requiredByCompose.set(v, files);
    }
  }

  // 2. compose → manifest: no undeclared required vars.
  const undeclared = [...unionRequired].filter((v) => !manifestKeys.has(v)).sort();
  if (undeclared.length > 0) {
    errors.push(`compose references require vars absent from manifest: ${undeclared.join(', ')}`);
    errors.push(`  Add each to ${MANIFEST_PATH} with type / purpose / rotation metadata.`);
  }

  // 3. manifest → compose: no stale entries.
  const stale = [...manifestKeys].filter((v) => !unionRequired.has(v)).sort();
  if (stale.length > 0) {
    errors.push(`manifest entries not referenced by any tracked compose file: ${stale.join(', ')}`);
    errors.push('  Either add a ${VAR:?...} reference in compose or remove the stale entry.');
  }

  for (const [name, entry] of entriesByName.entries()) {
    if (!unionRequired.has(name)) {
      continue;
    }
    const declaredRequiredBy = new Set(entry.required_by);
    const actualRequiredBy = requiredByCompose.get(name) ?? new Set<string>();
    if (
      declaredRequiredBy.size !== actualRequiredBy.size ||
      [...declaredRequiredBy].some((f) => !actualRequiredBy.has(f))
    ) {
      errors.push(
        `${sectionByName.get(name)} ${name}: required_by drift; declared [` +
          `${[...declaredRequiredBy].sort().join(', ')}], actual [` +
          `${[...actualRequiredBy].sort().join(', ')}]`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('::error::required-secrets manifest errors:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `OK: ${sections.secrets.length} required secrets and ` +
      `${sections.runtime_required_env.length} runtime required env vars, ` +
      `all in lockstep with ${composeFiles.join(', ')}.`,
  );
}

main();
