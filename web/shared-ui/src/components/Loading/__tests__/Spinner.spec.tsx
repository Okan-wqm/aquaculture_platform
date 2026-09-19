/**
 * Spinner is the one loading indicator (FE-MEDIUM-070): every size and
 * colour a page used to draw by hand maps onto a prop, and a page that
 * needs a screen-reader name gets one without visible text.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Spinner } from '../Loading';

function arc(container: HTMLElement): SVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('Spinner renders an svg arc');
  return svg;
}

function classes(element: Element | null): string[] {
  if (!element) throw new Error('element expected');
  return Array.from(element.classList);
}

describe('Spinner', () => {
  it('draws a medium theme-coloured arc by default', () => {
    const { container } = render(<Spinner />);
    const svg = arc(container);
    expect(classes(svg)).toEqual(
      expect.arrayContaining(['animate-spin', 'w-6', 'h-6', 'text-primary-500']),
    );
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('maps size and colour props onto the arc', () => {
    const { container } = render(<Spinner size="sm" color="white" />);
    expect(classes(arc(container))).toEqual(expect.arrayContaining(['w-4', 'h-4', 'text-white']));
  });

  it('inherits the surrounding text colour inside a button', () => {
    const { container } = render(
      <button type="button" className="text-white">
        <Spinner color="inherit" />
      </button>,
    );
    expect(classes(arc(container))).toContain('text-current');
    expect(classes(arc(container))).not.toContain('text-primary-500');
  });

  it('fills the row and centres when it is the only content', () => {
    const { container } = render(<Spinner block />);
    expect(classes(container.firstElementChild)).toEqual(
      expect.arrayContaining(['flex', 'justify-center']),
    );
    expect(classes(container.firstElementChild)).not.toContain('inline-flex');
  });

  it('names itself for assistive technology without visible text', () => {
    render(<Spinner label="Writing…" />);
    expect(classes(screen.getByText('Writing…'))).toContain('sr-only');
  });

  it('shows visible text beside the arc and needs no hidden label', () => {
    render(<Spinner text="Loading history" label="ignored" />);
    expect(classes(screen.getByText('Loading history'))).not.toContain('sr-only');
    expect(screen.queryByText('ignored')).toBeNull();
  });
});
