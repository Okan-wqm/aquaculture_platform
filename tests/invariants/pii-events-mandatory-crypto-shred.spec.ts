/**
 * Platform-wide invariant — DATA-LOW-003:
 *
 * Every eventType listed in `PII_BEARING_EVENT_TYPES` (the canonical
 * registry at `libs/event-contracts/src/base-event.ts`) MUST be
 * backed by an event-contract interface that DECLARES
 * `cryptoShredKeyId: string` as a MANDATORY field (no `?:` modifier,
 * no inheritance from BaseEvent's optional shape).
 *
 * # Why this lives in tests/invariants/
 *
 * `BaseEvent.cryptoShredKeyId` is optional (`?: string`) by design —
 * non-PII events shouldn't be forced to declare it. PII-bearing
 * events are a closed registry; the registry MUST stay in lockstep
 * with the actual interface shapes.
 *
 * Failure mode: a new entry in PII_BEARING_EVENT_TYPES whose
 * interface still inherits the optional shape silently passes the
 * type system but lets a publisher emit the event without
 * cryptoShredKeyId. GDPR-Art-17 crypto-shred coverage gap.
 *
 * # What this spec asserts
 *
 *   1. The PII_BEARING_EVENT_TYPES array exists and is non-empty.
 *   2. For every entry, an interface in libs/event-contracts/src/**.ts
 *      declares `cryptoShredKeyId: string;` (mandatory) — found
 *      by source-grep, not runtime reflection (the schema is
 *      type-erased at runtime).
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-LOW-003
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EVENT_CONTRACTS_SRC = 'libs/event-contracts/src';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/**
 * Recursively walk libs/event-contracts/src/ collecting every
 * .ts file (skipping spec files + index barrels). The result is
 * the corpus we grep for `cryptoShredKeyId: string;` declarations.
 */
function collectEventContractFiles(): string[] {
  const root = resolve(REPO_ROOT, EVENT_CONTRACTS_SRC);
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (name === '__tests__' || name === 'schemas') continue;
        walk(full);
        continue;
      }
      if (
        name.endsWith('.ts') &&
        !name.endsWith('.spec.ts') &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.d.ts')
      ) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

describe('DATA-LOW-003 — PII-bearing events mandate cryptoShredKeyId', () => {
  it('PII_BEARING_EVENT_TYPES is declared and non-empty', () => {
    const src = read(`${EVENT_CONTRACTS_SRC}/base-event.ts`);
    expect(src).toMatch(
      /export\s+const\s+PII_BEARING_EVENT_TYPES\s*:\s*readonly\s+string\[\]/,
    );
    // The array must contain at least one entry — the empty-list
    // case is treated as "policy not authored yet" and would
    // skip the lockstep check entirely. PasswordResetRequested
    // was the seed entry per the audit.
    expect(src).toMatch(/['"`]PasswordResetRequested['"`]/);
  });

  it('every PII_BEARING_EVENT_TYPES entry has a backing interface that declares cryptoShredKeyId: string (mandatory)', () => {
    const baseSrc = read(`${EVENT_CONTRACTS_SRC}/base-event.ts`);
    // Extract the array entries between PII_BEARING_EVENT_TYPES = [
    // and the closing ] as const.
    const arrayMatch =
      /PII_BEARING_EVENT_TYPES\s*:\s*readonly\s+string\[\]\s*=\s*\[([\s\S]*?)\]\s*as\s+const/.exec(
        baseSrc,
      );
    expect(arrayMatch).not.toBeNull();
    const arrayBody = arrayMatch![1] ?? '';
    // ORPHAN-HIGH-507 — narrowed at the SOURCE rather than at each use. `.map`
    // over match objects yields `(string | undefined)[]`, and four downstream
    // errors were all that one type escaping into the loop. Filtering here fixes
    // the cause; guarding each `missing.push` would have fixed four symptoms and
    // left the array's type still lying about its contents.
    const eventTypes = [...arrayBody.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g)]
      .map((m) => m[1])
      .filter((value): value is string => value !== undefined);
    expect(eventTypes.length).toBeGreaterThan(0);

    // Cache the file corpus once.
    const files = collectEventContractFiles();
    const corpus = files.map((f) => ({ path: f, src: readFileSync(f, 'utf8') }));

    const missing: Array<{ eventType: string; reason: string }> = [];

    for (const eventType of eventTypes) {
      // Find the interface whose `eventType: 'X'` literal field
      // matches. The canonical pattern in this codebase is:
      //
      //   export interface FooEvent extends BaseEvent {
      //     readonly eventType: 'Foo';
      //     ...
      //     cryptoShredKeyId: string;  // mandatory — no `?`
      //   }
      const interfaceFile = corpus.find(({ src }) =>
        new RegExp(
          `eventType\\s*:\\s*['"\`]${eventType}['"\`]`,
        ).test(src),
      );
      if (!interfaceFile) {
        missing.push({
          eventType,
          reason: 'no interface with matching eventType literal found',
        });
        continue;
      }
      // Within that file, locate the interface containing the
      // eventType literal and assert `cryptoShredKeyId: string;`
      // appears (mandatory shape — no `?` between the name and
      // colon).
      const interfaceMatch = new RegExp(
        `export\\s+interface\\s+\\w+\\s+extends\\s+\\w+\\s*{[\\s\\S]*?eventType\\s*:\\s*['"\`]${eventType}['"\`][\\s\\S]*?\\n}`,
        'm',
      ).exec(interfaceFile.src);
      if (!interfaceMatch) {
        missing.push({
          eventType,
          reason: `interface block could not be sliced from ${interfaceFile.path}`,
        });
        continue;
      }
      const interfaceBody = interfaceMatch[0];
      // Mandatory shape: `cryptoShredKeyId : string ;` with NO
      // `?` immediately before the colon. Permissive whitespace.
      const mandatoryShape =
        /cryptoShredKeyId\s*:\s*string\s*;/.test(interfaceBody);
      const optionalShape =
        /cryptoShredKeyId\s*\?\s*:\s*string\s*;/.test(interfaceBody);
      if (optionalShape && !mandatoryShape) {
        missing.push({
          eventType,
          reason:
            `${interfaceFile.path}: cryptoShredKeyId declared as OPTIONAL ` +
            '("?:"). PII-bearing events must declare it MANDATORY ' +
            '(no "?" modifier).',
        });
        continue;
      }
      if (!mandatoryShape) {
        missing.push({
          eventType,
          reason:
            `${interfaceFile.path}: no "cryptoShredKeyId: string;" ` +
            'declaration found in the matching interface block.',
        });
      }
    }

    expect(missing).toEqual([]);
  });

  // Sanity: the canonical seed entry's interface (PasswordResetRequestedEvent)
  // is the reference implementation. Pin its shape directly so a
  // refactor that breaks the canonical example trips the gate
  // even before the registry-walking spec above does.
  it('PasswordResetRequestedEvent declares cryptoShredKeyId as mandatory (canonical seed)', () => {
    const src = read(`${EVENT_CONTRACTS_SRC}/auth-events.ts`);
    expect(src).toMatch(
      /interface\s+PasswordResetRequestedEvent[\s\S]*?cryptoShredKeyId\s*:\s*string\s*;/,
    );
  });
});
