/**
 * ChannelQuantitySelect: a family key (ammonia) offers its members to declare,
 * and choosing the key's own meaning clears the declaration.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { ChannelQuantitySelect } from '../ChannelQuantitySelect';

const AMMONIA = {
  channelKey: 'ammonia',
  quantity: null,
  declaredQuantity: null,
  quantityFamily: 'ammonia',
  declarableQuantities: ['tan', 'nh3'],
};

describe('ChannelQuantitySelect', () => {
  it('declares a member of the family the key names', () => {
    const onChange = vi.fn();
    render(<ChannelQuantitySelect channel={AMMONIA} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('ammonia ölçülen büyüklük'), {
      target: { value: 'tan' },
    });
    expect(onChange).toHaveBeenCalledWith('tan');
    expect(
      screen.getByRole('option', { name: 'tan — total ammonia as N, mg/L' }),
    ).toBeInTheDocument();
  });

  it("clears the declaration when the key's own meaning is chosen", () => {
    const onChange = vi.fn();
    render(
      <ChannelQuantitySelect
        channel={{ ...AMMONIA, quantity: 'tan', declaredQuantity: 'tan' }}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('ammonia ölçülen büyüklük'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('is read-only for a reader, and plain text for a key with nothing to declare', () => {
    const { rerender } = render(
      <ChannelQuantitySelect channel={AMMONIA} disabled onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('ammonia ölçülen büyüklük')).toBeDisabled();
    rerender(
      <ChannelQuantitySelect
        channel={{
          channelKey: 'ph',
          quantity: 'ph',
          declaredQuantity: null,
          quantityFamily: null,
          declarableQuantities: [],
        }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('ph — NBS scale, pH')).toBeInTheDocument();
  });
});
