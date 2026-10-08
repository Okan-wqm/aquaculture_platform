import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FieldProvenanceChip } from '../FieldProvenanceChip';
import { composePointInputs } from '../inputs-adapter';

import {
  dosingSet,
  input,
  readyDosingInputs,
  readyToxicityInputs,
  reading,
  toxicitySet,
} from './fixtures';

const NOW = Date.parse('2026-10-08T10:05:00.000Z');

describe('FieldProvenanceChip', () => {
  it('shows a blocked value struck through, with the problem that blocks it', () => {
    const inputs = readyToxicityInputs().map((entry) =>
      entry.engineInput === 'h2sUgL' ? input('h2sUgL', 3.5, ['NOT_SAME_SAMPLE']) : entry,
    );
    const { fields } = composePointInputs({ own: toxicitySet(inputs), loop: null }, {});
    render(<FieldProvenanceChip entry={fields.h2sUgL} now={NOW} />);
    expect(screen.getByText('3.5')).toHaveClass('line-through');
    expect(screen.getByText('Not usable')).toBeInTheDocument();
    expect(
      screen.getByText('Not read within 15 minutes of the pH it is converted with'),
    ).toBeInTheDocument();
  });

  it("says a tank's alkalinity is the loop's, an inherited value where it stands, and its window", () => {
    const own = readyToxicityInputs().map((entry) =>
      entry.engineInput === 'tempC'
        ? { ...entry, reading: reading(15, { inheritedFrom: 'SYSTEM' }) }
        : entry,
    );
    const { fields } = composePointInputs(
      { own: toxicitySet(own), loop: dosingSet(readyDosingInputs(), { volumeM3: 50 }) },
      {},
    );
    const { rerender } = render(<FieldProvenanceChip entry={fields.alkalinityMg} now={NOW} />);
    expect(screen.getByText(/from the loop/)).toBeInTheDocument();
    expect(screen.getByText(/5 min ago/)).toBeInTheDocument();
    expect(screen.getByText('read within 4 h')).toBeInTheDocument();

    rerender(<FieldProvenanceChip entry={fields.tempC} now={NOW} />);
    expect(screen.getByText(/from the system/)).toBeInTheDocument();
    rerender(<FieldProvenanceChip entry={fields.volume} now={NOW} />);
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('50.0')).toBeInTheDocument();
  });

  it('takes an entry for an uncovered field, and a correction for a covered one', () => {
    const onEnter = vi.fn();
    const { fields } = composePointInputs(
      { own: dosingSet(readyDosingInputs(), { volumeM3: 50 }), loop: null },
      {},
    );
    const { rerender } = render(
      <FieldProvenanceChip entry={fields.tan} now={NOW} onEnter={onEnter} />,
    );
    fireEvent.change(screen.getByLabelText('Enter TAN (mg/L as N) for this session'), {
      target: { value: '0.4' },
    });
    expect(onEnter).toHaveBeenCalledWith(0.4);
    rerender(<FieldProvenanceChip entry={fields.pH} now={NOW} onEnter={onEnter} />);
    expect(screen.getByLabelText('Correct pH for this session')).toBeInTheDocument();
  });
});
