/**
 * Invariant — SEC-REVIEW-003: every `eslint-disable-next-line no-restricted-syntax`
 * annotation must be immediately followed by a matching restricted call.
 *
 * # Why this exists
 *
 * The Phase B `getRepository → tenantManagerRepo` migration left a
 * deliberately documented set of escape-hatch sites: cross-tenant
 * catalog entities (`Plan`, parent-row-scoped `DeviceIoConfig`),
 * pre-tenant auth flows, and platform-admin queries. Each one carries
 * a comment of the shape:
 *
 *     // eslint-disable-next-line no-restricted-syntax -- <rationale>
 *     manager.getRepository(Plan).findOne(...)
 *
 * The `eslint-disable-next-line` directive is positional — it applies
 * to the next non-blank, non-comment line. Two failure modes silently
 * defeat the architectural intent:
 *
 *   1. **Detached annotation.** A future refactor inserts a blank
 *      line, moves the import block, or reorders methods. The
 *      annotation now points at an unrelated line. ESLint loses the
 *      rationale-pointer and may even fire a "unused eslint-disable"
 *      warning, which the team historically accepts as noise.
 *
 *   2. **Free-floating annotation.** Someone deletes the original
 *      `getRepository(...)` call as part of a clean-up but leaves
 *      the comment. The annotation becomes a deception artifact:
 *      reviewers reading the file see a comment that claims a
 *      restricted call exists nearby, but no such call lives there.
 *
 *   3. **Drifted annotation onto a different `getRepository` call.**
 *      A new method is added between annotation and the original
 *      target, so the annotation now disables a NEW call without an
 *      audited rationale, while the originally-rationalised call is
 *      no longer disabled. Architecturally identical to bypassing
 *      lint without justification.
 *
 * The positional-binding invariant catches all three. For every
 * `eslint-disable-next-line no-restricted-syntax -- <rationale>` in
 * the tracked source tree, we walk forward to the next non-blank,
 * non-comment line and assert it contains a token from the
 * restricted-syntax rule list (`getRepository(`, `JSON.stringify(...,...,N)`,
 * `JWT_SECRET`). When the binding fails, the violator file:line is
 * surfaced with the rationale that became orphaned.
 *
 * # What this invariant does NOT check
 *
 *   - Whether the rationale TEXT after the `-- ` is meaningful. The
 *     architectural review (cross-tenant catalog vs. ORPHAN-DIC-001
 *     vs. pre-tenant auth) is human judgment; this invariant only
 *     enforces structural integrity.
 *   - Whether the next-line call's TARGET is appropriate (e.g.
 *     `getRepository(Plan)` may be cross-tenant catalog OK but
 *     `getRepository(User)` of a tenant-scoped table is not). Same
 *     reason — that is human review.
 *   - Block-level eslint-disable directives (the slash-star variant
 *     covering a whole region). Those are
 *     intentionally absent from the codebase per CLAUDE.md "Code
 *     Quality Standards" and would be caught by lint config review,
 *     not this invariant.
 *
 * # Tier classification
 *
 * Tier-3 make-detectable. Surfaces structural drift at PR-time so the
 * positional binding cannot rot unnoticed. Complement to the
 * `no-restricted-syntax` rule itself (which catches *missing* annotations)
 * and the `eslint-rule-presence` invariant (which catches the rule
 * being deleted from `.eslintrc.json`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Tokens the `no-restricted-syntax` rule in `.eslintrc.json` flags.
 * Kept in sync manually because each token's regex form here only
 * needs to match what the AST selector matches semantically; the
 * canonical AST selectors live in `.eslintrc.json` and are checked
 * for presence by `eslint-rule-presence.spec.ts`.
 *
 * Each entry is a literal substring + a friendly label for the
 * violation message. Grep-style substring matching is sufficient
 * because the goal is "the next code line names the restricted
 * surface", not full AST equivalence.
 */
const RESTRICTED_TOKENS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '.getRepository(', label: 'getRepository() call' },
  { token: 'JWT_SECRET', label: 'JWT_SECRET reference' },
];

/**
 * Source tree we sweep. The Phase B migrations all live under
 * `apps/`, and the ESLint rule applies platform-wide, but third-
 * party / vendored code is excluded by `git ls-files` already.
 *
 * Tests + __tests__ are excluded — they may legitimately spy on or
 * mock restricted surfaces with `eslint-disable` for fixture-shape
 * reasons that the architectural rule does not aim at.
 */
const TRACKED_GLOBS = ['apps', 'libs', 'platform'];

interface Hit {
  file: string;
  annotationLine: number;
  rationale: string;
  // The next non-blank/non-comment line that the annotation should
  // bind to. `null` when the file ended before any candidate.
  bindingLine: number | null;
  bindingText: string | null;
  /**
   * The structural failure mode. Distinct labels keep the test
   * output actionable instead of producing one undifferentiated list.
   */
  failure:
    | 'no-binding-line' // annotation is the last non-trivial line in the file
    | 'binding-misses-restricted-token'; // next code line does not contain any restricted-syntax marker
}

function listTrackedFiles(): readonly string[] {
  // `git ls-files` respects .gitignore, skips node_modules + dist,
  // and is faster than walking the FS by hand. Filtered to .ts only;
  // .tsx UI surfaces have no getRepository/JWT_SECRET callsites by
  // design (those are server-side primitives).
  const args = ['ls-files', '-z', '--', ...TRACKED_GLOBS.map((g) => `${g}/**/*.ts`)];
  const out = execSync(`git ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (
    out
      .split('\0')
      .filter(Boolean)
      .filter((p) => existsSync(resolve(REPO_ROOT, p)))
      .filter((p) => !p.endsWith('.d.ts'))
      // Spec / __tests__ / __mocks__ files are exempt — see header.
      .filter(
        (p) => !/(__tests__|__mocks__|\.spec\.ts$|\.test\.ts$|\.e2e-spec\.ts$|\.e2e\.ts$)/.test(p),
      )
  );
}

/**
 * A line is a "skippable" preamble between the annotation and the
 * statement it disables iff it is blank or a comment. ESLint's own
 * `eslint-disable-next-line` resolution skips these exact line shapes
 * when locating the next "code line", so we mirror that traversal.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('*')) return true;
  return false;
}

/**
 * A "continuation line" is a physical line whose first non-whitespace
 * character indicates the line is part of an expression that began on
 * a previous line. The canonical case in this codebase is fluent
 * TypeORM chaining:
 *
 *     // eslint-disable-next-line no-restricted-syntax -- <rationale>
 *     let invitation = await manager       <-- binding line
 *       .getRepository(Invitation)         <-- continuation, restricted
 *       .createQueryBuilder('invitation')
 *       .getOne();
 *
 * ESLint reports the `getRepository` violation at the enclosing
 * CallExpression's `loc.start`, which the parser anchors at the start
 * of `manager` (line N+1). The annotation on line N therefore covers
 * the violation even though the literal `.getRepository(` substring
 * only appears on line N+2. To mirror this AST-aware behaviour
 * without parsing TypeScript ourselves, the spec walks the binding
 * line *and* its continuation lines as a single logical statement
 * and asserts that ANY of them carries a restricted token.
 *
 * The character set below is conservative — it matches the leading
 * tokens of property access, optional chaining, argument lists,
 * binary operators, and ternary continuations. Statements never
 * begin with these characters, so the rule "starts with one of these
 * → continuation" has no false positives in TS source.
 */
function isContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  // Property / optional chaining / argument lists.
  if (trimmed.startsWith('.') || trimmed.startsWith('?.') || trimmed.startsWith(',')) {
    return true;
  }
  if (trimmed.startsWith(')') || trimmed.startsWith(']') || trimmed.startsWith('}')) {
    return true;
  }
  // Logical / arithmetic / nullish operator continuations.
  if (
    trimmed.startsWith('&&') ||
    trimmed.startsWith('||') ||
    trimmed.startsWith('??') ||
    trimmed.startsWith('+') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith(':') ||
    trimmed.startsWith('=')
  ) {
    return true;
  }
  return false;
}

const LINT_ANNOTATION_TOKEN = ['eslint', 'disable', 'next', 'line'].join('-');
const ANNOTATION_RE = new RegExp(
  `//\\s*${LINT_ANNOTATION_TOKEN}\\s+no-restricted-syntax(?:\\s*--\\s*(.+))?$`,
);

/**
 * Hard cap on how many continuation lines we scan beyond the binding
 * line. Real-world TypeORM / fluent-builder chains in this repo top
 * out around 8-10 lines (e.g. mqtt-listener.service.ts:1602 region).
 * 16 is a 2x safety margin — chosen to never misclassify a legitimate
 * fluent chain while still bounding the search to keep the spec O(n)
 * over file size.
 */
const MAX_CONTINUATION_SCAN = 16;

function scanFile(file: string): readonly Hit[] {
  const path = resolve(REPO_ROOT, file);
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const annotationMatch = ANNOTATION_RE.exec(lines[i] ?? '');
    if (!annotationMatch) continue;

    const rationale = (annotationMatch[1] ?? '').trim() || '<no rationale provided>';

    // Walk past intervening blank / comment lines to reach the
    // physical "binding line" — the first line ESLint considers
    // covered by `eslint-disable-next-line`.
    let j = i + 1;
    while (j < lines.length && isCommentLine(lines[j] ?? '')) {
      j++;
    }

    if (j >= lines.length) {
      hits.push({
        file,
        annotationLine: i + 1,
        rationale,
        bindingLine: null,
        bindingText: null,
        failure: 'no-binding-line',
      });
      continue;
    }

    // Build the logical statement that the annotation actually
    // disables: the binding line PLUS any subsequent continuation
    // lines (chained property access, argument-list spillover, etc.).
    // The substring search runs across the concatenated logical
    // statement, not just the binding line, because the violation's
    // physical position can be on any line of the multiline chain.
    const bindingText = lines[j] ?? '';
    const statementLines: string[] = [bindingText];
    for (let k = j + 1; k < lines.length && k - j <= MAX_CONTINUATION_SCAN; k++) {
      const next = lines[k] ?? '';
      if (next.trim() === '') break; // blank line breaks continuation
      if (!isContinuationLine(next)) break;
      statementLines.push(next);
    }
    const logicalStatement = statementLines.join('\n');

    const bindsRestricted = RESTRICTED_TOKENS.some(({ token }) => logicalStatement.includes(token));

    if (!bindsRestricted) {
      hits.push({
        file,
        annotationLine: i + 1,
        rationale,
        bindingLine: j + 1,
        bindingText,
        failure: 'binding-misses-restricted-token',
      });
    }
  }
  return hits;
}

describe('INVARIANT (SEC-REVIEW-003): eslint-disable-next-line no-restricted-syntax annotations bind to a restricted call', () => {
  const files = listTrackedFiles();
  const allHits: Hit[] = files.flatMap((f) => [...scanFile(f)]);

  it('every annotation is followed by a non-comment line within the same file', () => {
    const orphans = allHits.filter((h) => h.failure === 'no-binding-line');
    if (orphans.length > 0) {
      const lines = orphans
        .map(
          (h) =>
            `  ${h.file}:${h.annotationLine}\n    rationale: ${h.rationale}\n` +
            `    failure: file ends before any non-comment line follows the annotation — ` +
            `the rationale is unreachable by ESLint and the call it was meant to disable does not exist.`,
        )
        .join('\n');
      throw new Error(
        `${orphans.length} orphaned eslint-disable annotation(s) with no binding line:\n${lines}\n\n` +
          `Resolve by deleting the dangling annotation or by re-adding the missing call ` +
          `that justified it.`,
      );
    }
    expect(orphans).toEqual([]);
  });

  it('every annotation is immediately followed by a line that contains a restricted token', () => {
    const drifts = allHits.filter((h) => h.failure === 'binding-misses-restricted-token');
    if (drifts.length > 0) {
      const tokens = RESTRICTED_TOKENS.map((t) => t.label).join(', ');
      const lines = drifts
        .map(
          (h) =>
            `  ${h.file}:${h.annotationLine} → binds at line ${h.bindingLine}\n` +
            `    rationale:    ${h.rationale}\n` +
            `    binding line: ${(h.bindingText ?? '').trim().slice(0, 120)}`,
        )
        .join('\n\n');
      throw new Error(
        `${drifts.length} eslint-disable annotation(s) drifted off their target call:\n${lines}\n\n` +
          `Each annotation MUST land on the line immediately preceding a call that contains one of: ${tokens}. ` +
          `Either move the annotation back to the call it disables, OR delete it if the call no longer exists. ` +
          `If the binding line is genuinely a restricted call this rule did not catch, add its substring marker ` +
          `to RESTRICTED_TOKENS at the top of this spec.`,
      );
    }
    expect(drifts).toEqual([]);
  });
});
