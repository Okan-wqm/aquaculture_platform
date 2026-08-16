import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'smol-toml';

const CONFIG = resolve(process.cwd(), '.gitleaks.toml');

interface GitleaksRule {
  readonly id?: unknown;
  readonly regex?: unknown;
  readonly secretGroup?: unknown;
}

/** Count unescaped capturing groups; non-capturing/lookaround groups start `(?`. */
function capturingGroups(pattern: string): number {
  let count = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      index += 1;
      continue;
    }
    if (pattern[index] === '(' && pattern[index + 1] !== '?') count += 1;
  }
  return count;
}

function configuredRules(): GitleaksRule[] {
  const parsed: unknown = parse(readFileSync(CONFIG, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('rules' in parsed)) return [];
  const rules = parsed.rules;
  return Array.isArray(rules) ? rules : [];
}

describe('INVARIANT: gitleaks value allowlists are reachable', () => {
  const rules = configuredRules();

  it('loads the platform rule set non-vacuously', () => {
    expect(rules.some((rule) => rule.id === 'aquaculture-env-secret-assignment')).toBe(true);
  });

  it('declares a valid secretGroup for every multi-capture rule', () => {
    const offenders = rules.flatMap((rule) => {
      if (typeof rule.regex !== 'string') return [];
      const groupCount = capturingGroups(rule.regex);
      if (groupCount <= 1) return [];
      if (
        typeof rule.secretGroup === 'number' &&
        Number.isInteger(rule.secretGroup) &&
        rule.secretGroup >= 1 &&
        rule.secretGroup <= groupCount
      ) {
        return [];
      }
      return [
        `rule ${String(rule.id)} has ${groupCount} capture groups but secretGroup=${String(
          rule.secretGroup,
        )}`,
      ];
    });

    expect(offenders).toEqual([]);
  });
});
