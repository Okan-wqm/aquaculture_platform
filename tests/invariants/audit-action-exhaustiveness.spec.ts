/**
 * AuditAction exhaustiveness invariant — FARM-MEDIUM-001 follow-up
 * ============================================================================
 *
 * `AuditAction` is a Postgres-friendly string enum on
 * `apps/farm-service/src/database/entities/audit-log.entity.ts`.
 * Every value persists as the literal string in
 * `farm_audit_logs.action` (a `VARCHAR(50)` column with no DB-side
 * enum constraint — the discipline lives in TypeScript).
 *
 * `AuditLogService.generateSummary()` keeps an `actionText` map that
 * renders human-readable summary lines per action. When a developer
 * adds a new AuditAction value but forgets to extend the map, the
 * summary string for that action evaluates to `${undefined}` —
 * silent corruption of the audit trail's most-readable column.
 *
 * The class of bug almost happened in PR-46 (FARM-MEDIUM-001) when
 * `CAPACITY_BLOCKED` was added: the enum + handler emission both
 * landed before the `actionText` map was extended; only a code-
 * review pass caught it. This invariant fails CI before merge so
 * the next addition cannot leak through.
 *
 * # When this spec fails
 *
 *   - A new `AuditAction` value exists without an `actionText[...]`
 *     entry → extend `generateSummary()` in audit-log.service.ts.
 *   - An `actionText[...]` entry references an enum member that no
 *     longer exists → remove the stale entry.
 *
 * # What this invariant does NOT check
 *
 *   - Whether the action's emit path (logCreate / logUpdate / etc.)
 *     exists. Most actions get a typed helper but a handful (like
 *     CAPACITY_BLOCKED) emit through `log()` or `logWithManager()`
 *     directly with the action passed inline — that's intentional
 *     and the invariant doesn't enforce a 1:1 helper.
 *   - Whether the audit ROW for a given action carries the right
 *     metadata. That's the responsibility of the handler that emits
 *     it; the rule here is purely about the summary-rendering map.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTITY_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/entities/audit-log.entity.ts',
);
const SERVICE_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/services/audit-log.service.ts',
);

/**
 * Extract every member of the `AuditAction` enum declared in
 * audit-log.entity.ts. Returns the set of TypeScript identifiers
 * (e.g. `CREATE`, `CAPACITY_BLOCKED`), NOT the runtime string
 * values — the action map's keys are typed by the enum members
 * themselves, so identifier-level matching is what we want.
 */
function extractAuditActionMembers(source: string): Set<string> {
  const enumBlock = source.match(/export\s+enum\s+AuditAction\s*\{([^}]+)\}/);
  if (!enumBlock || !enumBlock[1]) {
    throw new Error(
      `Could not locate \`export enum AuditAction { ... }\` in ${ENTITY_PATH}. ` +
        'Either the enum was renamed/moved (update this invariant) or the ' +
        'file is unreadable.',
    );
  }
  const members = new Set<string>();
  // Match `IDENTIFIER = '...'` lines; ignore trailing commas, JSDoc, and inline comments.
  const memberRegex = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(enumBlock[1])) !== null) {
    members.add(m[1]!);
  }
  if (members.size === 0) {
    throw new Error(
      `Parsed AuditAction enum block but found no SCREAMING_SNAKE_CASE members. ` +
        'Either the enum is empty (unexpected) or the regex failed against a ' +
        'new style. Update the invariant if the enum syntax changed.',
    );
  }
  return members;
}

/**
 * Extract the keys of the `actionText` literal inside
 * `generateSummary()`. Each key reads as `[AuditAction.X]:` —
 * we capture the `X` identifier so it can be set-compared with
 * the enum's members.
 */
function extractActionTextKeys(source: string): Set<string> {
  // Locate the actionText declaration — narrow the search so we
  // don't accidentally catch unrelated AuditAction.* references.
  const block = source.match(
    /const\s+actionText\s*=\s*\{([\s\S]*?)\}\s*;/,
  );
  if (!block || !block[1]) {
    throw new Error(
      `Could not locate \`const actionText = { ... }\` in ${SERVICE_PATH}. ` +
        'Either generateSummary() was renamed/moved or the action map was ' +
        'extracted to a different shape — update this invariant.',
    );
  }
  const keys = new Set<string>();
  const keyRegex = /\[\s*AuditAction\.([A-Z][A-Z0-9_]*)\s*\]\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRegex.exec(block[1])) !== null) {
    keys.add(m[1]!);
  }
  if (keys.size === 0) {
    throw new Error(
      `Parsed actionText literal but found no \`[AuditAction.X]:\` keys. ` +
        'Either the map was emptied or its key syntax changed. Update the ' +
        'invariant if the shape evolved.',
    );
  }
  return keys;
}

describe('AuditAction exhaustiveness invariant (FARM-MEDIUM-001 follow-up)', () => {
  let enumMembers: Set<string>;
  let actionTextKeys: Set<string>;

  beforeAll(() => {
    enumMembers = extractAuditActionMembers(readFileSync(ENTITY_PATH, 'utf8'));
    actionTextKeys = extractActionTextKeys(readFileSync(SERVICE_PATH, 'utf8'));
  });

  it('every AuditAction enum member has a matching actionText entry', () => {
    const missing = [...enumMembers].filter((m) => !actionTextKeys.has(m)).sort();
    expect(missing).toEqual([]);
  });

  it('every actionText key references a real AuditAction member', () => {
    const stale = [...actionTextKeys].filter((k) => !enumMembers.has(k)).sort();
    expect(stale).toEqual([]);
  });

  it('AuditAction members are SCREAMING_SNAKE_CASE', () => {
    const malformed = [...enumMembers].filter(
      (m) => !/^[A-Z][A-Z0-9_]*$/.test(m),
    );
    expect(malformed).toEqual([]);
  });
});
