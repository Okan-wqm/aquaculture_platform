/**
 * AlarmPriorityCounts — the ISA-101 glyph + count pairs of a workspace row.
 *
 * Only a priority with alarms is drawn; each pair is announced as words (one
 * alarm in the singular), the glyph shape and the bare number being visual
 * only. The glyphs are drawn at the menu's size (design `glyph(p, 12)`), not
 * the annunciator tile's.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AlarmPriorityCounts } from '../AlarmPriorityCounts';

afterEach(cleanup);

function glyphClasses(container: HTMLElement, priority: string): string[] {
  const glyph = container.querySelector(`[data-glyph="${priority}"]`);
  return (glyph?.getAttribute('class') ?? '').split(/\s+/);
}

describe('AlarmPriorityCounts', () => {
  it('draws one glyph and count per priority with alarms, in P1–P3 order', () => {
    const { container } = render(<AlarmPriorityCounts counts={{ p1: 2, p2: 0, p3: 4 }} />);
    const pairs = container.querySelectorAll('[data-priority]');
    expect([...pairs].map((pair) => pair.getAttribute('data-priority'))).toEqual(['p1', 'p3']);
    expect(pairs[0]).toHaveTextContent('2');
    expect(pairs[1]).toHaveTextContent('4');
  });

  it('announces each pair in words, one alarm in the singular', () => {
    render(<AlarmPriorityCounts counts={{ p1: 1, p2: 3, p3: 0 }} />);
    expect(screen.getByText('1 critical (P1) alarm')).toHaveClass('sr-only');
    expect(screen.getByText('3 high (P2) alarms')).toHaveClass('sr-only');
    expect(screen.queryByText(/medium \(P3\)/)).toBeNull();
  });

  it('announces a single medium alarm in the singular too', () => {
    render(<AlarmPriorityCounts counts={{ p1: 0, p2: 1, p3: 1 }} />);
    expect(screen.getByText('1 high (P2) alarm')).toHaveClass('sr-only');
    expect(screen.getByText('1 medium (P3) alarm')).toHaveClass('sr-only');
  });

  it('draws the glyphs at the menu size: P1 12×12, P2 15×12, P3 a 9 px box with a 2 px border', () => {
    const { container } = render(<AlarmPriorityCounts counts={{ p1: 1, p2: 1, p3: 1 }} />);
    expect(glyphClasses(container, 'p1')).toEqual(expect.arrayContaining(['size-3']));
    expect(glyphClasses(container, 'p2')).toEqual(expect.arrayContaining(['h-3', 'w-[15px]']));
    expect(glyphClasses(container, 'p3')).toEqual(
      expect.arrayContaining(['size-[9px]', 'border-2', 'mx-[3px]', 'rotate-45']),
    );
    // Not the annunciator tile's marks.
    expect(glyphClasses(container, 'p1')).not.toContain('size-3.5');
    expect(glyphClasses(container, 'p3')).not.toContain('border-[1.5px]');
  });

  it('renders nothing without alarms', () => {
    const { container } = render(<AlarmPriorityCounts counts={{ p1: 0, p2: 0, p3: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
