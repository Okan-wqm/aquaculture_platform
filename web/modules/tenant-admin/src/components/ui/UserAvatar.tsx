import { memo } from 'react';

export interface UserAvatarProps {
  name: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses: Record<string, string> = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
};

/**
 * Renders a user avatar with initials fallback — the one avatar every
 * tenant-admin list and dialog draws. The fallback is the console's initials
 * plate (the header's user menu, README §7.4): the accent's lightest step, a
 * hairline of its 300 step, the initials in the condensed display face. The
 * `sd-accent` ramp follows the theme and the workspace by itself, so it needs
 * no `dark:` sibling. Round, as avatars stay.
 */
export const UserAvatar = memo<UserAvatarProps>(({ name, avatarUrl, size = 'md' }) => {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        className={`${sizeClasses[size]} rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${sizeClasses[size]} rounded-full border border-sd-accent-300 bg-sd-accent-100 flex shrink-0 items-center justify-center font-display-sd font-semibold text-sd-accent-800`}
    >
      {initials || '??'}
    </div>
  );
});

UserAvatar.displayName = 'UserAvatar';
