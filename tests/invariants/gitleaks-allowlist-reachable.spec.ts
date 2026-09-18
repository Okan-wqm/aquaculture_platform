/**
 * INVARIANT: every gitleaks rule reports the VALUE as the secret, so its
 * value-based allowlist can actually match.
 *
 * ## The failure this exists to prevent
 *
 * `aquaculture-env-secret-assignment` matches `<VAR><separator><value>` with two
 * capture groups. Gitleaks reports capture group 1 as "the secret" unless the
 * rule declares `secretGroup`, and allowlist `regexes` are tested against THAT
 * reported secret. The rule declared no `secretGroup`, so its secret was the
 * variable NAME (`POSTGRES_PASSWORD`) while every allowlist entry underneath it
 * described a VALUE (`change-me`, `${…}`, `aquaculture-test`, `dummy`). Nothing
 * could ever match. The rule's entire placeholder allowlist was dead from the
 * day it was written.
 *
 * Nothing surfaced it because CI scans a diff, not the tree: the dead allowlist
 * is invisible until someone ADDS a line matching the pattern. The first one
 * that came along was a test-database password in a new CI job — the gate failed
 * on an obvious placeholder, reported the variable name as the leaked secret,
 * and offered no way to allowlist it. Two bad outcomes at once: an unactionable
 * report, and pressure to weaken the rule to get CI green.
 *
 * ## The rule enforced here
 *
 * If a rule's regex has more than one capture group, it must say which one is
 * the secret. Single-group (or group-less) rules are unambiguous and exempt.
 *
 * This is a config-only invariant — it needs no gitleaks binary and no network,
 * so it runs everywhere the rest of the invariant suite runs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'smol-toml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG = resolve(REPO_ROOT, '.gitleaks.toml');

interface GitleaksRule {
  readonly id?: unknown;
  readonly regex?: unknown;
  readonly secretGroup?: unknown;
}

/**
 * Count CAPTURING groups: `(` not followed by `?`, and not escaped. Good enough
 * for this config's rules, and deliberately conservative — a miscount can only
 * make the gate demand `secretGroup` on a rule that does not strictly need it,
 * never let an ambiguous rule through.
 */
function capturingGroups(pattern: string): number {
  let count = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') {
      i += 1;
      continue;
    }
    if (pattern[i] === '(' && pattern[i + 1] !== '?') count += 1;
  }
  return count;
}

function rules(): GitleaksRule[] {
  const parsed = parse(readFileSync(CONFIG, 'utf8')) as { rules?: unknown };
  return Array.isArray(parsed.rules) ? (parsed.rules as GitleaksRule[]) : [];
}

describe('INVARIANT: gitleaks allowlists are reachable', () => {
  const all = rules();

  it('reads a real ruleset (a parse change must not fake a pass)', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((rule) => rule.id === 'aquaculture-env-secret-assignment')).toBe(true);
  });

  it('declares secretGroup on every multi-group rule', () => {
    const offenders = all
      .filter((rule) => typeof rule.regex === 'string' && capturingGroups(rule.regex) > 1)
      .filter((rule) => typeof rule.secretGroup !== 'number')
      .map(
        (rule) =>
          `rule "${String(rule.id)}" has multiple capture groups but no secretGroup — ` +
          'gitleaks will report group 1 as the secret, so any allowlist regex written ' +
          'against the matched VALUE can never match and the rule becomes unallowlistable',
      );

    expect(offenders).toEqual([]);
  });

  it('points secretGroup at a group the regex actually has', () => {
    const offenders = all
      .filter((rule) => typeof rule.secretGroup === 'number' && typeof rule.regex === 'string')
      .filter((rule) => (rule.secretGroup as number) > capturingGroups(rule.regex as string))
      .map(
        (rule) =>
          `rule "${String(rule.id)}" sets secretGroup=${String(rule.secretGroup)} but its regex ` +
          `has only ${capturingGroups(rule.regex as string)} capture group(s) — gitleaks falls ` +
          'back to the full match, silently reverting to the unallowlistable behaviour',
      );

    expect(offenders).toEqual([]);
  });
});
