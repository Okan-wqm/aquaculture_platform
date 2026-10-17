/**
 * The crew split bar names each segment's location.
 *
 * In the Company workspace the console accent is a near-neutral slate, so the
 * four crew series differ in lightness only; colour (or its absence) cannot
 * be the one way a segment is told apart. Each segment is an image named
 * "<location>: <count>", in the user's language, and the bar is one named
 * group, so a screen reader reads what a sighted user reads off the legend.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SeaLandSplitView } from '../SeaLandSplitView';

interface Group {
  count: number;
  employees: { id: string; firstName: string; lastName: string }[];
}
interface Split {
  offshore: Group;
  onshore: Group;
  inTransit: Group;
  onLeave: Group;
}

const group = (count: number): Group => ({
  count,
  employees: Array.from({ length: count }, (_, index) => ({
    id: `crew-${count}-${index}`,
    firstName: 'Crew',
    lastName: String(index),
  })),
});

const state = vi.hoisted((): { split: Split | undefined } => ({ split: undefined }));

vi.mock('../../../hooks', () => ({
  useSeaLandSplit: () => ({ data: state.split, isLoading: false, error: null }),
  useOffshoreHeadcount: () => ({ data: undefined }),
}));

/** The names of the bar's segments, left to right. */
function segments(): (string | null)[] {
  const bar = screen.getByRole('group', { name: 'Crew by location' });
  return within(bar)
    .getAllByRole('img')
    .map((segment) => segment.getAttribute('aria-label'));
}

describe('SeaLandSplitView summary bar', () => {
  beforeEach(() => {
    state.split = {
      offshore: group(5),
      onshore: group(3),
      inTransit: group(1),
      onLeave: group(2),
    };
  });

  it('is one named group of segments, each named by its location and count, in bar order', () => {
    render(<SeaLandSplitView variant="summary" />);

    expect(segments()).toEqual(['Offshore: 5', 'Onshore: 3', 'In transit: 1', 'On leave: 2']);
  });

  it('draws no segment for a location nobody is at', () => {
    state.split = { offshore: group(5), onshore: group(3), inTransit: group(0), onLeave: group(2) };
    render(<SeaLandSplitView variant="summary" />);

    expect(segments()).toEqual(['Offshore: 5', 'Onshore: 3', 'On leave: 2']);
  });
});
