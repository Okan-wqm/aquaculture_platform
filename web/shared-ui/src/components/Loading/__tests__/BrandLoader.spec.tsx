/**
 * BrandLoader — the one loading screen (FE-MEDIUM-349): the Suderra mark
 * turning slowly over "Loading…", with a screen-reader status that says
 * what is loading. The boot splash in web/shell/index.html is the same
 * markup (web/shell/src/__tests__/bootSplash.spec.tsx holds them equal),
 * so the hand-off from the splash to React shows no swap; the mark's turn
 * also carries over (holdBootSplashTurn).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRAND } from '../../../config/brand';
import { I18nProvider } from '../../../i18n';
import { BrandLoader } from '../BrandLoader';
import { holdBootSplashTurn } from '../bootSplashTurn';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  // Forget any splash turn a test held.
  holdBootSplashTurn(document);
});

function renderIn(locale: 'tr' | 'en', node: React.ReactElement): HTMLElement {
  const { container } = render(<I18nProvider locale={locale}>{node}</I18nProvider>);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('BrandLoader renders one root element');
  return root;
}

describe('BrandLoader', () => {
  it('is a polite status whose announced name says what is loading', () => {
    const root = renderIn('en', <BrandLoader />);
    expect(root).toBe(screen.getByRole('status'));
    expect(root).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toHaveTextContent('Loading, please wait.');
  });

  it('shows "Loading…" beneath the mark, in the reader\'s language, hidden from the announcement', () => {
    for (const [locale, text] of [
      ['en', 'Loading…'],
      ['tr', 'Yükleniyor…'],
    ] as const) {
      const root = renderIn(locale, <BrandLoader />);
      const visible = root.querySelector('.brand-loader__text');
      expect(visible).toHaveTextContent(text);
      expect(visible).toHaveAttribute('aria-hidden', 'true');
      cleanup();
    }
  });

  it('a caller names the wait for screen readers; the visible text stays "Loading…"', () => {
    const root = renderIn('en', <BrandLoader label="Checking your session" />);
    expect(root.querySelector('.sr-only')).toHaveTextContent('Checking your session');
    expect(root.querySelector('.brand-loader__text')).toHaveTextContent('Loading…');
  });

  it('draws the brand mark, decorative, on its plate, at a fixed size so nothing shifts as it loads', () => {
    const mark = renderIn('en', <BrandLoader />).querySelector('img');
    expect(mark?.parentElement).toHaveClass('brand-loader__plate');
    expect(mark).toHaveClass('brand-loader__mark');
    expect(mark).toHaveAttribute('src', BRAND.mark);
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveAttribute('width', '72');
    expect(mark).toHaveAttribute('height', '60');
  });

  it('fills the viewport as `screen` and the area it is placed in as `region` (the default)', () => {
    expect(renderIn('en', <BrandLoader />)).toHaveClass('brand-loader', 'brand-loader--region');
    cleanup();
    expect(renderIn('en', <BrandLoader variant="screen" />)).toHaveClass(
      'brand-loader',
      'brand-loader--screen',
    );
  });

  it("continues the boot splash's turn instead of starting it over", () => {
    // The splash React is about to replace: its mark has turned since start time 1234.
    const splash = document.createElement('div');
    splash.innerHTML = '<img class="brand-loader__mark" alt="" />';
    document.body.append(splash);
    const splashTurn = { startTime: 1234 };
    const loaderTurn = { startTime: 9876 };
    const getAnimations = vi.fn<() => Array<{ startTime: number }>>();
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: getAnimations,
    });
    getAnimations.mockReturnValueOnce([splashTurn]);
    holdBootSplashTurn(document);
    splash.remove();

    getAnimations.mockReturnValue([loaderTurn]);
    renderIn('en', <BrandLoader variant="screen" />);
    expect(loaderTurn.startTime).toBe(1234);
    Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  });

  it('without a splash to continue, keeps its own turn', async () => {
    // A fresh module instance holds no turn at all, so nothing an earlier case left in
    // bootSplashTurn's module state can stand in for "there was no splash".
    vi.resetModules();
    const [{ BrandLoader: FreshLoader }, { I18nProvider: FreshI18n }, fresh] = await Promise.all([
      import('../BrandLoader'),
      import('../../../i18n'),
      import('../bootSplashTurn'),
    ]);
    const loaderTurn = { startTime: 9876 };
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: () => [loaderTurn],
    });
    fresh.holdBootSplashTurn(document);
    render(
      <FreshI18n locale="en">
        <FreshLoader />
      </FreshI18n>,
    );
    expect(loaderTurn.startTime).toBe(9876);
    Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  });

  it('drops a turn held from an earlier splash once there is no splash to hold', () => {
    // Held first, in this case, so the outcome does not depend on what ran before it.
    const splash = document.createElement('div');
    splash.innerHTML = '<img class="brand-loader__mark" alt="" />';
    document.body.append(splash);
    const loaderTurn = { startTime: 9876 };
    const getAnimations = vi.fn<() => Array<{ startTime: number }>>();
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: getAnimations,
    });
    getAnimations.mockReturnValueOnce([{ startTime: 1234 }]);
    holdBootSplashTurn(document);
    splash.remove();
    holdBootSplashTurn(document);

    getAnimations.mockReturnValue([loaderTurn]);
    renderIn('en', <BrandLoader />);
    expect(loaderTurn.startTime).toBe(9876);
    Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  });
});
