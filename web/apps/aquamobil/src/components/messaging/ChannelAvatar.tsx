import { clsx } from 'clsx';
import { Bot } from 'lucide-react';
import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

interface ChannelAvatarProps {
  /** Channel type determines layout: DM shows single avatar, group shows stacked. */
  type: 'dm' | 'group' | 'ai';
  /** Display name (used for initials fallback). */
  name: string;
  /** Primary avatar image URL. */
  imageUrl?: string;
  /** Second member avatar URL for group stacked display. */
  secondImageUrl?: string;
  /** Whether the user (DM) is currently online. */
  isOnline?: boolean;
  /** Avatar size variant. */
  size?: AvatarSize;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * WHY: Deterministic color from name hash ensures the same user always gets
 * the same color across sessions without needing a server-stored color field.
 * 10 distinct hues provide enough variety for typical channel lists.
 */
const INITIALS_COLORS = [
  'bg-ocean-500',
  'bg-sea-500',
  'bg-coral-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-indigo-500',
  'bg-teal-500',
] as const;

const SIZE_MAP: Record<AvatarSize, { container: string; text: string; online: string; icon: number }> = {
  sm: { container: 'w-8 h-8', text: 'text-xs', online: 'w-2 h-2', icon: 14 },
  md: { container: 'w-10 h-10', text: 'text-sm', online: 'w-2.5 h-2.5', icon: 18 },
  lg: { container: 'w-14 h-14', text: 'text-lg', online: 'w-3 h-3', icon: 24 },
  xl: { container: 'w-20 h-20', text: 'text-2xl', online: 'w-3.5 h-3.5', icon: 32 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (name[0] ?? '?').toUpperCase();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ChannelAvatar -- channel/user avatar with image, initials fallback,
 * stacked group display, and online indicator.
 *
 * WHY React.memo: Avatars are rendered in every channel list row and
 * message bubble. They are pure -- same props always yield same output.
 */
export const ChannelAvatar = React.memo(function ChannelAvatar({
  type,
  name,
  imageUrl,
  secondImageUrl,
  isOnline,
  size = 'md',
}: ChannelAvatarProps) {
  const s = SIZE_MAP[size];
  const colorIdx = hashName(name) % INITIALS_COLORS.length;
  const bgColor = INITIALS_COLORS[colorIdx];
  const initials = getInitials(name);

  // -----------------------------------------------------------------------
  // AI channel: robot icon with purple border
  // -----------------------------------------------------------------------
  if (type === 'ai') {
    return (
      <div className={clsx('relative shrink-0', s.container)}>
        <div
          className={clsx(
            'rounded-full flex items-center justify-center bg-purple-100 dark:bg-purple-900/40 border-2 border-purple-400',
            s.container,
          )}
        >
          <Bot size={s.icon} className="text-purple-600 dark:text-purple-300" />
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Group channel: stacked two-member avatars or initials
  // -----------------------------------------------------------------------
  if (type === 'group' && !imageUrl) {
    return (
      <div className={clsx('relative shrink-0', s.container)}>
        {/* Back avatar (slightly offset) */}
        <div
          className={clsx(
            'absolute top-0 right-0 w-3/5 h-3/5 rounded-full border-2 border-white dark:border-gray-900 overflow-hidden',
            bgColor,
          )}
        >
          {secondImageUrl ? (
            <img src={secondImageUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="w-full h-full flex items-center justify-center text-white text-[9px] font-bold">
              {initials[1] ?? initials[0]}
            </span>
          )}
        </div>
        {/* Front avatar */}
        <div
          className={clsx(
            'absolute bottom-0 left-0 w-3/5 h-3/5 rounded-full border-2 border-white dark:border-gray-900 overflow-hidden z-[1]',
            bgColor,
          )}
        >
          <span className="w-full h-full flex items-center justify-center text-white text-[9px] font-bold">
            {initials[0]}
          </span>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // DM / Group with image: single avatar with optional online dot
  // -----------------------------------------------------------------------
  return (
    <div className={clsx('relative shrink-0', s.container)}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={name}
          className={clsx('rounded-full object-cover', s.container)}
        />
      ) : (
        <div
          className={clsx(
            'rounded-full flex items-center justify-center text-white font-bold',
            s.container,
            s.text,
            bgColor,
          )}
        >
          {initials}
        </div>
      )}
      {/* Online indicator dot */}
      {isOnline && (
        <span
          className={clsx(
            'absolute bottom-0 right-0 rounded-full bg-emerald-500 border-2 border-white dark:border-gray-900',
            s.online,
          )}
          aria-label="Online"
        />
      )}
    </div>
  );
});
