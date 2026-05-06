/**
 * CardsDashboard — Gridster-like card layout for SCADA operator views.
 *
 * Renders an array of cards in a CSS Grid layout. Each card embeds an
 * OperatorView for a specific screen/viewId. Cards support:
 *  - Close / maximize toggle via card header
 *  - Drag-to-reorder (simple pointer-event-based reorder)
 *  - Auto-fill responsive layout via CSS Grid auto-placement
 *  - Persistent layout saved to the operator store
 */

import React, {
  useState,
  useCallback,
  useRef,
  useMemo,
  useEffect,
  memo,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X, Maximize2, Minimize2, GripVertical } from 'lucide-react';

import { useOperatorStore } from '../../store/scada/operatorStore';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface DashboardCardConfig {
  /** Unique identifier for this card. */
  id: string;
  /** The view/screen ID to render inside the card. */
  viewId: string;
  /** Display title shown in the card header. */
  title: string;
  /** Grid column span (1-based, each unit = 1fr). */
  width: number;
  /** Grid row span (1-based, each unit = minmax row height). */
  height: number;
  /** Grid column start (1-based). 0 or undefined = auto. */
  colStart?: number;
  /** Grid row start (1-based). 0 or undefined = auto. */
  rowStart?: number;
}

export interface CardsDashboardProps {
  /** Card configuration array. */
  cards: DashboardCardConfig[];
  /** Called when a card is closed. */
  onCardClose?: (cardId: string) => void;
  /** Called when the card layout changes (reorder, maximize, etc.). */
  onLayoutChange?: (cards: DashboardCardConfig[]) => void;
  /** Content renderer for each card. Receives viewId, returns JSX. */
  renderCardContent?: (viewId: string, cardId: string) => ReactNode;
  /** Number of grid columns. Defaults to 12. */
  columns?: number;
  /** Row height in pixels. Defaults to 120. */
  rowHeight?: number;
  /** Gap between cards in pixels. Defaults to 8. */
  gap?: number;
}

/* ------------------------------------------------------------------ */
/*  CardHeader                                                          */
/* ------------------------------------------------------------------ */

interface CardHeaderProps {
  title: string;
  isMaximized: boolean;
  onClose: () => void;
  onToggleMaximize: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}

const CardHeader = memo<CardHeaderProps>(
  ({ title, isMaximized, onClose, onToggleMaximize, onDragStart }) => (
    <div
      className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700 select-none shrink-0"
      style={{ cursor: 'grab', touchAction: 'none' }}
      onPointerDown={onDragStart}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <GripVertical size={12} className="text-gray-500 shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-gray-200 truncate">{title}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMaximize();
          }}
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-100 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
          aria-label={isMaximized ? 'Restore card' : 'Maximize card'}
        >
          {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
          aria-label="Close card"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  ),
);
CardHeader.displayName = 'CardHeader';

/* ------------------------------------------------------------------ */
/*  DashboardCard                                                       */
/* ------------------------------------------------------------------ */

interface DashboardCardProps {
  card: DashboardCardConfig;
  isMaximized: boolean;
  children: ReactNode;
  onClose: () => void;
  onToggleMaximize: () => void;
  onDragStart: (cardId: string, e: React.PointerEvent) => void;
  columns: number;
  rowHeight: number;
}

const DashboardCard = memo<DashboardCardProps>(
  ({
    card,
    isMaximized,
    children,
    onClose,
    onToggleMaximize,
    onDragStart,
    columns,
    rowHeight,
  }) => {
    const handleDragStart = useCallback(
      (e: React.PointerEvent) => onDragStart(card.id, e),
      [card.id, onDragStart],
    );

    // Maximized card takes full grid area
    const gridStyle: React.CSSProperties = isMaximized
      ? {
          gridColumn: `1 / -1`,
          gridRow: `1 / -1`,
          zIndex: 30,
        }
      : {
          gridColumn: card.colStart
            ? `${card.colStart} / span ${Math.min(card.width, columns)}`
            : `span ${Math.min(card.width, columns)}`,
          gridRow: card.rowStart
            ? `${card.rowStart} / span ${card.height}`
            : `span ${card.height}`,
        };

    return (
      <div
        className="flex flex-col bg-gray-900 border border-gray-700 rounded-md overflow-hidden shadow-lg"
        style={gridStyle}
        data-card-id={card.id}
        role="region"
        aria-label={`Card: ${card.title}`}
      >
        <CardHeader
          title={card.title}
          isMaximized={isMaximized}
          onClose={onClose}
          onToggleMaximize={onToggleMaximize}
          onDragStart={handleDragStart}
        />
        <div className="flex-1 relative overflow-auto min-h-0">
          {children}
        </div>
      </div>
    );
  },
);
DashboardCard.displayName = 'DashboardCard';

/* ------------------------------------------------------------------ */
/*  Drop indicator                                                      */
/* ------------------------------------------------------------------ */

interface DropIndicatorProps {
  visible: boolean;
  /** Column span to match the card being dragged over. */
  colSpan?: number;
  /** Row span to match the card being dragged over. */
  rowSpan?: number;
}

const DropIndicator = memo<DropIndicatorProps>(({ visible, colSpan = 1, rowSpan = 1 }) => {
  if (!visible) return null;
  return (
    <div
      className="border-2 border-dashed border-blue-500/50 rounded-md bg-blue-500/10 pointer-events-none"
      style={{
        gridColumn: `span ${colSpan}`,
        gridRow: `span ${rowSpan}`,
        minHeight: 60,
      }}
      aria-hidden="true"
    />
  );
});
DropIndicator.displayName = 'DropIndicator';

/* ------------------------------------------------------------------ */
/*  CardsDashboard                                                      */
/* ------------------------------------------------------------------ */

export const CardsDashboard = memo<CardsDashboardProps>(
  ({
    cards: initialCards,
    onCardClose,
    onLayoutChange,
    renderCardContent,
    columns = 12,
    rowHeight = 120,
    gap = 8,
  }) => {
    const [cards, setCards] = useState<DashboardCardConfig[]>(initialCards);
    const [maximizedCardId, setMaximizedCardId] = useState<string | null>(null);
    const [dragCardId, setDragCardId] = useState<string | null>(null);
    const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Sync with parent prop changes
    useEffect(() => {
      setCards(initialCards);
    }, [initialCards]);

    // Notify parent of layout changes
    const emitLayoutChange = useCallback(
      (updated: DashboardCardConfig[]) => {
        setCards(updated);
        onLayoutChange?.(updated);
      },
      [onLayoutChange],
    );

    // Close card
    const handleClose = useCallback(
      (cardId: string) => {
        const updated = cards.filter((c) => c.id !== cardId);
        if (maximizedCardId === cardId) setMaximizedCardId(null);
        emitLayoutChange(updated);
        onCardClose?.(cardId);
      },
      [cards, maximizedCardId, emitLayoutChange, onCardClose],
    );

    // Toggle maximize
    const handleToggleMaximize = useCallback(
      (cardId: string) => {
        setMaximizedCardId((prev) => (prev === cardId ? null : cardId));
      },
      [],
    );

    // Drag-to-reorder: simple index-swap approach
    const handleDragStart = useCallback(
      (cardId: string, e: React.PointerEvent) => {
        // Only primary button
        if (e.button !== 0) return;
        e.preventDefault();
        setDragCardId(cardId);

        const handlePointerMove = (moveEvent: PointerEvent) => {
          if (!containerRef.current) return;
          const cardElements = containerRef.current.querySelectorAll<HTMLElement>('[data-card-id]');
          let closestIndex = -1;
          let closestDist = Infinity;

          cardElements.forEach((el, idx) => {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dist = Math.hypot(moveEvent.clientX - cx, moveEvent.clientY - cy);
            if (dist < closestDist) {
              closestDist = dist;
              closestIndex = idx;
            }
          });

          setDropTargetIndex(closestIndex >= 0 ? closestIndex : null);
        };

        const handlePointerUp = () => {
          document.removeEventListener('pointermove', handlePointerMove);
          document.removeEventListener('pointerup', handlePointerUp);

          setDragCardId((prevDragId) => {
            setDropTargetIndex((prevDropIdx) => {
              if (prevDragId && prevDropIdx !== null) {
                setCards((prevCards) => {
                  const fromIdx = prevCards.findIndex((c) => c.id === prevDragId);
                  if (fromIdx === -1 || fromIdx === prevDropIdx) return prevCards;

                  const updated = [...prevCards];
                  const [moved] = updated.splice(fromIdx, 1);
                  updated.splice(prevDropIdx, 0, moved);
                  onLayoutChange?.(updated);
                  return updated;
                });
              }
              return null;
            });
            return null;
          });
        };

        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);
      },
      [onLayoutChange],
    );

    // Grid template
    const gridStyle: React.CSSProperties = useMemo(
      () => ({
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridAutoRows: `minmax(${rowHeight}px, auto)`,
        gap: `${gap}px`,
        padding: `${gap}px`,
        width: '100%',
        height: '100%',
        overflow: 'auto',
      }),
      [columns, rowHeight, gap],
    );

    return (
      <div
        ref={containerRef}
        className="relative w-full h-full bg-gray-950"
        style={gridStyle}
        role="region"
        aria-label="Cards dashboard"
      >
        {cards.map((card, index) => {
          const isDragging = dragCardId !== null;
          const isDraggedCard = dragCardId === card.id;
          const showIndicatorBefore =
            isDragging && dropTargetIndex === index && !isDraggedCard;

          return (
            <React.Fragment key={card.id}>
              {showIndicatorBefore && (
                <DropIndicator
                  visible
                  colSpan={Math.min(
                    cards.find((c) => c.id === dragCardId)?.width ?? 1,
                    columns,
                  )}
                  rowSpan={cards.find((c) => c.id === dragCardId)?.height ?? 1}
                />
              )}
              <DashboardCard
                card={card}
                isMaximized={maximizedCardId === card.id}
                onClose={() => handleClose(card.id)}
                onToggleMaximize={() => handleToggleMaximize(card.id)}
                onDragStart={handleDragStart}
                columns={columns}
                rowHeight={rowHeight}
              >
                {renderCardContent ? (
                  renderCardContent(card.viewId, card.id)
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-500 text-xs">
                    View: {card.viewId}
                  </div>
                )}
              </DashboardCard>
            </React.Fragment>
          );
        })}

        {/* Drop indicator at the end of the list */}
        {dragCardId !== null &&
          dropTargetIndex !== null &&
          dropTargetIndex >= cards.length && (
            <DropIndicator
              visible
              colSpan={Math.min(
                cards.find((c) => c.id === dragCardId)?.width ?? 1,
                columns,
              )}
              rowSpan={cards.find((c) => c.id === dragCardId)?.height ?? 1}
            />
          )}

        {/* Empty state */}
        {cards.length === 0 && (
          <div
            className="flex items-center justify-center text-gray-500 text-sm"
            style={{ gridColumn: '1 / -1', minHeight: rowHeight * 2 }}
          >
            No cards configured
          </div>
        )}
      </div>
    );
  },
);
CardsDashboard.displayName = 'CardsDashboard';
