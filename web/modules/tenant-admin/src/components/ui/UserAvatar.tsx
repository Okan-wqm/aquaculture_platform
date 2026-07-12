import { memo } from 'react';
import { Avatar } from '@aquaculture/shared-ui';

export interface UserAvatarProps {
  name: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Renders a user avatar with initials fallback.
 *
 * Thin domain wrapper over the shared-ui `Avatar` (ADMIN-MEDIUM-004): keeps
 * the module-local `{ name, avatarUrl, size }` API so call sites don't churn.
 */
export const UserAvatar = memo<UserAvatarProps>(({ name, avatarUrl, size = 'md' }) => (
  <Avatar name={name} src={avatarUrl} size={size} />
));

UserAvatar.displayName = 'UserAvatar';
