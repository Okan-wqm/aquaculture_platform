import { safeRegex, validateRegexPattern } from '../safe-regex';

describe('safeRegex (SEC-LOW-066 — 2026-08-23 scan №11)', () => {
  it('compiles and caches a safe pattern', () => {
    const a = safeRegex('^10\\.0\\.');
    const b = safeRegex('^10\\.0\\.');
    expect(a).not.toBeNull();
    expect(a!.test('10.0.0.1')).toBe(true);
    expect(b).toBe(a);
  });

  it('supports validated flags (case-insensitive message filters)', () => {
    const re = safeRegex('error', 'i');
    expect(re).not.toBeNull();
    expect(re!.test('ErRoR happened')).toBe(true);
  });

  it('rejects catastrophic-backtracking shapes (fail closed -> null)', () => {
    expect(safeRegex('(a+)+$')).toBeNull();
    expect(safeRegex('(a*)*b')).toBeNull();
  });

  it('rejects overlong patterns and invalid regexes', () => {
    expect(safeRegex('a'.repeat(201))).toBeNull();
    expect(safeRegex('[unclosed')).toBeNull();
  });

  it('rejects invalid flag sets', () => {
    expect(validateRegexPattern('a', 'z')).toContain('Flags');
    expect(safeRegex('a', 'z')).toBeNull();
  });
});
