import { MessageSquare, Users } from 'lucide-react';
import React from 'react';

import type { Channel } from '../types/messaging';

import { MemberAvatar } from './MemberAvatar';
import { AVATAR_ICON_PX, PersonaAvatar, type AvatarSize } from './PersonaAvatar';

/**
 * A channel's face: an AI room shows its agent, a direct room the other person, a group room
 * the neutral group tile. Decorative — the room title beside it names the row. `myId` keeps the
 * caller's own face off a direct room (FAZ 1 rule); without it the other side cannot be told
 * apart, so the room shows the neutral tile rather than possibly the caller's own face.
 */
export function ChannelAvatar({
  channel,
  myId,
  size = 'md',
}: {
  channel: Channel;
  myId: string | null | undefined;
  size?: AvatarSize;
}): React.ReactElement {
  if (channel.type === 'AI') return <PersonaAvatar aiPersona={channel.aiPersona} size={size} />;

  const other = myId ? channel.members?.find((m) => m.userId !== myId) : undefined;
  if (channel.type === 'DIRECT' && other) return <MemberAvatar user={other.user} size={size} />;

  const Icon = channel.type === 'GROUP' ? Users : MessageSquare;
  return (
    <span
      className={`sd-avatar sd-avatar--${size}`}
      aria-hidden="true"
      data-testid="channel-avatar"
    >
      <Icon size={AVATAR_ICON_PX[size]} />
    </span>
  );
}
