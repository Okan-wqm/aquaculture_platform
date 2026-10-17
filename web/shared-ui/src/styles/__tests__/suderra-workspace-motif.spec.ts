/**
 * The tenant console's workspace motif (suderra.css, FE-MEDIUM-348).
 *
 * Switching the workspace (`data-ws` on <html>, written by the shell's
 * useFollowedWorkspace) swaps the static motif behind the console column:
 * reef fish for Production, hydroponic channels and leaves for Greenhouse,
 * circuit and P&ID lines for Control & sensors, and none for Company, which
 * keeps the plain engineering grid. The layer is decoration: it exists only
 * under the tenant console's column (`.sd-content`, which the SUPER_ADMIN
 * console and the auth pages never render), takes no input, sits under every
 * child, never moves and is not printed.
 *
 * jsdom does not cascade a stylesheet into pseudo-elements, so the spec reads
 * the motif rules from suderra.css and matches each rule's element part
 * against the DOM, the way suderra-dialog-scope.spec.tsx reads the scope.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const STYLES = resolve(__dirname, '..');
const RULES = [
  ...readFileSync(resolve(STYLES, 'suderra.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map(([, selector = '', body = '']) => ({
  selector: selector.replace(/\s+/g, ' ').trim(),
  body,
}));

const PSEUDO = '::after';
/** The rules that put a motif on the column's ::after, by the file they mask with. */
const MOTIF_RULES = RULES.filter(
  ({ selector, body }) => selector.endsWith(`.sd-content${PSEUDO}`) && /mask-image:/.test(body),
);

function declared(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

/** The motif file the column shows now, or undefined when no motif rule matches it. */
function motifOf(column: Element): string | undefined {
  const rule = MOTIF_RULES.find(({ selector }) =>
    column.matches(selector.slice(0, -PSEUDO.length)),
  );
  return rule === undefined ? undefined : /url\('([^']+)'\)/.exec(rule.body)?.[1];
}

function mountColumn(): HTMLElement {
  const column = document.createElement('div');
  column.className = 'sd-content';
  document.body.append(column);
  return column;
}

afterEach(() => {
  delete document.documentElement.dataset.ws;
  document.body.replaceChildren();
});

describe('suderra.css — the workspace motif (FE-MEDIUM-348)', () => {
  it('switching data-ws on <html> swaps the motif under the console column', () => {
    const column = mountColumn();
    const shown: Array<string | undefined> = [];
    for (const ws of ['aqua', 'gh', 'ctl', 'org']) {
      document.documentElement.dataset.ws = ws;
      shown.push(motifOf(column));
    }
    expect(shown).toEqual(['./motifs/aqua.svg', './motifs/gh.svg', './motifs/ctl.svg', undefined]);
  });

  it('draws nothing where no workspace is set — the SUPER_ADMIN console and the auth pages', () => {
    expect(motifOf(mountColumn())).toBeUndefined();
    // Every motif rule needs the tenant console's column, so a page without it fetches no motif.
    for (const { selector } of MOTIF_RULES) expect(selector).toMatch(/ \.sd-content::after$/);
    expect(MOTIF_RULES.length).toBe(3);
  });

  it('the layer is decoration: under every child, no input, fixed to the viewport', () => {
    const base = RULES.find(({ selector }) => selector === `.sd-content${PSEUDO}`);
    expect(base).toBeDefined();
    const body = base?.body ?? '';
    expect(declared(body, 'pointer-events')).toBe('none');
    expect(declared(body, 'z-index')).toBe('-1');
    expect(declared(body, 'position')).toBe('fixed');
    // The workspace accent at the theme's motif opacity: tokens, never a value of its own.
    expect(declared(body, 'background-color')).toBe('var(--color-sd-accent)');
    expect(declared(body, 'opacity')).toBe('var(--sd-motif-opacity)');
    // No box until a workspace rule gives it content: Company and no-workspace stay bare.
    expect(declared(body, 'content')).toBeUndefined();
    for (const { body: motif } of MOTIF_RULES) expect(declared(motif, 'content')).toBe("''");
  });

  it('is static: no animation or transition on the layer, under any motion preference', () => {
    const layer = RULES.filter(({ selector }) => selector.includes(`.sd-content${PSEUDO}`));
    expect(layer.length).toBeGreaterThan(MOTIF_RULES.length);
    for (const { selector, body } of layer)
      expect({ selector, moves: /\b(?:animation|transition)\b/.test(body) }).toEqual({
        selector,
        moves: false,
      });
  });

  it('is not printed', () => {
    const css = readFileSync(resolve(STYLES, 'suderra.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const print = /@media print\s*\{([\s\S]*?\}\s*)\}/.exec(css)?.[1] ?? '';
    expect(print).toMatch(/\.sd-content::after/);
    expect(print).toMatch(/display:\s*none;/);
  });

  it('each motif file is a static, colourless mask the size its rule tiles it at', () => {
    for (const { selector, body } of MOTIF_RULES) {
      const file = /url\('([^']+)'\)/.exec(body)?.[1] ?? '';
      const svg = readFileSync(resolve(STYLES, file), 'utf8');
      const at = `${selector} → ${file}`;
      // A mask reads coverage only; a colour here would be a second palette.
      expect({ at, colour: /(?<!href=")#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(svg) }).toEqual({
        at,
        colour: false,
      });
      const paints = [...svg.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)].map(([, v]) => v);
      expect({ at, paints: paints.filter((v) => v !== 'currentColor' && v !== 'none') }).toEqual({
        at,
        paints: [],
      });
      // Static: no SMIL, script or stylesheet that could move or restyle it.
      expect({ at, moving: /<(?:animate\w*|set|script|style)\b|animation/.test(svg) }).toEqual({
        at,
        moving: false,
      });
      const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      expect({ at, size: declared(body, 'mask-size') }).toEqual({
        at,
        size: `${viewBox?.[1]}px ${viewBox?.[2]}px`,
      });
    }
  });
});
