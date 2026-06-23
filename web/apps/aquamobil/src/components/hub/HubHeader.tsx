import { clsx } from 'clsx';
import { ArrowLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HubHeaderProps {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  gradient: string;
  onBack?: () => void;
  children?: ReactNode; // KPI strip slot rendered inside the gradient area
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * HubHeader -- reusable gradient header for all 4 hub pages.
 *
 * WHY separate component: Every hub page (DailyOps, StockEvents, Staff, Warehouse)
 * uses an identical header layout with only the title, icon, gradient, and optional
 * KPI strip differing. Extracting this eliminates ~40 lines of duplication per hub
 * and ensures visual consistency when the design system evolves.
 *
 * WHY curved SVG bottom: The existing app design system (HomePage, OperationsHubPage,
 * StorageHubPage) uses a consistent curved bottom edge on gradient headers. This SVG
 * approach avoids clip-path browser inconsistencies and renders crisply on all screen
 * densities.
 */
export function HubHeader({ title, subtitle, icon: Icon, gradient, onBack, children }: HubHeaderProps): ReactElement {
  const navigate = useNavigate();

  const handleBack = (): void => {
    if (onBack) {
      onBack();
      return;
    }

    // WHY: navigate(-1) pops the browser history stack, which is the expected
    // mobile UX. The fallback to /operations handles edge cases where the user
    // deep-linked directly to a hub page (no history entry to go back to).
    try {
      navigate(-1);
    } catch {
      navigate('/operations');
    }
  };

  return (
    <header className={clsx('bg-gradient-to-br text-white', gradient)}>
      <div className="px-5 pt-safe-top">
        {/* Top bar: back button + icon + title */}
        <div className="flex items-center gap-3 py-4">
          <button
            onClick={handleBack}
            aria-label="Go back"
            className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2 rounded-xl touch-feedback transition-colors hover:bg-white/10"
          >
            <ArrowLeft size={22} />
          </button>
          <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
            <Icon size={22} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold tracking-tight truncate">{title}</h1>
            {subtitle && (
              <p className="text-xs text-white/80 truncate">{subtitle}</p>
            )}
          </div>
        </div>

        {/* Optional KPI strip slot -- rendered inside the gradient area so KPI boxes
            can use the bg-white/10 backdrop-blur glass effect against the gradient. */}
        {children && <div className="pb-5">{children}</div>}
      </div>

      {/* Curved bottom edge -- consistent with HomePage, OperationsHubPage, StorageHubPage */}
      <div className="relative">
        <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
          <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
        </svg>
      </div>
    </header>
  );
}
