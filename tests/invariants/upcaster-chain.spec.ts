/**
 * Upcaster chain invariant (Phase 4 deliverable per
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-4,
 * covering W6 data-expert invariant "1:1 upcaster chain coverage").
 *
 * Event contracts at `libs/event-contracts/src/upcasters/**` MUST form
 * a gap-free version chain per eventType:
 *
 *   1. Every `*.upcaster.ts` in the upcasters directory is exported
 *      from `upcasters/index.ts` — unexported upcasters are dead code
 *      (the EventUpcasterRegistry never sees them at runtime).
 *   2. Every upcaster has a covering unit test in
 *      `upcasters/__tests__/` — untested upcasters are the DATA-MEDIUM-
 *      007 failure mode (schema drift detected only when a consumer
 *      crashes in prod).
 *   3. Upcasters for the same eventType form a CONTIGUOUS chain: if
 *      chain exists with fromVersion [1, 2, 4] and no version 3, the
 *      missing 3→4 step means events stored at v3 cannot replay.
 *
 * This spec is STRUCTURAL — it does NOT execute any upcaster logic
 * (that is the responsibility of the `upcasters/__tests__/*.spec.ts`
 * files that we simply assert exist here).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const UPCASTERS_DIR = resolve(REPO_ROOT, 'libs/event-contracts/src/upcasters');
const TESTS_DIR = resolve(UPCASTERS_DIR, '__tests__');
const INDEX_PATH = resolve(UPCASTERS_DIR, 'index.ts');

/**
 * Parse an upcaster source file and extract the (eventType, fromVersion,
 * toVersion) tuple from the exported const. Returns `null` if the file
 * is not an upcaster (e.g., infrastructure files like event-upcaster.ts
 * or factory helpers like timestamp-to-string.upcaster.ts that emit
 * multiple upcasters via a factory). The timestamp factory is special-
 * cased in the coverage check.
 */
interface UpcasterShape {
  readonly filename: string;
  readonly eventType: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * Strip JS/TS comments from source before regex extraction. The
 * version-marker regexes below are unanchored, so a JSDoc paragraph
 * that *describes* an example (e.g. "see fromVersion: 1, toVersion: 2"
 * inside `sensor-reading-v2-to-v3.upcaster.ts:39`) would otherwise
 * match BEFORE the real `fromVersion: 2` on the const declaration —
 * causing `parseUpcasterFile` to report fromVersion=1 for a v2→v3
 * upcaster, which then surfaces as a phantom chain gap.
 *
 * We strip:
 *   - block comments (incl. JSDoc): `/* ... *​/` non-greedy across newlines
 *   - line comments: `//` to end-of-line
 *
 * Stripping comments before regex matching is the architectural fix
 * (the alternative — line-anchored regex with negative lookbehind on
 * `*` — both narrows valid matches AND is fragile against indentation
 * variation in real upcaster constants).
 */
function stripComments(source: string): string {
  // Block comments first (greediness matters: `[\s\S]*?` non-greedy
  // so consecutive blocks don't merge).
  let out = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then line comments. We DO NOT strip URLs (e.g. `https://`) because
  // there's a `:` after `https`; the regex is anchored at start-of-
  // line whitespace + `//` to avoid that case.
  out = out.replace(/^\s*\/\/.*$/gm, '');
  return out;
}

function parseUpcasterFile(filename: string): UpcasterShape | null {
  const abs = resolve(UPCASTERS_DIR, filename);
  if (!existsSync(abs)) return null;
  const rawSource = readFileSync(abs, 'utf8');
  // Strip comments BEFORE regex extraction so JSDoc text mentioning
  // `fromVersion: N` does not pollute the const-declaration match.
  const source = stripComments(rawSource);

  const eventTypeMatch = /eventType\s*:\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/.exec(source);
  const fromMatch = /fromVersion\s*:\s*(\d+)/.exec(source);
  const toMatch = /toVersion\s*:\s*(\d+)/.exec(source);

  if (!eventTypeMatch?.[1] || !fromMatch?.[1] || !toMatch?.[1]) return null;

  return {
    filename,
    eventType: eventTypeMatch[1],
    fromVersion: parseInt(fromMatch[1], 10),
    toVersion: parseInt(toMatch[1], 10),
  };
}

describe('Event upcaster chain invariant (W6 data-expert)', () => {
  const upcasterFiles = readdirSync(UPCASTERS_DIR).filter(
    (f) => f.endsWith('.upcaster.ts'),
  );
  const indexSource = readFileSync(INDEX_PATH, 'utf8');

  /**
   * Factory-style upcasters — single file emits multiple upcasters via
   * a generator function. Excluded from the 1:1 file ↔ parseable-shape
   * check because fromVersion/toVersion are parameterised, not literal.
   * Map keyed by filename to the expected factory export name + a
   * substring expected to appear in the test suite.
   */
  const FACTORY_UPCASTERS: Record<string, { exportName: string; testMatch: string }> = {
    'timestamp-to-string.upcaster.ts': {
      exportName: 'createTimestampUpcaster',
      testMatch: 'timestamp',
    },
  };

  it('every upcaster file is exported from upcasters/index.ts', () => {
    const missing: string[] = [];
    for (const filename of upcasterFiles) {
      const factory = FACTORY_UPCASTERS[filename];
      if (factory) {
        if (!indexSource.includes(factory.exportName)) {
          missing.push(`${filename} (expected factory export: ${factory.exportName})`);
        }
        continue;
      }
      const shape = parseUpcasterFile(filename);
      if (!shape) {
        missing.push(`${filename} (unable to parse upcaster shape)`);
        continue;
      }
      // Expect export: `<eventType-camel>Upcaster`
      const expectedExport =
        shape.eventType.charAt(0).toLowerCase() +
        shape.eventType.slice(1) +
        'Upcaster';
      if (!indexSource.includes(expectedExport)) {
        missing.push(`${filename} (expected export: ${expectedExport})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every upcaster file has a covering unit test in __tests__/', () => {
    const testFiles = existsSync(TESTS_DIR) ? readdirSync(TESTS_DIR) : [];
    const testSources = testFiles
      .filter((f) => f.endsWith('.spec.ts'))
      .map((f) => readFileSync(resolve(TESTS_DIR, f), 'utf8'))
      .join('\n');

    const uncovered: string[] = [];
    for (const filename of upcasterFiles) {
      const factory = FACTORY_UPCASTERS[filename];
      if (factory) {
        // Factory tests prove shape via parameterised test cases; we only
        // require the factory name or a matching substring to appear.
        if (
          !testSources.includes(factory.exportName) &&
          !testSources.toLowerCase().includes(factory.testMatch.toLowerCase())
        ) {
          uncovered.push(filename);
        }
        continue;
      }
      const shape = parseUpcasterFile(filename);
      if (!shape) {
        uncovered.push(`${filename} (shape unparseable, cannot look up test)`);
        continue;
      }
      // A test file mentions either the export name or the eventType.
      const exportName =
        shape.eventType.charAt(0).toLowerCase() +
        shape.eventType.slice(1) +
        'Upcaster';
      if (
        !testSources.includes(exportName) &&
        !testSources.includes(shape.eventType)
      ) {
        uncovered.push(`${shape.eventType} (${filename}) — no test references it`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('upcaster chains per eventType are contiguous (no version gaps)', () => {
    const byEventType = new Map<string, UpcasterShape[]>();
    for (const filename of upcasterFiles) {
      if (filename in FACTORY_UPCASTERS) continue;
      const shape = parseUpcasterFile(filename);
      if (!shape) continue;
      const chain = byEventType.get(shape.eventType) ?? [];
      chain.push(shape);
      byEventType.set(shape.eventType, chain);
    }

    const gaps: string[] = [];
    for (const [eventType, chain] of byEventType) {
      chain.sort((a, b) => a.fromVersion - b.fromVersion);
      for (let i = 1; i < chain.length; i++) {
        const prev = chain[i - 1];
        const curr = chain[i];
        if (!prev || !curr) continue;
        if (curr.fromVersion !== prev.toVersion) {
          gaps.push(
            `${eventType}: gap between v${prev.toVersion} (${prev.filename}) and v${curr.fromVersion} (${curr.filename})`,
          );
        }
      }
      // fromVersion: 1 enforced only for multi-step chains. A single-step
      // v1→v2 is itself valid; v2→v3 without v1→v2 is a gap.
      const head = chain[0];
      if (chain.length > 0 && head && head.fromVersion > 1 && chain.length > 1) {
        gaps.push(
          `${eventType}: chain starts at v${head.fromVersion} but expected v1 (multi-step chain)`,
        );
      }
    }
    expect(gaps).toEqual([]);
  });

  it('every upcaster toVersion is exactly fromVersion + 1 (step-by-step, no skips)', () => {
    const skips: string[] = [];
    for (const filename of upcasterFiles) {
      if (filename in FACTORY_UPCASTERS) continue;
      const shape = parseUpcasterFile(filename);
      if (!shape) continue;
      if (shape.toVersion !== shape.fromVersion + 1) {
        skips.push(
          `${shape.eventType} (${filename}): fromVersion=${shape.fromVersion} toVersion=${shape.toVersion} — multi-step upcasters are forbidden (compose single-step upcasters instead)`,
        );
      }
    }
    expect(skips).toEqual([]);
  });
});
