/**
 * ConsoleHeader — the tenant console's top bar (FE-HIGH-334; design handoff
 * "Tenant Console — Industrial", README §7.1 and §7.4). Presentational: the
 * shell passes every label, value and callback.
 *
 * WHAT: a frosted header — the surface at 88% over a 14px backdrop blur —
 * holding one row, at least 80px tall: the phone navigation toggle (the
 * shell's hamburger, shown below `md` only), the heading (eyebrow + h1), the
 * command-palette trigger, then the title block, the shell's right-hand
 * content (notifications, the AI trigger) and the user menu. The annunciator
 * slot sits under the row inside the same element, so the two stick together.
 *
 * WHY container queries: the row lays out against the console column (the
 * `page` container, `.sd-content`), not the window, so opening or collapsing
 * the rail re-flows it. The title block's live counts show from 1180px and
 * its sheet code and revision from 1340px, the user's name from 980px.
 *
 * WHY the row wraps in DOM order (WCAG 2.4.3): at 820px and below the row
 * wraps, and every item keeps its place in the source — the heading, the
 * palette trigger (beside the heading while both fit, else on a line of its
 * own), then the tools and the user menu at the right. Focus therefore runs
 * down the lines as they are drawn; a trigger drawn last but focused second
 * (`order`) sent Tab back up the header.
 *
 * WHY it sticks only where it fits (WCAG 1.4.10, 2.4.11): the wrapped header
 * with its 2×2 annunciator is 324px tall on a phone and 267px at 700×400 —
 * stuck to the top it covered half the screen, all of it at 320×256 (a
 * 1280×1024 screen at 400%), and hid the control Tab moved to. So it sticks
 * only on a console wider than 820px in a viewport taller than 500px, and
 * elsewhere scrolls with the page. Only the whole header can stick: a sticky
 * box never leaves its parent, so a sticky title row inside it would scroll
 * away with it, and lifting the row out would split the banner landmark.
 * Where it sticks, useStickyHeaderOffset publishes its height as the
 * document's scroll padding, so a control reached by Tab stops below it.
 *
 * Hazard kept out: `backdrop-filter` makes the header the containing block of
 * any `position: fixed` descendant, so nothing fixed lives in here — the user
 * menu closes on an outside press through the shared Popover, not an overlay.
 *
 * The row's gutter is one value, `--sd-header-gutter`, set on the header:
 * the row pads with it, and where the row wraps the user menu's and the
 * bell's panels hang from this (positioned) header at the same gutter — the
 * Popover's `header-gutter` anchor — because their triggers may then sit
 * anywhere in the row.
 */
import { useRef, type ReactElement, type ReactNode } from 'react';

import { ConsoleHeading, type ConsoleHeadingProps } from './ConsoleHeading';
import { PaletteTrigger } from './PaletteTrigger';
import { useStickyHeaderOffset } from './useStickyHeaderOffset';

export interface ConsoleHeaderProps extends ConsoleHeadingProps {
  /** The phone navigation toggle (the shell's hamburger, opening the rail's overlay); first in the row. */
  readonly navToggle?: ReactNode;
  /** Opens the command palette (the shell owns it and its keyboard shortcut). */
  readonly onOpenPalette: () => void;
  /** Whether the palette is open, reported on the trigger. */
  readonly paletteOpen?: boolean;
  /** The title block (`<TitleBlock>`); it hides itself where the row cannot hold it. */
  readonly titleBlock?: ReactNode;
  /** Notifications and the AI trigger, framed to the user menu's height. */
  readonly rightContent?: ReactNode;
  /** The user menu (`<UserMenu>`). */
  readonly userMenu?: ReactNode;
  /** The alarm annunciator, under the row and sticky with it. */
  readonly annunciator?: ReactNode;
}

/**
 * Sticky on a console wider than 820px in a viewport taller than 500px;
 * elsewhere in the flow, still positioned so the header-gutter panels hang
 * from it.
 */
const PLACEMENT =
  'sticky top-0 z-30 @max-[821px]/page:relative [@media(max-height:500px)]:relative';

const ROW_GAP = 'gap-[clamp(12px,1.6cqi,24px)]';

export function ConsoleHeader({
  workspaceLabel,
  areaLabel,
  title,
  navToggle,
  onOpenPalette,
  paletteOpen = false,
  titleBlock,
  rightContent,
  userMenu,
  annunciator,
}: ConsoleHeaderProps): ReactElement {
  const headerRef = useRef<HTMLElement>(null);
  useStickyHeaderOffset(headerRef);

  return (
    <header
      ref={headerRef}
      className={`${PLACEMENT} border-b border-sd-rule bg-[color-mix(in_srgb,var(--color-sd-parchment)_88%,transparent)] backdrop-blur-[14px] backdrop-saturate-115 [--sd-header-gutter:clamp(14px,2.4cqi,40px)] print:hidden`}
    >
      <div
        className={`flex min-h-20 items-center ${ROW_GAP} px-(--sd-header-gutter) py-[10.2px] @max-[821px]/page:flex-wrap`}
      >
        {navToggle}
        <ConsoleHeading workspaceLabel={workspaceLabel} areaLabel={areaLabel} title={title} />
        <PaletteTrigger onOpen={onOpenPalette} open={paletteOpen} />
        {titleBlock}
        {/* The tools and the user menu stay together, at the right of whichever line they land on. */}
        <div className={`flex shrink-0 items-center ${ROW_GAP} @max-[821px]/page:ml-auto`}>
          {rightContent !== undefined && (
            <div className="flex min-h-14 shrink-0 items-center gap-1 border border-sd-rule px-1">
              {rightContent}
            </div>
          )}
          {userMenu}
        </div>
      </div>
      {annunciator}
    </header>
  );
}
