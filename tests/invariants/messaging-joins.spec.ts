/**
 * Messaging entity-relation invariant
 * ============================================================================
 *
 * Closes AUDIT-MEDIUM-006 (2026-04-22 cold audit). The messaging service
 * has 12 open findings where cross-entity relations (channel ↔ channel-
 * member, message ↔ attachments/reactions/receipts) previously drifted —
 * typically a developer adding `@ManyToOne(...)` without a companion
 * `@JoinColumn(...)`, which lets TypeORM silently create a shadow FK
 * column with a generated name that the schema-drift validator then
 * cannot match against the entity's migration.
 *
 * Invariant:
 *
 *   1. Every @ManyToOne(...) decorator on a messaging entity property
 *      MUST be followed (within 10 lines, before the property
 *      declaration) by a @JoinColumn(...) decorator.
 *   2. Every @OneToMany(...) decorator MUST include a back-reference
 *      arrow (e.g. `(att) => att.message`) — the second argument is
 *      required by TypeORM for bidirectional relations and its
 *      omission means the reverse side can't navigate back.
 *
 * The invariant is scoped to messaging-service because AUDIT-MEDIUM-006
 * is messaging-specific; adjacent-service scope expansion is a separate
 * finding and a separate invariant.
 *
 * # When this spec fails
 *
 *   - Add the missing @JoinColumn OR delete the @ManyToOne if the
 *     relation isn't actually desired.
 *   - Add the arrow back-reference to @OneToMany if missing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MESSAGING_SRC = path.resolve(REPO_ROOT, 'apps/messaging-service/src');

function walkEntityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkEntityFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      out.push(abs);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  decorator: '@ManyToOne' | '@OneToMany' | '@OneToOne';
  reason: string;
}

/**
 * For each @ManyToOne / @OneToOne line, scan the next up-to-10 lines
 * looking for either:
 *   - a @JoinColumn decorator (pass)
 *   - a property declaration `<name>:` without @JoinColumn in between (fail)
 *
 * For each @OneToMany line, verify the decorator's second argument
 * exists — it must contain `=>` (an arrow fn back-reference).
 */
function analyze(filePath: string): Violation[] {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Match @ManyToOne(...) / @OneToOne(...) — these require @JoinColumn.
    const manyOneMatch = /^@(ManyToOne|OneToOne)\b/.exec(trimmed);
    if (manyOneMatch) {
      const decorator = `@${manyOneMatch[1]!}` as '@ManyToOne' | '@OneToOne';
      let foundJoin = false;
      let scanLines = 0;
      for (let j = i + 1; j < lines.length && scanLines < 10; j++, scanLines++) {
        const tj = lines[j]!.trim();
        if (/^@JoinColumn\b/.test(tj)) {
          foundJoin = true;
          break;
        }
        // Property declaration (bare name followed by colon or ?) means
        // we've passed the decorator block without a JoinColumn.
        if (/^\s*[a-zA-Z_][\w]*[?!]?\s*:/.test(tj)) break;
      }
      if (!foundJoin) {
        violations.push({
          file: filePath,
          line: i + 1,
          decorator,
          reason: `${decorator} missing companion @JoinColumn within 10 lines — TypeORM will generate a shadow FK column name and drift from migration`,
        });
      }
      continue;
    }

    // Match @OneToMany(target, backref) — the backref arrow is required.
    const oneManyMatch = /^@OneToMany\s*\(/.exec(trimmed);
    if (oneManyMatch) {
      // Accumulate the full decorator call across lines until the close paren.
      let call = line;
      let j = i;
      let depth = 0;
      for (; j < lines.length; j++) {
        depth += (lines[j]!.match(/\(/g) ?? []).length;
        depth -= (lines[j]!.match(/\)/g) ?? []).length;
        if (j > i) call += ' ' + lines[j]!.trim();
        if (depth === 0) break;
      }
      // The second argument must be present and contain '=>'.
      // Minimum accepted form: @OneToMany(() => X, y => y.foo)
      // The arrow check is strict enough to catch single-arg (relation-
      // without-inverse) cases the plan calls out.
      const arrowCount = (call.match(/=>/g) ?? []).length;
      if (arrowCount < 2) {
        violations.push({
          file: filePath,
          line: i + 1,
          decorator: '@OneToMany',
          reason: '@OneToMany missing inverse-side arrow (expected `(child) => child.parent`); unidirectional @OneToMany leaves child entity unable to navigate back',
        });
      }
      i = j;
    }
  }

  return violations;
}

describe('AUDIT-MEDIUM-006 messaging entity-relation invariant', () => {
  if (!statSync(MESSAGING_SRC, { throwIfNoEntry: false })?.isDirectory()) {
    it.skip('messaging-service source not found — skipping', () => {
      /* no-op */
    });
    return;
  }

  const files = walkEntityFiles(MESSAGING_SRC);

  it('at least one entity file is in scope', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f);
    describe(rel, () => {
      const violations = analyze(f);
      if (violations.length === 0) {
        it('every relation decorator is well-formed', () => {
          expect(violations).toEqual([]);
        });
        return;
      }
      for (const v of violations) {
        it(`${rel}:${v.line} ${v.decorator} — ${v.reason}`, () => {
          throw new Error(`${rel}:${v.line} ${v.decorator} — ${v.reason}`);
        });
      }
    });
  }
});
