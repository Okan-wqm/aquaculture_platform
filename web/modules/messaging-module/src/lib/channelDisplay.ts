import type { Channel } from '../types/messaging';

/**
 * A channel's display title. Group/AI channels carry an explicit `name`; direct
 * channels have none, so we derive it from the OTHER members' names — `myId`
 * filters the caller's own membership out so a DM header never contains the
 * current user's own name (FAZ 1). Pure — the single most reused piece of
 * channel rendering, extracted so it is unit-tested independently of React.
 */
export function channelTitle(channel: Channel, myId?: string | null): string {
  if (channel.name) return channel.name;
  const others = (channel.members ?? [])
    .filter((m) => m.userId !== myId)
    .map((m) => m.user)
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Member');
  return others.join(', ') || 'Direct message';
}
