/**
 * MockPreview — preview data renders only inside its notice (FE-MEDIUM-337).
 *
 * The block variant draws the hazard notice band (eyebrow, reason, finding id,
 * "sample data") above the content and describes the content by it. The value
 * reaches the page through the render prop only, the notice is drawn whatever
 * the render prop returns, and a handle definePreviewData did not make is
 * refused. The inline variant's chip and tooltip: MockPreviewInline.spec.tsx.
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { definePreviewData, MockPreview, type PreviewData } from '../previewData';

const BUDGET = definePreviewData(
  {
    finding: 'FARM-MEDIUM-439',
    // Any message key reads as the reason; the real surfaces pass their own.
    reasonKey: 'common.noResults',
    needs: 'farm-service budget entity + budgetVsActual query',
  },
  { planned: 125_000 },
);

describe('MockPreview — block', () => {
  it('draws the notice band above the content and hands the value to the render prop', () => {
    const renderValue = vi.fn((value: { planned: number }) => <p>Planned {value.planned}</p>);
    render(
      <MockPreview data={BUDGET} variant="block">
        {renderValue}
      </MockPreview>,
    );

    const note = screen.getByRole('note');
    expect(within(note).getByText('PREVIEW · NO BACKEND YET')).toBeInTheDocument();
    expect(within(note).getByText('MOCK')).toBeInTheDocument();
    expect(within(note).getByText('No results found')).toBeInTheDocument();
    expect(within(note).getByText(/FARM-MEDIUM-439/)).toBeInTheDocument();
    expect(within(note).getByText('Data shown is sample data.')).toBeInTheDocument();

    expect(renderValue).toHaveBeenCalledTimes(1);
    expect(renderValue.mock.calls[0]?.[0]).toEqual({ planned: 125_000 });
    expect(screen.getByText('Planned 125000')).toBeInTheDocument();
    // The notice precedes the content in reading order.
    const content = screen.getByRole('group');
    expect(note.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('describes the content by the notice so assistive technology hears it is sample data', () => {
    render(
      <MockPreview data={BUDGET} variant="block">
        {(value) => <span>{value.planned}</span>}
      </MockPreview>,
    );
    const content = screen.getByRole('group');
    expect(content).toHaveAccessibleDescription(/FARM-MEDIUM-439/);
    expect(content).toHaveAccessibleDescription(/sample data/);
  });

  it('draws the notice even when the render prop renders nothing', () => {
    render(
      <MockPreview data={BUDGET} variant="block">
        {() => null}
      </MockPreview>,
    );
    expect(screen.getByRole('note')).toHaveTextContent('PREVIEW · NO BACKEND YET');
  });

  it('speaks Turkish under a Turkish provider', () => {
    render(
      <I18nProvider locale="tr">
        <MockPreview data={BUDGET} variant="block">
          {(value) => <span>{value.planned}</span>}
        </MockPreview>
      </I18nProvider>,
    );
    const note = screen.getByRole('note');
    expect(within(note).getByText('ÖNİZLEME · BACKEND YOK')).toBeInTheDocument();
    expect(within(note).getByText('Gösterilen veriler örnek veridir.')).toBeInTheDocument();
  });
});

describe('MockPreview — a handle definePreviewData did not make', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to render, so a forged handle cannot pass for preview data', () => {
    // React reports the thrown render error; keep the run output readable.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const forged: PreviewData<number> = Object.freeze({}) as PreviewData<number>;
    expect(() =>
      render(
        <MockPreview data={forged} variant="block">
          {(value) => <span>{value}</span>}
        </MockPreview>,
      ),
    ).toThrow(/definePreviewData/);
  });
});
