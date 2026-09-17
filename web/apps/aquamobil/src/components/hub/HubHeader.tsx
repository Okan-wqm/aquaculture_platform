import { ChevronLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { IconButton } from '@/components/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HubHeaderProps {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  onBack?: () => void;
  children?: ReactNode; // KPI strip slot rendered under the title row
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * HubHeader -- reusable header for all 4 hub pages.
 *
 * WHY separate component: Every hub page (DailyOps, StockEvents, Staff, Warehouse)
 * uses an identical header layout with only the title, icon, and optional
 * KPI strip differing. Extracting this eliminates ~40 lines of duplication per hub
 * and ensures visual consistency when the design system evolves.
 *
 * v4: the two-stop gradient, the glass icon well and the curved SVG bottom edge
 * are gone. They existed to blend a coloured banner into the page ground, and v4
 * has no coloured banner — the ground is owned by <body> and the header is flat,
 * matching AppHeader so a hub does not look like a different app. The `gradient`
 * prop went with them: there is no token for a per-hub hue, and inventing one
 * would put four competing colours back on screens whose alarm state has to be
 * the loudest thing on them. Hub identity now rests on the icon and the title.
 */
export function HubHeader({
  title,
  subtitle,
  icon: Icon,
  onBack,
  children,
}: HubHeaderProps): ReactElement {
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
    <header className="px-4 pt-safe-top">
      {/* Top bar: back button + icon + title */}
      <div className="flex items-center gap-3 py-4">
        <IconButton aria-label="Go back" onClick={handleBack} className="bg-surface-2 rounded-xl">
          <ChevronLeft size={18} className="text-ink-2" />
        </IconButton>
        <span
          aria-hidden
          className="w-10 h-10 shrink-0 rounded-xl bg-acc-dim text-acc inline-flex items-center justify-center"
        >
          <Icon size={20} />
        </span>
        <div className="flex-1 min-w-0">
          {subtitle && <div className="text-body text-ink-3 truncate">{subtitle}</div>}
          <h1 className="text-head font-semibold text-ink-1 truncate">{title}</h1>
        </div>
      </div>

      {/* Optional KPI strip slot. */}
      {children && <div className="pb-4">{children}</div>}
    </header>
  );
}
