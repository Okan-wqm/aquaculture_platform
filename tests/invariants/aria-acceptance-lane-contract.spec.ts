/**
 * ARIA acceptance-lane contract (Plan tranquil-sniffing-pancake Faz 2.3/2.4).
 *
 * The lane's load-bearing clauses lived only in prose and were violated in
 * practice (fixer-attributed closures shipped as non-draft merged PRs
 * touching aria-kernel/**). This spec makes the clauses' PRESENCE detectable;
 * behavioural enforcement of "the PR was actually opened as draft" needs the
 * registry+GitHub join and is tracked in the Faz-4 findings batch.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const R = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(R, p), 'utf8');

describe('aria acceptance lane contract', () => {
  it('gap-fixer keeps the draft-only and kernel-refusal clauses', () => {
    const fixer = read('.claude/agents/aria-acceptance-gap-fixer.md');
    expect(fixer.toLowerCase()).toContain('draft');
    expect(fixer).toContain('aria-kernel/**');
    expect(fixer).toMatch(/never|asla|refus/i);
  });

  it('every acceptance agent carries knowledge bookmarks', () => {
    for (const a of [
      'aria-acceptance-lead',
      'aria-acceptance-output-validator',
      'aria-acceptance-gap-hunter',
      'aria-acceptance-gap-fixer',
    ]) {
      expect(read(`.claude/agents/${a}.md`)).toContain('@.claude/knowledge/layer-1-aria.md');
    }
  });

  it('/aria-accept invokes the harness with the persisted-report CLI', () => {
    const cmd = read('.claude/commands/aria-accept.md');
    expect(cmd).toContain('--json-out');
  });
});
