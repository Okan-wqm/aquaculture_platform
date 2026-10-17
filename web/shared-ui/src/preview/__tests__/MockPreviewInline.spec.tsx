/**
 * MockPreview, inline — the MOCK chip beside a single value (FE-MEDIUM-337).
 *
 * The chip is a button described by its tooltip (reason, finding, "sample
 * data"), so the description reaches assistive technology whether or not the
 * tooltip shows. The tooltip follows WCAG 1.4.13: a hover, a focus or a press
 * shows it and none of them hides what another still holds; Escape dismisses
 * it wherever focus is, without also closing the dialog around it; leaving
 * every trigger hides it. It resets the type of the cell it sits in and
 * places itself inside the viewport.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { definePreviewData, MockPreview } from '../previewData';

const REVISION = definePreviewData(
  {
    finding: 'FE-LOW-338',
    // Any message key reads as the reason; the real surfaces pass their own.
    reasonKey: 'common.noResults',
    needs: 'a page revision source for the console title block',
  },
  'C',
);

function renderChip(): { chip: HTMLElement; tooltip: HTMLElement } {
  render(
    <>
      <MockPreview data={REVISION} variant="inline">
        {(revision) => <span>Rev {revision}</span>}
      </MockPreview>
      <button type="button">Next control</button>
    </>,
  );
  return {
    chip: screen.getByRole('button', { name: 'MOCK' }),
    tooltip: screen.getByRole('tooltip', { hidden: true }),
  };
}

describe('MockPreview — inline chip', () => {
  it('puts a focusable MOCK chip beside the value, described by the reason and the finding', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    expect(screen.getByText('Rev C')).toBeInTheDocument();
    expect(chip).toHaveAccessibleDescription(/No results found/);
    expect(chip).toHaveAccessibleDescription(/FE-LOW-338/);
    expect(chip).toHaveAccessibleDescription(/Data shown is sample data\./);
    expect(tooltip).not.toBeVisible();

    await user.tab();
    expect(chip).toHaveFocus();
    expect(tooltip).toBeVisible();
  });

  it('draws the chip as the Industry badge: square 22 px, 12.5 px bold (design handoff §7.8)', () => {
    const { chip } = renderChip();
    for (const size of ['h-[22px]', 'min-w-[22px]', 'text-[12.5px]', 'font-bold'])
      expect(chip).toHaveClass(size);
  });

  it('labels the chip in Turkish under a Turkish provider', () => {
    render(
      <I18nProvider locale="tr">
        <MockPreview data={REVISION} variant="inline">
          {(revision) => <span>{revision}</span>}
        </MockPreview>
      </I18nProvider>,
    );
    const chip = screen.getByRole('button', { name: 'ÖRNEK' });
    expect(chip).toHaveAccessibleDescription(/FE-LOW-338/);
  });
});

describe('MockPreview — inline tooltip triggers (WCAG 1.4.13)', () => {
  it('shows the tooltip on a click and keeps it after a second one', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.click(chip);
    expect(tooltip).toBeVisible();
    await user.click(chip);
    expect(tooltip).toBeVisible();
  });

  it('shows the tooltip on a tap that brings no focus and keeps it once the touch ends', () => {
    const { chip, tooltip } = renderChip();
    // A touch tap where the browser does not focus the button (Safari).
    fireEvent.mouseOver(chip);
    fireEvent.click(chip);
    fireEvent.mouseOut(chip);
    expect(tooltip).toBeVisible();

    fireEvent.pointerDown(document.body);
    expect(tooltip).not.toBeVisible();
  });

  it('dismisses a hover-opened tooltip on Escape while focus is elsewhere', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.hover(chip);
    expect(tooltip).toBeVisible();
    expect(document.body).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(tooltip).not.toBeVisible();

    // A new hover shows it again.
    await user.unhover(chip);
    await user.hover(chip);
    expect(tooltip).toBeVisible();
  });

  it('keeps the tooltip while the chip has focus and the pointer leaves', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.tab();
    await user.hover(chip);
    await user.unhover(chip);
    expect(chip).toHaveFocus();
    expect(tooltip).toBeVisible();
  });

  it('keeps the tooltip while the pointer is over it, so it can be read', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.hover(chip);
    await user.hover(tooltip);
    expect(tooltip).toBeVisible();
  });

  it('hides the tooltip when focus leaves the chip', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.tab();
    expect(tooltip).toBeVisible();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
    expect(chip).not.toHaveFocus();
    expect(tooltip).not.toBeVisible();
  });

  it('closes a clicked tooltip on a press elsewhere', async () => {
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.click(chip);
    expect(tooltip).toBeVisible();
    await user.click(screen.getByText('Rev C'));
    expect(tooltip).not.toBeVisible();
  });

  it('spends the first Escape on the tooltip, not on the dialog around the chip', async () => {
    const user = userEvent.setup();
    const closeDialog = vi.fn();
    render(
      <div
        role="dialog"
        aria-label="Workspaces"
        onKeyDown={(event) => {
          if (event.key === 'Escape') closeDialog();
        }}
      >
        <MockPreview data={REVISION} variant="inline">
          {(revision) => <span>{revision}</span>}
        </MockPreview>
      </div>,
    );
    const tooltip = screen.getByRole('tooltip', { hidden: true });

    await user.tab();
    expect(tooltip).toBeVisible();
    await user.keyboard('{Escape}');
    expect(tooltip).not.toBeVisible();
    expect(closeDialog).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });
});

describe('MockPreview — inline tooltip layout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets the type of the cell it sits in, so the reason wraps in body text', () => {
    render(
      <dd className="whitespace-nowrap font-display-sd font-semibold uppercase tabular-nums">
        <MockPreview data={REVISION} variant="inline">
          {(revision) => revision}
        </MockPreview>
      </dd>,
    );
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    for (const reset of [
      'whitespace-normal',
      'font-body-sd',
      'font-normal',
      'normal-case',
      'tracking-normal',
      'normal-nums',
      'max-w-[min(18rem,calc(100vw-32px))]',
    ])
      expect(tooltip).toHaveClass(reset);
  });

  /** Lays the chip out at (left, top) in a 1280 × 800 viewport, the tooltip 288 × 96. */
  function layOut(left: number, top: number): void {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'tooltip'
        ? new DOMRect(0, 0, 288, 96)
        : new DOMRect(left, top, 22, 22);
    });
  }

  it('opens above and centred where it fits', async () => {
    layOut(600, 400);
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.hover(chip);
    expect(tooltip).toHaveAttribute('data-side', 'top');
    expect(tooltip).toHaveAttribute('data-align', 'center');
  });

  it('opens below a chip in the sticky header and inward from the right edge', async () => {
    layOut(1240, 40);
    const user = userEvent.setup();
    const { chip, tooltip } = renderChip();

    await user.hover(chip);
    expect(tooltip).toHaveAttribute('data-side', 'bottom');
    expect(tooltip).toHaveAttribute('data-align', 'end');
  });
});
