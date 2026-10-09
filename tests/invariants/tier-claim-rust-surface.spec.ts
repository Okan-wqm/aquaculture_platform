/**
 * ARIA-MEDIUM-392 — the tier-claim vocabulary must name Rust mechanisms,
 * and the lint gate must actually scan `.rs` files.
 *
 * The SSoT chain is `.claude/shared/tier-claim-syntax.md` (table) →
 * `tools/gates/tier-claim-lint.ts` (mechanism hints + file filter +
 * enforcement domain) → `root-cause-auditor.md` (mirror + canonical
 * refs). Before this closure the filter was ts|tsx only and the
 * domain apps sources only, so a Rust tier-claim could neither be
 * selected nor tier-4-gated — while the repo carries ~210k LOC of
 * Rust behind `sens-api-gateway/src` and `crates` sources.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('ARIA-MEDIUM-392 — Rust tier-claim surface', () => {
  const lintSource = readFileSync(resolve(REPO_ROOT, 'tools/gates/tier-claim-lint.ts'), 'utf8');
  const ssoTDoc = readFileSync(resolve(REPO_ROOT, '.claude/shared/tier-claim-syntax.md'), 'utf8');
  const auditorDoc = readFileSync(
    resolve(REPO_ROOT, '.claude/agents/root-cause-auditor.md'),
    'utf8',
  );

  it('staged and range file selection admits .rs files and excludes only test fixtures', () => {
    const selection = lintSource.match(/function isProductCode[\s\S]*?\n}/)?.[0] ?? '';
    expect(selection).toContain('(ts|tsx|rs)');
    expect(selection).toContain('TEST_FIXTURE_RE');
    // The exclusion is the fixtures tree, not all of tests/: specs and
    // helpers under tests/ are code a claim can sit in and stay scanned.
    const literal = lintSource.match(/const TEST_FIXTURE_RE = \/(.*)\/;$/m)?.[1] ?? '';
    expect(literal).not.toBe('');
    const fixtureRe = new RegExp(literal);
    expect(fixtureRe.test('tests/invariants/fixtures/tier-claim-rust/claim-vague.rs')).toBe(true);
    expect(fixtureRe.test('tests/fixtures/x.ts')).toBe(true);
    expect(fixtureRe.test('tests/invariants/tier-claim-rust-surface.spec.ts')).toBe(false);
    expect(fixtureRe.test('tests/e2e/helpers/login.ts')).toBe(false);
    expect(fixtureRe.test('apps/x/src/fixtures/seed.ts')).toBe(false);
    const stagedFn = lintSource.match(/function stagedFiles\(\)[\s\S]*?\n}/)?.[0] ?? '';
    const rangeFn = lintSource.match(/function rangeFiles\([\s\S]*?\n}/)?.[0] ?? '';
    expect(stagedFn).toContain('isProductCode');
    expect(rangeFn).toContain('isProductCode');
  });

  it('the enforcement domain covers the Rust roots for tier-4 gating', () => {
    const domain = lintSource.match(/const DOMAIN_CODE_RE = .*$/m)?.[0] ?? '';
    expect(domain).toContain('sens-api-gateway');
    expect(domain).toContain('crates');
    expect(domain).toContain('src');
  });

  it('the mechanism hint list names the Rust Tier-1/2/3 mechanisms', () => {
    const hints = lintSource.match(/MECHANISM_HINTS[\s\S]*?\];/)?.[0] ?? '';
    expect(hints).toContain('newtype');
    expect(hints).toContain('exhaustive\\s+match');
    expect(hints).toContain('non_exhaustive');
    // A named lint id, not the bare word.
    expect(hints).toContain('clippy::');
    expect(hints).not.toContain('/\\bclippy\\b/i');
    // The never-TYPE form only; a bare word-boundary `never` admits prose.
    expect(hints).not.toContain('/\\bnever\\b/i');
  });

  it('inline, begin and end claim patterns admit the Rust doc-comment forms', () => {
    for (const name of ['INLINE_RE', 'BEGIN_RE', 'END_RE']) {
      const decl = lintSource.match(new RegExp(`const ${name} = .*$`, 'm'))?.[0] ?? '';
      expect(decl).toContain('[/!]?');
    }
  });

  it('the SSoT table carries Rust examples per tier', () => {
    expect(ssoTDoc).toContain('newtype');
    expect(ssoTDoc).toContain('exhaustive `match`');
    expect(ssoTDoc).toContain('#[non_exhaustive]');
    expect(ssoTDoc).toContain('clippy `deny` wall');
  });

  it('root-cause-auditor cites the Rust knowledge file in its canonical refs', () => {
    expect(auditorDoc).toContain('.claude/knowledge/layer-1-rust.md');
  });

  describe('functional gate runs over a Rust fixture', () => {
    const runGate = (fixture: string): { status: number; out: string } => {
      try {
        const stdout = execFileSync(
          resolve(REPO_ROOT, 'node_modules', '.bin', 'ts-node'),
          [
            '--project',
            'tools/gates/tsconfig.json',
            'tools/gates/tier-claim-lint.ts',
            '--mode=file',
            fixture,
          ],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        return { status: 0, out: stdout };
      } catch (error) {
        const err = error as { status?: number; stdout?: string; stderr?: string };
        // report() writes violations to stderr; the pass line to stdout.
        return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    };

    it('accepts a Rust tier-1 claim naming concrete mechanisms', () => {
      const result = runGate('tests/invariants/fixtures/tier-claim-rust/claim-with-mechanism.rs');
      expect(result.status).toBe(0);
      expect(result.out).toMatch(/passed/i);
    });

    it('flags a Rust tier claim that names no mechanism (R7)', () => {
      const result = runGate('tests/invariants/fixtures/tier-claim-rust/claim-vague.rs');
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/R7-vague-claim/);
    });

    it('flags prose that only contains the word "never" (R7)', () => {
      const result = runGate('tests/invariants/fixtures/tier-claim-rust/claim-vague-never.rs');
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/R7-vague-claim/);
    });

    it('flags a bare "clippy" that names no lint (R7)', () => {
      const result = runGate('tests/invariants/fixtures/tier-claim-rust/claim-bare-clippy.rs');
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/R7-vague-claim/);
    });

    it('accepts a claim naming clippy lint ids', () => {
      const result = runGate('tests/invariants/fixtures/tier-claim-rust/claim-named-clippy.rs');
      expect(result.status).toBe(0);
      expect(result.out).toMatch(/passed/i);
    });

    it('scans a //! inner-doc module claim and flags it when vague (R7)', () => {
      const result = runGate('tests/invariants/fixtures/tier-claim-rust/claim-inner-doc-vague.rs');
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/R7-vague-claim/);
    });
  });
});
