import type { Channel } from '../types/messaging';

/**
 * A channel's display title. Group/AI channels carry an explicit `name`; direct
 * channels have none, so we derive it from the other members' names. Pure — the
 * single most reused piece of channel rendering, extracted so it is unit-tested
 * independently of React.
 */
export function channelTitle(channel: Channel): string {
  if (channel.name) return channel.name;
  const others = (channel.members ?? [])
    .map((m) => m.user)
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Member');
  return others.join(', ') || 'Direct message';
}
