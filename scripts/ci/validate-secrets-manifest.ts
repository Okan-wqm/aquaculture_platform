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
 *   - generated manifest version must be 1.
 *   - each entry declares name / owner / class / purpose /
 *     rotation_intent / provisioning_mode / required_by.
 *   - secrets live under `secrets` with class `secret`.
 *   - runtime env vars live under `runtime_required_env` with class
 *     `runtime-env`.
 *
 * Exit codes:
 *   0  manifest ↔ compose in sync, schema valid
 *   1  drift or schema error
 *   2  invocation error (file missing, manifest malformed)
 */
import { existsSync, readFileSync } from 'node:fs';

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

type ManifestListSection = 'compose_files' | 'secrets' | 'runtime_required_env';

const ENTRY_KEYS = new Set<keyof RequiredEnvEntry>([
  'name',
  'owner',
  'class',
  'purpose',
  'rotation_intent',
  'provisioning_mode',
  'required_by',
]);

function parseStringScalar(path: string, lineNo: number, raw: string): string {
  const value = raw.trim();
  if (!value) {
    failInvocation(`manifest ${path}:${lineNo} has an empty scalar`);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) {
      failInvocation(`manifest ${path}:${lineNo} has an unterminated quoted string`);
    }
    try {
      return JSON.parse(value) as string;
    } catch {
      failInvocation(`manifest ${path}:${lineNo} has an invalid quoted string`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) {
      failInvocation(`manifest ${path}:${lineNo} has an unterminated quoted string`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineList(path: string, lineNo: number, raw: string): string[] {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) {
    failInvocation(`manifest ${path}:${lineNo} expected an inline string list`);
  }
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  return body.split(',').map((part) => parseStringScalar(path, lineNo, part));
}

function setEntryValue(
  path: string,
  lineNo: number,
  entry: Partial<RequiredEnvEntry>,
  key: string,
  rawValue: string,
): void {
  if (!ENTRY_KEYS.has(key as keyof RequiredEnvEntry)) {
    failInvocation(`manifest ${path}:${lineNo} has unsupported entry key \`${key}\``);
  }
  if (Object.prototype.hasOwnProperty.call(entry, key)) {
    failInvocation(`manifest ${path}:${lineNo} repeats entry key \`${key}\``);
  }
  if (key === 'required_by') {
    entry.required_by = parseInlineList(path, lineNo, rawValue);
    return;
  }
  const value = parseStringScalar(path, lineNo, rawValue);
  (entry as Record<string, string>)[key] = value;
}

function requiredMatchGroup(
  path: string,
  lineNo: number,
  match: RegExpMatchArray,
  index: number,
  label: string,
): string {
  const value = match[index];
  if (typeof value !== 'string') {
    failInvocation(`manifest ${path}:${lineNo} missing regex capture for ${label}`);
  }
  return value;
}

function parseRequiredSecretsManifest(path: string, text: string): Manifest {
  const manifest: Manifest = {};
  let section: ManifestListSection | null = null;
  let currentEntry: Partial<RequiredEnvEntry> | null = null;

  const ensureSection = <K extends ManifestListSection>(key: K): NonNullable<Manifest[K]> => {
    const value = manifest[key];
    if (Array.isArray(value)) {
      return value as NonNullable<Manifest[K]>;
    }
    const next: NonNullable<Manifest[K]> = [] as unknown as NonNullable<Manifest[K]>;
    manifest[key] = next;
    return next;
  };

  const lines = text.split(/\r?\n/);
  for (const [index, originalLine] of lines.entries()) {
    const lineNo = index + 1;
    const line = originalLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const topLevel = line.match(/^([a-z_]+):(?:\s*(.*))?$/);
    if (topLevel) {
      const [, key, rawValue = ''] = topLevel;
      currentEntry = null;
      if (key === 'version') {
        const version = Number.parseInt(rawValue.trim(), 10);
        if (!Number.isSafeInteger(version) || String(version) !== rawValue.trim()) {
          failInvocation(`manifest ${path}:${lineNo} version must be an integer`);
        }
        manifest.version = version;
        section = null;
        continue;
      }
      if (key === 'compose_files' || key === 'secrets' || key === 'runtime_required_env') {
        if (rawValue.trim()) {
          failInvocation(`manifest ${path}:${lineNo} section \`${key}\` must be a list`);
        }
        section = key;
        ensureSection(section);
        continue;
      }
      failInvocation(`manifest ${path}:${lineNo} has unsupported top-level key \`${key}\``);
    }

    if (!section) {
      failInvocation(`manifest ${path}:${lineNo} has indented content outside a list section`);
    }

    if (section === 'compose_files') {
      const item = line.match(/^  -\s+(.+)$/);
      if (!item) {
        failInvocation(`manifest ${path}:${lineNo} expected a compose_files list item`);
      }
      ensureSection('compose_files').push(
        parseStringScalar(path, lineNo, requiredMatchGroup(path, lineNo, item, 1, 'compose file')),
      );
      continue;
    }

    const entryStart = line.match(/^  -\s+([a-z_]+):\s*(.+)$/);
    if (entryStart) {
      currentEntry = {};
      ensureSection(section).push(currentEntry as RequiredEnvEntry);
      setEntryValue(
        path,
        lineNo,
        currentEntry,
        requiredMatchGroup(path, lineNo, entryStart, 1, 'entry key'),
        requiredMatchGroup(path, lineNo, entryStart, 2, 'entry value'),
      );
      continue;
    }

    const entryField = line.match(/^    ([a-z_]+):\s*(.+)$/);
    if (entryField && currentEntry) {
      setEntryValue(
        path,
        lineNo,
        currentEntry,
        requiredMatchGroup(path, lineNo, entryField, 1, 'entry key'),
        requiredMatchGroup(path, lineNo, entryField, 2, 'entry value'),
      );
      continue;
    }

    failInvocation(`manifest ${path}:${lineNo} has unsupported indentation or list shape`);
  }

  return manifest;
}

function extractRequiredVars(composePath: string): Set<string> {
  const text = readFileSync(composePath, 'utf8');
  const vars = new Set<string>();
  for (const m of text.matchAll(REQUIRED_VAR_PATTERN)) {
    vars.add(requiredMatchGroup(composePath, 0, m, 1, 'required compose var'));
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
  const data = parseRequiredSecretsManifest(path, readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object') {
    failInvocation(`manifest ${path} is not a mapping`);
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
