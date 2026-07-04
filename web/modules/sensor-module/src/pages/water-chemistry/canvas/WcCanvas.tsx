/**
 * GridStack canvas (P2). Draggable/resizable grid of water-chemistry cards.
 *
 * Bridges GridStack.js <-> React with the repo's proven pattern (see
 * components/dashboard/GridStackDashboard.tsx): React renders the `.grid-stack-item`
 * DOM; GridStack.init() adopts the initial items; new cards are registered with
 * makeWidget(); removal calls removeWidget() BEFORE React unmounts; geometry is synced
 * back on dragstop/resizestop.
 */
import { GridStack, type GridStackNode } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { type ReactElement, useEffect, useRef } from 'react';

import { isSystemCard, type AnyWcCard, type WcCard, type WcSystemCard } from '../types';
import WcChartCard from './WcChartCard';
import WcSystemCardView from './WcSystemCard';

const WcCanvas = ({
  cards,
  onChange,
  onConfigure,
  onRemove,
}: {
  cards: AnyWcCard[];
  onChange: (id: string, patch: Partial<WcCard> | Partial<WcSystemCard>) => void;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
}): ReactElement => {
  const gridRef = useRef<HTMLDivElement>(null);
  const grid = useRef<GridStack | null>(null);
  const known = useRef<Set<string>>(new Set());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Init once; adopt initial items; sync geometry on drag/resize end.
  useEffect(() => {
    if (!gridRef.current) return;
    const g = GridStack.init(
      { column: 12, cellHeight: 64, margin: 8, float: true, draggable: { handle: '.drag-handle' } },
      gridRef.current,
    );
    grid.current = g;
    gridRef.current.querySelectorAll<HTMLElement>('[data-card-id]').forEach((el) => {
      const id = el.getAttribute('data-card-id');
      if (id) known.current.add(id);
    });
    const sync = (): void => {
      g.engine.nodes.forEach((n: GridStackNode) => {
        const id = (n.el as HTMLElement | undefined)?.getAttribute('data-card-id');
        // Persist only fully-resolved geometry — skip a mid-transition node with an
        // undefined coord so a stale read never collapses every card to x:0.
        if (id && n.x != null && n.y != null && n.w != null && n.h != null) {
          onChangeRef.current(id, { layout: { x: n.x, y: n.y, w: n.w, h: n.h } });
        }
      });
    };
    // `change` is GridStack's canonical geometry event (drag + resize + programmatic
    // moves) — persist on all of them so the layout survives reload.
    g.on('change', sync);
    return () => {
      g.off('change');
      g.destroy(false);
      grid.current = null;
      known.current.clear();
    };
    // init-once: add/remove handled below and in handleRemove
  }, []);

  // Register newly-added cards with GridStack (React already rendered their DOM).
  useEffect(() => {
    const g = grid.current;
    if (!g || !gridRef.current) return;
    for (const c of cards) {
      if (known.current.has(c.id)) continue;
      const el = gridRef.current.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`);
      if (el) {
        g.makeWidget(el);
        known.current.add(c.id);
      }
    }
  }, [cards]);

  // Remove from GridStack BEFORE React unmounts the DOM node, then drop from state.
  const handleRemove = (id: string): void => {
    const g = grid.current;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
    if (g && el) g.removeWidget(el, false);
    known.current.delete(id);
    onRemove(id);
  };

  return (
    <div ref={gridRef} className="grid-stack min-h-[60vh]">
      {cards.map((c) => (
        <div
          key={c.id}
          className="grid-stack-item"
          data-card-id={c.id}
          gs-x={c.layout.x}
          gs-y={c.layout.y}
          gs-w={c.layout.w}
          gs-h={c.layout.h}
        >
          <div className="grid-stack-item-content">
            {isSystemCard(c) ? (
              <WcSystemCardView
                card={c}
                onChange={(p) => onChange(c.id, p)}
                onConfigure={() => onConfigure(c.id)}
                onRemove={() => handleRemove(c.id)}
              />
            ) : (
              <WcChartCard
                card={c}
                onChange={(p) => onChange(c.id, p)}
                onConfigure={() => onConfigure(c.id)}
                onRemove={() => handleRemove(c.id)}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default WcCanvas;
