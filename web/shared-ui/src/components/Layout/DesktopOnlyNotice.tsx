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
import { Monitor } from 'lucide-react';

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
    <Monitor className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
    <p>
      {tool} is laid out for a screen at least 768 px wide. On this screen the work area scrolls
      sideways; a tablet in landscape or a desktop is the editing surface.
    </p>
  </div>
);

export default DesktopOnlyNotice;
