/**
 * SkipToContent — the first tab stop on every page (WCAG 2.4.1).
 *
 * The shell layout used by every tenant user had no skip link, so a keyboard
 * user tabbed through up to ~60 sidebar items on every page load; only the
 * super-admin layout carried one. Render it first in the layout and give
 * `<main>` the matching id with `tabIndex={-1}` so focus lands inside it.
 */
import React from 'react';

export interface SkipToContentProps {
  /** Id of the `<main>` element (default `main-content`) */
  targetId?: string;
  children?: React.ReactNode;
}

export const SkipToContent: React.FC<SkipToContentProps> = ({
  targetId = 'main-content',
  children = 'Skip to main content',
}) => (
  <a
    href={`#${targetId}`}
    className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
  >
    {children}
  </a>
);
