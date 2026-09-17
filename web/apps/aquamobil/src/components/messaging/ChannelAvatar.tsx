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
 *
 * WHY five hues rather than the ten hand-picked Tailwind ramps this replaces:
 * these are the v4 decorative tokens that are NOT already spoken for by an
 * alarm meaning, so an avatar can never be mistaken for a warning. They resolve
 * per theme, which the old fixed ramps did not. The same five back
 * MessageBubble's sender names and MentionPicker's avatars, so one person keeps
 * one hue wherever they appear.
 */
const INITIALS_COLORS = [
  'bg-acc',
  'bg-type-water',
  'bg-type-transfer',
  'bg-type-cull',
  'bg-type-harvest',
] as const;

/**
 * The ink that sits on a saturated fill. `--on-acc` is the theme's answer to
 * exactly that question (near-black on the light night hues, white on the dark
 * day hues), so it is correct on every entry in INITIALS_COLORS — which a
 * hardcoded white was not.
 */
const ON_FILL_INK = 'text-acc-on';

const SIZE_MAP: Record<
  AvatarSize,
  { container: string; text: string; online: string; icon: number }
> = {
  sm: { container: 'w-8 h-8', text: 'text-meta', online: 'w-2 h-2', icon: 14 },
  md: { container: 'w-10 h-10', text: 'text-body', online: 'w-2.5 h-2.5', icon: 18 },
  lg: { container: 'w-14 h-14', text: 'text-head', online: 'w-3 h-3', icon: 24 },
  xl: { container: 'w-20 h-20', text: 'text-display', online: 'w-3.5 h-3.5', icon: 32 },
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
  // AI channel: robot icon on the accent
  // -----------------------------------------------------------------------
  // WHY the accent and not a violet of its own: v4 gives the accent EVERY
  // action and active state, and there is no AI token. A hand-picked purple
  // would be the one colour in the app that no theme owns.
  if (type === 'ai') {
    return (
      <div className={clsx('relative shrink-0', s.container)}>
        <div
          className={clsx(
            'rounded-full flex items-center justify-center bg-acc-dim border-2 border-acc',
            s.container,
          )}
        >
          <Bot size={s.icon} className="text-acc" />
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Group channel: stacked two-member avatars or initials
  // -----------------------------------------------------------------------
  if (type === 'group' && !imageUrl) {
    return (
      // The ring separating the two stacked discs takes the surface they sit on
      // (a channel row / a chat header), not a fixed white.
      <div className={clsx('relative shrink-0', s.container)}>
        {/* Back avatar (slightly offset) */}
        <div
          className={clsx(
            'absolute top-0 right-0 w-3/5 h-3/5 rounded-full border-2 border-surface-1 overflow-hidden',
            bgColor,
          )}
        >
          {secondImageUrl ? (
            <img src={secondImageUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <span
              className={clsx(
                'w-full h-full flex items-center justify-center text-meta font-bold',
                ON_FILL_INK,
              )}
            >
              {initials[1] ?? initials[0]}
            </span>
          )}
        </div>
        {/* Front avatar */}
        <div
          className={clsx(
            'absolute bottom-0 left-0 w-3/5 h-3/5 rounded-full border-2 border-surface-1 overflow-hidden z-[1]',
            bgColor,
          )}
        >
          <span
            className={clsx(
              'w-full h-full flex items-center justify-center text-meta font-bold',
              ON_FILL_INK,
            )}
          >
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
        <img src={imageUrl} alt={name} className={clsx('rounded-full object-cover', s.container)} />
      ) : (
        <div
          className={clsx(
            'rounded-full flex items-center justify-center font-bold',
            ON_FILL_INK,
            s.container,
            s.text,
            bgColor,
          )}
        >
          {initials}
        </div>
      )}
      {/* Online indicator dot — `ok` is the confirm token; the ring takes the
          surface the avatar sits on rather than a fixed white. */}
      {isOnline && (
        <span
          className={clsx(
            'absolute bottom-0 right-0 rounded-full bg-ok border-2 border-surface-1',
            s.online,
          )}
          aria-label="Online"
        />
      )}
    </div>
  );
});
