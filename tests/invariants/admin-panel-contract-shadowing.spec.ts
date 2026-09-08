/**
 * The admin panel does not hand-declare a shape the contract already describes
 * (ADMIN-MEDIUM-111).
 *
 * # What went wrong, six times
 *
 * `web/modules/admin-panel/src/services/generated/admin-api.ts` is generated
 * from `apps/admin-api-service/openapi.json`, which is generated from the Nest
 * module graph. When the panel writes its own `interface` for a response the
 * contract already carries, the two are free to disagree — and they did, always
 * silently, because a React page reading a field that is not there renders
 * nothing rather than throwing:
 *
 *  - the messaging list showed zero unread on every thread (ADMIN-HIGH-110);
 *  - the audit severity filter offered three values the column has never held,
 *    so filtering for high-severity events returned an empty list, and a
 *    `warning` row rendered identically to a routine one (ADMIN-HIGH-112);
 *  - saving a feature-toggle edit sent two fields the update DTO forbids, and
 *    the platform runs `forbidNonWhitelisted`, so every save was rejected 400
 *    (ADMIN-HIGH-113);
 *  - the tenant list's Trial badge and both pages' Last Activity could not draw;
 *  - a paused job rendered as an ordinary queued one, and a queue's "Running"
 *    count was blank on every card;
 *  - every real bug-report ticket rendered with no icon, while the category
 *    that can never arrive had one.
 *
 * # Why a gate, and why only now
 *
 * The rule this enforces is not "never write an interface". It is: if the
 * contract describes this exact shape, source it, so a backend rename is a
 * compile error in the page that reads it rather than a blank cell.
 *
 * It could not ship earlier. Nine types disagreed field-for-field, and a gate
 * carrying a nine-entry allowlist is longer than the enforcement it provides —
 * it reads as compliance rather than being it. Eight are converted. One remains,
 * for a reason that is itself a finding, and it is allowed BY NAME so a tenth
 * still fails.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PANEL = 'web/modules/admin-panel/src';
const TYPES_DIR = join(REPO_ROOT, PANEL, 'services/types');
const GENERATED = join(REPO_ROOT, PANEL, 'services/generated/admin-api.ts');

/**
 * Hand-declared shapes allowed by name, each under a tracked finding. Removing
 * an entry is how the finding closes; adding one needs a finding of its own.
 */
const TRACKED_SHADOWS: Readonly<Record<string, string>> = {
  // The contract OVERSTATES this one — the inverse of every other case.
  // `TicketController.getComments` declares no return type, so the swagger
  // plugin emitted the entity and the schema requires `ticket: SupportTicket`.
  // The service's `findAndCount` loads no relations, so that property is never
  // in the response, and aliasing would demand a field that does not arrive.
  // Closing it means an explicit `TicketCommentDto` on the endpoint.
  'support.ts:TicketComment': 'ADMIN-MEDIUM-114',
};

/** Every schema name the generated contract carries. */
function contractSchemaNames(): Set<string> {
  const src = readFileSync(GENERATED, 'utf-8');
  const block = /schemas:\s*\{([\s\S]*?)\n {4}\};/.exec(src);
  if (!block) {
    throw new Error(
      `Could not find the schemas block in ${relative(REPO_ROOT, GENERATED)}. ` +
        `The generator's output shape changed and this gate is reading nothing.`,
    );
  }
  return new Set(Array.from(block[1].matchAll(/^ {8}(\w+):/gm), (m) => m[1] as string));
}

/** `export interface Name {` declarations in one file. */
function declaredInterfaces(source: string): string[] {
  return Array.from(source.matchAll(/^export interface (\w+)\s*\{/gm), (m) => m[1] as string);
}

/**
 * The contract schema a hand-declared name shadows, if any.
 *
 * Both spellings, because the panel names a type after either the DTO class
 * (`TenantLimitsDto` -> `TenantLimits`) or the entity (`AuditLog`).
 */
function shadowedSchema(name: string, schemas: Set<string>): string | null {
  if (schemas.has(name)) return name;
  if (schemas.has(`${name}Dto`)) return `${name}Dto`;
  return null;
}

describe('INVARIANT: the admin panel sources its types from the generated contract', () => {
  const schemas = contractSchemaNames();
  const files = readdirSync(TYPES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.ts')
    .map((entry) => entry.name)
    .sort();

  it('reads a contract with schemas in it, and a types directory with files in it', () => {
    // Either side coming back empty would make the case below vacuously green.
    expect(schemas.size).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(5);
  });

  it('hand-declares no shape the contract already describes, beyond the tracked one', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(TYPES_DIR, file), 'utf-8');
      for (const name of declaredInterfaces(source)) {
        const key = `${file}:${name}`;
        if (key in TRACKED_SHADOWS) continue;
        const schema = shadowedSchema(name, schemas);
        if (schema) offenders.push(`${key} shadows contract schema '${schema}'`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} hand-declared type(s) in ${PANEL}/services/types shadow a schema ` +
          `the generated contract already carries. A hand copy is free to disagree, and every ` +
          `time one has, a page rendered a blank instead of failing: ADMIN-HIGH-110, -112, -113. ` +
          `Write it as \`export type X = ApiSchema<'Schema'>\` so a backend rename is a compile ` +
          `error here. If the contract genuinely cannot describe the shape, that is a finding ` +
          `about the endpoint — register it and add an entry to TRACKED_SHADOWS:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('still sees the tracked shadow, rather than having stopped matching it', () => {
    // An allowlist entry that no longer matches would make this gate pass on a
    // file it believes it is holding, and ADMIN-MEDIUM-114 would look closed
    // without anyone closing it.
    for (const [key, findingId] of Object.entries(TRACKED_SHADOWS)) {
      const [file, name] = key.split(':');
      const source = readFileSync(join(TYPES_DIR, file as string), 'utf-8');
      const declared = declaredInterfaces(source).includes(name as string);
      const shadows = shadowedSchema(name as string, schemas) !== null;
      expect(`${key} (${findingId}) declared:${declared} shadows:${shadows}`).toBe(
        `${key} (${findingId}) declared:true shadows:true`,
      );
    }
  });

  it('recognises the alias form as compliant, not as a shadow', () => {
    // The cure must not look like the disease: `export type X = ApiSchema<…>`
    // is what this gate asks for, so it must not be reported as a declaration.
    expect(declaredInterfaces("export type Tenant = ApiSchema<'TenantListItemDto'>;\n")).toEqual(
      [],
    );
    expect(declaredInterfaces('export interface Tenant {\n  id: string;\n}\n')).toEqual(['Tenant']);
  });

  it('matches a name against both spellings the panel uses', () => {
    const fake = new Set(['AuditLog', 'TenantLimitsDto']);
    expect(shadowedSchema('AuditLog', fake)).toBe('AuditLog');
    expect(shadowedSchema('TenantLimits', fake)).toBe('TenantLimitsDto');
    expect(shadowedSchema('SomethingLocal', fake)).toBeNull();
  });
});
