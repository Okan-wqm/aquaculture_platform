import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactElement, type ReactNode, useRef } from 'react';

/**
 * MOB-MEDIUM-012: shared virtualized list for the surfaces that grow without
 * bound (notifications, stock item pickers). Owns its scroll container and
 * mounts only the visible window (+overscan) via @tanstack/react-virtual,
 * with dynamic row measurement so variable-height cards render correctly.
 *
 * Bounded, dashboard-embedded lists (e.g. the home tank cards — physically
 * limited by farm size) deliberately stay plain: nesting a scroll region
 * inside a scrolling dashboard hurts one-handed field use more than a few
 * dozen cards hurt memory.
 */
export interface VirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** Estimated row height in px (refined by dynamic measurement). */
  estimateSize: () => number;
  renderItem: (item: T, index: number) => ReactNode;
  /** Height/layout classes for the scroll container (e.g. 'flex-1', 'max-h-[50vh]'). */
  className?: string;
  /** Vertical gap between rows, in px (applied as row padding-bottom). */
  gapPx?: number;
  emptyState?: ReactNode;
  overscan?: number;
  /**
   * Initial viewport rect for the virtualizer — needed in test environments
   * (jsdom has no layout/ResizeObserver, so the measured rect stays 0×0 and
   * zero rows would mount). Production leaves this unset; the ResizeObserver
   * measurement takes over after mount either way.
   */
  initialRect?: { width: number; height: number };
}

export function VirtualList<T>({
  items,
  getKey,
  estimateSize,
  renderItem,
  className,
  gapPx = 0,
  emptyState = null,
  overscan = 8,
  initialRect,
}: VirtualListProps<T>): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan,
    initialRect,
  });

  if (items.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div ref={scrollRef} className={`overflow-y-auto overscroll-contain ${className ?? ''}`}>
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (item === undefined) return null;
          return (
            <div
              key={getKey(item)}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom: gapPx ? `${gapPx}px` : undefined,
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
