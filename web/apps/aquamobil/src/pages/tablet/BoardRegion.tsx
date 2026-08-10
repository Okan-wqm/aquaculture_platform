/**
 * BoardRegion — one column of a board view: a labelled card whose body scrolls
 * on its own.
 *
 * WHY IT IS SHARED. All three board views are built from the same column: the
 * Board's alarms / units / inspector, Reports' summary and submissions, Chat's
 * conversation list and open thread. Each column is a landmark with a heading
 * and its own scroller, and a second copy of that chrome would drift in radius,
 * padding and heading level the first time somebody adjusted one — which is
 * precisely how the pre-v4 app ended up with three heights of the same list row.
 *
 * The label is a real heading rather than a caption so the regions are navigable
 * landmarks — on a 1280px board the columns are far enough apart that a
 * screen-reader user needs to jump between them.
 *
 * WHY THE BODY SCROLLS AND THE PAGE DOES NOT: a wall display that has been
 * scrolled away from its alarms is worse than one that shows less. The shell
 * fixes the height; each column overflows inside itself.
 */
import { type LucideIcon } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { Card, CardDivider } from '@/components/ui';

export interface BoardRegionProps {
  /** Names the landmark, e.g. "Alarms and tasks". Becomes the region's heading. */
  label: string;
  icon: LucideIcon;
  /**
   * Optional right-hand slot on the heading line — a count, a filter, a small
   * control. Kept in the heading row so a region never needs a second bar under
   * it just to carry one chip.
   */
  action?: ReactNode;
  /**
   * Padding and gap for the scrolling body. The default suits a stack of cards;
   * a region whose child manages its own edges (a chat thread, a channel list
   * that draws full-bleed rows) passes `bodyClassName="p-0 gap-0"`.
   */
  bodyClassName?: string;
  children: ReactNode;
}

export function BoardRegion({
  label,
  icon: Icon,
  action,
  bodyClassName = 'flex flex-col gap-3 p-3',
  children,
}: BoardRegionProps): ReactElement {
  return (
    <Card aria-label={label} className="flex flex-col min-h-0 overflow-hidden" role="region">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3">
        <h2 className="flex items-center gap-2 text-body font-semibold text-ink-3">
          <Icon size={16} aria-hidden />
          {label}
        </h2>
        {action !== undefined && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      <CardDivider />
      <div className={`flex-1 min-h-0 overflow-y-auto ${bodyClassName}`}>{children}</div>
    </Card>
  );
}

export default BoardRegion;
