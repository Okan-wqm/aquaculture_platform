import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  SeverityBadge,
  normalizeSeverity,
  severityClasses,
  severityColor,
  SEVERITIES,
  type SeverityTone,
} from '../Severity';
import { colors } from '../../../styles/theme';

const TONES: readonly SeverityTone[] = ['solid', 'soft', 'row', 'bar', 'text'];

/**
 * What a class list paints inside the tenant console's token scope
 * (suderra.css), per theme: property → the theme.css token it resolves to.
 *
 * WHY resolve instead of comparing class names: the scope re-assigns `accent`
 * and `warning` to the same hazard-amber ramp (README §7.5 has one amber), so
 * `bg-accent-100` and `bg-warning-100` are different classes that paint the
 * same colour there. Only the resolved token says whether two levels can be
 * told apart on screen.
 */
const SCOPE_RULES = [
  ...readFileSync(resolve(__dirname, '../../../styles/suderra.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map(([, selector = '', body = '']) => ({ selector: selector.trim(), body }));

function assignments(body: string): Map<string, string> {
  return new Map(
    [...body.matchAll(/--color-([\w-]+):\s*var\(--color-([\w-]+)\)/g)].map(
      ([, name = '', token = '']): [string, string] => [name, token],
    ),
  );
}

function scopeRule(test: (rule: { selector: string; body: string }) => boolean): string {
  const rule = SCOPE_RULES.find(test);
  if (rule === undefined) throw new Error('suderra.css lost a scope rule this spec reads');
  return rule.body;
}

const LIGHT_SCOPE = assignments(
  scopeRule(({ body }) => body.includes('--color-white: var(--color-sd-cream);')),
);
const DARK_SCOPE = new Map([
  ...LIGHT_SCOPE,
  ...assignments(
    scopeRule(
      ({ selector, body }) =>
        selector.startsWith("[data-theme='dark']") && body.includes('--color-gray-900:'),
    ),
  ),
]);

const COLOUR_UTILITY = /^(dark:)?(bg|text|border-l|border)-([a-z]+(?:-\d+)?)(?:\/(\d+))?$/;
const NOT_A_COLOUR = new Set(['xs', 'sm', 'base', 'lg', 'xl', 'left', 'center', 'right']);

function paint(classes: string, theme: 'light' | 'dark'): Record<string, string> {
  const scope = theme === 'dark' ? DARK_SCOPE : LIGHT_SCOPE;
  const painted: Record<string, string> = {};
  // The base classes first, then (dark only) the `dark:` siblings that override them.
  for (const darkPass of theme === 'dark' ? [false, true] : [false]) {
    for (const utility of classes.split(/\s+/)) {
      const match = COLOUR_UTILITY.exec(utility);
      if (match === null) continue;
      const [, dark, property = '', colour = '', alpha] = match;
      if (Boolean(dark) !== darkPass || NOT_A_COLOUR.has(colour)) continue;
      const token = scope.get(colour) ?? colour;
      painted[property] = alpha === undefined ? token : `${token}/${alpha}`;
    }
  }
  return painted;
}

/** A theme.css token's light value (the @theme block, the first declaration). */
function lightValue(token: string): string {
  const css = readFileSync(resolve(__dirname, '../../../styles/theme.css'), 'utf8');
  const value = new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
  if (value === undefined) throw new Error(`theme.css has no --color-${token}`);
  return value.toLowerCase();
}

describe('Severity', () => {
  it('normalises the three historical vocabularies onto one', () => {
    expect(normalizeSeverity('EMERGENCY')).toBe('critical');
    expect(normalizeSeverity('CRITICAL')).toBe('critical');
    expect(normalizeSeverity('Warning')).toBe('warning');
    expect(normalizeSeverity('medium')).toBe('medium');
    expect(normalizeSeverity('low')).toBe('low');
    expect(normalizeSeverity(undefined)).toBe('info');
    expect(normalizeSeverity('anything-else')).toBe('info');
  });

  it('every severity has every tone, painted from the theme scales, never a raw hue', () => {
    for (const severity of SEVERITIES) {
      for (const tone of TONES) {
        const classes = severityClasses(severity, tone);
        expect(classes.length).toBeGreaterThan(0);
        expect(classes).not.toMatch(/-(?:red|orange|amber|yellow|blue|green)-\d/);
      }
    }
    expect(severityColor('critical').bg).toBe(colors.error[600]);
    expect(severityColor('info').bg).toBe(colors.neutral[500]);
  });

  it('the badge carries name and colour together', () => {
    render(<SeverityBadge severity="EMERGENCY" tone="solid" />);
    const badge = screen.getByText('Critical');
    expect(badge.getAttribute('data-severity')).toBe('critical');
    expect(badge.className).toContain('bg-error-600');
  });

  describe('inside the console scope, where high and medium share the hazard amber', () => {
    it('reads both scope rules it resolves through', () => {
      expect(LIGHT_SCOPE.get('accent-400')).toBe('sd-amber-400');
      expect(LIGHT_SCOPE.get('warning-400')).toBe('sd-amber-400');
      expect(DARK_SCOPE.get('gray-900')).toBe('sd-deep-900');
    });

    it.each(TONES)('high and medium/warning paint differently in the %s tone', (tone) => {
      for (const theme of ['light', 'dark'] as const) {
        const high = paint(severityClasses('high', tone), theme);
        expect(Object.keys(high).length).toBeGreaterThan(0);
        for (const lower of ['medium', 'warning'] as const) {
          expect({
            theme,
            tone,
            lower,
            paint: paint(severityClasses(lower, tone), theme),
          }).not.toEqual({ theme, tone, lower, paint: high });
        }
      }
    });

    it('high is the filled HIGH tile (hazard amber, ink text) in both themes; medium is a surface with amber ink (README §7.5)', () => {
      expect(lightValue('sd-amber-400')).toBe(lightValue('sd-hz-amber'));
      expect(lightValue('sd-amber-700')).toBe(lightValue('sd-hz-amber-ink'));
      for (const theme of ['light', 'dark'] as const) {
        expect(paint(severityClasses('high', 'soft'), theme)).toMatchObject({
          bg: 'sd-amber-400',
          text: theme === 'light' ? 'sd-ink-900' : 'sd-deep-900',
        });
        expect(paint(severityClasses('medium', 'soft'), theme)).toMatchObject({
          bg: 'transparent',
          // amber-300 is the dark theme's --color-sd-hz-amber-ink (theme.css)
          text: theme === 'light' ? 'sd-amber-700' : 'sd-amber-300',
        });
      }
    });
  });
});
