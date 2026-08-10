/**
 * BoardPage — the tablet control board's three-column grid.
 *
 * THIS FILE OWNS THE GRID, NOT THE CONTENTS. Each region below is a labelled,
 * independently scrolling column holding one pane:
 *
 *   1. ALARMS AND TASKS — the narrow left column (<AttentionPane/>).
 *   2. UNITS — the middle column, the unit grid (<UnitGridPane/>).
 *   3. SELECTED UNIT — the right column, the detail of whatever the middle
 *      column has selected (<UnitInspectorPane/>).
 *
 * Beneath the three columns runs the DRIVES strip (<DrivesPane/>) — the design's
 * feeders row, which the mobile client could not draw until it had VFD documents
 * of its own. It spans the full width because it is about machinery rather than
 * about one pen's biology, and it scrolls sideways within itself so a site with
 * many drives never pushes the columns off the screen.
 *
 * SELECTION IS NOT NAVIGATION. Choosing a unit in the middle fills the right
 * pane and leaves the board mounted; both panes reach that state through
 * useSelectedUnit() (see ./useSelectedUnit.ts) rather than through props, so
 * neither pane has to know the other exists. The drives strip reads the same
 * selection, which is why picking a pen also shows what feeds it.
 *
 * WHY THE COLUMNS SCROLL SEPARATELY: a wall display that has been scrolled away
 * from its alarms is worse than one that shows less. The page itself never
 * scrolls — the shell fixes its height and each column overflows inside itself.
 */
import { clsx } from 'clsx';
import { AlertTriangle, Fish, LayoutGrid } from 'lucide-react';
import { type ReactElement } from 'react';

import { BoardRegion } from '@/pages/tablet/BoardRegion';
import { AttentionPane } from '@/pages/tablet/panes/AttentionPane';
import { DrivesPane } from '@/pages/tablet/panes/DrivesPane';
import { UnitGridPane } from '@/pages/tablet/panes/UnitGridPane';
import { UnitInspectorPane } from '@/pages/tablet/panes/UnitInspectorPane';
import { useSelectedUnit } from '@/pages/tablet/useSelectedUnit';

export function BoardPage(): ReactElement {
  // selectUnit is handed DOWN to the alarm pane, which can name a unit but has
  // no reason to know how selection is stored. The unit grid and the inspector
  // read and write the same selection through useSelectedUnit() themselves, so
  // this page never has to hold the selected id — it is in the URL.
  const { selectUnit } = useSelectedUnit();

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div
        className={clsx(
          'flex-1 min-h-0 grid gap-3 p-3',
          // Fixed side columns, elastic middle. The unit grid gets the slack
          // because it is the only region whose content count varies; the
          // alarms column and the detail pane have a natural width and widen
          // only on a large cabin tablet (`board-wide`, ≥1280px).
          'grid-cols-[290px_minmax(0,1fr)_360px]',
          'board-wide:grid-cols-[330px_minmax(0,1fr)_420px]',
        )}
      >
        <BoardRegion label="Alarms and tasks" icon={AlertTriangle}>
          {/* An alarm that names a loaded unit fills the detail column instead
              of navigating — the board owns the selection, the pane only asks
              for it. Tasks carry no unit id, so they stay a readout. */}
          <AttentionPane onSelectUnit={selectUnit} />
        </BoardRegion>

        <BoardRegion label="Units" icon={LayoutGrid}>
          <UnitGridPane />
        </BoardRegion>

        <BoardRegion label="Selected unit" icon={Fish}>
          <UnitInspectorPane />
        </BoardRegion>
      </div>

      {/* The feeders/drives strip. It sits BELOW the columns rather than inside
          one because it is about the site's machinery, not about one pen — and
          because a wall board's alarms must never be pushed off screen by it. */}
      <DrivesPane />

      <p className="shrink-0 px-4 pb-3 text-meta text-ink-3">
        Tap a unit to inspect it. Log entries and drive commands happen on the handheld, standing at
        the machine — this board is for watching and planning.
      </p>
    </div>
  );
}

export default BoardPage;
