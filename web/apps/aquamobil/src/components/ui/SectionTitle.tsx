/** SectionTitle — the caption above a group of fields or rows (replaces Konsta's BlockTitle). */
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function SectionTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <h2
      className={clsx(
        'px-4 pb-2 pt-5 text-meta font-semibold uppercase tracking-wider text-ink-3',
        className,
      )}
    >
      {children}
    </h2>
  );
}
