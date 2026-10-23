/**
 * The boot splash is the BrandLoader before React (FE-MEDIUM-349).
 *
 * index.html paints the splash before any bundle loads; React's first
 * loader (the session check) replaces it. They are one visual only while
 * they are one markup and one stylesheet: this spec renders shared-ui's
 * BrandLoader as the session check does (full screen, Turkish — index.html
 * is `lang="tr"`) and holds the splash to it element by element, and holds
 * the loader stylesheet in index.html to the owner's decision: the mark
 * turns slowly and steadily, and under reduced motion it only fades.
 *
 * It also holds the splash to one theme from first paint to hand-off. The
 * console tokens arrive with the design system's stylesheet, in light values
 * until `data-theme` says otherwise; a splash that read them before the theme
 * was applied went dark → light → dark for a dark-OS user. So the splash reads
 * them only under `:root[data-theme]`, and the entry (main.tsx) applies the
 * theme before it imports the bootstrap chunk that requests the stylesheet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BrandLoader, I18nProvider } from '@aquaculture/shared-ui';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const INDEX_HTML = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const BOOT_DOCUMENT = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
const STYLE = [...BOOT_DOCUMENT.querySelectorAll('head style')]
  .map((style) => style.textContent ?? '')
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** An element as the comparison reads it: tag, sorted classes, the attributes that shape it, own text. */
interface Shape {
  readonly tag: string;
  readonly classes: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string;
  readonly children: readonly Shape[];
}

const COMPARED = ['role', 'aria-live', 'aria-hidden', 'src', 'alt', 'width', 'height'];

function shape(element: Element): Shape {
  const attributes: Record<string, string> = {};
  for (const name of COMPARED) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value;
  }
  return {
    tag: element.tagName.toLowerCase(),
    classes: [...element.classList].sort().join(' '),
    attributes,
    text: [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim(),
    children: [...element.children].map(shape),
  };
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string, css = STYLE): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^{}]*)\\}`).exec(css)?.[1];
  if (body === undefined) throw new Error(`index.html has no \`${selector}\` rule`);
  return body;
}

/** The body of the at-rule that starts with `prelude` (`@media …`, `@keyframes …`). */
function atRule(prelude: string): string {
  const start = STYLE.indexOf(prelude);
  if (start < 0) throw new Error(`index.html has no ${prelude} block`);
  const open = STYLE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < STYLE.length; i += 1) {
    if (STYLE[i] === '{') depth += 1;
    if (STYLE[i] === '}') depth -= 1;
    if (depth === 0) return STYLE.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${prelude} block`);
}

describe('index.html boot splash (FE-MEDIUM-349)', () => {
  it('is the BrandLoader the session check renders, element by element', () => {
    const splash = BOOT_DOCUMENT.querySelector('#root')?.firstElementChild;
    if (!splash) throw new Error('index.html #root holds no splash');
    expect(BOOT_DOCUMENT.querySelector('#root')?.children).toHaveLength(1);

    const { container } = render(
      <I18nProvider locale="tr">
        <BrandLoader variant="screen" />
      </I18nProvider>,
    );
    const loader = container.firstElementChild;
    if (!loader) throw new Error('BrandLoader renders nothing');
    expect(shape(splash)).toEqual(shape(loader));
  });

  it('turns the mark slowly and smoothly: one linear turn every 1.6–2 s, forever', () => {
    const mark = rule('.brand-loader__mark');
    const animation = /animation:\s*brand-loader-turn\s+([\d.]+)s\s+linear\s+infinite;/.exec(mark);
    expect(animation).not.toBeNull();
    const seconds = Number(animation?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(1.6);
    expect(seconds).toBeLessThanOrEqual(2);
    expect(rule('to', atRule('@keyframes brand-loader-turn'))).toMatch(
      /transform:\s*rotate\(360deg\)/,
    );
  });

  it('under reduced motion the mark does not turn: it only fades gently', () => {
    const reduced = atRule('@media (prefers-reduced-motion: reduce)');
    const mark = rule('.brand-loader__mark', reduced);
    expect(mark).toMatch(/animation:\s*brand-loader-breathe\s/);
    const keyframes = atRule('@keyframes brand-loader-breathe');
    expect(keyframes).toMatch(/opacity:\s*0\.\d+/);
    expect(keyframes).not.toMatch(/transform|rotate|scale|translate/);
  });

  it('paints from the console tokens once the theme is resolved, from the generated copy before', () => {
    // Before `data-theme` is on <html>: the generated copy only.
    expect(rule('.brand-loader--screen')).toMatch(/background:\s*var\(--brand-loader-ground\);/);
    expect(rule('.brand-loader')).toMatch(/color:\s*var\(--brand-loader-ink\);/);
    // Once the shell has resolved the theme: the console tokens, the copy standing in until they load.
    expect(rule(':root[data-theme] .brand-loader--screen')).toMatch(
      /background:\s*var\(--color-sd-paper,\s*var\(--brand-loader-ground\)\);/,
    );
    expect(rule(':root[data-theme] .brand-loader')).toMatch(
      /color:\s*var\(--color-sd-ink-muted,\s*var\(--brand-loader-ink\)\);/,
    );
    // The resolved theme, once the shell has set it, decides; before that, the OS scheme.
    expect(rule(":root[data-theme='dark']")).toMatch(/--brand-loader-ground:/);
    expect(rule(':root:not([data-theme])', atRule('@media (prefers-color-scheme: dark)'))).toMatch(
      /--brand-loader-ground:/,
    );
  });

  it('reads no console token before the theme is resolved, so their light values cannot flash', () => {
    // Every rule that names a design-system token is scoped to a resolved theme. The tokens
    // arrive in light values until `data-theme` picks one; unscoped, they repainted a dark-OS
    // user's splash light between the stylesheet and the theme.
    const unscoped = [...STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector = '', body = '']) => ({ selector: selector.trim(), body }))
      .filter(({ body }) => /var\(--(?!brand-loader-)/.test(body))
      .filter(({ selector }) => !selector.startsWith(':root[data-theme] '))
      .map(({ selector }) => selector);
    expect(unscoped).toEqual([]);
  });

  it('keeps the screen-reader label off screen and the page edge where React leaves it', () => {
    expect(rule('.brand-loader .sr-only')).toMatch(/position:\s*absolute;/);
    expect(rule('.brand-loader .sr-only')).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\);/);
    // Tailwind's preflight zeroes the body margin once the bundle loads; the splash already has.
    expect(rule('body')).toMatch(/margin:\s*0;/);
  });
});

describe('the entry applies the theme before it loads the bootstrap chunk (FE-MEDIUM-349)', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.doUnmock('../bootstrap');
    vi.doUnmock('../utils/remoteIntegrity');
    vi.resetModules();
    const root = document.documentElement;
    delete root.dataset.theme;
    delete root.dataset.themePreference;
    root.style.colorScheme = '';
  });

  it("puts a dark-OS user's theme on <html> before the stylesheet is requested", async () => {
    // Importing the bootstrap chunk is what requests the design system's stylesheet.
    const atBootstrap: Array<string | undefined> = [];
    vi.resetModules();
    vi.doMock('../utils/remoteIntegrity', () => ({ installRemoteIntegrityGuard: vi.fn() }));
    vi.doMock('../bootstrap', () => {
      atBootstrap.push(document.documentElement.dataset.theme);
      return {};
    });
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      }) satisfies MediaQueryList;

    await import('../main');
    await vi.waitFor(() => expect(atBootstrap).toEqual(['dark']));
  });
});
