/**
 * DesktopOnlyNotice — a builder's declared minimum width (FE-HIGH-088).
 *
 * The SCADA package builder and the process editor lay a tree panel, a canvas
 * and a properties panel side by side. Below Tailwind's `md` they declared
 * nothing, so a phone crushed the three columns into 375 px. The notice
 * renders only below `md` and names the width the tool needs; the builder's
 * work row carries a `min-w` so the canvas scrolls sideways instead of
 * collapsing. One primitive, so the wording and the breakpoint cannot drift
 * between the builders.
 */

import React from 'react';

import { cn } from '../../utils';

export interface DesktopOnlyNoticeProps {
  /** The tool the sentence names, e.g. "The SCADA builder" */
  tool: string;
  className?: string;
}

export const DesktopOnlyNotice: React.FC<DesktopOnlyNoticeProps> = ({ tool, className }) => (
  <div
    role="note"
    className={cn(
      'md:hidden flex items-start gap-3 border-b border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800 dark:border-warning-800 dark:bg-warning-900 dark:text-warning-100',
      className,
    )}
  >
    <svg
      className="mt-0.5 h-5 w-5 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </svg>
    <p>
      {tool} is laid out for a screen at least 768 px wide. On this screen the work area scrolls
      sideways; a tablet in landscape or a desktop is the editing surface.
    </p>
  </div>
);

export default DesktopOnlyNotice;
