/**
 * PageHeader — the header every AquaMobil screen opens with.
 *
 * WHY one component: 27 pages wrote the same header by hand — a back arrow, an
 * icon, the title, sometimes a subtitle or a right-hand action — in a dozen
 * spellings (row paddings, hover colours, touch-target sizes, back handlers),
 * and the four hub pages carried a second copy. This is the mobile counterpart
 * of shared-ui's PageHeader (the PWA takes only i18n and brand from shared-ui).
 *
 * v4 shape: flat and quiet, on the page ground. The feature-toned gradient
 * bands and the hub variant's curved edge are gone — they cost contrast in
 * sunlight and the alarm colours had to shout over them, and v4 has no token
 * for a per-feature hue. Identity rests on the icon tile and the title.
 *
 * - `back`: `true` pops history, a function runs instead, `false` hides it.
 * - `brand`: with no back arrow, the brand mark leads the row (top-level screens).
 * - `icon`: an accent tile beside the title (hubs, record flows).
 * - `size`: `display` for a top-level screen title, `head` for everything else.
 * - `actions`: right-hand controls; `children`: under the title row (a KPI
 *   strip, a search field, a status line).
 */
import { clsx } from 'clsx';
import { ChevronLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { IconButton } from './IconButton';

export interface PageHeaderProps {
  title: ReactNode;
  /** Context above the title — the site, a code, a date, a count */
  subtitle?: ReactNode;
  /** Rendered in the accent tile beside the title */
  icon?: LucideIcon;
  /** `true` pops history, a function runs instead, `false` hides the arrow */
  back?: boolean | (() => void);
  backLabel?: string;
  /** Show the brand mark when there is no back arrow */
  brand?: boolean;
  size?: 'display' | 'head';
  /** Right-hand controls on the title row */
  actions?: ReactNode;
  /** Under the title row: a KPI strip, a search field, a status line */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  back = true,
  backLabel = 'Back',
  brand = false,
  size = 'head',
  actions,
  children,
  className,
}: PageHeaderProps): ReactElement {
  const navigate = useNavigate();
  const handleBack = (): void => {
    if (typeof back === 'function') {
      back();
      return;
    }
    navigate(-1);
  };

  return (
    <header className={clsx('px-4 pt-safe-top', className)}>
      <div className="flex items-center gap-3 py-4">
        {back !== false ? (
          <IconButton
            aria-label={backLabel}
            onClick={handleBack}
            className="bg-surface-2 rounded-xl"
          >
            <ChevronLeft size={18} className="text-ink-2" />
          </IconButton>
        ) : (
          brand && (
            <img
              src="/mobile/icons/icon-512x512.svg"
              alt=""
              aria-hidden
              className="w-9 h-9 shrink-0"
            />
          )
        )}
        {Icon && (
          <span
            aria-hidden
            className="w-10 h-10 shrink-0 rounded-xl bg-acc-dim text-acc inline-flex items-center justify-center"
          >
            <Icon size={20} />
          </span>
        )}
        <div className="flex-1 min-w-0">
          {subtitle !== undefined && (
            <div className="text-body text-ink-3 truncate">{subtitle}</div>
          )}
          <h1
            className={clsx(
              'font-semibold text-ink-1 truncate',
              size === 'display' ? 'text-display' : 'text-head',
            )}
          >
            {title}
          </h1>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="pb-4">{children}</div>}
    </header>
  );
}
