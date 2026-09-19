/**
 * PageHeader — the band every AquaMobil page opens with.
 *
 * WHY one component: 27 pages wrote the same band by hand — a feature-toned
 * gradient, a back arrow, a 22px icon, the title, sometimes a subtitle or a
 * right-hand action — in a dozen spellings (row paddings, hover colours,
 * touch-target sizes, back handlers), and the four hub pages carried a second
 * copy with a glass icon box and a curved bottom edge. The band is the mobile
 * counterpart of shared-ui's PageHeader (the PWA cannot import shared-ui):
 * `tone` picks the feature gradient, `variant="hub"` the glass box and curve,
 * `back` the arrow (history pop by default, a handler, or none), `actions`
 * the right side, and `children` whatever sits inside the band under the row
 * (a search field, a KPI strip, a status line).
 */
import { clsx } from 'clsx';
import { ArrowLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

// Literal class strings: Tailwind's content scan needs every gradient it emits.
const TONES = {
  ocean: { bar: 'from-ocean-600 to-ocean-500', hub: 'from-ocean-700 via-ocean-600 to-ocean-500' },
  blue: { bar: 'from-blue-600 to-blue-500', hub: 'from-blue-700 via-blue-600 to-blue-500' },
  cyan: { bar: 'from-cyan-600 to-cyan-500', hub: 'from-cyan-700 via-cyan-600 to-cyan-500' },
  teal: { bar: 'from-teal-600 to-teal-500', hub: 'from-teal-700 via-teal-600 to-teal-500' },
  green: { bar: 'from-green-600 to-green-500', hub: 'from-green-700 via-green-600 to-green-500' },
  emerald: { bar: 'from-emerald-600 to-emerald-500', hub: 'from-emerald-700 via-emerald-600 to-emerald-500' },
  gray: { bar: 'from-gray-600 to-gray-500', hub: 'from-gray-700 via-gray-600 to-gray-500' },
  amber: { bar: 'from-amber-600 to-amber-500', hub: 'from-amber-700 via-amber-600 to-amber-500' },
  orange: { bar: 'from-orange-600 to-orange-500', hub: 'from-orange-600 via-orange-500 to-amber-500' },
  red: { bar: 'from-red-600 to-red-500', hub: 'from-red-700 via-red-600 to-red-500' },
  violet: { bar: 'from-violet-600 to-violet-500', hub: 'from-violet-700 via-violet-600 to-violet-500' },
  purple: { bar: 'from-purple-600 to-purple-500', hub: 'from-purple-700 via-purple-600 to-violet-500' },
  indigo: { bar: 'from-indigo-600 to-indigo-500', hub: 'from-indigo-700 via-indigo-600 to-indigo-500' },
} as const;

export type PageHeaderTone = keyof typeof TONES | 'plain';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** The 22px icon beside the title; in the hub variant it sits in the glass box */
  icon?: LucideIcon;
  /** Feature gradient; `plain` is the light surface with a bottom border */
  tone?: PageHeaderTone;
  /** `hub`: glass icon box, no back arrow by default, curved bottom edge */
  variant?: 'bar' | 'hub';
  /** The curved bottom edge; hub bands always have it */
  curved?: boolean;
  /** `true` pops history, a function runs instead, `false` hides the arrow (hub default) */
  back?: boolean | (() => void);
  backLabel?: string;
  /** Right-hand controls on the title row */
  actions?: ReactNode;
  /** Inside the band, under the title row: a search field, a KPI strip, a status line */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  tone = 'ocean',
  variant = 'bar',
  curved,
  back,
  backLabel = 'Back',
  actions,
  children,
  className,
}: PageHeaderProps): ReactElement {
  const navigate = useNavigate();
  const plain = tone === 'plain';
  const hub = variant === 'hub';
  const showBack = back === undefined ? !hub : back !== false;
  const handleBack = (): void => {
    if (typeof back === 'function') {
      back();
      return;
    }
    navigate(-1);
  };
  const gradient = plain ? '' : TONES[tone][hub ? 'hub' : 'bar'];

  return (
    <header
      className={clsx(
        plain
          ? 'bg-white text-gray-900 border-b border-gray-200 dark:bg-gray-900 dark:text-white dark:border-gray-800'
          : clsx(hub ? 'bg-gradient-to-br' : 'bg-gradient-to-r', gradient, 'text-white'),
        className,
      )}
    >
      <div className={clsx(hub ? 'px-5' : 'px-4', 'pt-safe-top')}>
        <div className="flex items-center gap-3 py-4">
          {showBack && (
            <button
              type="button"
              onClick={handleBack}
              aria-label={backLabel}
              className={clsx(
                'min-h-touch min-w-touch -ml-2 flex shrink-0 items-center justify-center rounded-xl touch-feedback transition-colors',
                plain ? 'hover:bg-gray-100 dark:hover:bg-gray-800' : 'hover:bg-white/10 dark:hover:bg-gray-800/10',
              )}
            >
              <ArrowLeft size={22} />
            </button>
          )}
          {Icon &&
            (hub ? (
              <div className="w-10 h-10 shrink-0 bg-white/15 dark:bg-gray-900/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
                <Icon size={22} className="text-white" />
              </div>
            ) : (
              <Icon size={22} className="shrink-0" />
            ))}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold tracking-tight truncate">{title}</h1>
            {subtitle && (
              <p className={clsx('text-xs truncate', plain ? 'text-gray-500 dark:text-gray-400' : 'text-white/80')}>
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children && <div className="pb-4">{children}</div>}
      </div>
      {(curved ?? hub) && (
        // The curved edge every hub band ends with; it paints the page background colour.
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      )}
    </header>
  );
}
