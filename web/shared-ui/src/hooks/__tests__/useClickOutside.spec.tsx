/**
 * useClickOutside — davranış testleri
 *
 * Görünmez `fixed inset-0` arka-plan katmanının yerini alan kancanın üç
 * sözünü sabitler: dış basış çağırır, iç basış çağırmaz, kapalıyken ve
 * unmount sonrası hiç dinlemez.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { useRef } from 'react';

import { useClickOutside } from '../useClickOutside';

function Probe({ onOutside, enabled = true }: { onOutside: () => void; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onOutside, enabled);
  return (
    <div>
      <div ref={ref}>
        <button type="button">iç</button>
      </div>
      <button type="button">dış</button>
    </div>
  );
}

describe('useClickOutside', () => {
  it('dışa basış geri çağırır, içe basış çağırmaz', () => {
    const onOutside = vi.fn();
    render(<Probe onOutside={onOutside} />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'iç' }));
    expect(onOutside).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'dış' }));
    expect(onOutside).toHaveBeenCalledTimes(1);

    fireEvent.touchStart(document.body);
    expect(onOutside).toHaveBeenCalledTimes(2);
  });

  it('enabled=false iken dinlemez', () => {
    const onOutside = vi.fn();
    render(<Probe onOutside={onOutside} enabled={false} />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'dış' }));
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('unmount sonrası belge dinleyicisi kalmaz', () => {
    const onOutside = vi.fn();
    const { unmount } = render(<Probe onOutside={onOutside} />);
    unmount();

    fireEvent.mouseDown(document.body);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('geri çağırmanın en son hâlini kullanır', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe onOutside={first} />);
    rerender(<Probe onOutside={second} />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'dış' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
