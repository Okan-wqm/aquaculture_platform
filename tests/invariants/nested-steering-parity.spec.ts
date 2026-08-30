/**
 * Nested Steering Parity Invariant
 * ============================================================================
 *
 * Nested CLAUDE.md files load on demand when an agent edits files in their
 * directory, which makes them the highest-signal place to record the per-table
 * schema INVERSIONS an agent would otherwise get wrong. Several of them
 * enumerate a service's cross-tenant table set in prose.
 *
 * A hand-typed enumeration is a copied SSoT, and it rots exactly the way
 * CLAUDE.md itself warns about ("do not hardcode a copy"). Measured on
 * 2026-08-04:
 *
 *   apps/messaging-service/CLAUDE.md  claimed cross-tenant tables were
 *     "EXACTLY" 3; the real set was 5. Went wrong on 2026-07-12 (a0a1e9b5e,
 *     which added the erasure-proof ledger spread) and stayed wrong 3 weeks.
 *   apps/farm-service/CLAUDE.md       claimed 5; the real set was 8.
 *
 * claude-md-accuracy.spec.ts could not catch either: it asserts path
 * existence, line budgets and the inheritance note, and says so explicitly in
 * its own header. Every stale claim cited paths that still resolved — that is
 * precisely its blind spot, and this spec closes it.
 *
 * # Contract
 *
 * Wrap the enumeration in a marker naming the MODULE_SCHEMAS moduleName:
 *
 *   <!-- infra-tables:messaging -->`migrations`, `messaging_outbox`,
 *   `embeddings_metadata`<!-- /infra-tables -->
 *
 * Table names are the backticked tokens inside the marker body; surrounding
 * prose is ignored. The comparison is bidirectional and against the REAL
 * array — not against a docstring, which is the known soft spot of the
 * analogous aria-kernel I-V4-08 check.
 *
 * Scanning is WHOLE-FILE (`[\s\S]*?`), not line-by-line as in
 * doc-cardinality.spec.ts: nested files have an 80-line budget, so a long
 * table list necessarily wraps, and a line-scanner would silently see nothing.
 *
 * # When this spec fails
 *
 *   - Marker list disagrees with MODULE_SCHEMAS → update the doc (the failure
 *     message prints the exact missing/extra names), or fix the registry if
 *     the registry is what is wrong.
 *   - A REQUIRED_MARKERS entry is missing → the marker was deleted or renamed.
 *     Restore it; deleting a marker must never be a way to silence this spec.
 *
 * # References
 *
 *   - libs/backend-common/src/database/schema-manager.service.ts § MODULE_SCHEMAS
 *   - tests/invariants/doc-cardinality.spec.ts (marker idiom, numeric claims)
 *   - tests/invariants/claude-md-accuracy.spec.ts (paths + budgets, not content)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { MODULE_SCHEMAS } from '../../libs/backend-common/src/database/schema-manager.service';
import { discoverSteeringFiles } from './_constants';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Whole-file, non-greedy body capture. `[\s\S]` rather than `.` so the body
 * may span lines — see the header note on the 80-line nested budget.
 */
const MARKER_RE =
  /<!--\s*infra-tables:([a-z][a-z0-9_-]*)\s*-->([\s\S]*?)<!--\s*\/infra-tables\s*-->/g;

/**
 * Files that MUST carry a marker for the named module. Without this, deleting
 * a marker would make the spec vacuously green — the failure mode that makes
 * an extract-then-compare test worse than no test at all.
 *
 * Faz 2/3 of plan tranquil-sniffing-pancake: every new nested CLAUDE.md that
 * enumerates a cross-tenant table set adds its row here in the same commit.
 */
const REQUIRED_MARKERS: ReadonlyArray<readonly [file: string, module: string]> = [
  ['apps/farm-service/CLAUDE.md', 'farm'],
  ['apps/messaging-service/CLAUDE.md', 'messaging'],
  ['apps/sensor-service/CLAUDE.md', 'sensor'],
  ['apps/hr-service/CLAUDE.md', 'hr'],
  ['apps/ai-service/CLAUDE.md', 'ai'],
  ['apps/alert-engine/CLAUDE.md', 'alert'],
  ['apps/observability-service/CLAUDE.md', 'observability'],
];

interface MarkerHit {
  readonly file: string;
  readonly line: number;
  readonly module: string;
  readonly claimed: readonly string[];
}

/** Backticked tokens inside a marker body, in document order, de-duplicated. */
function extractTables(body: string): string[] {
  const tokens = body.match(/`([^`]+)`/g) ?? [];
  return [...new Set(tokens.map((t) => t.replace(/`/g, '').trim()))];
}

function scanMarkers(relFile: string): MarkerHit[] {
  const abs = join(REPO_ROOT, relFile);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf8');
  const hits: MarkerHit[] = [];
  const re = new RegExp(MARKER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const [, moduleName, body] = m;
    if (!moduleName || body === undefined) continue;
    hits.push({
      file: relFile,
      line: content.slice(0, m.index).split('\n').length,
      module: moduleName,
      claimed: extractTables(body),
    });
  }
  return hits;
}

/** The registry's fully-expanded cross-tenant set for a module. */
function actualInfrastructureTables(moduleName: string): string[] {
  const entry = MODULE_SCHEMAS.find((m) => m.moduleName === moduleName);
  if (!entry) {
    throw new Error(
      `No MODULE_SCHEMAS entry named "${moduleName}". ` +
        `Valid moduleNames: ${MODULE_SCHEMAS.map((m) => m.moduleName)
          .sort()
          .join(', ')}.`,
    );
  }
  return [...(entry.infrastructureTables ?? [])];
}

const steeringFiles = discoverSteeringFiles(REPO_ROOT);
const allHits: MarkerHit[] = steeringFiles.flatMap(scanMarkers);

describe('nested-steering-parity invariant', () => {
  describe('marker coverage', () => {
    it.each(REQUIRED_MARKERS)('%s carries an infra-tables marker for "%s"', (file, moduleName) => {
      const hit = allHits.find((h) => h.file === file && h.module === moduleName);
      if (!hit) {
        throw new Error(
          `${file} is missing its <!-- infra-tables:${moduleName} --> marker.\n` +
            `Wrap the cross-tenant table enumeration in the marker so this spec ` +
            `can prove it against MODULE_SCHEMAS. Deleting the marker is not a fix.`,
        );
      }
      // A marker whose body parsed to nothing is the same silent failure as
      // a deleted marker: `[] === []` would pass the parity check below.
      expect(hit.claimed.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('every marker names a real MODULE_SCHEMAS module', () => {
    const known = new Set(MODULE_SCHEMAS.map((m) => m.moduleName));
    const unknown = allHits.filter((h) => !known.has(h.module));
    if (unknown.length > 0) {
      const listing = unknown
        .map((h) => `  ${h.file}:${h.line} — unknown module "${h.module}"`)
        .join('\n');
      throw new Error(
        `Unknown infra-tables modules:\n${listing}\n\n` +
          `Valid moduleNames: ${[...known].sort().join(', ')}.`,
      );
    }
    expect(unknown).toEqual([]);
  });

  describe('claimed table set matches MODULE_SCHEMAS', () => {
    if (allHits.length === 0) {
      it.todo('no infra-tables markers found — coverage test above owns this');
      return;
    }
    it.each(allHits)('$file:$line infra-tables:$module', (hit) => {
      const actual = actualInfrastructureTables(hit.module);
      const claimedSet = new Set(hit.claimed);
      const actualSet = new Set(actual);

      // Two directional assertions rather than one toEqual, so the message
      // names WHICH way the drift runs (the I-V4-08 idiom).
      const missingFromDoc = actual.filter((t) => !claimedSet.has(t));
      const extraInDoc = hit.claimed.filter((t) => !actualSet.has(t));

      if (missingFromDoc.length > 0) {
        throw new Error(
          `${hit.file}:${hit.line} infra-tables:${hit.module} omits ${missingFromDoc.length} ` +
            `table(s) that MODULE_SCHEMAS declares: ${missingFromDoc.join(', ')}.\n` +
            `Full authoritative set (${actual.length}): ${actual.join(', ')}.\n` +
            `Note: the registry uses spreads (e.g. ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES) ` +
            `and includes 'migrations' — both are easy to miss when copying by hand.`,
        );
      }
      if (extraInDoc.length > 0) {
        throw new Error(
          `${hit.file}:${hit.line} infra-tables:${hit.module} lists ${extraInDoc.length} ` +
            `table(s) MODULE_SCHEMAS does not declare: ${extraInDoc.join(', ')}.\n` +
            `Full authoritative set (${actual.length}): ${actual.join(', ')}.\n` +
            `Either the doc is stale or the table was dropped from the registry.`,
        );
      }
      expect([...claimedSet].sort()).toEqual([...actualSet].sort());
    });
  });
});
