/**
 * APA-150 — what the admin panel SENDS to `/reports/definitions` must be a
 * subset of what the DTO whitelists.
 *
 * The platform pipe runs `whitelist: true, forbidNonWhitelisted: true`, so an
 * unknown key is a 400, not a silent drop. `createReportDefinition` typed its
 * payload as `Omit<ReportDefinition, 'id' | 'createdAt' | 'lastRunAt'>` — a READ
 * model minus a few keys, which is not a write contract. It still carried
 * `isActive`, `columns`, `filters` and `nextRunAt`, none of them whitelisted, so
 * the call would have been rejected the moment anything invoked it. It was
 * latent only because `ReportsPage` ships a hardcoded catalogue and never calls
 * the definitions API.
 *
 * Deriving a write type from a read type is the reusable mistake here, so the
 * gate checks the property SETS in both directions: a field the client sends
 * that the DTO does not accept is a 400, and a field the DTO accepts that the
 * client cannot express is a capability the UI silently cannot reach.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-150
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const CONTROLLER = readFileSync(
  join(REPO_ROOT, 'apps/admin-api-service/src/analytics/controllers/reports.controller.ts'),
  'utf8',
);
const FRONTEND_TYPES = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/types/reports.ts'),
  'utf8',
);
const FRONTEND_API = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/api/reports.ts'),
  'utf8',
);

/** Declared property names of a `class X { … }` or `interface X { … }` block. */
function declaredFields(source: string, kind: 'class' | 'interface', name: string): string[] {
  const header = new RegExp(`(?:export )?${kind} ${name}\\s*\\{`);
  const match = header.exec(source);
  if (!match) {
    throw new Error(`${kind} ${name} not found`);
  }

  let depth = 0;
  let index = match.index + match[0].length - 1;
  const start = index;
  do {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    index++;
  } while (depth > 0 && index < source.length);

  const body = source
    .slice(start + 1, index - 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const fields = new Set<string>();
  for (const line of body.split('\n')) {
    // `name!: string;` (DTO) and `name?: string;` / `name: string;` (interface).
    const field = /^\s*(\w+)[!?]?\s*:/.exec(line);
    if (field?.[1]) fields.add(field[1]);
  }
  return [...fields].sort();
}

describe('admin-panel report-definition write contract (APA-150)', () => {
  it('sends only fields CreateDefinitionDto whitelists', () => {
    const whitelisted = declaredFields(CONTROLLER, 'class', 'CreateDefinitionDto');
    const sent = declaredFields(FRONTEND_TYPES, 'interface', 'CreateReportDefinitionInput');

    // Equality, not subset: a field the DTO accepts and the client cannot
    // express is a capability the UI silently cannot reach.
    expect(sent).toEqual(whitelisted);
  });

  it('sends only fields UpdateDefinitionDto whitelists', () => {
    const whitelisted = declaredFields(CONTROLLER, 'class', 'UpdateDefinitionDto');
    const sent = declaredFields(FRONTEND_TYPES, 'interface', 'UpdateReportDefinitionInput');

    expect(sent).toEqual(whitelisted);
  });

  it('never derives a write payload from the read model', () => {
    // `Omit<ReportDefinition, …>` is the exact shape of the defect: it looks
    // like a narrowing and is in fact a read model carrying server-owned
    // fields into a body that rejects unknown keys.
    const derived = [
      ...FRONTEND_API.matchAll(/data:\s*(?:Omit|Partial|Pick)<\s*ReportDefinition/g),
    ].map((match) => match[0]);

    expect(derived).toEqual([]);
  });

  it('reads no field the definition entity does not carry', () => {
    // `columns` and `nextRunAt` were invented; there is no scheduler and so no
    // next run — the schedule fields were retired in APA-141. Comments are
    // stripped first, since the explanation of a removal necessarily names it.
    const declarations = FRONTEND_TYPES.replace(/\/\*[\s\S]*?\*\//g, '').replace(
      /^\s*\/\/.*$/gm,
      '',
    );

    expect(declarations).not.toMatch(/^\s*columns\??\s*:/m);
    expect(declarations).not.toMatch(/^\s*nextRunAt\??\s*:/m);
    expect(declarations).not.toMatch(/^\s*isActive\??\s*:/m);
  });
});
