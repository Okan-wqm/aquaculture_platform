import { toIntlLocale, useI18n } from '@aquaculture/shared-ui';
import React, { useState } from 'react';

import type { MessagingUser } from '../types/messaging';

import type { AvatarSize } from './PersonaAvatar';

/** A person's full name, or the localised "Member" when the profile carries none. */
export function memberName(user: MessagingUser | null, fallback: string): string {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || fallback;
}

/**
 * A person's face on the same square tile as the agents: the profile photo when it loads,
 * otherwise up to two initials, upper-cased in the UI language (Turkish "i" → "İ"). A photo that
 * fails (dead URL, blocked by the console's img-src policy) falls back to the initials.
 * Decorative — it always stands beside the person's visible name.
 */
export function MemberAvatar({
  user,
  size = 'md',
}: {
  user: MessagingUser | null;
  size?: AvatarSize;
}): React.ReactElement {
  const { t, locale } = useI18n();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const name = memberName(user, t('messaging.memberFallback'));
  const initials = [user?.firstName, user?.lastName]
    .map((part) => part?.trim().charAt(0) ?? '')
    .join('')
    .toLocaleUpperCase(toIntlLocale(locale));
  const photo = user?.profileImageUrl;
  return (
    <span className={`sd-avatar sd-avatar--${size}`} aria-hidden="true" data-testid="member-avatar">
      {photo && photo !== failedSrc ? (
        <img src={photo} alt="" onError={() => setFailedSrc(photo)} />
      ) : (
        <span>{initials || name.charAt(0)}</span>
      )}
    </span>
  );
}
