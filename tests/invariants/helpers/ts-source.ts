/**
 * Comment-stripping for source-text invariants.
 *
 * A spec that greps migration text for a construct will otherwise match the
 * construct being DESCRIBED in a docblock. That is not hypothetical: correcting
 * MSG-HIGH-077 meant writing `pinSearchPath(queryRunner, 'messaging')` into two
 * docblocks to explain why it must not be called, which a naive grep reads as
 * two fresh violations.
 *
 * Regex-based stripping is not good enough — `//` and `/*` occur inside SQL
 * template literals — so this walks the source tracking string, template and
 * comment state, and blanks comment bodies while preserving offsets so a
 * reported index still points at the right place in the original file.
 */

/** Replace every comment body with spaces, keeping newlines and total length. */
export function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');

  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out.push('  ');
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out.push('  ');
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out.push(ch);
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') state = 'code';
      out.push(blank(ch));
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(blank(ch));
      i += 1;
      continue;
    }

    // Inside a string or template literal: copy verbatim, honour escapes.
    if (ch === '\\') {
      out.push(ch, source[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    out.push(ch);
    i += 1;
  }

  return out.join('');
}
