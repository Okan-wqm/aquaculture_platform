/**
 * TitleBlock — the drawing sheet's title block in the console header
 * (README §7.4, the "pafta").
 *
 * A cell is drawn only when it has a value from a real source: the live-site
 * and device ratios only while their query is 'ready' (loading, failed or not
 * for this viewer → no cell, never a made-up zero), the sheet code only when
 * it could be derived, the revision only when the shell passes its cell (a
 * labelled preview, FE-LOW-338). With no cell at all, nothing is drawn.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../../../../i18n';
import { TitleBlock, type TitleBlockProps } from '../TitleBlock';

const READY_SITES: TitleBlockProps['sites'] = { status: 'ready', live: 2, total: 3 };
const READY_DEVICES: TitleBlockProps['devices'] = { status: 'ready', online: 11, total: 12 };

function block(): HTMLElement {
  return screen.getByRole('group', { name: 'Title block' });
}

function cells(): HTMLElement[] {
  // Each cell is a term/definition pair inside the description list.
  return within(block())
    .getAllByRole('term')
    .map((term) => term.parentElement as HTMLElement);
}

describe('TitleBlock', () => {
  it('draws live sites and devices as "value / total" with a spoken form', () => {
    render(<TitleBlock sites={READY_SITES} devices={READY_DEVICES} sheetCode="AQ-ENVIR" />);

    const [sites, devices, sheet] = cells();
    expect(within(sites as HTMLElement).getByRole('term')).toHaveTextContent('Live sites');
    expect(within(sites as HTMLElement).getByRole('definition')).toHaveTextContent(
      '2 / 32 of 3 sites live',
    );
    expect(within(devices as HTMLElement).getByText('11 of 12 devices online')).toHaveClass(
      'sr-only',
    );
    expect(within(sheet as HTMLElement).getByRole('term')).toHaveTextContent('Sheet');
    expect(within(sheet as HTMLElement).getByRole('definition')).toHaveTextContent('AQ-ENVIR');
  });

  it.each(['loading', 'error', 'unavailable'] as const)(
    'hides a count cell while its status is %s',
    (status) => {
      render(
        <TitleBlock
          sites={{ status, live: null, total: null }}
          devices={READY_DEVICES}
          sheetCode="AQ-ENVIR"
        />,
      );
      expect(screen.queryByText('Live sites')).not.toBeInTheDocument();
      expect(screen.getByText('Devices')).toBeInTheDocument();
    },
  );

  it('draws the revision cell only when the shell passes one', () => {
    const { rerender } = render(
      <TitleBlock sites={READY_SITES} devices={READY_DEVICES} sheetCode="AQ-ENVIR" />,
    );
    expect(screen.queryByText('Rev.')).not.toBeInTheDocument();

    rerender(
      <TitleBlock
        sites={READY_SITES}
        devices={READY_DEVICES}
        sheetCode="AQ-ENVIR"
        revision={<span>rev-cell</span>}
      />,
    );
    const revision = cells().at(-1) as HTMLElement;
    expect(within(revision).getByRole('term')).toHaveTextContent('Rev.');
    expect(within(revision).getByRole('definition')).toHaveTextContent('rev-cell');
  });

  it('hides the sheet cell when no code could be derived', () => {
    render(<TitleBlock sites={READY_SITES} devices={READY_DEVICES} sheetCode={null} />);
    expect(screen.queryByText('Sheet')).not.toBeInTheDocument();
  });

  it('renders nothing when no cell has a value', () => {
    const { container } = render(
      <TitleBlock
        sites={{ status: 'loading', live: null, total: null }}
        devices={{ status: 'error', online: null, total: null }}
        sheetCode={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // A <dl> with role="group" loses its list semantics, which orphans every
  // term and definition (axe "dlitem", serious). The name sits on a wrapping
  // group; the list keeps its own semantics.
  it('names a group around a plain description list', () => {
    render(<TitleBlock sites={READY_SITES} devices={READY_DEVICES} sheetCode="AQ-ENVIR" />);
    const list = block().firstElementChild as HTMLElement;
    expect(list.tagName).toBe('DL');
    expect(list).not.toHaveAttribute('role');
    expect(block().tagName).toBe('DIV');
  });

  // The header row cannot shrink the title block, and with the tools frame
  // and the Rev. cell's MOCK chip the four cells overflowed the console
  // column below 1340px (Chromium, Turkish, a long name: 65px at 1180px).
  // The live counts show from 1180px; the sheet code and the revision join
  // them from 1340px. Container queries, not viewport ones.
  it('shows the live counts from 1180px and the sheet code and revision from 1340px', () => {
    render(
      <TitleBlock
        sites={READY_SITES}
        devices={READY_DEVICES}
        sheetCode="AQ-ENVIR"
        revision={<span>rev-cell</span>}
      />,
    );
    expect(block()).toHaveClass('hidden', '@min-[1180px]/page:block');
    const [sites, devices, sheet, revision] = cells();
    for (const cell of [sites, devices]) {
      expect(cell).toHaveClass('flex');
      expect(cell).not.toHaveClass('hidden');
    }
    for (const cell of [sheet, revision]) {
      expect(cell).toHaveClass('hidden', '@min-[1340px]/page:flex');
    }
  });

  it('waits for 1340px when only the sheet code and revision have a value', () => {
    render(
      <TitleBlock
        sites={{ status: 'loading', live: null, total: null }}
        devices={{ status: 'unavailable', online: null, total: null }}
        sheetCode="AQ-ENVIR"
        revision={<span>rev-cell</span>}
      />,
    );
    expect(block()).toHaveClass('hidden', '@min-[1340px]/page:block');
    expect(block()).not.toHaveClass('@min-[1180px]/page:block');
  });

  it('speaks Turkish under the Turkish locale', () => {
    render(
      <I18nProvider locale="tr">
        <TitleBlock sites={READY_SITES} devices={READY_DEVICES} sheetCode="AQ-ENVIR" />
      </I18nProvider>,
    );
    expect(screen.getByRole('group', { name: 'Pafta bloğu' })).toBeInTheDocument();
    expect(screen.getByText('Canlı saha')).toBeInTheDocument();
    expect(screen.getByText('3 sahadan 2 canlı')).toBeInTheDocument();
  });
});
