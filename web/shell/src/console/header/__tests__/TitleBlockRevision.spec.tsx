/**
 * TitleBlockRevision — the title block's "Rev." cell (FE-LOW-338).
 *
 * No console page has a revision record, so the cell is a labelled preview:
 * the sample revision only ever renders beside the MOCK chip, whose
 * description names the missing source and the tracked finding.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TitleBlockRevision } from '../TitleBlockRevision';

describe('TitleBlockRevision', () => {
  it('renders the sample revision beside the MOCK chip that names FE-LOW-338', () => {
    const { container } = render(<TitleBlockRevision />);

    const chip = screen.getByRole('button', { name: 'MOCK' });
    const descriptionId = chip.getAttribute('aria-describedby');
    expect(descriptionId).not.toBeNull();
    const description = document.getElementById(descriptionId ?? '')?.textContent ?? '';
    expect(description).toContain('no sheet revision is recorded anywhere');
    expect(description).toContain('FE-LOW-338');
    expect(description).toContain('sample data');

    const cell = container.querySelector('[data-preview-finding="FE-LOW-338"]');
    expect(cell?.textContent?.startsWith('CMOCK')).toBe(true);
  });
});
