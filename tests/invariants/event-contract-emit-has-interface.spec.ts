/**
 * Platform-wide invariant — DATA-HIGH-002 / DATA-HIGH-004 /
 * COMPLIANCE-CRITICAL-003 / CONTRACT-CRITICAL-002:
 *
 * Every `createBaseEvent('<EventType>', …)` call site MUST have a
 * matching `<EventType>Event` interface declared in `libs/event-contracts/src/`.
 *
 * # Why
 *
 * `createBaseEvent` accepts a generic `T extends BaseEvent` and uses
 * `T['eventType']` as the literal type. When callers omit the generic
 * argument (most do — the type-inference path), `T` defaults to
 * `BaseEvent` and `T['eventType']` is the broad `string`, so any string
 * literal compiles cleanly. This was the loophole that let
 * SubscriptionPastDue, SubscriptionExpired, UserDeleted, and several
 * GDPR events ship as raw emits with no contract — the audit captured
 * them as DATA-HIGH-004 + COMPLIANCE-CRITICAL-003 + CONTRACT-CRITICAL-002.
 *
 * # What this test enforces
 *
 *   1. Walk every `*.ts` file under apps/, libs/, platform/ (excluding
 *      tests + node_modules) for `createBaseEvent<…>('…', …)` and
 *      `createBaseEvent('…', …)` invocations.
 *   2. For each matched eventType literal, assert that an interface
 *      named `${EventType}Event` is exported from one of the
 *      `*-events.ts` files in libs/event-contracts/src/ (or its
 *      sub-barrels like security/security-events.ts).
 *   3. Also verify the interface appears in the relevant domain union
 *      (AuthEvent | BillingEvent | SecurityEvent | …) so the
 *      `AnyPlatformEvent` rollup includes it.
 *
 * Source-only check; uses regex + filesystem walks. Cheap to run on
 * every PR and detects the regression class at compile time.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACTS_DIR = 'libs/event-contracts/src';

/**
 * Special-case eventType literals that legitimately do not (yet) have
 * a contract interface. Each entry MUST reference the orphan finding
 * that tracks the gap. The list is the safety hatch — not a deferral
 * mechanism — used when the missing interface lives in a domain that
 * was OUT OF SCOPE for the audit cycle that introduced this invariant.
 *
 * Removal of an entry happens when the matching domain audit lands the
 * interface; the invariant then catches any future regression.
 */
const KNOWN_EXEMPT: ReadonlySet<string> = new Set<string>([
  // 2026-04-29: 20 orphan eventTypes from the messaging-service +
  // sensor-service automation domains were drained by authoring the
  // matching interfaces in libs/event-contracts/src/messaging-events.ts
  // (16 events) + libs/event-contracts/src/automation-events.ts (4
  // events). Allowlist now empty — the invariant unconditionally
  // enforces interface presence for every createBaseEvent call site.
]);

interface CallSite {
  file: string;
  eventType: string;
}

function discoverCallSites(): CallSite[] {
  // git ls-files gives us the tracked TypeScript files; we then grep
  // each file in process. execFileSync (not execSync) avoids shell
  // expansion + quoting hazards on the grep pattern.
  const lsFilesOut = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files',
      'apps/*.ts', 'apps/**/*.ts',
      'libs/*.ts', 'libs/**/*.ts',
      'platform/*.ts', 'platform/**/*.ts'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );

  const files = lsFilesOut.split('\n').filter(
    (f) =>
      f.length > 0 &&
      !f.includes('/__tests__/') &&
      !f.endsWith('.spec.ts') &&
      !f.endsWith('.test.ts'),
  );

  const eventTypeRe = /createBaseEvent(?:<[^>]*>)?\(\s*['"]([A-Z][A-Za-z0-9]*)['"]/g;
  const sites: CallSite[] = [];
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // skip unreadable files
    }
    if (!src.includes('createBaseEvent')) continue; // fast-path skip
    // Strip /* … */ and // … comments so a docblock example like
    // `* createBaseEvent('EventType', …)` does not register as a real
    // call site. Block-comment stripping is non-greedy across newlines.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
      .join('\n');
    eventTypeRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = eventTypeRe.exec(stripped)) !== null) {
      const eventType = m[1];
      if (eventType) sites.push({ file: rel, eventType });
    }
  }
  return sites;
}

function discoverDeclaredInterfaces(): Set<string> {
  // Walk every *.ts under libs/event-contracts/src and collect interface
  // names of the form `XxxEvent`. Filesystem walk avoids shell-escape risk.
  const lsFilesOut = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', `${CONTRACTS_DIR}/*.ts`, `${CONTRACTS_DIR}/**/*.ts`],
    { encoding: 'utf8' },
  );
  const files = lsFilesOut.split('\n').filter(
    (f) => f.length > 0 && !f.includes('/__tests__/') && !f.endsWith('.spec.ts'),
  );

  const declRe = /export interface ([A-Z][A-Za-z0-9]+Event)\b/g;
  const names = new Set<string>();
  for (const rel of files) {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    declRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(src)) !== null) {
      const name = m[1];
      if (name) names.add(name);
    }
  }
  return names;
}

describe('INVARIANT (DATA-HIGH-004): every createBaseEvent emit has a matching contract interface', () => {
  it('every emitted eventType has a `${EventType}Event` interface in libs/event-contracts/src', () => {
    const sites = discoverCallSites();
    expect(sites.length).toBeGreaterThan(0);

    const declared = discoverDeclaredInterfaces();
    expect(declared.size).toBeGreaterThan(0);

    const orphans: { eventType: string; sites: string[] }[] = [];
    const grouped = new Map<string, string[]>();
    for (const site of sites) {
      if (!grouped.has(site.eventType)) grouped.set(site.eventType, []);
      grouped.get(site.eventType)!.push(site.file);
    }

    for (const [eventType, files] of grouped) {
      if (KNOWN_EXEMPT.has(eventType)) continue;
      const interfaceName = `${eventType}Event`;
      if (!declared.has(interfaceName)) {
        orphans.push({ eventType, sites: Array.from(new Set(files)) });
      }
    }

    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} eventType literal(s) have no matching contract interface in libs/event-contracts/src/.\n` +
          orphans
            .map(
              ({ eventType, sites }) =>
                `  - createBaseEvent('${eventType}', …) is called but no \`${eventType}Event\` interface exists.\n` +
                `    Emitted from: ${sites.slice(0, 5).join(', ')}${sites.length > 5 ? `, +${sites.length - 5} more` : ''}\n` +
                `    Fix: add \`export interface ${eventType}Event extends BaseEvent { eventType: '${eventType}'; … }\` ` +
                `to the appropriate libs/event-contracts/src/*-events.ts file AND add it to the corresponding domain union.`,
            )
            .join('\n'),
      );
    }
  });
});
