/**
 * PageHeader — the title row every page opens with.
 *
 * WHY one component: 130 pages wrote the same three lines by hand (a
 * `justify-between` row, an `h1` in `text-2xl font-bold`, a grey description)
 * in a dozen spellings — five description sizes, three wrapper layouts, dark
 * variants on some — and none of them could be retuned centrally. The row is
 * responsive by default (stacks under `sm`), carries the dark-mode text
 * colours, and takes the page's actions, an eyebrow above the title (a back
 * link, a breadcrumb, a category label), a leading element beside it (an icon
 * box, a back button) and any content that belongs under the title row (tabs,
 * a filter strip).
 */
import React from 'react';

export interface PageHeaderProps {
  /** The page title — rendered as the page's single `h1` */
  title: React.ReactNode;
  /** One line under the title */
  description?: React.ReactNode;
  /** Buttons and controls on the right of the title */
  actions?: React.ReactNode;
  /** Above the title: a back link, a breadcrumb, a category label */
  eyebrow?: React.ReactNode;
  /** Beside the title block: an icon box, a back button */
  leading?: React.ReactNode;
  /** Under the title row: tabs, a filter strip, a status line */
  children?: React.ReactNode;
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  eyebrow,
  leading,
  children,
  className = '',
}) => {
  return (
    <header className={className}>
      {eyebrow && <div className="mb-2">{eyebrow}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {leading && <div className="shrink-0">{leading}</div>}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
            {description && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
};

export default PageHeader;
