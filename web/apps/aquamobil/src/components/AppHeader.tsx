/**
 * AppHeader — the one header every v4 screen wears.
 *
 * WHY it exists: before v4 there was no header component at all. Each page drew
 * its own ocean-gradient banner with a decorative blob and an SVG wave, which is
 * why the same "back arrow, title, avatar" row had a different height, a
 * different title size and a different safe-area treatment on six pages.
 *
 * The v4 shape is flat and quiet — brand mark, a context line naming where the
 * worker is, the screen title, and the account avatar on the right. The heavy
 * gradient is gone on purpose: it cost contrast in sunlight and the alarm
 * colours had to shout over it.
 */
import { ChevronLeft } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { AccountAvatar } from '@/components/AccountAvatar';
import { IconButton } from '@/components/ui';

export interface AppHeaderProps {
  /** The screen name, set at the display size. */
  title: string;
  /** Context above the title — the site, a code, a date, a count. */
  subtitle?: string;
  /** Shows a back chevron instead of the brand mark. */
  onBack?: () => void;
  /** Extra controls on the right, left of the avatar. */
  actions?: ReactNode;
  /** Hide the avatar on screens that are themselves the account area. */
  showAvatar?: boolean;
}

export function AppHeader({
  title,
  subtitle,
  onBack,
  actions,
  showAvatar = true,
}: AppHeaderProps): ReactElement {
  return (
    <header className="px-4 pt-safe-top">
      <div className="flex items-start justify-between gap-3 py-4">
        <div className="flex items-center gap-3 min-w-0">
          {onBack ? (
            <IconButton aria-label="Back" onClick={onBack} className="bg-surface-2 rounded-xl">
              <ChevronLeft size={18} className="text-ink-2" />
            </IconButton>
          ) : (
            <img
              src="/mobile/icons/icon-512x512.svg"
              alt=""
              aria-hidden
              className="w-9 h-9 shrink-0"
            />
          )}
          <div className="min-w-0">
            {subtitle !== undefined && (
              <div className="text-body text-ink-3 truncate">{subtitle}</div>
            )}
            <h1 className="text-display font-semibold text-ink-1 truncate">{title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {/* The avatar is the v4 route to Account, which no longer holds a dock
              slot — the dock's five slots go to the things a worker uses during a
              shift, and settings is not one of them. Shared with the tablet
              board's top bar (src/components/AccountAvatar.tsx). */}
          {showAvatar && <AccountAvatar />}
        </div>
      </div>
    </header>
  );
}
