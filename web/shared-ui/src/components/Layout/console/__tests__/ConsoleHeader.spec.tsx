/**
 * ConsoleHeader — the tenant console's sticky top bar (README §7.4).
 *
 * Left: the eyebrow "Workspace · Area" over the page title (the page's h1).
 * Middle: the command-palette trigger, a blueprint-framed button that only
 * asks the shell to open the palette. Right: the title block, the shell's
 * right-hand content (notifications, AI) and the user menu, in that order.
 * The annunciator slot sits under the row, inside the same sticky header.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../../i18n';
import { ConsoleHeader } from '../ConsoleHeader';

const BASE = {
  workspaceLabel: 'Production',
  areaLabel: 'Operations',
  title: 'Environment',
  onOpenPalette: (): void => undefined,
};

const realUserAgent = navigator.userAgent;
function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}
afterEach(() => setUserAgent(realUserAgent));

describe('ConsoleHeader — heading', () => {
  it('renders the page title as the h1 and the eyebrow as "Workspace · Area"', () => {
    render(<ConsoleHeader {...BASE} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Environment' })).toBeInTheDocument();
    expect(screen.getByText('Production · Operations')).toBeInTheDocument();
  });

  it('shows the workspace alone when there is no area, or the area repeats it', () => {
    const { rerender } = render(<ConsoleHeader {...BASE} areaLabel={undefined} />);
    expect(screen.getByText('Production')).toBeInTheDocument();
    rerender(<ConsoleHeader {...BASE} areaLabel="Production" />);
    expect(screen.queryByText('Production · Production')).not.toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
  });

  it('is a sticky banner above the page', () => {
    render(<ConsoleHeader {...BASE} />);
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('sticky', 'top-0', 'z-30');
  });

  // Wrapped, with its 2x2 annunciator, the header was 324px tall on a phone
  // and taller than a 320x256 viewport (WCAG 1.4.10); stuck, it hid the
  // control Tab moved to (2.4.11). Where it does not fit it scrolls with the
  // page — still positioned, so the header-gutter panels hang from it.
  it('scrolls with the page on a narrow console or a short viewport', () => {
    render(<ConsoleHeader {...BASE} />);
    expect(screen.getByRole('banner')).toHaveClass(
      '@max-[821px]/page:relative',
      '[@media(max-height:500px)]:relative',
    );
  });
});

/**
 * The document's scroll padding is the header's height while it sticks
 * (suderra.css reads `--sd-header-sticky-h`), so focus scrolling stops below
 * it; 0 while it scrolls with the page, and gone with the header.
 */
describe('ConsoleHeader — sticky offset', () => {
  const root = document.documentElement;
  const offset = (): string => root.style.getPropertyValue('--sd-header-sticky-h');

  function layOut(header: HTMLElement, position: string, height: number): void {
    header.style.position = position;
    header.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 1024, height);
    window.dispatchEvent(new Event('resize'));
  }

  it('publishes the height while the header sticks, 0 while it scrolls, nothing once gone', () => {
    const { unmount } = render(<ConsoleHeader {...BASE} />);
    const header = screen.getByRole('banner');

    layOut(header, 'sticky', 180.4);
    expect(offset()).toBe('181px');

    layOut(header, 'relative', 324);
    expect(offset()).toBe('0px');

    unmount();
    expect(offset()).toBe('');
  });
});

describe('ConsoleHeader — command palette trigger', () => {
  it('names the palette, reports its shortcut and asks the shell to open it', async () => {
    const onOpenPalette = vi.fn();
    render(<ConsoleHeader {...BASE} onOpenPalette={onOpenPalette} paletteOpen={false} />);

    const trigger = screen.getByRole('button', {
      name: 'Type a page, person, device or command…',
    });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveClass('sd-corners');

    await userEvent.click(trigger);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('shows ⌘ K on Apple platforms and Ctrl K elsewhere, as hidden key caps', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)');
    const { unmount } = render(<ConsoleHeader {...BASE} />);
    let trigger = screen.getByRole('button', { name: /Type a page/ });
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    expect(within(trigger).getByText('⌘')).toBeInTheDocument();
    unmount();

    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    render(<ConsoleHeader {...BASE} />);
    trigger = screen.getByRole('button', { name: /Type a page/ });
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    const keys = within(trigger).getByText('Ctrl').parentElement as HTMLElement;
    expect(keys).toHaveAttribute('aria-hidden', 'true');
    expect(keys).toHaveTextContent('CtrlK');
  });

  it('reports an open palette through aria-expanded', () => {
    render(<ConsoleHeader {...BASE} paletteOpen />);
    expect(screen.getByRole('button', { name: /Type a page/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('ConsoleHeader — slots', () => {
  it('lays out title block, right content and user menu after the trigger, in that order', () => {
    render(
      <ConsoleHeader
        {...BASE}
        titleBlock={<div>title-block</div>}
        rightContent={<button type="button">bell</button>}
        userMenu={<button type="button">user</button>}
        annunciator={<div>annunciator</div>}
      />,
    );
    const order = ['Type a page', 'title-block', 'bell', 'user', 'annunciator'].map((text) =>
      screen.getByText(new RegExp(text)),
    );
    for (let index = 1; index < order.length; index += 1) {
      const before = order[index - 1] as HTMLElement;
      const after = order[index] as HTMLElement;
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The annunciator sticks with the bar: it is inside the same banner.
    expect(within(screen.getByRole('banner')).getByText('annunciator')).toBeInTheDocument();
  });

  // One gutter for the row and for the user menu's panel, which hangs from
  // this sticky (positioned) header where the row wraps.
  it('defines the row gutter on the header, which the row pads with', () => {
    render(<ConsoleHeader {...BASE} />);
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('sticky', '[--sd-header-gutter:clamp(14px,2.4cqi,40px)]');
    expect(header.firstElementChild).toHaveClass('px-(--sd-header-gutter)');
  });

  // WCAG 2.4.3: where the row wraps it keeps the source order, so Tab runs
  // down the lines as drawn — heading, palette trigger, tools, user menu. The
  // trigger once drew last (`order`) while it was focused second.
  it('wraps in source order: no item is moved with `order`, the tools keep right', () => {
    render(
      <ConsoleHeader
        {...BASE}
        rightContent={<button type="button">bell</button>}
        userMenu={<button type="button">user</button>}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    const trigger = screen.getByRole('button', { name: /Type a page/ });
    const bell = screen.getByRole('button', { name: 'bell' });
    const user = screen.getByRole('button', { name: 'user' });
    for (const [before, after] of [
      [heading, trigger],
      [trigger, bell],
      [bell, user],
    ] as const)
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const row = screen.getByRole('banner').firstElementChild as HTMLElement;
    for (const item of row.querySelectorAll('*'))
      expect(item.getAttribute('class') ?? '').not.toMatch(/(^|\s|:)order-/);
    // Beside the heading where both fit, a line of its own where they do not.
    expect(trigger).toHaveClass('@max-[821px]/page:flex-[1_1_240px]');
    expect(bell.closest('.\\@max-\\[821px\\]\\/page\\:ml-auto')).toContainElement(user);
  });

  it('puts the phone navigation toggle first in the row, before the heading', () => {
    render(<ConsoleHeader {...BASE} navToggle={<button type="button">Open navigation</button>} />);
    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Open navigation' }),
    ).toBe(toggle);
    expect(toggle.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ConsoleHeader — Turkish', () => {
  it('speaks the active locale', () => {
    render(
      <I18nProvider locale="tr">
        <ConsoleHeader {...BASE} workspaceLabel="Üretim" areaLabel="Operasyon" title="Ortam" />
      </I18nProvider>,
    );
    expect(screen.getByText('Üretim · Operasyon')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sayfa, kişi, cihaz veya komut yazın…' }),
    ).toBeInTheDocument();
  });
});
