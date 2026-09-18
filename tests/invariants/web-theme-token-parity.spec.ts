/**
 * INVARIANT (FE-HIGH-066): the TypeScript colour tokens mirror theme.css.
 *
 * ## Two records of one palette
 *
 * `web/shared-ui/src/styles/theme.css` is the design system's single source
 * of truth for colour: shell and every federated remote import it, and every
 * `bg-primary-*` / `text-error-*` utility resolves from its `@theme` block.
 * CSS classes cannot reach everywhere, though — chart libraries take stroke
 * and fill as strings, gauges draw on SVG, and a default role colour has to be
 * a value. Those places need the same palette as TypeScript, which is what
 * `colors` in `web/shared-ui/src/styles/theme.ts` is for.
 *
 * Before this gate, `theme.ts` carried a *different* palette (an Ant-Design
 * blue as "brand", a different grey scale) that nothing consumed, while every
 * chart wrote raw hex instead — 2 136 occurrences outside theme.css. A second
 * palette that can drift is worse than none: a chart that "uses the tokens"
 * would silently render the wrong brand.
 *
 * ## The rule
 *
 * Every `--color-<scale>-<step>` token in theme.css exists in `colors` with
 * the same value, and every scale/step in `colors` exists in theme.css — so
 * the raw-hex ratchet (`web-design-system-ratchet.spec.ts`) can send chart
 * colours to `colors` knowing they ARE the theme.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { colors } from '../../web/shared-ui/src/styles/theme';

const REPO_ROOT = resolve(__dirname, '../..');
const THEME_CSS = 'web/shared-ui/src/styles/theme.css';

const TOKEN = /--color-([a-z]+)-(\d+):\s*(#[0-9a-fA-F]{6})\s*;/g;

function cssTokens(): Map<string, string> {
  const css = readFileSync(resolve(REPO_ROOT, THEME_CSS), 'utf8');
  const tokens = new Map<string, string>();
  for (const [, scale, step, value] of css.matchAll(TOKEN)) {
    if (scale === undefined || step === undefined || value === undefined) continue;
    tokens.set(`${scale}-${step}`, value.toLowerCase());
  }
  return tokens;
}

function tsTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [scale, steps] of Object.entries(colors)) {
    if (typeof steps === 'string') continue; // white / black / transparent
    const scaleSteps: Readonly<Record<number, string>> = steps;
    for (const [step, value] of Object.entries(scaleSteps)) {
      tokens.set(`${scale}-${step}`, value.toLowerCase());
    }
  }
  return tokens;
}

describe('INVARIANT (FE-HIGH-066): TypeScript colour tokens mirror theme.css', () => {
  const css = cssTokens();
  const ts = tsTokens();

  it('reads the theme', () => {
    // A regex or path slip would otherwise make the comparisons vacuous.
    expect(css.size).toBeGreaterThan(50);
    expect(css.get('primary-500')).toBe('#0073e6');
  });

  it('every theme.css colour token exists in `colors` with the same value', () => {
    const drift = [...css]
      .filter(([name, value]) => ts.get(name) !== value)
      .map(([name, value]) => `${name}: css ${value} vs ts ${ts.get(name) ?? '(missing)'}`);
    expect(drift).toEqual([]);
  });

  it('`colors` declares nothing theme.css does not have', () => {
    const orphans = [...ts.keys()].filter((name) => !css.has(name)).sort();
    expect(orphans).toEqual([]);
  });
});
