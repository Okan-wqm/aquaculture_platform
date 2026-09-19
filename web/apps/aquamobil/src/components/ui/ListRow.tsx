/** ListRow — one row of a list: leading, title/subtitle, trailing (replaces Konsta's ListItem). */
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  after?: ReactNode;
  onClick?: () => void;
  className?: string;
}

export function ListRow({ title, subtitle, leading, after, onClick, className }: ListRowProps): ReactNode {
  const body = (
    <>
      {leading && <span className="flex-shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{title}</span>
        {subtitle && <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{subtitle}</span>}
      </span>
      {after && <span className="flex flex-shrink-0 items-center gap-2">{after}</span>}
    </>
  );
  const classes = clsx('flex w-full items-center gap-3 px-4 py-3 text-left', className);
  return (
    <li className="border-b border-gray-100 last:border-b-0 dark:border-gray-800">
      {onClick ? (
        <button type="button" onClick={onClick} className={clsx(classes, 'min-h-touch touch-feedback hover:bg-gray-50 dark:hover:bg-gray-800')}>
          {body}
        </button>
      ) : (
        <div className={classes}>{body}</div>
      )}
    </li>
  );
}

/** The list surface ListRow sits in: a card with hairline dividers. */
export function List({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <ul className={clsx('mx-4 overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900', className)}>{children}</ul>;
}
