// MOB-MEDIUM-012 — large lists must not render every row into the DOM.
//
// Notifications, chat history and stock item lists grow without bound; on
// low-end field devices a fully-rendered list janks and eats memory. The
// shared VirtualList mounts only the visible window (plus overscan) through
// @tanstack/react-virtual, with dynamic row measurement so variable-height
// cards stay correct.

import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import { VirtualList } from '../VirtualList';

const items = Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}` }));

describe('VirtualList (MOB-MEDIUM-012)', () => {
  beforeEach(() => {
    // jsdom lays out nothing — a firing ResizeObserver would overwrite the
    // initialRect with the 0×0 jsdom rect and collapse the window to zero
    // rows. A no-op observer keeps initialRect authoritative in tests.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          // no-op: measurements must not fire in jsdom
        }
        unobserve(): void {
          // no-op
        }
        disconnect(): void {
          // no-op
        }
      },
    );
    // jsdom lays out nothing — the virtualizer reads offsetWidth/offsetHeight
    // for the scroll viewport (virtual-core getRect), so give those a real
    // size or zero rows would mount.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mounts only a window of rows, not all 500', () => {
    render(
      <VirtualList
        items={items}
        getKey={(item) => item.id}
        estimateSize={() => 60}
        className="h-[400px]"
        initialRect={{ width: 400, height: 400 }}
        renderItem={(item) => <div data-testid="row">{item.label}</div>}
      />,
    );

    const rendered = screen.getAllByTestId('row');
    expect(rendered.length).toBeGreaterThan(0);
    // jsdom reports zero heights, so the virtualizer renders the overscan
    // window only — far below the full list either way.
    expect(rendered.length).toBeLessThan(100);
    expect(screen.getByText('Row 0')).toBeTruthy();
  });

  it('renders an explicit empty state slot when there are no items', () => {
    render(
      <VirtualList
        items={[]}
        getKey={(item: { id: string }) => item.id}
        estimateSize={() => 60}
        renderItem={() => <div />}
        emptyState={<p>Nothing here</p>}
      />,
    );

    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
